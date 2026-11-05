---
name: failure-recovery
description: >-
  Что делать, когда команда, gate, субагент или сессия упали: классификация
  ошибки transient/permanent/policy/timeout, ограниченные повторы, сохранение
  изменений без reset/clean, эскалация. Включать при любом сбое и при обрыве
  работы.
---

# Failure Recovery

## Классификация

| Класс | Признаки | Действие |
|---|---|---|
| transient | сеть, 429/5xx, rate limit, lock timeout, флап теста | повтор с паузой, максимум `maxAttempts` |
| timeout | истекла аренда, gate вышел по `timeoutSec` | `reclaim`, затем как transient |
| permanent | ошибка типов, падающий тест, неверная логика, нет файла | чинить причину, не повторять вслепую |
| policy | deny/ask от `policy.mjs`, нет approval | стоп, эскалация человеку |

```bash
node "$HOME/.agent-harness/tools/orchestrator.mjs" fail --id T-0003 --agent builder-1 --class transient --error "npm registry 503"
# transient/timeout и attempts < maxAttempts → снова pending; иначе failed
```

## Сохранить работу

1. `git status --short` и `git diff --stat`: зафиксируй, что изменено.
2. Незакоммиченное в worktree оставь как есть или `git stash push -m "agent: <task-id>"` (это ask).
3. Запиши `note --id <id> --text "что сломалось" --next "с чего продолжить"`.

## Никогда автоматически

- `git reset --hard`, `git clean`, `git checkout -- .`, `git restore .` (это deny в политике).
- Удаление worktree с изменениями (`remove` без `--force` откажет).
- Повтор permanent-ошибки той же командой.

## Эскалация

Повтор не помог дважды или класс policy: остановись. Отчёт: что пробовал, точный текст ошибки, гипотеза, что нужно от человека.
