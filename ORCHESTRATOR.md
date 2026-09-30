# ORCHESTRATOR.md — LangGraph Оркестратор в Aura IDE

Расширение `extensions/langgraph-orchestrator` — мультиагентный оркестратор
с тир-маршрутизацией ключей. Пользовательская документация — в README
расширения; здесь — заметки для разработчиков форка.

## Состав

| Путь | Назначение |
|---|---|
| `src/extension.ts` | активация, команды, статус-бар |
| `src/host.ts` | OrchestratorHost: связывает реестр/роутер/инструменты/сайдкар/панель, аппрувы, чекпоинты |
| `src/keys/registry.ts` | KeyRegistry: ключи из `auraApi.exportKeysList` + `auraTeam.getState`, тиры, статусы, cooldown |
| `src/llm/routerProxy.ts` | тир-роутер поверх `vscode.lm` (vendor `auraApi`), перебор кандидатов |
| `src/tools/index.ts` | инструменты агентов: fs.readFile/listFiles/search/writeFile, terminal.run, diagnostics.get |
| `src/sidecar/rpcClient.ts`, `processManager.ts` | JSON-RPC клиент + жизненный цикл сайдкара (watchdog, рестарт ≤3/5мин) |
| `src/panel/*` | вкладка Custom Editor (`auraOrchestrator.panel`), ru/en |
| `src/util/throttle.ts` | троттлинг отправки состояния в панель (ведущее ребро + хвост) |
| `sidecar/src/*` | Node-сайдкар: LangGraph.js StateGraph (планировщик → router → worker → reducer → verify → join), LlmClient (HTTP-прокси/RPC/mock), агентный цикл, Gate, FileSaver |
| `build/compile-sidecar.mjs` | esbuild-бандл сайдкара → `dist/sidecar.cjs` |
| `test/sidecar.test.mjs` | юнит-тесты (parseDecision, эскалация, Gate, RPC, полный mock-цикл) |
| `test/panel-contract.test.mjs` | контракты: `invoke()` панели ↔ ветки `host.ts`, оркестратор ↔ публичный API Team |
| `test/throttle.test.mjs` | троттлинг состояния: ведущее ребро, схлопывание пачки, отмена по dispose |

## Протокол stdio JSON-RPC

- расширение → сайдкар: `{kind:'cmd', id, method: start|pause|resume|cancel|status, params}` → `{kind:'res', id, ok, result|error}`
- сайдкар → расширение: `{kind:'req', id, method: chat.complete|tool.invoke, params{…, requestId}}` → `{kind:'res', id, …}`; стрим токенов — `{kind:'evt', id: requestId, event:'token', data}`
- нотификации сайдкара: `{kind:'ntf', method: graph.event|checkpoint|log, params}`

## Решения, которые надо знать перед правками

- **Секреты не покидают ядро.** LLM-вызов сайдкара — всегда RPC в расширение,
  дальше `vscode.lm`. Не добавлять путей, где сайдкар получает ключи напрямую.
- **Тиры живут в KeyRegistry**, роли привязаны к тирам в `sidecar/src/llm.js`
  (`ROLE_TIERS`). Меняя одно — проверь другое.
- **Эскалация тира** — в `LlmClient.complete` (sidecar/src/llm.js): low→mid→high
  до `escalationThreshold` включительно. Фейловер внутри тира — в RouterProxy.
- **Лимит раундов супервизора** форсит finish в `parseDecision` ДО разбора
  плана (иначе граф может делегировать бесконечно) — покрыто тестом.
- **Планировщик валидирует JSON-схему.** Невалидный ответ — ровно один ретрай
  (`plannerRetryPrompt`), потом `fallbackDecision` (coder-узел без результатов
  или finish с объяснением). Форма плана — `nodes[{id, goal, deps[], tier, kind,
  files_hint[]}]`; старые `delegates` ещё принимаются (id/kind достраиваются,
  `dependsOn`-индексы резолвятся в id).
- **Сборка**: расширение — gulp `compile-extension:langgraph-orchestrator`;
  сайдкар — отдельно, `node build/compile-sidecar.mjs`. После правок
  `sidecar/src/*` бандл пересобирать обязательно.
