---
name: a11y-audit
description: >-
  Автоматический и ручной аудит доступности по WCAG 2.2 AA: axe-core через
  Playwright (gate a11y), клавиатура, видимый фокус, контраст в светлой и
  тёмной теме, reduced motion, зум 200%, скринридер-семантика. Включать для qa,
  reviewer и любой UI-правки; findings с severity и фиксом.
---

# A11y Audit

Чек-лист без машины = пожелание. Здесь сначала машина (axe), потом то, что машина не ловит.

## 1. Автоматика (обязательно)

```bash
node ~/.agent-harness/tools/gates.mjs --only a11y   # = <pm> run test:a11y
```

Нет скрипта `test:a11y` — verdict `unverified`; поставь контур: `node ~/.agent-harness/tools/frontend-init.mjs`.

Спека `e2e/a11y.spec.ts` проверяет каждый роут из `e2e/routes.ts`:
- axe с тегами `wcag2a wcag2aa wcag21a wcag21aa wcag22aa` в **light и dark**;
- видимый фокус на первых 15 Tab-остановках;
- отсутствие длинных/бесконечных анимаций при `prefers-reduced-motion: reduce`.

Через MCP без тестов: Playwright MCP `browser_evaluate` с инжектом axe, либо Chrome DevTools MCP (Lighthouse a11y). Это допустимо как evidence, если приложен JSON.

## 2. Руками (axe этого не видит)

- [ ] Весь сценарий проходится только клавиатурой: Tab/Shift+Tab, Enter/Space, Esc закрывает модалку, фокус возвращается на триггер.
- [ ] Порядок фокуса совпадает с визуальным; нет ловушек вне модалок.
- [ ] Skip-link «к содержимому» на страницах с длинной навигацией.
- [ ] Зум 200% и ширина 320px: ничего не обрезается, нет горизонтального скролла (WCAG 1.4.10).
- [ ] Цель клика не меньше 24x24 CSS px (WCAG 2.5.8), на мобиле лучше 44x44.
- [ ] Ошибки форм: текстом рядом с полем, `aria-invalid`, `aria-describedby`, фокус на первую ошибку.
- [ ] Динамические сообщения (тост, «сохранено») идут через `role="status"` / `aria-live="polite"`.
- [ ] Иконка-кнопка с `aria-label`; декоративная svg с `aria-hidden="true"`.
- [ ] Информация не передаётся только цветом (ошибка = цвет + иконка/текст).
- [ ] `lang` на `<html>`; один `<h1>`; заголовки без пропусков уровней; landmarks `header/nav/main/footer`.
- [ ] Видео и анимации ставятся на паузу; автоплей без звука.

## 3. Контраст

- Текст 4.5:1, крупный (24px или 18.66px bold) 3:1, иконки и границы полей 3:1.
- Проверяй **обе темы**. Типовой баг — `text-muted-foreground` на `bg-muted` в dark.

## Severity

| severity | пример |
|---|---|
| blocker | сценарий нельзя пройти клавиатурой; модалка без выхода; форма без label |
| high | axe serious/critical; невидимый фокус; контраст ниже 3:1 |
| medium | axe moderate; цель клика меньше 24px; нет live-region |
| low | axe minor; порядок заголовков |

Каждый finding: роут + селектор + правило (axe id или WCAG критерий) + конкретный фикс.
