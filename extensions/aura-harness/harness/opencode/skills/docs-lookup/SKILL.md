---
name: docs-lookup
description: >-
  Актуальная документация библиотек вместо памяти модели: Context7 MCP по
  точной версии из package.json, затем fetch официальных docs, затем исходники в
  node_modules. Включать перед кодом с версионно-чувствительными API (Next.js,
  React, Tailwind, AI SDK, ORM, auth, роутеры) и при любой ошибке «нет такого
  экспорта / deprecated».
---

# Docs Lookup

Модель помнит API на момент обучения. Проект живёт на версии из `package.json`. Когда они расходятся, получаются `tailwind.config.js` в v4, синхронные `params` в Next 15 и выдуманные опции.

## Порядок источников

1. **Версия.** `package.json` + lock-файл (или `pnpm list <pkg>`). Без версии в поиск не иди.
2. **Context7 MCP** (`context7`):
   - `resolve-library-id` с именем пакета → id;
   - `get-library-docs` с id, `topic` (например, `"caching"`, `"server actions"`, `"@theme"`) и разумным `tokens`.
   - Запрашивай узкую тему, а не «всё про Next».
3. **Официальные docs** через `fetch` / web-search: nextjs.org, react.dev, tailwindcss.com, ui.shadcn.com, sdk.vercel.ai, orm.drizzle.team и т.п. Сверь, что страница относится к твоей мажорной версии.
4. **Исходники**: `node_modules/<pkg>/package.json` (`exports`, `types`) и `.d.ts`. Это истина для «есть ли такой экспорт».
5. Ничего не нашёл — так и скажи. Не выдумывай сигнатуру.

## Когда обязательно

- Мажорная версия вышла меньше 18 месяцев назад.
- Ошибка `is not exported`, `deprecated`, `Unknown option`, падение типов в конфиге.
- Конфиги: `next.config`, Tailwind/PostCSS, ESLint flat config, Vitest/Playwright, tsconfig paths.
- Миграция между мажорами.

## Evidence

В handoff одной строкой: `docs: <pkg>@<version> — <источник/тема>`. Reviewer видит, что API сверен, а не взят по памяти.

## Без Context7

MCP не подключён или упал: шаги 3–4, плюс warning в отчёте «context7 недоступен». Ключ `CONTEXT7_API_KEY` опционален и поднимает лимиты; храни его в окружении, не в конфиге.