- **Verify-нода (evaluator-optimizer)**: ретраит узлы со статусом `failed`
  (результат кладёт reducer, а не воркер); с `verifyCommand` — реальный прогон
  через `tool.invoke('terminal.run')` (метка nodeId `verify`), вывод летит в
  ретрай-инструкцию воркера. Ошибка команды проверки граф не роняет.
- **Язык интерфейса — русский по умолчанию.** `langgraphOrchestrator.uiLanguage`
  (`ru` | `en` | `auto`); хост разрешает `auto` по `vscode.env.language`
  (`src/util/language.ts`) и отдаёт панели и сайдкару **готовое** значение — webview
  не гадает по `navigator.language`, иначе язык интерфейса и язык заметок агентов
  могут разойтись. Словари панели — `DICTS.ru` / `DICTS.en` в `template.html`,
  наборы ключей обязаны совпадать (проверяется тестом), а значение, совпавшее
  в ru и en, тест считает забытым переводом (в белом списке — только тиры,
  `auto` и подпись diff; имена вкладок из него убраны и переведены). Тиры
  остаются машинными обозначениями (LOW/MID/HIGH) в бейджах и колонках, а в
  сводке «Модели по тирам» рядом живут русские названия (`tierNames`) — иначе
  строка читалась как английский текст.
- **Подписи `<select>` нельзя создавать один раз.** Первый рендер панели идёт до
  снапшота, когда язык ещё неизвестен и берётся язык браузера (у англоязычной IDE
  — английский), а опции пересоздавать нельзя: слетит выбранное значение. Поэтому
  `fillSelect()` создаёт опции один раз и переставляет подписи на каждом рендере —
  иначе в фильтре навсегда оставалось «All sources».
- **Числа и слова.** После числа слово склоняется `plural(count, t.*Forms)`:
  «1 токен / 2 токена / 5 токенов», «1 живой / 2 живых», «1 файл / 3 файла»,
  «1 спан / 5 спанов», «1 ретрай / 2 ретрая».
- **Чекпоинты**: FileSaver (`sidecar/src/fileSaver.js`) наследует MemorySaver
  и персистит storage/writes в JSON (`checkpointFile` из хоста;
  `.aura/orchestrator/checkpoints/graph-store.json`). Thread_id живёт в
  снапшоте (`resumeState.threadId`) — resume той же задачи продолжает поток.

## Ядро графа (Этап 3)

Сайдкар — **JavaScript/LangGraph.js**, не Python: это зафиксированное решение,
не долг (см. `@langchain/langgraph` 0.2.x в `sidecar/package.json`).

**State** (`OrchestratorState` в `sidecar/src/graph.js`): `task`, `round`,
`plan` (DAG), `results`, `raw`, `budget`, `errors`, `summary`, `queue`,
`batch`, `itemState`, `attempts`.

- `plan` — `nodes[{id, goal, deps[], tier, kind, files_hint[]}]`; `kind` задаёт
  агента (`code→coder`, `test→tester`, `review→reviewer`, `security→security-auditor`).
  `search`/`boilerplate` принудительно на `low` (`tierForNode`).
- `results` — `node_id → {status, summary (≤5 строк), diff_stat, commit, tokens, cost}`.
  Пишет их **только reducer** — воркер кладёт сырой ответ в `raw`.
- `raw` — транзитный, merge-clear канал: reducer стирает его (ссылка `null`
  удаляет ключ), поэтому к финишу в state остаются резюме и ссылки, а не логи.
  Сырой текст ограничен (`RAW_MAX_CHARS`) и в чекпоинте живёт один суперстеп.
- `budget` — суммарные токены (стоимость — 0: прайсинга моделей у нас нет).
- `errors` — `[{node, message}]`, короткие сообщения, не логи.

**Ноды**: `planner` (supervisor, tier high) → `router` (fan-out через
`langgraph.types.Send`, лимит воркеров, не более одного `confirm` в пачке) →
`worker` → `reducer` → `verify` → `join` → снова `router` либо планировщик.
`join` — явная точка решения: очередь исчерпана → к планировщику (merge/finish),
иначе → `router`.

