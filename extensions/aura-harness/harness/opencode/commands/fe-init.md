---
description: Поставить в проект фронтенд-контур качества (Playwright e2e/a11y/visual, Lighthouse CI, Vitest) под gates.mjs
---
Проект: $ARGUMENTS (пусто = текущий каталог)

1. `node "$HOME/.agent-harness/tools/frontend-init.mjs"` (dry-run): покажи, какие файлы, scripts и devDependencies добавятся.
2. Спроси подтверждение. После «да»: `node "$HOME/.agent-harness/tools/frontend-init.mjs" --write`.
3. Установка зависимостей и браузера — отдельные команды из вывода, каждая через approval policy.
4. Заполни `e2e/routes.ts` всеми пользовательскими роутами, `ROUTES` в `lighthouserc.cjs` важными роутами.
5. Baseline visual: только на платформе CI (Linux / образ Playwright) и с подтверждением: `test:visual:update`.
6. `node "$HOME/.agent-harness/tools/gates.mjs"`: покажи verdict по каждому gate.
7. Итог: что поставлено, что осталось руками (baseline, роуты, CI).
