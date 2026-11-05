---
name: visual-regression
description: >-
  Визуальная регрессия через Playwright toHaveScreenshot: baseline на каждый
  роут, desktop и mobile, светлая и тёмная тема, маски динамики, правила
  обновления baseline только с approval. Главная защита роя от того, что один
  builder ломает вёрстку другому. Включать для qa, integration-шага /fleet и
  любой правки общих компонентов, токенов или layout.
---

# Visual Regression

Скриншот в qa — это «посмотрел глазами». Visual regression — это «машина сравнила с эталоном попиксельно». Для роя нужно второе: builder A меняет `Button`, а ломается страница builder B.

## Gate

```bash
node ~/.agent-harness/tools/gates.mjs --only visual   # = <pm> run test:visual
```

`e2e/visual.spec.ts` снимает каждый роут из `e2e/routes.ts` в проектах `desktop` (1440x900) и `mobile` (375x812), в `light` и `dark`, fullPage, с `reducedMotion: reduce`. Эталоны лежат в `e2e/__screenshots__/<project>/…` и **коммитятся**.

## Когда падает

1. Открой diff: `.agent-state/artifacts/playwright/results/**/*-diff.png` (или `npx playwright show-report .agent-state/artifacts/playwright/html`).
2. Реши: это **регрессия** или **намеренное изменение**.
   - Регрессия: чини код. Baseline не трогай.
   - Намеренное: в handoff опиши, что и почему изменилось, приложи `actual` и `diff`. Обновление baseline (`test:visual:update`) — команда с **approval** (policy: ask).
3. Обновлять baseline, чтобы тест «позеленел», запрещено. Reviewer ставит за это blocker.

## Стабильность (иначе тест будет флапать)

- Динамику (даты, аватары, случайные данные, карусели, видео) помечай `data-visual-mask`, её маскирует спека.
- Данные бери из фикстур или моков, не из живого API.
- Шрифты ждутся через `document.fonts.ready` (в `helpers.ts`). Анимации и каретка отключены в конфиге.
- **Baseline зависит от ОС и браузера.** Создавай и обновляй его на той же платформе, что CI (Linux), лучше в образе `mcr.microsoft.com/playwright`. Baseline с macOS на Linux CI будет падать.
- Порог `maxDiffPixelRatio: 0.01`. Поднимать его, чтобы скрыть баг, нельзя.

## В рое

- Каждый builder гоняет `visual` в своём worktree. Падение на роуте, которого задача не касалась, значит, что задета общая часть: **стоп**, handoff главному агенту.
- Integration-шаг (`worktree.mjs integrate`) гоняет все gates, включая visual, уже после слияния веток. Именно там ловятся конфликты «каждый по отдельности зелёный».