**Checkpointer**: `FileSaver` (наследник `MemorySaver`), файл в
`globalStorage`/`.aura`, `thread_id` = id запуска. `AsyncSqliteSaver` в JS-пакете
`langgraph-checkpoint-*` отсутствует (доступен только `MemorySaver`) — FileSaver
даёт ту же персистентность (переживает рестарт сайдкара).

**Команды из IDE**: `pause`, `resume`, `cancel`, `cancelNode`, `history`
(`getStateHistory`), `rewind` (`checkpoint_id`), `patchState` (`update_state`,
он же «edit»), затем продолжение с этого чекпоинта.

**git-ссылки**: reducer зовёт `collectDiff` хоста (`git diff --stat`,
`git rev-parse --short HEAD`) с дедлайном `GIT_PROBE_TIMEOUT_MS` — без extension
host (дымовой тест) ответа нет, граф не ждёт. Коммит принимается только в
hex-виде, иначе это текст отказа.

## Изоляция, самолечение, предохранители (Этап 4)

**Worktree на узел.** Каждый пишущий узел работает в своём рабочем дереве
`.aura/worktrees/<run>/<node>` на ветке `aura/<run>/nodes/<node>` от `baseCommit`
запуска (снимается хостом при старте). Основное дерево воркеры не трогают.
Путь/ветку считает сайдкар (`sidecar/src/worktrees.js`), а git исполняет
расширение через `execFile` (`src/git/gitClient.ts`) — не shell-строку, ключей
не видит. Read-only узлы (`search`/`review`/`security`) не изолируются. Нет git
или `workspaceRoot` — изоляция молча выключается, воркер работает в корне.
Результат узла коммитится на его ветке (`git.commitWorktree`), ссылки `branch`,
`commit`, `diff_stat` уходят в `results`. Ветки запуска и узлов — **соседи**
(`aura/<run>/run` и `aura/<run>/nodes/<node>`), а не родитель/ребёнок: git не даёт
ref быть одновременно и папкой, и листом — это поймал интеграционный тест на
настоящем репозитории (`test/git-integration.test.mjs`).

**Самолечение.** Настройка `langgraphOrchestrator.checks` (по умолчанию
`npm run lint` / `npx tsc --noEmit` / `npm test`) гоняется в worktree узла после
правки. При падении воркер получает **только первые 40 строк** ошибок и имена
упавших тестов (`sidecar/src/checks.js`). Жёсткий лимит
`langgraphOrchestrator.maxFixIterations` (3): после него узел получает статус
`needs_human`, а нода `escalate` поднимает `interrupt()` с резюме ошибки.

**Merge.** Когда очередь исчерпана, `join` идёт в ноду `merge`: run-дерево
`.aura/worktrees/<run>/__run` на ветке `aura/<run>/run`, в него по очереди вливаются
ветки узлов. Конфликт **не резолвится моделью**: merge узла откатывается, файлы
уходят в state, а чистая нода `mergeGate` поднимает `interrupt` со списком
конфликтов (resume не переигрывает merge). После merge — финальный прогон
проверок.

**Предохранитель.** `sidecar/src/guardrails.js` классифицирует действия:
`git push`, `npm publish`, сеть (`curl`/`wget`/`ssh`), необратимое удаление
(`rm -rf`, `git reset --hard`), запись в `.env`/ключи/конфиги, `fs.delete`.
Перед таким вызовом граф поднимает `interrupt()`, продолжение — только
`Command({resume:{approved, note}})`. Вторая линия — расширение: запись вне
`cwd`/workspace отклоняется в `ToolExecutor`.

**Финал.** Нода `deliver` считает единый патч `base..aura/<run>/run` и шлёт
`patch.ready` (файлы + diffstat, без сырого диффа в state). В панели —
**Применить** (merge run-ветки в текущую ветку пользователя), **Отклонить**
(очистка: worktree и ветки удаляются, следов нет) и **Открыть diff**
(`_workbench.openMultiDiffEditor`; оригинал/изменённое читаются схемой
`aura-orchestrator` через `git show`, фолбэк — единый diff-документ).
`cleanup` вызывается и на отмену запуска. Каталог `.aura/` добавлен в `.gitignore`.

