---
description: Сделать UI с визуальным направлением, design-map, машинными gates (e2e/a11y/visual/perf) и браузерной проверкой desktop и mobile
---
UI-задача: $ARGUMENTS

1. `node "$HOME/.agent-harness/tools/design-map.mjs"`, прочитай `.agent-state/design-map.md`. Есть система — работаешь в ней.
2. Загрузи `ui-craft`, `frontend-stack`, `docs-lookup`. Новый проект/редизайн: зафиксируй направление, 3–5 цветов-токенов, максимум 2 шрифта, один запоминающийся приём.
3. Нет контура тестов (`test:a11y`, `test:visual`, `test:perf` в package.json): `node "$HOME/.agent-harness/tools/frontend-init.mjs"` → покажи план → `--write` и установка зависимостей только после подтверждения.
4. Реализуй mobile-first, light + dark, с состояниями empty/loading/error и доступностью. Новая страница = строка в `e2e/routes.ts`.
5. `node "$HOME/.agent-harness/tools/gates.mjs"`: passed или честно unverified (что именно не запустилось).
6. `node "$HOME/.agent-harness/tools/design-map.mjs" --compare <снимок до>`: drift не вырос.
7. Делегируй `qa`: gates + 1440x900 и 375x812, скриншоты в `.agent-state/artifacts/qa/`.
8. Исправь findings blocker/high и повтори qa один раз.
9. Итог: что сделано, verdict каждого gate, LCP/CLS/TBT, ссылки на скриншоты, что осталось.
