# DONE a2-team-fix — доработка по ZAN-zan-a2-team.md (REQUEST_CHANGES)

**Дата:** 2026-10-18 · **Зона:** `extensions/aura-team` (тесты + док). Кодовая база не менялась — только тесты и DONE.
**Прогон (реальный, после правок):** `node test/run-all.mjs` → `=== tsc (сборка out/) ===` + 18 тест-файлов (вкл. `invite.modal.test.mjs`, `kanban.render.test.mjs`) → **ALL 19 STEPS PASSED, exit 0**. Отдельно: `node test/invite.modal.test.mjs` → 22/22 ok, exit 0; `node test/kanban.render.test.mjs` → ALL CHECKS PASSED (вкл. 5 новых), exit 0. aura-orca/langgraph-orchestrator не тронуты — их tsc-чистота из ревью Зана в силе.

| Пункт «минимум к ACCEPT» | Статус | Доказательство |
|---|---|---|
| 1. Ложное «покрыто invite-тестами» | закрыт (тестом, не удалением заявки) | Новый `test/invite.modal.test.mjs` гоняет именно изменённый модал-путь `wireInviteActions` (template.html:1677-1694): revoke→create цепочка одним кликом, `{cancelled:true}` не трогает код/модалку, даблклик-гарды на revoke/gen (disabled, один invoke), copy-кнопка. 22 проверки зелёные. DONE-a2-team.md: заявка заменена на «Покрыто test/invite.modal.test.mjs…», сайдбар-путь честно отнесён к invite.sidebar.test.mjs. |
| 2. «16 новых EN» → 15 | закрыт | DONE исправлен; сверено по `git diff`: 15 новых ключей + тронутая строка `command.getState` (есть в HEAD). |
| 3. «376, 388» → 376, 387 (AURA-026) | закрыт | DONE исправлен; `extension.ts:387` — `notifyToast('🔔 {0}: {1}'…)` подтверждён чтением. |
| 4. «288-291» → 301-304 (AURA-023) | закрыт | DONE исправлен + `~360` → `370`; `extension.ts:301-304` (`cleanupTempDirs()` перед снапшотом) и `:370` (`onDidDispose`) подтверждены чтением. |
| 5. (желательно) тест на скролл-рестор mount() | закрыт | `kanban.render.test.mjs` секция 15: scrollLeft `.board`=55 и scrollTop колонки=77 восстановлены на **новых** узлах после innerHTML-перерисовки; гвард через `lastMountedRoute==='teams'` после ухода с доски. 5 проверок зелёные. |

**Побочная правка:** шапка DONE — «ALL 18 STEPS» → «ALL 19 STEPS» (новый тест-файл автоподхвачен run-all.mjs).
**Не трогал:** код расширений (правки не требовались), чужие несмёрженные следы в зоне, мусор `tmp-regions.txt`/`patch-kanban.py` (отдельной задачей по ревью).
**Осталось за кадром (не блокеры из ревью):** runtime-строки EN-only (#2), обрезанная метрика output KB в heartbeat (#3) — зафиксированы Заном как косметика/известный пробел, не входили в «минимум».
Коммитов нет — изменения в рабочем дереве.