## Бюджет, трейсинг, кэш (Этап 5)

**Бюджет токенов и денег.** Настройка `langgraphOrchestrator.budget`:
`runTokens`/`runCost` (лимит всего запуска) и `nodeTokens`/`nodeCost` (лимит
каждого узла), 0 — без лимита; `prices` — цены по тирам, `modelPrices` —
пер-модельные переопределения по подстроке имени; неизвестная модель считается
как **high**. Учёт делает extension host: `RouterProxy` считает вход по сообщениям,
а выход — по тексту и аргументам tool-calls (`countTokens`), и приписывает
`usage {inputTokens, outputTokens, costUsd, model, tier}`; и HTTP-прокси
(`src/llm/localProxy.ts`), и RPC-фолбэк `chat.complete` отдают один и тот же
`usage`. Цены и стоимость остаются в host — сайдкар лимиты видит, таблицу цен нет.
`agents.js` копит расход и после каждого ответа модели сверяется с лимитом
**узла** (0 — без лимита): перерасход останавливает узел до следующего вызова.
Такой узел получает `needs_human` + `reason: 'budget'`, а нода `escalate`
поднимает `interrupt` с реальной цифрой. Расход запуска копится в канале
`budget` (reducer суммирует `tokens`/`cost`); чистая нода `budgetGate` после
reducer поднимает `interrupt` при превышении **запуска**, а `budgetAck`
не даёт спросить дважды. Отказ человека ставит `budgetHalt` и уводит граф в
`deliver` (конец, без дальнейших трат). В панели есть блок **Бюджет**: прогресс
к лимитам запуска (токены/$ с цветом по заполненности), расход по моделям
(модель, тир, токены, $, вызовы), командные траты по людям и кнопка
**Очистить кэш** (команда `toolCache.clear` + `toolCache.stats`). Каждый
рендер трогает статистику кэша не чаще раза в 3 с. Лимиты и цены
**редактируются прямо в панели**: форма шлёт `budget.update`, host пишет
настройку `budget` в Global (сливая с текущими значениями и санитизируя через
`normalizeBudget`), а изменения применяются к следующему запуску. Редактор
строится один раз и переиспользуется между рендерами — иначе пуш состояния
сбрасывал бы фокус и набранные значения. Рядом — **профили бюджета**:
встроенные пресеты `economy`/`normal`/`max` (`src/util/budgetProfiles.ts`)
и именованные снимки пользователя в globalState (`orchestrator.budgetProfiles`,
активный — `orchestrator.budgetActive`). «Применить» пишет бюджет профиля
в настройки и метит его активным; «Сохранить как…» снимает текущий бюджет
в профиль; «Удалить» доступно только пользовательским (встроенные не удаляются).
Ручная правка полей снимает активную метку — бюджет становится «своим».
Командные траты по людям
берутся из Team API, **только если** он отдаёт
необязательный `getUsage()` (структурная проверка как у `looksCompatible`);
иначе — пусто, и оркестратор работает как раньше.

**Трейсинг (OpenTelemetry-подобный).** Настройка `langgraphOrchestrator.trace`:
`enabled`, `file` (JSONL в `.aura/orchestrator/traces/spans.jsonl`), `maxSpans`,
опциональный `otlpEndpoint`. `sidecar/src/trace.js` держит спаны в кольцевом
буфере, опционально пишет JSONL и шлёт OTLP/JSON (`POST <endpoint>/v1/traces`,
best-effort). Спаны создают `supervisor`/`worker` (kind `node`) и каждый
LLM-вызов внутри `runAgentLoop` (kind `llm`); атрибуты — `node, tier, model,
tokens_in/out, cost, duration, retries, status`. **Никаких промптов, ответов и
ключей** в спанах нет. Спаны живут потоком (`trace.span` → host), host держит их
в памяти и считает агрегаты; вкладка **Trace** рисует водопад и «топ нод по
времени» и «по деньгам». Есть команда `trace.spans` для запроса снапшота.

