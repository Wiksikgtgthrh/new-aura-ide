---
name: governance
description: >-
  Классы риска read/write/sensitive/destructive, проверка shell-команд через
  policy.mjs, бюджеты задач и попыток, границы прав субагентов. Включать перед
  любым действием с побочным эффектом: правки, установка пакетов, git push,
  миграции, деплой, SSH, удаление.
---

# Governance

## Классы риска

| Класс | Примеры | Что нужно |
|---|---|---|
| read | чтение файлов, git status/diff/log, поиск | ничего |
| write | правки в своём worktree, локальные тесты, сборка | gates после изменений |
| sensitive | установка пакетов, git commit/push, внешние API с записью, SSH-чтение прод | approval человека |
| destructive | удаление данных, миграции, деплой, force push, reset, SSH-запись, firewall | approval + план отката + backup |

Сомневаешься между классами, бери старший.

## Проверка команды

```bash
node "$HOME/.agent-harness/tools/policy.mjs" check "git push origin main"
# exit 0 allow · exit 2 ask (стоп, спроси человека) · exit 3 deny (не выполнять)
```

- Составные команды (`&&`, `;`, `|`) проверяются по каждой части, побеждает самая строгая.
- Неизвестная команда считается `ask`.
- В OpenCode те же правила действуют нативно: блок `permission` генерирует `policy.mjs opencode-permission`.
- В Pi нативного bash-гейта нет, поэтому builder обязан вызывать `policy.mjs check` сам. Это слабее, отмечай в отчёте.

## Бюджеты

- `orchestrator.mjs init --max-tasks N --max-attempts M --timeout MIN`. Превышение `maxTasks` блокирует `add`.
- Повтор только для transient и timeout, пока `attempts < maxAttempts`.
- Субагенты ограничены `turnBudget`/`timeoutMs` (Pi) и `steps` (OpenCode) в файлах агентов.

## Никогда

- Не выполнять deny-команды в обход, через другой синтаксис, скрипт или `node -e`.
- Не одобрять свои же задачи (`approve`, `approve-release`).
- Не читать `.env`, приватные ключи и не печатать секреты в лог.
