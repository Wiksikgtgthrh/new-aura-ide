# DONE-a2-n8n-fix: закрытие ZAN-zan-a2 §6 (REQUEST_CHANGES → фикс)

**Результат:** все 3 блока §6 закрыты, не коммичено (git: по-прежнему `?? extensions/n8n-panel/`; тронуты только extension.js + этот файл + DONE-a2-n8n-low.md:8). Дата 2026-10-18.

| §6 | Пункт | Статус | Доказательство (extension.js, номера после правки) |
|---|---|---|---|
| 1 | Миграция мертва (get-фолбэк) | **закрыт** | :33–:41 `isSelfSignedAllowed` через `inspect('allowSelfSigned')` (:34): userVal = `workspaceFolderValue ?? workspaceValue ?? globalValue` (:36) — boolean → он (:37–:38), иначе старый `n8n.allowSelfSigned` (:40). Мёртвого `get()`-фолбэка нет. |
| 2 | Враньё-строка в DONE-a2-n8n-low | **закрыт** | :8 переписана: «старый читается, только когда новый не задан юзером ни в одном scope» + честная отсылка к §6.1. |
| 3 | Регистр схемы (§4.1) | **закрыт** | :25 `getUrl` нормализует схему в нижний регистр; `checkStatus` :47/:49 (не менялся) теперь всегда видит lowercase → правильный клиент. |
| — | §4.2 трим `/`, §4.3 токен launcher | не блокер, не трогал | Зан: «на заметку», §6 их не требовал. |

**Проверки (реальный прогон):**
1. `node .../a2-n8n-fix-verify.cjs` (стаб 'vscode' c реальной семантикой: `get()`=манифест-дефолт, `inspect()`=scope-значения; живой **self-signed HTTPS-сервер** (openssl CN=127.0.0.1) + http-сервер; vm-прогон их webview-скрипта; регрессия фаз Зана 1–4): **`==== 30/30 PASS ====`**, `unhandledRejection=0, uncaughtException=0`. Ключевые: `PASS B1 БЛОКЕР§6.1+§6.3: unset-новый + старый n8n.allowSelfSigned=true + «HTTPS://» → живой self-signed сервер онлайн`; `PASS C1 … новый unset ни в одном scope + старый true → allow (rejectUnauthorized=false)`; `PASS C0 контроль бага: старая логика на realistic-семантике игнорирует старый ключ (dead code подтверждён)`; C2–C6 матрица приоритетов (global unset=false дефолт безопасен; явный новый бьёт старый; folder>workspace>global); B3 «нигде не задано → offline (verify)»; D1–D6 токен/экранирование/reveal — регрессии нет. Первая серия была 29/30 — FAIL D6, баг харнесса (забыл dispose перед фазой reveal, в оригинале Зана он есть), после починки харнесса — 30/30; код не менялся.
2. `node node_modules/typescript/lib/tsc.js -p …/tsconfig.zan-a2-n8n.json` (allowJs+checkJs, src/vscode-dts/vscode.d.ts + @types/node, конфиг Зана §3): **пустой вывод, `tsc exit: 0`** (0 ошибок).
3. Статика внутри харнесса: `node --check extension.js` OK; JSON ×4; %ключи% 9↔9↔9; l10n 10↔10 — PASS (файлы манифеста не правились, сверено на всякий).

**Верифицировано против реального API:** vscode.d.ts:6865–6890 `inspect<T>` → `globalValue?/workspaceValue?/workspaceFolderValue?` — scope-поля есть только когда юзер задал; приоритет folder>workspace>global = семантика эффективного значения (порядок `??` у Зана был перечислением, не приоритетом — semantics «unset→старый» сохранён ровно).

**Инфра:** aggg2-канон-скилл/db-tools в этом билде нет (загрузка скилла = ошибка) — находки здесь и в ZAN-файле; ничего не коммичено.
