---
description: Продолжить прерванную работу по task-record без потери изменений
---
Загрузи скилл `session-resume` и действуй по нему.

Состояние задач:
!`node "$HOME/.agent-harness/tools/orchestrator.mjs" status`

Последние события:
!`node "$HOME/.agent-harness/tools/orchestrator.mjs" events --tail 15`

Рабочее дерево:
!`git status --short`

Сначала скажи, где остановились и что дальше (поле next), потом продолжай. Ничего не сбрасывай и не чисти.
