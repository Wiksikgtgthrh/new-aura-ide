# DONE-b2: n8n-panel — маркет + IDE (builder)

**Дата:** 2026-10-18 · **Ветка:** без коммитов (по ТЗ) · **Файлы:** `extensions/n8n-panel/{package.json, extension.js, package.nls.json, package.nls.ru.json, l10n/bundle.l10n.ru.json, media/n8n-icon.png}`

## По ID

- **AURA-001** (маркет): `package.json:6-21` — publisher `aura`, `icon`, `galleryBanner #ff6d5a/dark`, `repository` (заглушка aura-ide/n8n-panel), `categories [Visualization, Other]`, `keywords`. Иконка `media/n8n-icon.png` 128×128 RGBA сгенерирована node-скриптом (temp `gen-n8n-icon.cjs`, мотив = ромб узлов из `media/icon.svg`); IHDR проверен программно.
- **AURA-002** (activity bar): `package.json:54-70` — viewsContainers.activitybar (иконка `media/icon.svg`) + webview-view `n8nPanel.launcher`; `extension.js:156-243` — лаунчер: URL, живой статус (точка ok/bad), кнопки → `n8nPanel.openTab`/`openExternal` (команды сохранены).
- **AURA-003** (CSP): `extension.js:44-52,58` — `script-src 'nonce-<random16B>'`, `'unsafe-inline'` убран, inline `onclick` заменён на `addEventListener`; nonce свежий на каждый рендер (оба webview).
- **AURA-004** (TLS): `rejectUnauthorized:false` убран; `extension.js:33` — дефолт verify, opt-in через настройку `n8n.allowSelfSigned` (default false, `package.json:37-41`); в описании настройки — совет про NODE_EXTRA_CA_CERTS.
- **AURA-005** (reconnect): `extension.js:7` — таймаут 10с (было 20), прогресс-бар + обратный отсчёт секунд; кнопка «Переподключиться» → postMessage → расширение перечитывает URL из настроек → `{type:'load',url}` → iframe перезагружается (`extension.js:105-117, 277-283`).
- **AURA-006** (утечка): singleton-панель + `reveal()` при повторном вызове (`extension.js:263-266`), `onDidDispose` чистит ссылку (`:274`). `retainContextWhenHidden:true` оставлен сознательно: у n8n-canvas несохранённое состояние, пересоздание iframe при смене вкладки его теряет; утечкой было размножение панелей — закрыто.
- **AURA-007/l10n** (из ТЗ п.7): манифест на `%ключи%` + `package.nls.json/.ru.json` (9 ключей); рантайм — `vscode.l10n.t` (EN-source) + `l10n/bundle.l10n.ru.json` (10 ключей). Миграция на TS (AURA-028) НЕ делалась — по ТЗ.
- **product.json**: НЕ тронут. `builtInExtensions` — только скачиваемые из галереи пакеты (build/lib/builtInExtensions.ts:97-117), а имя там **исключает** локальную папку из сборки (build/lib/extensions.ts:433). Неопубликованный n8n-panel → build попытался бы качать его из маркета и упал. Папка `extensions/n8n-panel` бандлится автоматически (glob `extensions/*/package.json`).

## Проверено

- `node --check extension.js` — OK; все 4 JSON парсятся; PNG: сигнатура + IHDR 128×128 RGBA.
- Харнес (temp `n8n-harness.cjs`, стабы vscode/https): CSP без unsafe-inline + nonce совпадает в meta и script; нет `onclick`; TIMEOUT=10000; `rejectUnauthorized` true по умолчанию / false при `allowSelfSigned`; reveal вместо новой панели; после dispose — новая; reconnect возвращает свежий URL; лаунчер зарегистрирован, CSP чистый; nonce уникальны между рендерами. **ALL PASSED**.
- Ключи l10n сверены скриптом: runtime 10/10, manifest 9/9, без потерь/лишних.

## НЕ проверено

- Отображение в маркете/галерее Aura IDE — нужна сборка IDE (icon/galleryBanner видны только там).
- Живой iframe против реального n8n (X-Frame-Options — конфиг самого n8n).
- Визуальный вид PNG в просмотрщике (браузер-сессия недоступна; геометрия 1:1 с принятой icon.svg).
- `vsce package` (генерация `__metadata`) — не запускался, нет в ТЗ.
