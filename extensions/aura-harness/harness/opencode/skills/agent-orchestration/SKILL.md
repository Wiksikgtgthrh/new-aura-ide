---
name: agent-orchestration
description: >-
  Координация нескольких агентов на одной задаче: разбиение через planner,
  очередь задач в orchestrator.mjs с ролями, зависимостями, арендой и бюджетом,
  изоляция параллельной работы в git worktree, handoff между ролями. Включать
  для нетривиальных задач, /fleet и любой работы, где больше одного агента.
---

# Agent Orchestration

Главный агент держит решение. Субагенты делают узкие куски и сдают handoff, а не транскрипт.

## Роли

| Роль | Пишет код | Где определена |
|---|---|---|
| explorer | нет | `~/.pi/agent/agents/explorer.md`, `~/.config/opencode/agents/explorer.md` |
| planner | нет | `planner.md` |
| builder | да, только в своём worktree | `builder.md` |
| reviewer | нет | `reviewer.md` (в Pi перекрывает встроенный reviewer) |
| qa | нет | `qa.md`, нужен Playwright MCP |
| release | нет, деплой только после approval | `release.md` |

Права ролей заданы в самих файлах агентов: allowlist `tools` в Pi и `permission` в OpenCode. Это настоящее ограничение, а не просьба в промпте.

## Цикл

```bash
H="$HOME/.agent-harness/tools"
node "$H/orchestrator.mjs" init --max-tasks 20 --max-attempts 3 --timeout 30
node "$H/orchestrator.mjs" add --title "API /health + тест" --role builder --risk write
node "$H/orchestrator.mjs" add --title "Ревью /health" --role reviewer --risk read --deps T-0001
node "$H/worktree.mjs" create health-endpoint
# builder внутри .agent-worktrees/health-endpoint:
node "$H/orchestrator.mjs" claim --agent builder-1 --role builder
node "$H/orchestrator.mjs" finish --id T-0001 --agent builder-1 --evidence .agent-state/artifacts/gates-latest.json
node "$H/orchestrator.mjs" status
```

## Правила

- Одна задача, один владелец. `claim` атомарный (file lock), двое одну задачу не возьмут.
- Аренда: `timeout` минут. Долгая работа шлёт `heartbeat`. Истёкшую аренду `reclaim` или следующий `claim` возвращает в очередь как timeout.
- `sensitive`/`destructive` стартуют в `awaiting_approval`. `approve --by <человек>` делает только человек (в OpenCode эта команда спрашивает подтверждение).
- Параллельно не больше 3 builder. Каждый в своём `worktree.mjs create <slug>`.
- REQUEST_CHANGES от reviewer: не больше 2 кругов, потом эскалация человеку.
- Мерж веток `agent/*` в основную ветку решает человек. Агенты сливают только в integration-worktree (ниже).
- Builder коммитит в своём worktree до `finish`; грязный worktree не интегрируется.
- `worktree.mjs create <slug> --link-deps` ставит symlink на корневой `node_modules`, чтобы gates в worktree работали без install.

## Integration-шаг (обязателен при 2+ builder)

Каждая ветка по отдельности зелёная — это ещё ничего не значит. Конфликты роя видны только после слияния.

```bash
node "$H/worktree.mjs" integrate header-nav pricing-section faq-block
# новый worktree agent/integration-<ts>, merge --no-ff по порядку,
# стоп на первом конфликте (merge --abort, список файлов), затем gates.mjs внутри
```

- Exit 0 = passed, 2 = unverified, 1 = failed или conflict. Отчёт: `.agent-state/artifacts/integration-latest.json`.
- Конфликт: задача уходит обратно builder с файлами конфликта (`note --next "rebase on agent/integration-…"`).
- Изменились lock-файл или `package.json`: deps не линкуются, нужен install с approval.
- Для UI после integrate запусти `qa` на integration-worktree. Visual-gate ловит, как builder A сломал страницу builder B.

## Фронтенд-рой

1. Главный агент: `design-map.mjs`, путь к `.agent-state/design-map.md` в задачу explorer/planner и в каждый builder-handoff.
2. planner: меняются токены/шрифты/примитивы → это **первая** задача «design-tokens», все UI-задачи идут с `--deps` на неё.
3. planner режет по роутам/секциям, а не по слоям («header» + «pricing», а не «все стили» + «вся разметка»). Два builder не трогают один файл.
4. Каждая новая страница = строка в `e2e/routes.ts` в той же задаче.
5. reviewer: `design-map.mjs --compare` (drift не растёт), `frontend-stack`, `a11y-audit`.
6. integrate → qa на integration-worktree → финал.

## Handoff (до 40 строк)

1. Что сделано и где (файлы).
2. Evidence: пути к артефактам.
3. Что не проверено и почему.
4. Следующее действие (`note --next "..."`).

## Финальный отчёт

Таблица из `orchestrator.mjs status`: id, роль, статус, verified/UNVERIFIED, evidence. Вердикт отдельно.