**Кэш инструментов.** Настройка не нужна: `src/tools/cache.ts` — SQLite
(`node:sqlite`) в `globalStorage` расширения, таблица `tool_cache`. Ключ
`sha256(tool + каноничные args + commit_sha + worktree_dirty_hash)`: TTL не нужен,
ключ сам инвалидируется новым коммитом или грязным деревом (`git status
--porcelain`). Кэшируются read-only тулы `fs.readFile`, `fs.listFiles`,
`fs.search`/`grep`, `symbols.list`; мутирующие — никогда. Вне git (нет sha)
кэш не используется: ключ не смог бы инвалидироваться. Добавлены тулы `grep`
(алиас `fs.search`) и `symbols.list` (дешёвый статический обзор объявлений).
SQLite недоступен (старый Node) — кэш молча выключается, ошибки записи не роняют
запуск. Очистка: команда панели `toolCache.clear`.

## Веб-панель (переработка)

Одна страница `src/panel/template.html` (Custom Editor), пять вкладок:
**Запуск / Доска / Модели / Трасса / Журнал** (идентификаторы вкладок —
`run/board/models/trace/log`: они же едут в командах палитры).

- **Протокол `{type, payload}`**: webview → `{type:'invoke',
  payload:{command,args,id}}` и `{type:'ready'}`; host → `{type:'state',
  payload: PanelState}` и `{type:'response', payload:{id, ok, result|error}}`.
  `panelProvider.ts` только транслирует payload; логика команд в
  `OrchestratorHost.invoke` не менялась.
- **Один reducer в webview**: серверный снапшот лежит в `ui.server`, локальное
  UI (вкладка, задача, выбранная нода, фильтры лога) — рядом; `dispatch()`
  обновляет состояние через `reduce()`, сохраняет UI в `vscode.setState` и
  перерисовывает. Строки из снапшота вставляются только через `textContent`/
  создание узлов — `innerHTML` используется лишь для статических SVG-иконок
  (pause/continue/stop).
- **Снапшоты схлопываются по кадру** (`action.type === 'server'` в `dispatch()`):
  хост шлёт состояние на каждое событие графа, спан и строку лога, а `render()`
  перерисовывает все семь секций целиком — без этого за прогон получались сотни
  полных перерисовок вместо десятков. Побеждает последнее состояние (оно накрывает
  предыдущие), действия пользователя рисуются синхронно. В стендах без
  `requestAnimationFrame` (jsdom-заглушка панели) рендер остаётся синхронным —
  поэтому тест может проверять DOM сразу после отправки состояния.
- **Хост не шлёт состояние чаще, чем полезно**: `pushState()` идёт через
  `createThrottle` (`src/util/throttle.ts`, `STATE_PUSH_INTERVAL_MS`) — первая
  отправка после тишины мгновенная (клик по «Пауза» не ждёт), остальные в окне
  схлопываются в одну. `dispose()` отменяет отложенную отправку — иначе таймер
  дёргал бы закрытую панель. Покрыто `test/throttle.test.mjs`.
- **Run**: поле задачи + переключатель «Своя задача / С доски» (задачи
  `todo`/`doing` из Team), справочная строка «Планнер / Макс. параллель»
  (`runDefaults`), план как список-DAG с отступом по `deps`; клик по ноде —
  деталь (goal, summary, `diff_stat`, «Открыть diff» → `node.openDiff`,
  «Перезапустить» → `node.restart`); блок «Ждёт тебя» (interrupt/approvals с
  заметкой), таймлайн чекпоинтов, пустое состояние с примерами.
- **Models**: таблица `state.models` (каталог), сегмент-контрол тира пишет
  `keys.setTier`; «Used today» — вызовы/токены из `budget.perModel`. Сюда же
  переехал сворачиваемый блок бюджета (лимиты, цены, профили, командные траты,
  очистка кэша). **Доска** — компактный канбан команды: карточки с «Отдать
  агентам» и форма своей задачи (`team.createTask`), колонки — `todo/doing/
  review/done`.
  **Trace** — водопад спанов + топы. **Log** — журнал с фильтрами.
- **Структурный лог**: `PanelState.logs: LogEntry[]` (`{ts, level, node,
  message}`) рядом с плоским `log`; уровень выводится из типа события и текста
  (`eventLevel`), нода — из `event.node.id`. Фильтры уровня/ноды точные.
