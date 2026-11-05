---
description: Полный аудит фронтенда без правок кода — design drift, a11y, visual, perf, анти-паттерны стека
---
Цель: $ARGUMENTS (URL dev-сервера или роут; пусто = все роуты из e2e/routes.ts)

Ничего не правь. Только отчёт.

1. `node "$HOME/.agent-harness/tools/design-map.mjs"`: стек, примитивы, drift (топ файлов).
2. `node "$HOME/.agent-harness/tools/gates.mjs" --only e2e,a11y,visual,perf`: verdict каждого, ссылки на логи.
3. Делегируй `qa` (скиллы `visual-qa`, `a11y-audit`, `web-perf`): ручной проход desktop/mobile, light/dark, клавиатура, trace через chrome-devtools на главном роуте.
4. Делегируй `reviewer` на код UI (скилл `frontend-stack`): `"use client"` без причины, fetch в эффектах, дубли примитивов, секреты в клиенте.
5. Отчёт:
   - таблица `область | verdict | ключевая цифра | evidence`;
   - findings blocker → low с роутом/файлом и фиксом;
   - топ-3 действия с наибольшим эффектом.
