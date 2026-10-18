# ZAN-zan-a2-n8n: ревью DONE-a2-n8n-low (n8n-panel LOW-хвост)

**Вердикт: REQUEST_CHANGES** — п.1–3, 5, 6 из §5 ZAN-b2 подтверждены независимым прогоном (27/27 ассертов, 0 unhandled rejection), но п.4 «софт-миграция» — мёртвый код в реальном VS Code: заявление DONE «старый читается, когда новый не задан» воспроизводится только в стабе, где незаданный ключ = undefined. Это враньё в evidence (непредумышленное: стаб промоделировал рантайм неверно), лечится одним маленьким диффом.

**Дата:** 2026-10-18 · **Ревьюер:** Зан · **Основа:** DONE-a2-n8n-low.md против ZAN-b2.md §5 п.1–6; код extensions/n8n-panel; механизмы VS Code — по исходникам этого же репо (первоисточник).

---

## 1. Независимый прогон (не вера билдеру)

Харнес: `C:\Users\Wiks\AppData\Local\Temp\opencode\zan-a2-verify.cjs` (Module._load-стаб `vscode`, живой http-сервер, vm-исполнение webview-скрипта из HTML, сгенерированного их же extension.js — код не переписывался, исполнялся их). **27/27 PASS.**

| Проверка | Результат |
|---|---|
| `node --check extension.js` | OK |
| JSON ×4 (package, nls ×2, l10n) | все парсятся |
| %ключи% манифеста | 9 = nls 9 = nls.ru 9, 1:1 |
| `vscode.l10n.t` ключи | 12 call-сайтов → 10 уникальных = bundle 10, 1:1 |
| git | `?? extensions/n8n-panel/`, product.json не тронут — как заявлено |
| unhandledRejection после всех путей (живой/мёртвый/битый URL) | 0 |

## 2. По пунктам §5 ZAN-b2

**п.1 (LOW, токен) — ПОДТВЕРЖДЁН.** extension.js:296 `crypto.randomBytes(16).toString('hex')` (в HTML — 32 hex-символа), :108 вшивка через `jsonForScript`, :162 `msg.token === RENDER_TOKEN`, :301 `{type:'load', url, token}`. Живьём: форджери без токена → `frame.src` не менялся; с чужим токеном → отброшено; с верным → принят. Reconnect-петля целиком: webview → extension (:297–:304) → postMessage c тем же токеном → frame.src = свежий URL. Токен нечитаем для iframe (webview-origin уникален, SOP), `event.source`-альтернативу из ZAN-b2 заменил токен — допустимо. «Per-render» = per-panel (HTML рендерится один раз на панель, :305) — синхронно с :296, консистентно.

**п.2 (LOW, sync-throw) — ПОДТВЕРЖДЁН.** try :38 / catch :50–53: URL с внутренним пробелом (`exa mple.invalid`) → синхронный throw `http.get` → `resolve(false)` → warning, не reject; харнес бы упал на `await openTab()`, если бы реджектилось. getUrl:19 трим, :20–22 автодополнение `https://` голому хосту (`localhost:5678/` → `https://localhost:5678`), `http(s)://` не трогает. Живой сервер → true без warning, мёртвый → false c warning.

**п.3 (LOW, экранирование) — ПОДТВЕРЖДЁН.** jsonForScript :67–69, применён :107 (tab STR), :108 (токен), :214 (launcher STR). Живьём: l10n-значение `</script><b>INJECT` → в обоих HTML ровно 1 закрывающий `</script>` (настоящий тег), payload присутствует только как `\u003c/script>\u003cb>`. Вырыва из скрипт-контекста нет.

**п.4 (NIT, один префикс + миграция) — РАСКОДОДАН.** Префикс: package.json:37–41 `n8nPanel.allowSelfSigned` (default false), старого `n8n.*` в манифесте нет — сделано. Миграция — **нет**: цепочка рантайма: package.json:39 default false → configurationModels.ts:1124–1125 (`parse(data.defaults)`) → :1024 (`_defaultConfiguration.merge(application, user, workspace, memory)`) → extHostConfiguration.ts:169, :194–198 (`lookUp(config, key)`; undefined → только тогда defaultValue). В реальном VS Code `getConfiguration('n8nPanel').get('allowSelfSigned')` у юзера, не задавшего новый ключ, возвращает **false** (манифест-дефолт), `typeof val === 'boolean'` (:29) всегда true → фолбэк :32 **недостижим**. Матрица (живой прогон): стаб-семантика билдера (unset = undefined) → фолбэк работает; реальная семантика (unset = default false) + старый `n8n.allowSelfSigned: true` в settings.json → `rejectUnauthorized=true`, старый ключ молча проигнорирован. Последствие: юзеры старого ключа тихо теряют opt-in при апгрейде (падение в безопасную сторону — verify, статус станет красным на self-signed сервере; вкладка не страдает). Impact LOW, но заявление DONE «старый читается, когда новый не задан» — **враньё в evidence**: проверялось стабом, который возвращает undefined там, где рантайм возвращает манифест-дефолт.

