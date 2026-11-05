---
description: Подготовить релиз через release gate, план отката и approval человека
agent: release
subtask: true
---
Цель релиза: $ARGUMENTS

Действуй по скиллу `deploy-release`. Порядок жёсткий: gates → secret scan → rollback.md → approval человека → `policy.mjs release` = OPEN → деплой → smoke. На любом FAIL или BLOCKED остановись и перечисли причины. Approval никогда не выдавай сам.
