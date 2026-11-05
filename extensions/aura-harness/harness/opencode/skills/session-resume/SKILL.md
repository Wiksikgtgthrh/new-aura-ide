---
name: session-resume
description: >-
  Продолжение прерванной работы: восстановить картину по tasks.json,
  events.jsonl, worktree и Session-Context, вернуть зависшие задачи в очередь и
  продолжить с поля next без потери изменений. Включать для /resume, «продолжи»,
  после краша, перезапуска или смены агента.
---

# Session Resume

## 1. Собрать картину (только чтение)

```bash
H="$HOME/.agent-harness/tools"
node "$H/orchestrator.mjs" status
node "$H/orchestrator.mjs" events --tail 30
node "$H/worktree.mjs" list
git status --short && git log --oneline -5
```

Плюс последняя выжимка: `~/Session-Context/Projects/<проект>/` (скилл `session-context`).

## 2. Восстановить очередь

```bash
node "$H/orchestrator.mjs" reclaim   # running с истёкшей арендой → pending (timeout)
```

Задача running с живой арендой может принадлежать другому агенту. Не трогай её, подожди или спроси.

## 3. Проверить грязные worktree

- `worktree.mjs diff <slug>` для каждого с `dirty>0`.
- Изменения оставь. Не reset, не clean, не удаляй worktree.
- Изменения не совпадают с задачей: опиши человеку и спроси.

## 4. Продолжить

1. Скажи в 3–5 строках: где остановились, что готово (verified/UNVERIFIED), что дальше.
2. Возьми задачу: `claim --agent <имя> --role <роль>`. Начни с её поля `next` и последней `note`.
3. Gates в `gates-latest.json` старше последних правок: перезапусти, старому verdict не верь.

## 5. Перед уходом

`note --id <id> --text "<что сделал>" --next "<следующий шаг>"`. Следующий агент начнёт отсюда.
