---
name: approval-policy
description: >-
  Как запрашивать и фиксировать подтверждение человека для sensitive и
  destructive действий: формат запроса, что считается approval, как он
  записывается в orchestrator и release gate. Включать, когда policy.mjs
  вернул ask, задача в awaiting_approval или готовится релиз.
---

# Approval Policy

## Что требует approval

- Задачи с risk `sensitive` или `destructive` (стартуют в `awaiting_approval`).
- Команды, на которые `policy.mjs check` вернул exit 2.
- Любой релиз: `policy.mjs release` требует запись в `.agent-state/approvals/release.json`.

## Формат запроса

Одним блоком, без воды:

```
Нужно подтверждение: <действие одной строкой>
Цель: <зачем>
Команды: <точные команды>
Затронет: <файлы / сервисы / данные>
Риск: <что может сломаться>
Откат: <как вернуть>
Ответь "да" или скажи, что поменять.
```

## Что считается approval

- Явное «да / ок / подтверждаю» человека в чате на конкретный запрос.
- Нажатие allow в окне permission OpenCode.
- Не считается: молчание, «давай» на другой вопрос, разрешение «из прошлой сессии», собственное решение агента.

## Запись

```bash
# задача (выполняет человек или агент по прямому "да" в чате; в OpenCode спросит подтверждение)
node "$HOME/.agent-harness/tools/orchestrator.mjs" approve --id T-0004 --by artem --note "миграция users.email"
# релиз (только человек; агенту release это запрещено permission-правилом)
node "$HOME/.agent-harness/tools/policy.mjs" approve-release --by artem --rollback .agent-state/release/rollback.md
```

Approval релиза привязан к `HEAD`. Новый коммит после approval закрывает gate, нужно подтверждать снова.

## Ограничение

Запись `--by` не криптографическая. Защита держится на том, что OpenCode спрашивает человека перед этими командами. В Pi такого гейта нет, поэтому агент не запускает `approve*` без явного «да» в чате.
