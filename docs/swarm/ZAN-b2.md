# ZAN-b2: ревью заявки DONE-b2 (n8n-panel)

**Вердикт: ACCEPT** — с хвостом из 3 LOW на следующий проход. Блокеров нет, вранья нет, оба спорных решения билдера подтверждены исходниками сборки.

**Дата:** 2026-10-18 · **Ревьюер:** Зан · **Основа:** docs/swarm/DONE-b2.md против кода; механизмы VS Code проверены по исходникам этого же репо (для форка это первоисточник, не доки).

---

## 1. Git-состояние

- `git status --short -- extensions/n8n-panel product.json` → только `?? extensions/n8n-panel/`. **product.json не тронут.**
- Untracked (8 файлов): `package.json`, `extension.js`, `package.nls.json`, `package.nls.ru.json`, `l10n/bundle.l10n.ru.json`, `media/icon.svg`, `media/n8n-icon.png`, `README.md`.
- Диффа «до/после» не существует: папка целиком untracked, коммитов нет (по ТЗ). Заявления «было 20с / unsafe-inline / rejectUnauthorized:false» сверяемы только с REVIEW-AURA.md — принято, git-базлайна нет.
- Посторонние правки (ORCHESTRATOR.md, aura-team-server/*) не затронуты.

## 2. Независимый прогон (не вера билдеру)

| Проверка | Результат |
|---|---|
| `node --check extension.js` | OK |
| JSON × 4 (package, nls × 2, l10n) | все парсятся |
| PNG структура | сигнатура ✓, CRC всех чанков ✓, IHDR 128×128/8-bit/RGBA(6) ✓, IDAT inflate = 65664 байт = ровно 128×(1+512) ✓, IEND последний ✓ — валидный PNG, глубже заявленного «IHDR проверен» |
| %ключи% манифеста | 9 = nls 9 = nls.ru 9, потерь/лишних нет |
| `vscode.l10n.t` ключи | runtime 10 = bundle 10, 1:1 |
| CSP | script-src `'nonce-…'` без `unsafe-inline` в обоих webview; inline `onclick` отсутствует |
| Поведение | `http.get('host-без-схемы')` бросает синхронно `Invalid URL` → см. §5 п.2 |

## 3. Подтверждённые пункты DONE (по коду)

**AURA-001** — package.json:6 (publisher `aura`), :8 (icon `media/n8n-icon.png`), :9-12 (galleryBanner #ff6d5a/dark), :13-16 (repository, заглушка aura-ide/n8n-panel), :20 (Visualization+Other), :21 (keywords). PNG структурно валиден (§2). Оговорка: галерейные поля дают эффект только при реальной публикации; внутри IDE иконка проявится в списке Built-in. Билдер это раскрыл в «НЕ проверено» — честно.

**AURA-002** — контейнер package.json:54-62: id `n8nPanel` проходит рантайм-паттерн `/^[a-z0-9_-]+$/i` (viewsExtensionPoint.ts:357), title/icon обязательны и есть (:361-368). Views :63-71: рантайм требует только `id`+`name` (viewsExtensionPoint.ts:585+), `type: "webview"` валиден (:553-562), иконка на view опциональна с фолбэком на иконку контейнера (:489-492, :522) — references-view у Microsoft тоже без view-иконки, для built-in это норма, НЕ ошибка. Лаунчер extension.js:155-246: статус-точка ok/bad (:207-214), кнопки → postMessage → `executeCommand` openTab/openExternal (:197-204, :232-238). Активация `onView:n8nPanel.launcher` срабатывает (webviewViewPane.ts:208 `activateByEvent('onView:…')`). Отсутствие сервера n8n ничего не ломает: checkStatus резолвится false (extension.js:40), точка красная; openTab при недоступности рисует error-screen с reconnect — штатная деградация.

**AURA-003** — cspNonce extension.js:45-47 (`crypto.randomBytes(16)` = 128 бит), CSP в :61 (tab) и :165 (launcher), nonce в meta :66/:176 и в script :87/:192, генерится заново на каждый вызов tabHtml/launcherHtml (:55, :156). Обработчики — только addEventListener, программно подтверждено.

**AURA-004** — extension.js:32-34 `rejectUnauthorized = !isSelfSignedAllowed()`, дефолт false (:23-25) → verify. package.json:37-41. Совет NODE_EXTRA_CA_CERTS — package.nls.json:6.

**AURA-005** — :7 `LOAD_TIMEOUT_MS = 10000`; прогресс-бар + посекундный отсчёт (:114-122); кнопка Reconnect (:136-139) → postMessage → handler (:275-282) читает свежий URL из настроек → `{type:'load', url}` → `frame.src = msg.url` (:140-147) — перезагрузка iframe подтверждена.

**AURA-006** — singleton+reveal extension.js:263-266, `onDidDispose` → `currentPanel = undefined` (:274). Размножение панелей исключено, пересоздание после закрытия работает.

**AURA-007/l10n** — манифест: 9 %ключей% ↔ оба nls-файла 1:1; рантайм: 10 ключей ↔ bundle 1:1. Механизмы реальны: `package.nls.<locale>.json` читает extensionsScannerService.ts:908-930 (findMessageBundles, фолбэк-цепочка локалей); `l10n/bundle.l10n.<locale>.json` — штатный механизм ext host с 1.73. Оговорки — §5 п.7.

## 4. Спорные решения билдера — проверены по исходникам

**product.json не тронут — аргументация ВЕРНА.**
- build/lib/builtInExtensions.ts:96-119 (`getExtensionDownloadStream`): записи из product.json builtInExtensions только скачиваются (vsix → GitHub platformSpecific → marketplace при наличии `extensionsGallery.serviceUrl` → GitHub). Локальную папку оттуда не берут.
- build/lib/extensions.ts:433: `.filter(({name}) => builtInExtensions.every(b => b.name !== name))` — имя в builtInExtensions **исключает** локальную папку из локального бандла.
- В product.json этого форка `extensionsGallery.serviceUrl` присутствует → добавление unpublished n8n-panel в builtInExtensions = попытка скачать с маркета = падение сборки. Вывод билдера подтверждён по трём точкам.
- Автобандлинг: extensions.ts:424 (glob `extensions/*/package.json`); n8n-panel нет ни в `excludedExtensions` (:322-330), ни в `nativeExtensions` (:317-321) → попадает в сборку как обычное локальное расширение. Решение правильное.

**retainContextWhenHidden: true оставлен — аргументация защитима.**
- Утечка AURA-006 была в размножении retained webview — закрыта singleton + onDidDispose (:263-266, :274): память ограничена одной панелью.
- `retainContextWhenHidden: false` уничтожал бы webview при переключении вкладок редактора → iframe перезагружается → несохранённое состояние n8n-canvas теряется. Реальный UX-регресс ради экономии памяти одной панели. Решение принимаю.

## 5. Проблемы (чинить в следующем проходе)

1. **LOW** — extension.js:140-147 — `window.addEventListener('message')` в tabHtml принимает `{type:'load', url}` от любого источника. Кросс-origin iframe (скомпрометированный n8n — ровно угроз-модель AURA-003) может postMessage'ом навигировать iframe на произвольный http(s) URL без действия юзера. Смягчает: CSP `frame-src https: http:` режет javascript:/data:; вред — подмена содержимого iframe, которым вредоносная страница и так владеет. Но канал расширению не нужен. Чинить: per-render токен — вшить случайный токен в STR, extension шлёт его в `{type:'load', token}`, webview сверяет; либо отбрасывать сообщения с `event.source === frame.contentWindow`.
2. **LOW** — extension.js:29-41 + :224-231 + :284 — checkStatus не защищён от синхронного throw. URL без схемы (юзер вписал `localhost:5678` или голый IP) → `http.get` бросает `Invalid URL` (проверено прогоном) → Promise reject → unhandled rejection в render(): лаунчер виснет на «Проверяю…»; команда openTab завершается ошибкой (панель при этом уже создана и живёт). Чинить: try/catch внутри executor и/или scheme-валидация в getUrl() с автодополнением https://.
3. **LOW** — extension.js:89, :194 — `JSON.stringify(strings)` внутри `<script>` не экранирует `<`. Строка перевода с `</script>` выйдет из скрипт-контекста и обгонит nonce-CSP. Сейчас ключи чистые, но l10n-файл — данные, не код. Чинить: `.replace(/</g, '\\u003c')` после stringify.
4. **NIT** — package.json:32 vs :37 — настройки в двух префиксах: `n8nPanel.url` и `n8n.allowSelfSigned`. Один extension — один префикс.
5. **NIT** — extension.js:264 — `reveal(ViewColumn.One)` тащит вкладку в первую колонку, даже если юзер перенёс её во вторую. Убрать аргумент.
6. **NIT** — `n8n.allowSelfSigned` влияет только на Node-проверку статуса (extension.js:33); iframe в Chromium валидирует сертификат независимо — с self-signed вкладка не загрузится при любой галке. Описание в nls честно scoped, но юзера галка введёт в заблуждение. Дописать: «на загрузку вкладки не влияет».
7. **INFO** — локализация манифеста: extensionsScannerService.ts:925-927 — при `nlsConfiguration.devMode` (запуск IDE из исходников) всегда package.nls.json (EN). ru-манифест работает только в собранном билде и при ru display language. Не баг, но проверять руками надо на билде, не на dev-запуске — иначе увидишь EN и сделаешь ложный вывод.
8. **INFO** — CSP защищает родительский документ webview, а исходная угроза AURA-003 («URL n8n скомпрометирован») живёт в iframe — там её сдерживает same-origin policy, не этот CSP. Nonce — реальное усиление родителя (инлайн-скрипт без nonce не исполнится), но уровень фактической защиты ниже формулировки ревью-заявки. `style-src 'unsafe-inline'` — норма для webview, JS через CSS не исполнить.
9. **NIT** — в DONE строки-цитаты дрейфуют: AURA-003 «extension.js:44-52,58» — CSP реально в :61 и :165 (:58 — l10n-строка, не CSP); AURA-002 «54-70» — views до :71; «277-283» — это :275-282. Суть везде на месте, но file:line в DONE-файле обязаны быть точными — это валюта, по которой роя проверяют друг друга.

## 6. Заявлено, но не подтвердилось

- Фактических расхождений нет: все пункты AURA-001…006 + l10n подтверждены кодом, product.json-аргументация — исходниками сборки.
- Невоспроизводимо (temp-файлы удалены билдером): harness «ALL PASSED», `gen-n8n-icon.cjs`. Ключевые ассерты harness'а (CSP/nonce/нет onclick/TIMEOUT=10000/rejectUnauthorized по умолчанию) воспроизведены независимо в §2 — совпали. Дальше temp-харнессы в DONE не ссылать: удалённый артефакт — не evidence.
- Заявлено и честно раскрыто билдером как непроверенное: вид в маркете/галерее (нужна публикация), живой iframe против реального n8n (X-Frame-Options — конфиг сервера), визуальный вид PNG. Оценка: маркет-поля до реальной `vsce publish` мертвы; иконка в списке Built-in внутри IDE появится.

## 7. Резюме

Заявка честная: каждый пункт нашёлся в коде и делает заявленное, спорные решения аргументированы правильно. Долг на следующий проход — §5 п.1-3 (postMessage-токен, try/catch в checkStatus, экранирование `<` в JSON.stringify). Это три маленьких диффа, не блокер.