- **Перезапуск ноды** (`Orchestrator.restartNode`, команда `restartNode`):
  возвращает подзадачу в `queue`, стирает `results[id]` (редьюсер `results`
  понимает `null` как удаление), сбрасывает `attempts[id]` и продолжает граф
  с `router`. Только на остановленном графе (как rewind/patchState).
- **План не стирается на финале**: супервизор на `finish` больше не затирает
  `plan` пустым списком — маршрут решает новый канал `planDone`. Так DAG остаётся
  видимым после завершения, а `restartNode` находит ноду в плане.
- **Горячие клавиши и палитра**: в `package.json` — `keybindings` F6/F7/F8
  (pause/resume/cancel) с `when: activeCustomEditorId == 'auraOrchestrator.panel'
  && auraOrchestrator.running/paused`; команды `auraOrchestrator.tab.*` открывают
  панель и переключают вкладку. Путь вкладки: команда → `host.requestTab(tab)` →
  событие `onDidRequestTab` → провайдер шлёт webview `{type:'tab', payload}`.
  Если webview ещё не прислал `ready`, просьба хранится в `pendingTab` и уходит
  при первой готовности — иначе сообщение терялось бы при открытии панели.
  Сам webview ещё и ловит F6/F7/F8 в `keydown` (fallback, когда биндинг VS Code
  не сработал), сверяясь с текущим `running/paused`.
- **Подпись вкладки редактора** — это имя виртуального документа, поэтому
  `panelUri()` отдаёт путь `/Оркестратор`; менять его — значит менять подпись.
  **Строки манифеста впечатаны в `package.json` по-русски**, без `%ключей%`:
  через `package.nls` VS Code выбирает перевод по локали IDE, и при английской
  IDE палитра с настройками были английскими. `package.nls.json` /
  `package.nls.ru.json` остались словарём (ru — эталон текстов: тест сверяет
  с ним манифест и паритет ключей en/ru) — правя текст, меняй оба места.

## Мост с доской Aura Team

- **Публичный API Team** (`extensions/aura-team/src/publicApi.ts`) версионирован:
  `apiVersion === 1`. Обязательных членов шесть — `getSession`, `getBoard`,
  `updateTask`, `onDidChangeBoard`, `listApiKeys`, `createProxyToken`; набор
  обязательных менять без смены версии нельзя. Добавлять можно только новым
  **необязательным** методом (`getUsage`, `createTask`): мост проверяет наличие
  перед вызовом, поэтому старый Team и новый оркестратор совместимы в обе стороны.
- **Контракт держат тестом** (`test/panel-contract.test.mjs`), а не глазами: каждый
  `invoke()` из панели обязан иметь ветку в `host.ts`, иначе кнопка молча ничего не
  делает (вызов идёт под `.catch`, ошибка «unknown invoke» в UI не всплывает).
  Методы, которые мост зовёт на чужом объекте, обязаны быть объявлены в публичном
  API Team — либо проверены через `typeof … === 'function'` (тогда метод
  необязательный). Тот же тест сверяет `TEAM_API_VERSION` с `PUBLIC_API_VERSION`
  и то, что `activate()` Team отдаёт ровно объявленный набор.
- **Мост** (`src/team/bridge.ts`) ищет `aura.aura-team` через
  `vscode.extensions.getExtension`, активирует и проверяет `apiVersion` структурно.
  Плагина нет / версия чужая / activate упал — мост выключен, оркестратор работает
  как раньше, а вкладка Board скрыта (ключ `aura.orchestratorAvailable`).
- **Синхронизация статусов** (`src/team/sync.ts`, без vscode): старт → `doing`
  и заметка «взял в работу» в описании; готовый патч → `review`; ошибка/отмена →
  остаётся `doing` + короткое резюме. В `done` переводит только человек.
- **taskId → threadId** хранится в globalState (`orchestrator.teamTaskThread`):
  повторный клик продолжает существующий поток графа, а не создаёт второй
  (плюс защита `this.running`).
- **Автозабор** (`teamAutoGrab`): задачи из `todo` с меткой `[agent]` берутся
  по одной; `teamAutoGrabLimit` — глубина очереди.
