---
name: design-system-map
description: >-
  Карта дизайн-системы проекта перед UI-работой: стек, токены, примитивы,
  шрифты, иконки и метрика drift (hex, палитровые классы, arbitrary values).
  Один раз на задачу генерирует главный агент, все builder в рое читают
  одну карту, reviewer сравнивает drift до и после. Включать перед любым UI-кодом
  и в /fleet с UI-подзадачами.
---

# Design System Map

Проблема роя: 3 builder параллельно и не видят друг друга. Без общей карты получается 3 разные кнопки, 3 оттенка серого и 2 библиотеки иконок. Карта — это общий контракт.

## Сгенерировать

```bash
node ~/.agent-harness/tools/design-map.mjs          # пишет .agent-state/design-map.md + .json
node ~/.agent-harness/tools/design-map.mjs --json   # машинный вывод
```

В `/fleet` это делает главный агент **до** explorer и planner (у них нет bash). Путь к карте передаётся в handoff каждому builder.

## Что в карте

- **Stack**: фреймворк, UI-библиотека, стили, примитивы, иконки, данные, формы, motion, i18n, тесты, с версиями.
- **Tailwind**: v3 (config) или v4 (`@theme`).
- **Primitives**: `components/ui/*`. Их переиспользуют, не дублируют.
- **Tokens**: `:root`, `.dark`, `@theme`.
- **Drift**: сколько hex, палитровых классов, arbitrary values, inline style, `bg-white`/`text-black`, плюс топ файлов.

## Правила для builder

1. Прочитай карту до первой строки UI-кода.
2. Цвет, радиус, тень берутся из токенов. Нужен новый — добавь **токен** в CSS (`:root` + `.dark` + `@theme`), а не hex в JSX. В handoff напиши: «добавил токен X, потому что…».
3. Нужен примитив, которого нет — добавь его через `shadcn add`. Все задачи роя используют этот же примитив.
4. Иконки бери из одной библиотеки, которая уже в стеке. Вторую не тащи.
5. Шрифты бери из карты. Третье семейство не добавляй.

## Правила для reviewer

```bash
# в базовой ветке / до изменений
node ~/.agent-harness/tools/design-map.mjs && cp .agent-state/design-map.json /tmp/design-map.before.json
# в worktree builder
node ~/.agent-harness/tools/design-map.mjs --compare /tmp/design-map.before.json
```

Exit 1 значит, что drift вырос: finding **medium** с файлами из таблицы. Дубль существующего примитива — **high**.

## Конфликт карты и задачи

Если задача требует редизайна (новая палитра, новые шрифты), это решение planner, и он заводит его отдельной подзадачей «токены» **первой**. Остальные UI-задачи ставятся с `--deps` на неё. Так рой не красит в разные цвета одновременно.
