# DONE-a2: n8n-panel LOW-хвост (Зан-b2 §5, п.1–6)

**Результат:** все 6 пунктов сделаны, не коммичено (git: `?? extensions/n8n-panel/`). `node --check extension.js` OK; JSON ×4 парсятся; 9 %ключей% ↔ nls ↔ nls.ru 1:1; l10n 10 ключей цел. Дата: 2026-10-18.

1. §5.1 токен — extension.js:296 `crypto.randomBytes(16)` per-render, вшивка в HTML :108, сверка в слушателе :162 (`msg.token === RENDER_TOKEN`), своё сообщение с токеном :301. Проверка: forgery без токена → отброс, с токеном → accept; сигнатура `tabHtml(url, renderToken)` :72.
2. §5.2 checkStatus — try/catch в executor extension.js:50 (синхронный throw → `resolve(false)`, не unhandled rejection); getUrl :18-23 автодополняет `https://` голому хосту/IP, `http(s)://` не трогает, трим хвостовых `/`. Проверка: mock-throw `Invalid URL` резолвится false.
3. §5.3 экранирование — helper extension.js:67-69 `jsonForScript` = stringify + `.replace(/</g,'\\u003c')`; применён в tab :107, launcher :214, токен :108. Проверка: l10n-значение `</script><b>` — в обоих HTML нет сырого `</script>`, есть `\u003c`.
4. §5.4 один префикс — package.json:37 `n8nPanel.allowSelfSigned`; софт-миграция: extension.js:34 (`inspect('allowSelfSigned')`, scope-значения workspaceFolder→workspace→global) — старый `n8n.allowSelfSigned` (:40) читается, только когда новый **не задан юзером ни в одном scope**; в рантайме VS Code `get()` на незаданном ключе возвращает манифест-дефолт false, поэтому фолбэк по `get()` был мёртв (ZAN-zan-a2 §6.1 — исправлено). Проверка: realistic-стаб (get=манифест-дефолт, inspect=scope) — новый приоритетен / старый читается при unset / дефолт false.
5. §5.5 reveal — extension.js:284 `currentPanel.reveal()` без аргументов. Проверка: первоисточник форка vscode.d.ts:10149 — `undefined` = текущая viewColumn; вхождений `reveal(vscode.ViewColumn` в файле не осталось.
6. §5.6 описание — package.nls.json:6 и package.nls.ru.json:6: скоуп «только проверка статуса» + «на загрузку вкладки (iframe) не влияет». Проверка: grep обоих файлов.

**НЕ проверено:** живой n8n и рендер настроек в UI (нужен запуск IDE); в dev-режиме манифест-nls всегда EN (Зан §5 п.7) — renamed-ключ глазами не сверян.
**Инфра:** aggg2-канон-скилл и db-tools/findings.py в этом билде отсутствуют (glob пуст) — находки зафиксированы только здесь.
