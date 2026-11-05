---
description: Провести задачу через полный контур агентов (explorer → planner → builder → reviewer → integrate → qa)
---
Задача: $ARGUMENTS

Загрузи скилл `agent-orchestration` и действуй по нему. Коротко:

0. UI в задаче: `node "$HOME/.agent-harness/tools/design-map.mjs"` и сохрани снимок `cp .agent-state/design-map.json .agent-state/design-map.before.json`.
1. Делегируй `explorer`: карта кода и способ проверки (передай путь к design-map).
2. Делегируй `planner`: подзадачи с role, risk, deps. Меняются токены/примитивы → первая задача «design-tokens», остальные UI-задачи с `--deps` на неё. Режь по роутам/секциям, два builder не трогают один файл.
3. Заведи их: `node "$HOME/.agent-harness/tools/orchestrator.mjs" add --title "..." --role builder --risk write --deps T-0001`.
   Задачи с risk sensitive/destructive ждут `approve` от человека. Сам не одобряй.
4. Для каждой независимой builder-задачи: `node "$HOME/.agent-harness/tools/worktree.mjs" create <task-slug> --link-deps` и запусти `builder` в этом каталоге. Параллельно, но не больше 3 одновременно.
5. После каждой сдачи запусти `reviewer` на `worktree.mjs diff <slug>` (+ `design-map.mjs --compare .agent-state/design-map.before.json` в worktree). REQUEST_CHANGES возвращает задачу builder (не больше 2 кругов).
6. 2+ builder: `node "$HOME/.agent-harness/tools/worktree.mjs" integrate <slug1> <slug2> ...`. Конфликт — задача обратно builder с файлами.
7. Для UI запусти `qa` на integration-worktree (не на отдельных ветках).
8. Финал: таблица задач из `orchestrator.mjs status`, verdict integrate и gates, evidence, что unverified, и какую ветку мержить. Мерж в основную ветку делает человек.
