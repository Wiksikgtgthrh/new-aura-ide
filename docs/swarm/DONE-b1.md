# DONE-b1 — эмулятор Android (aura-kotlin): живой поток, поворот, рамка, жесты

Дата: 2026-10-18. Файлы: `extensions/aura-kotlin/src/deviceScreen.ts`, `src/android.ts`, `l10n/bundle.l10n.ru.json`. Коммитов нет (по ТЗ).

## По пунктам

- **AURA-007 (fps 1.25 → живой поток)** — сделано. Основной путь: `adb exec-out screenrecord --output-format=h264 -` (битрейт 8 Мбит/с, размер ≤1920 по длинной стороне), Annex-B режется на access unit по slice-NAL, в webview декодирует **WebCodecs VideoDecoder** → canvas (~30 fps, без MSE: raw h264 не фрагментированный MP4, MSE бы не взял). deviceScreen.ts:108-156 (запуск/перезапуск каждые 180 с и после поворота), 191-255 (NAL-разбивка, avc1-кодек из SPS). Фолбэк без temp-файлов: `exec-out screencap` подряд, следующий кадр сразу после доставки (пауза 16 мс), ретрай 3 с при офлайне: 159-189. Пауза при скрытой панели: `onDidChangeViewState` → stop/start, 68-74; `retainContextWhenHidden: false`.
- **AURA-008 (viewport после поворота)** — сделано. rotate → `wm size` → `pushSize()` в webview → `layout()` пересчитывает `#stage` (data-orientation portrait/landscape, aspect-ratio, рамка) + поток перезапускается с новым `--size`. deviceScreen.ts:258-270, 396-411; android.ts:463-473 (берём **последний** match `wm size` — Override отражает поворот, не Physical).
- **AURA-010 (рамка телефона)** — сделано. Чистый CSS: корпус-градиент, скругления 42px/28px, тень, кнопки vol/pwr по кромке, камера-точка, landscape-вариант. deviceScreen.ts:327-337, 353-365.
- **AURA-029 (порог свайпа)** — сделано: `12 * (deviceWidth / rect.width)` CSS-px→device-px, под зумом тоже корректно (rect растёт пропорционально). deviceScreen.ts:531-535.
- **AURA-009 (pinch-zoom)** — сделано базово: два пальца → локальный зум картинки 1–4x (pointer events, центр — между пальцами на первом pinch), снап в 1:1 при <1.15x, сброс по даблклику. На устройство жест НЕ шлём: `adb input` multi-touch не умеет. Тапы/свайпы под зумом точны (uniform scale сохраняет пропорции rect). deviceScreen.ts:465-545.

## Баг, найденный своим ревью и закрытый

Гонка `startVideo()`: пока `await screenSize()`, hide→show панели (или `ready` пересозданного webview) вызывал `stop()+start()` — проснувшийся промис спавнил второй `screenrecord`, осиротевший процесс жёг CPU устройства до 180-с лимита. Фикс: generation-счётчик `videoGen` (инкремент в `killVideo`, проверка после await). deviceScreen.ts:49, 104, 114, 120.

## Проверка

- `tsc --noEmit` (корневой `node_modules/.bin/tsc`, в extensions/aura-kotlin): **0 ошибок** до и после правок. `npx tsc` из папки расширения битый — ищет `extensions/node_modules/typescript` (нет такого), это пред-существующее.
- Inline-скрипт webview извлечён из шаблона, `${...}`-интерполяции заменены заглушкой → `node --check`: **синтаксис OK**.
- Ревью логики NAL-разбивки, перезапуска, фолбэков, паузы — вручную по коду.

## НЕ проверено (нет живого Android-устройства/эмулятора под рукой)

- Реальный h264-поток и WebCodecs-декод в webview Aura IDE; частота кадров фолбэка screencap.
- `wm size` реально свопает оси после `user_rotation` на всех API — логика на это рассчитывает.
- Pinch на тачскрине (pointer events мышью воспроизводятся частично — один указатель).
