# REQUEST_CHANGES

**Ревью:** b1 — живой h264-стрим экрана эмулятора (WebCodecs) + поворот + CSS-рамка + pinch-zoom
**Основание:** `docs/swarm/DONE-b1.md` против `docs/swarm/REVIEW-AURA.md` (AURA-007, 008, 010, 029, 009)
**Вердикт:** ядро видеотракта статически добротное, но два блокера и пять мейджоров. Не ACCEPT. Не REJECT — фундамент чинится точечно, переписывать не надо.

---

## Блокеры

### ZAN-1. Фича не собрана: в билде её нет — BLOCKER
`extensions/aura-kotlin/out/deviceScreen.js` (артефакт от 15 октября, 11433 байта)

В out/ лежит старый скомпилированный deviceScreen.js: только `FRAME_INTERVAL_MS`-луп, ноль вхождений `videoGen`/`VideoDecoder`/`video-chunk`. Билдер прогнал `tsc --noEmit` — типы проверил, но эмит не делал. `package.json` main → `./out/extension.js`. Вся «живая трансляция», поворот, zoom и рамка существуют **только в src/**. Расширение, которое скачает юзер, работает как до b1: статичные скриншоты.

**Фикс:** `tsc -p extensions/aura-kotlin/tsconfig.json` (эмит), проверить свежесть `out/`, убрать стейл-артефакт из поставки или пересобрать. Принимается только с доказательством: дата/размер out/deviceScreen.js после эмита + grep `VideoDecoder` в нём.

### ZAN-2. AURA-008 построен на ложной посылке: `wm size` не меняет оси при повороте — BLOCKER
`src/deviceScreen.ts` (rotate-перезапуск), `src/android.ts:463-473`

Механика AURA-008 предполагает: после `settings put system user_rotation 1` команда `wm size` отдаёт обменённые оси, и по ним строится `--size` для нового screenrecord. Ложно. AOSP `DisplayContent.java` (`updateDisplayAndOrientation`): `dw = rotated ? mBaseDisplayHeight : mBaseDisplayWidth` — **base-размеры считаются в нативной ориентации дисплея**, `wm size` печатает их как есть (`WindowManagerShellCommand.java:201-205`: Physical первым, Override вторым только если задан вручную). Эмулятор с нативной портретной матрицей (AVD по умолчанию) выдаёт `wm size` = 720x1280 **до и после** поворота.

Следствие после поворота: layout остаётся в старой ориентации, screenrecord перезапускается с портретным `--size` при ландшафтном буфере → летербокс-видео, координаты тапов через `toDevice` маппятся неверно. AURA-008 как «работающий поворот» не подтверждён.

**Фикс (любой из):**
1. Парсить `dumpsys window displays` — строка `cur=...` отражает реальную текущую ориентацию.
2. Знать `user_rotation`, которым сами крутили, и менять оси сами: `rotated ? [h,w] : [w,h]`.
3. Убрать `--size` из перезапуска: без него screenrecord берёт текущий размер дисплея в текущей ориентации (базовое поведение AOSP).

---

## Мейджоры

### ZAN-3. Приоритет размеров наоборот: ground truth ≠ devSize — MAJOR
`src/deviceScreen.ts:397-400` (layout), `460-462` (toDevice)

И layout, и маппинг координат сначала верят `devSize` (ответ `wm size`), а фактический битмап — фолбэк. По ZAN-2 devSize при повороте — ложь; кроме того в видео-режиме истина — `canvas.width/height` декодированного кадра, в image-режиме — `img.naturalWidth/Height`. Маппинг тапов обязан считаться от фактического размера медиа, иначе зум/поворот дают сдвиг кликов.

**Фикс:** порядок приоритета — режим видео: canvas.width/height; режим картинок: img.naturalWidth/Height; devSize только как последний фолбэк для CSS-layout до первого кадра.

### ZAN-4. `avc: { format: 'annexb' }` в configure — плацебо — MAJOR
`src/deviceScreen.ts:430`

Члена `avc` в `VideoDecoderConfig` не существует (W3C IDL: `AvcDecoderConfig` определён только для `VideoEncoderConfig`). WebIDL молча игнорирует незнакомые ключи — код «работает» исключительно потому, что `description` опущен, а это и есть переключатель Annex-B (см. «Подтверждено»). Мёртвый конфиг, который **выглядит** как управляющий — хуже отсутствующего: следующий читатель решит, что режим выбирается здесь.

**Фикс:** удалить `avc: {...}` из configure, оставить комментарий: «description отсутствует ⇒ вход Annex B (W3C AVC registration §3)».

### ZAN-5. Гонка двойного image-лупа — MAJOR
`src/deviceScreen.ts:159-163`

Сценарий: видео упало → `fallbackToImages` → но `video-error` может прийти **асинхронно позже** (от in-flight `video-chunk` после того, как фолбэк уже случился из другой точки, или от повторной ошибки декодера) → повторный вход в `fallbackToImages`. Предохранитель `!this.timer` — классический check-then-act: во время `await captureScreen` внутри тика `this.timer` ещё `undefined` → второй вход возможен → два параллельных тик-лупа (двойная нагрузка adb, дёрганая картинка, разбор через stop).

**Фикс:** первая строка тик-цикла и fallbackToImages: `if (this.mode === 'image' && this.imageGen === myGen) return;` — поколение-счётчик на image-луп (по образцу уже сделанного videoGen).

### ZAN-6. Дроп чанков при перегрузке ломает референс-цепь — MAJOR
webview `feedChunk` (~deviceScreen.ts:436)

`decodeQueueSize > 60` → дроп **не-ключевых** чанков. Дропнутый P-кадр разрывает reference chain: все последующие P до следующего IDR недекодируемы → декодер кидает ошибку → перманентный уход в картинки. «Защита от отставания» превращается в «гарантированный отвал видео при лаге».

**Фикс:** при перегрузке — `decoder.reset()` и скип до следующего ключевого чанка (ключевость уже помечена на стороне TS). Либо queue-size-хинт демуксеру, но reset+skip — минимум.

### ZAN-8. Граница AU: любая VCL после VCL — многослайсные кадры режутся — MAJOR (условный)
`src/deviceScreen.ts:205-225` (парсер)

Текущее правило: встретил VCL NAL после VCL NAL → режь access unit. Спека (W3C AVC registration §2): один chunk = один access unit. Кадр из нескольких slice (зависит от энкодера/девайса, для screenrecord не гарантирован монослайс) будет порезан на частичные AU → decode error. На конкретном эмуляторе может не стрелять годами — потому «условный», но это протокольное нарушение, а не стиль.

**Фикс:** резать AU только по `first_mb_in_slice == 0` следующего слайса (поле есть в slice header; парсеры SPS/PPS уже есть — добавить slice-header-заглядывание).

---

## Миноры

### ZAN-7. spawn без windowsHide — MINOR
`src/deviceScreen.ts:131` — `spawn(...)` без `windowsHide: true`; Node по умолчанию `false` → на Windows ext-host возможен мигающий чёрный лог-каждый-кадр у screencap-фолбэка. Фикс бесплатен: добавить опцию.

### ZAN-9. start() до 'ready' webview — MINOR
`onDidChangeViewState` дёргает start при первом показе до того, как webview загрузился и прислал 'ready': сообщения в незагруженный webview теряются, adb-spawn/screenrecord стартует вслепую → один холостой spawn screenrecord на каждый re-show. **Фикс:** флаг webviewReady, старт стрима только после 'ready' (рукопожатие уже есть — им и воспользоваться).

### ZAN-10. Нет CSP + интерполяция переводов внутрь JS-строки — MINOR
webview без nonce-CSP (VS Code пишет warning, `src/vs/workbench/api/common/extHostWebview.ts:234`); `${t(...)}` внутри JS-контекста (`MODE_TITLES`, ~:373) — перевод с кавычкой ломает скрипт. **Фикс:** nonce-CSP + передавать переводы через data-атрибуты/`acquireVsCodeApi`-message, не интерполяцией.

### ZAN-11. Мусор в рабочем дереве — MINOR
Неотслеживаемый `extensions/aura-kotlin/package-lock.json` (артефакт установки @types/node) — не упомянут в DONE. Убрать или закоммитить осознанно.

---

## Подтверждено (проверено по коду и первоисточникам)

- **Annex-B NAL-парсер корректен.** 3- и 4-байтовые start-коды, EPB-safe (нигде не трогает payload), pending-реасемблинг между чанками, разрез AU по следующему слайсу, префикс-AU из SPS/PPS перед IDR, мусорный лимит 16 МБ (:224). Отдельно: Annex-B **без** `description` — легальный, спекой и Chrome поддерживаемый режим (W3C §3: нет description ⇒ annexb; §4: ключевой Annex-B чанк = IDR + все parameter sets — и парсер именно так их пакует). Ответ на вопрос «работает ли WebCodecs+Annex-B в реальной жизни»: **да** — но не благодаря `avc.format` (ZAN-4), а благодаря отсутствию description.
- **Кодек-строка из SPS.** Байты 1-3 SPS = profile/constraints/level, формат avc1.PPCCLL — по RFC 6381 §3.4. Корректно.
- **180-секундный рестарт.** AOSP screenrecord.cpp: `kMaxTimeLimitSec = 180` — лимит реальный; цепочка exit→600 мс→startVideo статически корректна; свежий декодер через `lastCodec=''`→video-config→resetDecoder. Шов ~1-2 с заморозки — приемлемо.
- **exec-out → сырой h264 в stdout** — валидный путь (screenrecord.cpp:764-776), без pty-обвязки.
- **screencap-фолбэк** — 16 мс/3 с интервалы, без временных файлов, реальный effective 2-5 fps; как фолбэк — добротно.
- **Пауза при скрытии** — stop() убивает процесс и таймеры; `retainContextWhenHidden: false` + пересоздание webview; рукопожатие 'ready' перевзводит стрим. Цикл замкнут.
- **Гонка старта видео закрыта** (videoGen: проверка поколения после `await screenSize` :119-120; exit-handler под `this.video !== child`). Заявленная в DONE гонка действительно устранена — но см. ZAN-5: аналогичная дыра осталась в image-ветке.
- **Pinch-zoom в adb не гадит:** во время жеста `down=null`, ничего не шлётся; при равномерном scale маппинг тапа через (clientX - rect.left) * deviceW / rect.width остаётся точным и в зуме. Порог 12·(deviceW/rect.width) учитывает zoom — ок.
- **CSS-рамка телефона** — на месте (в src; в билд не попала — ZAN-1).
- **tsc --noEmit: 0 ошибок** — воспроизвёл, exit 0.
- **node --check webview-скрипта** — SYNTAX_OK (после подстановки интерполяций).
- **inputTap/inputSwipe Math.round** — android.ts:476-481, атомарные целые в `input tap/swipe`. Ок.

## Заявлено, но не подтвердилось

- **AURA-008 «поворот работает»** — посылка `wm size`-свапа осей опровергнута AOSP-исходниками (ZAN-2).
- **«avc1-описание из SPS валидно для configure»** — из SPS собирается только **codec string** (avc1.PPCCLL), avcC-блоб не строится и не передаётся. Для Annex-B он и не нужен — но формулировка в DONE вводит в заблуждение, будто configure получает описание. Уточнить формулировку; технической поломки нет.
- **«Эмулятор переведён на живой поток»** — не в собранном артефакте (ZAN-1). Переведён исходник.
- **«screenrecord завершается при повороте»** — ложь по AOSP-исходнику: screenrecord не выходит при смене ориентации. Комментарий в deviceScreen.ts:24 и :148 неверен; рестарт при повороте — ручной, ваш собственный. Комментарий убрать/переписать.

## Источники

- W3C WebCodecs AVC codec registration (§2: chunk = access unit; §3: no description ⇒ annexb; §4: annexb key chunk = IDR + parameter sets) — w3c.github.io/webcodecs/avc_codec_registration/
- MDN `VideoDecoder.configure` (SecureContext; в `VideoDecoderConfig` члена `avc` нет)
- webcodecsfundamentals.org/datasets/codec-support-table/ — поддержка AVC-декодера ~97.85% (для common codec strings ~99.8%)
- AOSP: screenrecord.cpp (kMaxTimeLimitSec=180; stdout h264 764-776); WindowManagerShellCommand.java:101, 201-205; DisplayContent.java updateDisplayAndOrientation
- Node.js docs: child_process `windowsHide` (default false)
- Репо: src/main.ts:96-100 — схема vscode-webview зарегистрирована `secure: true` (webview = secure context, WebCodecs доступен); extHostWebview.ts:234 — warning за webview без CSP

## Метод

Статическая верификация: чтение src целиком, diff против HEAD, `git status`; tsc --noEmit (exit 0); извлечение inline webview-скрипта → `node --check`; декодирование AOSP-исходников (screenrecord.cpp, WMS, DisplayContent) для проверки adb-посылок; сопоставление каждого пункта DONE с кодом построчно. Живого девайса нет — требование «статически доказуемо» применено ко всем пунктам; критерий «наверное работает» не принимался.

**Итог: REQUEST_CHANGES.** Минимум к следующей итерации: эмит билда (ZAN-1) и честный механизм осей при повороте (ZAN-2). Остальное — по списку, мейджоры до ACCEPT обязательны.
