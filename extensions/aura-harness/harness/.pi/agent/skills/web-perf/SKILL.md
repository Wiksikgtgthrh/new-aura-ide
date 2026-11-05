---
name: web-perf
description: >-
  Производительность фронтенда с бюджетами: Core Web Vitals (LCP, CLS, INP),
  Lighthouse CI как gate perf, трассы через Chrome DevTools MCP, бандл, картинки,
  шрифты, RSC/стриминг. Включать для qa, при жалобах «тормозит», перед релизом
  и для любой правки hero/LCP-элемента, шрифтов, картинок или зависимостей.
---

# Web Perf

Сначала замер, потом правка, потом снова замер. Оптимизация без цифр — это гадание.

## Бюджеты (по умолчанию, в `lighthouserc.cjs`)

| метрика | бюджет | уровень |
|---|---|---|
| Performance score | ≥ 0.90 | error |
| LCP | ≤ 2.5 s | error |
| CLS | ≤ 0.1 | error |
| TBT (лаб. прокси INP) | ≤ 200 ms | error |
| INP (поле / трасса) | ≤ 200 ms | цель |
| Total byte weight | ≤ 1.6 MB | warn |

Проект может ужесточить бюджеты. Ослабить — только по решению человека, с причиной в коммите.

## 1. Gate

```bash
node ~/.agent-harness/tools/gates.mjs --only perf   # = <pm> run test:perf -> lhci autorun
```

Отчёты лежат в `.agent-state/artifacts/lhci/`. Lighthouse меряет **прод-сборку** (`build && start`), dev-режим не считается. Каждый важный роут нужно добавить в `ROUTES` в `lighthouserc.cjs`.

## 2. Диагностика через MCP

- **Chrome DevTools MCP** (`chrome-devtools`): `performance_start_trace` → действие → `performance_stop_trace` → `performance_analyze_insight`. Так видны LCP-элемент, long tasks, layout shifts и render-blocking ресурсы.
- **Playwright MCP**: `browser_network_requests` — что грузится, сколько и в каком порядке.

## 3. Чем лечить (по частоте)

**LCP**
- LCP-картинка через `next/image` с `priority` и корректным `sizes`; формат AVIF/WebP; без lazy.
- Шрифт через `next/font` с `display: swap`, без внешних `<link>` на Google Fonts.
- Данные для hero идут с сервера (RSC), а не через клиентский fetch после гидрации.
- Медленные блоки ниже первого экрана заворачивай в `<Suspense>` и стримь.

**CLS**
- У каждой картинки и видео есть размеры или `aspect-ratio`.
- Skeleton той же геометрии, что контент.
- Баннеры и тосты не сдвигают контент: overlay или зарезервированное место.
- Шрифт с fallback-метриками (`next/font` делает `adjustFontFallback`).

**INP / TBT**
- Меньше клиентского JS: `"use client"` только у листьев; тяжёлые виджеты через `next/dynamic` или по взаимодействию.
- Длинные обработчики разбивай (`startTransition`, `scheduler.yield`, debounce ввода).
- Большие списки виртуализируй (`@tanstack/react-virtual`).

**Бандл**
- Перед добавлением зависимости проверь её вес (bundlephobia / `pnpm why`). Иконки импортируй поштучно.
- `@next/bundle-analyzer` по запросу, отчёт клади в artifacts.
- Moment, lodash целиком, вторая UI-библиотека — finding **medium**.

## Отчёт

| роут | LCP | CLS | TBT | score | было → стало |
|---|---|---|---|---|---|

Без цифр «до» и «после» оптимизация считается `unverified`.