- **Своя задача с панели** (`team.createTask` → `bridge.createTask` →
  `createTask` публичного API → `POST /v1/teams/:id/tasks`): заголовок чистит и
  режет `normalizeTaskTitle` (`TASK_TITLE_LIMIT`), колонка — только из
  `todo/doing/review/done`. Отказ приходит машинным кодом (`unavailable` /
  `rejected`), а подпись выбирает панель — иначе в английской панели была бы
  русская ошибка хоста. Создали — доска перечитывается, поле чистится только
  при успехе.

## Производительность (замерено, не на глаз)

Найдено и исправлено в паре заходов по горячим местам; у каждого числа есть
повод — иначе это были бы догадки:

- **Отправка состояния в панель**: было на каждое событие графа / спан / строку
  лога, со сборкой всего состояния и клонированием его в webview. Стало: хост
  троттлит до одной отправки в `STATE_PUSH_INTERVAL_MS`, панель схлопывает
  пришедшую пачку в один кадр.
- **Обновление состояния в Aura Team**: `doRefresh()` делал шесть
  последовательных HTTP-кругов подряд. При RTT 40 мс это 270 мс на одно
  обновление; после перевода пяти независимых чтений в один `Promise.all` —
  102 мс. Зависимость ровно одна: `teamId` из сессии. Держит
  `aura-team/test/refresh-batching.test.mjs`.
- **Сервер** (`aura-team-server/test/bench.ts` — ручной стенд замеров,
  150 участников / 3000 задач / 20k событий / 41 команда): лента команды читала
  все события ради 20 строк (10.7 → 0.55 мс, `ORDER BY created_at, id` вместо
  `id`), поиск участников сканировал всю таблицу членств сервера (индекс
  `memberships_team`), реордер колонки компилировал один и тот же UPDATE на
  каждую задачу (4.9 → 1.9 мс на 250 задач).
- **Что осталось тяжёлым осознанно**: `GET /v1/teams/:id/board` отдаёт доску
  целиком (3000 задач ≈ 0.8 МБ), и именно сериализация этого тела занимает
  основное время маршрута; кэш/ETag или постраничная загрузка — отдельная
  задача, которая меняет контракт с панелью.

## Не сделано (осознанно, следующие итерации)

- **Назначение «Orchestrator»**: сервер Team отвергает assignee вне команды,
  поэтому взятие в работу видно как статус `doing` + заметка в описании, а не
  как assignee. Заведём служебного участника — тогда строку можно убрать.
- **Ссылка на коммит/ветку** в заметке исхода: `reportCommit` не входит в
  публичный API (#1 ограничил список), поэтому в описании пока только резюме.
- Автозабор берёт не более одной задачи за раз: граф обслуживает один запуск.
- Per-key управление командным банком (нужны правки сервера).
- Per-node стрим токенов в панель (сейчас токены идут только в сайдкар).
- **Командные траты**: маршрут сервера `GET /v1/teams/:teamId/usage` есть, но
  публичный API Team (`apiVersion 1`) его не пробрасывает — Budget показывает
  командные цифры только когда в Team появится `getUsage()`. Пока — локальные
  траты оркестратора по моделям.
- **Точные токены `vscode.lm`**: вход/выход считаются через `countTokens`
  (истинного usage от провайдера нет), поэтому стоимость — оценка.
- **Продуктовые цены**: дефолтная таблица цен в настройках — placeholder,
  реальные цены пользователь заводит сам.
- OTLP-экспорт не проверен против живого коллектора (только best-effort POST).
- **Уровень строки журнала** выводится эвристикой по тексту (`eventLevel`):
  сайдкар не шлёт уровень явно, поэтому возможно редкое отнесение warn/error
  не туда. Когда в события добавится явный `level`, эвристику уберём.
- **«Перезапустить»** ноду доступно только на остановленном графе (во время
  запуска кнопка выключена): подменить вход идущей пачки LangGraph нельзя.
- **«Открыть diff»** ноды работает, когда у неё есть своя ветка (изоляция);
  для read-only kind и запусков без git кнопка выключена.
