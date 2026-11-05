---
description: Read-only код-ревью текущего диффа с severity и доказательствами
agent: reviewer
subtask: true
---
Проведи ревью. Область: $ARGUMENTS (если пусто, незакоммиченные изменения и последний коммит).

Текущее состояние:
!`git status --short`

!`git log --oneline -5`

Действуй по скиллу `code-review`. Каждый finding: severity, file:line, последствие, минимальный фикс. Итог одной строкой: APPROVE / APPROVE_WITH_NITS / REQUEST_CHANGES.