**п.5 (NIT, reveal) — ПОДТВЕРЖДЁН.** :284 `currentPanel.reveal()` без аргументов — живьём: повторный openTab → 0 аргументов в reveal, панель не размножается, после dispose создаётся заново. vscode.d.ts:10149 — точен: реальный путь `src/vscode-dts/vscode.d.ts`, `@param viewColumn … Shows in the current WebviewPanel.viewColumn if undefined` (:10149), сигнатура :10152. `reveal(vscode.ViewColumn` в файле не осталось.

**п.6 (NIT, описание) — ПОДТВЕРЖДЁН.** package.nls.json:6 / package.nls.ru.json:6 — «only … status check» / «только при проверке статуса» + «Does not affect loading … (iframe)» / «На загрузку вкладки n8n (iframe) не влияет».

File:line-валюта в DONE-a2 на этот раз чистая — все ссылки сверены, дрейфа из ZAN-b2 §5.9 нет.

## 3. tsc

- **extensions/n8n-panel:** TS-кода нет, ни в один compile-юнит не входит. Независимый `tsc --noEmit` (allowJs+checkJs, `src/vscode-dts/vscode.d.ts` + @types/node репо): **0 ошибок, exit 0.**
- **Корень (`tsconfig.json`):** include только `src/vs/workbench/contrib/auraApi/**` (зона параллельного билдера), exit 2, 4540 ошибок — транзитивно притянутый base-код (конфиг без `lib`/DOM при target ES2020), **ни одной строки про n8n**. Сигнала по этой задаче ноль, зафиксировано как требовалось.

## 4. Новые проблемы (мои, не из ZAN-b2)

1. **LOW — регистр схемы разъезжается.** getUrl:20 `/^https?:\/\//i` (case-insensitive), но checkStatus:39 `url.startsWith('https')` (case-sensitive). Юзерский `HTTPS://host` не префиксуется и уходит в http-клиент: Node кидает синхронно `Protocol "https:" not supported. Expected "http:"` (воспроизведено) → try/catch глотает → статус offline при живом сервере, вкладка при этом грузится. Фикс: lowercase схемы в getUrl или клиент по `new URL(url).protocol`.
2. **INFO — трим хвостовых `/` ест и слэш пути.** `https://host/n8n/` → `https://host/n8n` — для subpath-инсталляций iframe попадает на редирект. Почти безвредно, но настройка тихо меняет смысл.
3. **INFO — асимметрия токена.** Launcher-канал `status` (:227–234) без токена. Не эксплойт: в лаунчере нет iframe (CSP `default-src 'none'` режет фреймы), чужое окно в webview не попадает. На заметку, если в лаунчер когда-нибудь добавят фрейм.

## 5. Зона и инфра

Только `extensions/n8n-panel/` (untracked) + docs/swarm. product.json, build/, src/ — следов n8n нет (grep чист). M-файлы aura-*/langgraph/src — параллельные билдеры, этой задачей не тронуты. Инфра-заявка DONE подтверждена: db-tools/findings.py и aggg2-скилла в этом билде нет — находки остаются только в ревью-файлах.

## 6. Блокер (что чинить)

1. §5.4: сделать миграцию живой. Вариант: `inspect('allowSelfSigned')` и смотреть `globalValue ?? workspaceValue ?? workspaceFolderValue` — юзером не задан → читать старый `n8n.allowSelfSigned`; иначе новое значение. Ровно семантика, заявленная в DONE.
2. DONE-a2-n8n-low.md: строку «старый читается, когда новый не задан» переписать под реальность или удалить после фикса.
3. (Не блокер, вместе с п.1.) Регистр схемы из §4.1 — тем же диффом, одна строка.

## 7. Резюме

Пять из шести пунктов закрыты и выдержали независимое воспроизведение целиком, включая полный postMessage-цикл. Шестой (миграция) заявлен как проверенный, а проверен только против неправильной модели рантайма: в реальном VS Code фолбэк мёртв. Плюс один свежий LOW по регистру схемы. Оба фикса — микро-диффы, вердикт перевернётся без второго круга допроса.
