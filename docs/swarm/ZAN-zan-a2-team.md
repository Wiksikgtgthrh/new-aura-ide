# REQUEST_CHANGES

**Ревью:** zan-a2-team — DONE-a2-team.md против кода · Предмет: пункты REVIEW-AURA AURA-018..027, 032, 033 + kanban/invite UX
**Дата:** 2026-10-18 · **Ревьюер:** Зан · **Зона:** `extensions/aura-team`, `extensions/aura-orca`, `extensions/langgraph-orchestrator`
**Итог:** все 14 функциональных пунктов в коде подтверждены построчно, все ключевые цифры DONE воспроизведены моими прогонами. Но один evidence-заяв в DONE — ложный: «поведение [invite regen] покрыто существующими invite-тестами» — покрытие есть у **чужого** кодового пути (сайдбар), который билдер не трогал, а изменённый модал-путь тестами не покрыт вообще. Плюс «16 новых EN» — фактически 15. Код рабочий, док врёт о проверке — чинится одной строкой DONE или дешёвым тестом.

---

## Гейты (мои живые прогоны, не из DONE)

| Проверка | Результат |
|---|---|
| `node test/run-all.mjs` (aura-team) | **ALL 18 STEPS PASSED, exit 0** = tsc-сборка в `out/` + 17 тест-файлов. Цифра DONE воспроизведена ✓ |
| `node test/manifest.test.mjs` отдельно | 13/13 ok, exit 0: ключи (58), мёртвых нет (58), RU покрывает EN без дыр ✓ |
| `npx tsc --noEmit -p tsconfig.json` (aura-team) | **не исполняется**: `MODULE_NOT_FOUND … extensions/node_modules/typescript/bin/tsc` — грабля окружения, у билдера та же (a2-team.log:131-194). `npx` из extensions/* резолвит typescript в несуществующий `extensions/node_modules` |
| `node <корень>/node_modules/typescript/lib/tsc.js --noEmit` | **aura-team exit 0 · aura-orca exit 0 · langgraph-orchestrator exit 0** (TS 6.0.3) — все три затронутых расширения чисты ✓ |
| tsc по корню (src/vs) | **не гнал осознанно**: корень в рабочем дереве перепахан параллельными билдерами (auraMarket, aggg, auraApi, titlebar…), результат был бы шумом чужих зон. Зона a2-team ядро не трогала |
| Ключи nls | EN=58, RU=58, RU⊆EN и EN⊆RU — без дыр ✓ |
| Манифест | литералов `"title|description|displayName|category": "…"` — 0; `%category.team%` × 37; `"minimum": 60` на package.json:70 ✓ |

---

## Пункты построчно

### AURA-018 — done ✓ (с оговоркой по счётчику)
`package.nls.ru.json` — 58 ключей, ровно как в DONE; манифест полностью на `%ключах%` (мой grep литералов пуст); `manifest.test.mjs:68-71` резолвит `%category.team%` через EN-карту — тест зелёный, категория всех 37 команд = «Team». RU покрывает EN 1:1 — проверено скриптом (missing: [], extra: []).
**Оговорка:** DONE заявляет «16 новых EN» в package.nls.json:45-60. По `git diff` новых ключей **15** (`inviteOpen`, `syncNow`, `toggleAutoPush`, `category.team`, `customEditor.displayName` + 10 `configuration.*`); 16-я строка диффа — тронутый `command.getState` (перенос запятой). Мелочь, но счётчик врановый.

### AURA-019 — already done ✓ (честно)
`langgraph-orchestrator/src/extension.ts:70` — `context.subscriptions.push(statusBar)`. `git diff HEAD` по этому файлу пуст: фиксу место в коммитах, билдер не приписал себе чужое. REVIEW-AURA по этому пункту устарел.

### AURA-021 — already done ✓ (честно)
`aura-orca/src/extension.ts:457, 472` — оба `installedCache.delete(…)`. В диффе HEAD этих строк нет — были до билдера.

### AURA-022 — done ✓
`orca:149` — `context.subscriptions.push(listener)` в startInteractive. Dispose идемпотентен: listener гасится по event (145) или таймауту 3с (150), повторный dispose из subscriptions — no-op. Заявка точная.

### AURA-023 — done ✓, номера строк съехали
`orca:62-67` — `tempDirs` Set + `cleanupTempDirs` (rmSync recursive/force, ошибки глушатся) + disposable. Cleanup перед новым снапшотом — фактически **301-304** (DONE: «288-291», минус 13 строк — взято до правок). `panel.onDidDispose` с cleanup — фактически **370** (DONE: «~360», помечено тильдой, терпимо). Семантика заявленная — на месте.

### AURA-024 — done ✓
`aura-team/src/extension.ts:47-54` — pid-файл `.aura-team-server.pid` в `globalStorageUri` (не в репо ✓), kill stale по signal-0 проверке; `78-83` — pid пишется только после успешного probe; `88` — kill недостартовавшего child. Всё в uncommitted-диффе — атрибуция a2-team подтверждена.

### AURA-025 — done ✓
`220` — `GIT_CACHE_TTL_MS = 10_000`; `229-240` — `gitSnapshot()`; `222-228` — WeakSet + `repo.state.onDidChange` → сброс кэша; `264` — `git: await gitSnapshot()`. «Ошибочные снапшоты не кэшируются» — правда: catch-ветка возвращает undefined, не записывая кэш. Семантика сохранена.

### AURA-026 — done ✓, off-by-one
`334-363` — агрегатор: первый тост сразу, окно 5с (`TOAST_WINDOW_MS` 337), `{0} (+{1} more)` через `l10n.t` (351), backlog ≤ 10 + overflow (338, 361), таймер в subscriptions (363). Вызовы: **376** — точно; **387** (DONE: «388»). Единственная содержательная дыра формата: flush не выводит хвост backlog в лог/канал — только один тост; для low-sev пункта достаточно.

### AURA-027 — done ✓
`package.json:70` — `"minimum": 60`; `teamSync.ts:63` — `Math.max(60, …)` с комментарием про согласованность с манифестом. Точь-в-точь.

### AURA-032 — done ✓
`orca:181-186` — `setInterval(30_000)`, dim-строка `… ♥ running for {0}s, output {1} KB` + log; `clearInterval` в error (197) и close (205). Без изменения протокола — правда. «В живом терминале не гонял» — заявлено честно.

### AURA-033 — done ✓
`tools/index.ts:573-581` — poll `auraOrca.getState` каждые 20с, матч по точному title (title задаётся самим оркестратором, совпадение гарантировано), `logInfo` аптайм/объём; `592` — clearInterval в finally (582-593 try/finally). `.then(ok, err)` двухаргументный на 575-580 — Thenable-совместимо, история с `.catch`/TS2339 в логе билдера (1855) закрыта корректно.

### kanban scroll — done ✓, но «jsdom-тесты зелёные» — слабее, чем звучит
`template.html:1810-1833` — `mount()`: снапшот `body.scrollTop` + `.board.scrollLeft` + `.column-body[data-status].scrollTop`, рестор только при `lastMountedRoute === route` (смена раздела — скролл с нуля). Код корректен. **Но:** тесты этот код не трогают — grep по `test/` даёт только jsdom-заглушки `scrollIntoView` (kanban.render.test.mjs:32); `lastMountedRoute`/`scrollTop` в тестах не упоминаются. «Зелёные» = «не сломаны», не «покрыты». Вживую не гонялось — заявлено.

### kanban deleteArchive — done ✓
`template.html:3323-3331` — клик `[data-del-archive]` через существующий `confirmAction` (существование подтверждено: git.render.test.mjs:115 режет исходник по `function confirmAction` — функция доисторическая). «Колонок-удаления нет: 4 фиксированных статуса» — правда (`['todo','doing','review','done']`, extension.ts:531). Тестами не покрыто (grep пуст).

### invite regen — done по коду ✓, **evidence — ложное**
`template.html:1677-1694` — revoke→createInvite одним кликом; `{cancelled}` обрабатывается честно (extension.ts:812-816 возвращает `{ok:false, cancelled:true}` при отмене подтверждения — webview на отмене не трогает ничего); гварды: revoke 1684, send 1713, gen 1666-1674 (DONE «1708-1722» покрывает только send-гард, gen живёт раньше).
**Ложь в evidence:** «Поведение покрыто существующими invite-тестами». invite.sidebar.test.mjs гоняет **сайдбар**-путь: `inviteRevokeBtn` → `extension.ts:2087` → `revokeInvite()` — код, который a2-team **не менял**. Изменённый модал-путь (`wireInviteActions` / `[data-revoke-invite]` / `[data-gen-invite]`) в тестах не упоминается ни разу (grep по test/ пуст). Тесты зелёные, потому что проверяют другое. Это и есть враньё, названное своим именем.

---

## Враньё и неточности в evidence (сводка)

| # | Заявка DONE | Факт | Тяжесть |
|---|---|---|---|
| 1 | «Поведение [invite regen] покрыто существующими invite-тестами» | Тесты покрывают сайдбар-путь, который не менялся; модал-путь — нулевое покрытие | **блокер для ACCEPT** — ложное evidence |
| 2 | «16 новых EN» | 15 новых ключей + 1 тронутая строка (getState/запятая) | мелочь |
| 3 | «вызовы 376, 388» (AURA-026) | 376 и **387** | мелочь |
| 4 | «288-291» (AURA-023) | фактически **301-304** | мелочь, строки до правок |

Цифры по существу — 18/18, 58 ключей, tsc 3×0, 37 команд — воспроизведены точно. Враньё локальное, в двух заявлениях о покрытии/счётчике, но #1 — это именно тот класс, который рой обязан ловить: непроверенный код, упакованный как проверенный.

## Новые проблемы

1. **Нулевое тестовое покрытие трёх новых UX-поведений** — скролл-рестор канбана, deleteArchive-подтверждение, модал regen инвайта. Код по чтению корректен, но единственная защита от регресса — следующая правка руками. Дешёвый jsdom-тест на `wireInviteActions` (инфраструктура в invite.sidebar.test.mjs уже умеет и модалки, и `answer()`-моки) закрыл бы все три.
2. **Runtime-строки новых фич — EN-only.** Ни `aura-team`, ни `aura-orca` не имеют `l10n/`-бандла (проверено ls): `'{0} (+{1} more)'`, `'running for {0}s, output {1} KB'` в RU-IDE покажутся английскими. Это продолжение известного пробела из REVIEW (л10n runtime), не регрессия — но каждая новая строка его расширяет.
3. **AURA-033 метрика объёма врёт в логе:** `auraOrca.getState` → `serializeSession` отдаёт `tail(session.output, 6000)` (orca:324) — «output X KB» в heartbeat оркестратора упирается в ~5 КБ, реальный буфер до 200 КБ. Косметика лога, статус/аптайм честные.
4. Наблюдение: heartbeat-интервал orca живёт до `close/error` child; если pty закрыли, а child не умер (kill не сработал), тикает в никуда. Теоретический хвост, close после kill стреляет штатно. Не требую правки.

## Зона / параллельные билдеры

`git diff HEAD` по зоне: все правки, заявленные DONE, в диффе и соответствуют логу a2-team — атрибуция чистая. В тех же файлах лежат **более ранние несмёрженные следы чужой работы**, которых в логе a2-team нет: `randomUUID`-импорт, `ELECTRON_RUN_AS_NODE`, `subscriptions.push(api)` (extension.ts), а также модификации `client.ts`, `service.ts`, `workflow.ts`, `panelProvider.ts`, `sidebar-syntax.test.mjs`, `package-lock.json` (aura-team), `aura-orca/package.json`, `host.ts`, `panel/template.html` (orchestrator). Ни одна претензия DONE на них не опирается — зоны не перепутаны. `aura-team/tmp-regions.txt` (24.09) и `patch-kanban.py` (05.10) — мусор до роя, не билдера; вычищать отдельной задачей. aura-kotlin/b1, n8n-panel/b2, `src/vs/*` — вне предмета, не смотрел.

## Минимум к следующей итерации

1. **DONE: убрать/заменить ложное «покрыто invite-тестами»** — либо честное «не покрыто тестами, проверено чтением кода», либо (лучше) добавить jsdom-тест на `wireInviteActions` с моками `{cancelled:true}` и revoke→create цепочкой + disabled-гардами.
2. DONE: «16 новых EN» → «15», «388» → «387», «288-291» → «301-304». Косметика, но счётчики должны биться.
3. (желательно) тест на скролл-рестор `mount()` — три строки jsdom: выставить scrollTop, перерисовать, прочитать.

Без пункта 1 не принимать: исправный код, упакованный в док с ложным покрытием, — следующий билдер скопирует паттерн «заявил тесты, которых нет».

## Метод

Построчное чтение `aura-team/src/extension.ts`, `aura-orca/src/extension.ts`, `langgraph-orchestrator/src/extension.ts` (зона 019), `tools/index.ts` (033), `template.html` (1810-1833, 1677-1719, 3323-3331), `teamSync.ts`, `package.json`/`nls.json`/`nls.ru.json`, `manifest.test.mjs` против каждого пункта DONE; живые прогоны: `run-all.mjs` (18/18, exit 0), `manifest.test.mjs` (13 ok), tsc noEmit ×3 (exit 0, TS 6.0.3, `npx`-грабля зафиксирована), подсчёт ключей скриптом (58/58, покрытие 1:1), `git diff HEAD` по зоне для атрибуции каждой hunks-группы (в т.ч. доказательство «already done» по 019/021 пустым диффом), grep-аудит тестового покрытия новых поведений (scroll/modal-invite/deleteArchive — пусто), проверка существования l10n-бандлов (нет), mtime-датировка мусора в зоне (не билдера). Сверка каждого номера строки из DONE с фактическим.

**Итог: REQUEST_CHANGES.** Код по всем 14 пунктам в порядке и подтверждён живыми прогонами; блокирует единственное ложное evidence-заявление о тестовом покрытии invite-regen и счётчик «16». Минимальный фикс — строка в DONE плюс дешёвый тест; после него — ACCEPT без повторного полного прогона.
