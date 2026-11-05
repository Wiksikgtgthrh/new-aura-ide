---
name: deploy-release
description: >-
  Релиз и деплой через release gate: quality gates, secret scan, план отката,
  approval человека, проверка policy.mjs release, деплой, smoke и мониторинг.
  Включать для /release, деплоя на Vercel/VPS/Docker, публикации пакетов и
  любой выкладки на прод.
---

# Deploy & Release

## Порядок (не переставлять)

```bash
H="$HOME/.agent-harness/tools"
node "$H/gates.mjs"                      # 1. verdict passed (не unverified)
node "$H/policy.mjs" scan                # 2. 0 секретов
# 3. написать .agent-state/release/rollback.md
# 4. человек: node "$H/policy.mjs" approve-release --by <имя> --rollback .agent-state/release/rollback.md
node "$H/policy.mjs" release             # 5. OPEN
# 6. деплой, 7. smoke, 8. мониторинг
```

`release` проверяет: чистое дерево, свежие (≤ 60 мин) passed gates, отсутствие секретов, approval на текущий HEAD, наличие rollback.md. Любой FAIL значит BLOCKED.

## rollback.md (шаблон)

```
Что выкатываем: <версия / коммит / изменения>
Куда: <окружение, сервис>
Как откатить: <точные команды или кнопка: vercel rollback, git revert + deploy, docker tag предыдущий>
Данные: <миграции? обратимы? backup где>
Признаки поломки: <метрики, ошибки, URL для smoke>
Время на откат: <оценка>
```

## Деплой по платформам

- Vercel: preview-деплой и проверка URL до продакшна. Откат через instant rollback на прошлый деплой.
- VPS: скилл `cli-vps`. Read-only диагностика, backup, один шаг, проверка после каждого шага.
- Docker: тег образа с версией, не `latest`. Откат на предыдущий тег.
- npm publish: `--dry-run` первым, проверить `files` в package.json.

## После деплоя

1. Smoke: главная, health-эндпоинт, ключевой сценарий. HTTP-коды и время ответа.
2. 10–15 минут мониторинга по скиллу `observability`.
3. Отчёт: версия, где, smoke-результат, ссылка на rollback.md.
