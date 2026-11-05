---
name: visual-qa
description: >-
  Проверка интерфейса в реальном браузере через Playwright MCP: desktop и
  mobile viewport, скриншоты как evidence, чек-лист вёрстки, доступности и
  состояний. Включать после любой UI-правки, для /ui и роли qa.
---

# Visual QA

## Подготовка

- Нужен запущенный dev-сервер и его URL. Нет сервера: verdict `unverified`, причина в отчёт.
- Нужен Playwright MCP (`@playwright/mcp`). Нет: `unverified`, не выдумывай результат по коду.
- Папка: `.agent-state/artifacts/qa/<task-id>/`.

## Проход

Для каждого viewport, сначала 1440x900, потом 375x812:

1. `browser_navigate` на URL, дождаться загрузки.
2. `browser_snapshot`: структура, заголовки, подписи кнопок и полей.
3. `browser_take_screenshot` (fullPage) → `<page>-desktop.png` / `<page>-mobile.png`.
4. Проверить ключевой сценарий кликами и вводом: форма, навигация, модалка.
5. `browser_console_messages`: ошибки и предупреждения.

## Машинная часть (до ручного прохода)

```bash
node ~/.agent-harness/tools/gates.mjs --only e2e,a11y,visual,perf
```

Результаты лежат в `.agent-state/artifacts/gates-latest.json`, `playwright/`, `lhci/`. Упавший gate идёт в findings
со ссылкой на лог. Gate `skipped (REQUIRED)` = `unverified` в отчёте (поставить контур:
`frontend-init.mjs`). Детали: `a11y-audit`, `visual-regression`, `web-perf`.

Нет тестов, но есть MCP: Chrome DevTools MCP (`performance_start_trace`, Lighthouse) для
перфа и инжект axe через `browser_evaluate` для a11y. JSON-вывод приложи как evidence.

## Чек-лист

- [ ] Тёмная тема (переключатель в UI; эмуляцию `prefers-color-scheme` делают gates a11y/visual): контраст, иконки, границы
- [ ] Зум 200% / ширина 320px: без обрезаний
- [ ] Длинный контент: заголовок x2, пустой список, огромное число
- [ ] Нет горизонтального скролла на 375px
- [ ] Текст не обрезан и не налезает, заголовки переносятся аккуратно
- [ ] Контраст текста достаточный, нет белого на белом
- [ ] Tab проходит все интерактивные элементы, фокус виден
- [ ] У картинок alt, у полей label, у иконок-кнопок aria-label
- [ ] Состояния empty / loading / error реально показываются
- [ ] Нет ошибок в консоли
- [ ] Изображения грузятся, нет битых ссылок

## Отчёт

| Проверка | Desktop | Mobile | Скрин |
|---|---|---|---|

Затем findings: severity, где (страница + элемент), что видно, как исправить. Исправляй то, что видно на скриншоте, а не то, что «должно работать».
