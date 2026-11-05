---
name: frontend-stack
description: >-
  Инженерные правила фронтенда под современный стек: Next.js App Router (15/16),
  React 19, TypeScript strict, Tailwind v4, shadcn/ui, формы, данные, кэш, ошибки,
  тесты компонентов. Включать для любого кода в React/Next-проекте, вместе с
  ui-craft (вкус) и docs-lookup (актуальные API). Не про стиль, а про то, как
  писать код, который не сломается в проде.
---

# Frontend Stack

`ui-craft` отвечает за «красиво». Этот скилл отвечает за «правильно». Версии в проекте важнее памяти модели: сначала `package.json`, потом `docs-lookup`, потом код.

## 0. Перед первой строкой

1. Прочитай `package.json`: версии `next`, `react`, `tailwindcss`, `typescript`, менеджер пакетов.
2. Прочитай `.agent-state/design-map.md` (нет: `node ~/.agent-harness/tools/design-map.mjs`).
3. Любой API, который менялся за последний год (кэш Next, `params`, Tailwind config, AI SDK, роутинг), сверяй через `docs-lookup`. Не по памяти.

## Next.js App Router

- **Server Components по умолчанию.** `"use client"` только у листа, которому нужны state, эффекты, браузерные API или обработчики. Не ставь его на layout или страницу целиком.
- **Данные грузятся на сервере**: `async` компонент + `fetch`/запрос в БД. Клиенту передаются уже готовые сериализуемые props. Не делай `fetch` внутри `useEffect`. Для клиентского кэша и синхронизации используй SWR или TanStack Query.
- **Next 15+**: `params`, `searchParams`, `cookies()`, `headers()` асинхронные, их нужно `await`.
- **Next 16**: `middleware.ts` переименован в `proxy.ts`; Turbopack по умолчанию; кэш явный (`"use cache"`, `cacheLife`, `cacheTag`, флаг `cacheComponents`); `revalidateTag(tag, profile)` требует второй аргумент; в Server Actions есть `updateTag()` для read-your-writes.
- **Мутации** делай через Server Actions (`"use server"`) с валидацией (zod/valibot) на сервере. На клиенте используй `useActionState` для ошибок и `useFormStatus` для pending. Клиентская валидация только для UX, не для безопасности.
- **Границы**: в каждом сегменте с данными должны быть `loading.tsx` (или `<Suspense>`), `error.tsx` (client) и `not-found.tsx`. Медленные куски заворачивай в `Suspense`, чтобы не блокировать всю страницу.
- **Метаданные**: `export const metadata` / `generateMetadata`, `viewport` с `themeColor`. Нужен один `<h1>` на страницу.
- **Изображения**: только `next/image` с `width`/`height` или `fill` + `sizes`. `priority` ставь только у LCP-картинки.
- **Шрифты**: `next/font` с `display: 'swap'` и CSS-переменной. Максимум 2 семейства.
- **Секреты** на клиент не попадают: только переменные с префиксом `NEXT_PUBLIC_*`, и то с умом. Серверный код помечай `import 'server-only'`.

## React 19

- Компонент = одна ответственность. Файл страницы собирает секции из `components/`.
- Не синхронизируй props в state через эффект. Вычисляй значение при рендере или используй `key` для сброса.
- `useEffect` нужен только для синхронизации с внешней системой. Для данных он не нужен.
- Списки рендери со стабильным `key` из данных, не индекс.
- Новые API: `use()`, `useOptimistic`, `useActionState`, `<Activity>`, `useEffectEvent`. Они есть только если версия React их поддерживает. Проверь.
- Включён React Compiler (`reactCompiler`)? Тогда ручные `useMemo`/`useCallback` без замера не добавляй.

## TypeScript

- `strict: true`. `any` под запретом; `unknown` + сужение. `as` только с комментарием почему.
- Типы props описывай рядом с компонентом. Общие доменные типы держи в `lib/types.ts`.
- Внешние данные (API, формы, `searchParams`) проходят через схему (zod/valibot), а не через `as`.

## Tailwind / стили

- **v4** (`@import "tailwindcss"` в CSS): токены лежат в `@theme`, конфига `tailwind.config.js` нет. **v3**: токены лежат в `tailwind.config`. Узнай, что за версия, через design-map.
- Используй семантические токены (`bg-background`, `text-foreground`, `bg-primary`, `border-border`), а не `bg-white`, `text-gray-500` и hex.
- Произвольные значения `w-[437px]` допустимы только когда другого пути нет. Сначала шкала (`gap-4`, `p-6`).
- Тёмная тема работает через те же токены (`.dark` или `prefers-color-scheme`). Компонент не знает про тему.
- Класс собирай через `cn()`. Вариантам (`variant`, `size`) нужен `cva`, а не тернарники на 5 строк.
- Layout строй на flex по умолчанию; grid используй для настоящих 2D-сеток. Вместо `margin` между соседями — `gap`.

## shadcn/ui

- Сначала посмотри `components/ui/*` (список есть в design-map). Нужен новый примитив — добавь его через CLI (`shadcn add <name>`), не копируй руками.
- Не форкай `Button` ради одного цвета: добавь вариант в `cva`.
- Доступность примитивов (Radix) не ломай: не убирай `DialogTitle`, `aria-*`, focus trap.

## Формы

- `<label htmlFor>` у каждого поля. Ошибки выводятся рядом с полем и связываются через `aria-describedby`, плюс `aria-invalid`.
- Сабмит по Enter не должен срабатывать во время IME-композиции: проверяй `e.nativeEvent.isComposing || e.keyCode === 229`.
- Кнопка во время pending получает `disabled` и индикатор. Повторную отправку блокируй.

## Состояния

У любого блока с данными обязательны 4 состояния: **loading** (skeleton той же геометрии, без прыжка layout), **empty** (что делать дальше), **error** (что случилось + retry), **ready**. Все четыре видны в QA.

## Тесты

- **Unit/компоненты**: Vitest + Testing Library. Тестируй поведение через роли (`getByRole`), а не классы и `data-testid`.
- **E2E / a11y / visual / perf**: шаблоны ставит `frontend-init.mjs`, гоняет `gates.mjs`. Новая страница = новая строка в `e2e/routes.ts` в том же диффе.
- Баг-фикс = тест, который падал до фикса.

## Анти-паттерны (reviewer ставит high)

- `"use client"` на странице или layout без причины.
- `fetch` в `useEffect`, водопады запросов вместо параллельных `Promise.all`.
- Секрет или серверный модуль в клиентском бандле.
- Новый компонент, дублирующий существующий примитив.
- Hex, палитровые классы и `bg-white` вместо токенов (растёт drift в design-map).
- Картинка без `alt`, кнопка-иконка без `aria-label`, div с `onClick` вместо `button`.
