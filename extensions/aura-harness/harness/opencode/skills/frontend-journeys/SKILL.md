---
name: frontend-journeys
description: >-
  Сценарные frontend-journeys: долгие цепочки поведения (trading, auth,
  nav-completeness, responsive, theme, data-state, visual, a11y, perf)
  с фикстурами детерминизма и state-контрактами. Обязательный гейт для
  фронтенда: прогон после реализации, исправления, повтор. Раннер:
  tools/journeys.mjs.
---

# Skill: frontend-journeys
# Frontend Journeys — долгие сценарии вместо одноэкранных проверок

Когда подключать: любая нетривиальная фронтенд-задача после реализации. Гейт `journeys`
обязателен для фронтенда; нет скрипта `test:journeys` — результат `unverified`.

Гейт «красивый UI» пройден — это середина. Продукт ломается после 5–10 действий:
смена состояния → ошибка → восстановление → refresh → повтор. Journeys заставляют
пройти эту цепочку, а не угадать её.

## Цикл

```
journeys --list → прогон → чтение report.md → исправления → повторный прогон
```

```bash
node ~/.agent-harness/tools/journeys.mjs --cwd . --url http://127.0.0.1:PORT/
node ~/.agent-harness/tools/journeys.mjs --journey auth        # точечно
node ~/.agent-harness/tools/journeys.mjs --update-snapshots    # visual baseline, через approval
```

Нет конфига в проекте — `frontend-init.mjs` кладёт `journeys.config.json` и скрипт.
Селекторы проекта переопределяются в `journeys.config.json → selectors.<journeyId>`.

## Встроенные сценарии (journeys/frontend/)

| journey | цепочка |
|---|---|
| trading-terminal | пара → таймфрейм → тип графика → стакан/сделки → цена из стакана → ордер → валидация → размещение → открытые → отмена → история |
| nav-completeness | ни одного мёртвого пункта меню: href="#"/aria-disabled запрещены; клик по каждому пункту меняет URL, контент или открывает модалку |
| auth | login → глаз пароля → невалидный email → короткий пароль → register+consent → refresh (сессия) → logout → refresh (аноним) |
| responsive | desktop/tablet/mobile: перелив, живой график, модалка на mobile |
| theme | dark↔light → refresh persistence → axe в обеих темах → storage-контракт |
| data-state | детерминизм по seed → pause/resume realtime → stale-индикатор → CDN-fallback |
| visual-regression | детерминированные кадры ключевых состояний против baseline |
| a11y | keyboard-only, focus trap, Escape, tab/tabpanel, axe по состояниям |
| performance | realtime budget: DOM-мутации/с, resize графика, heap длинной сессии |

## Правила честности

- Шаг упал → journey failed, остальные шаги skipped. Не «почти прошло».
- `optional` шаг (stale-индикатор, CDN-fallback) падает как `warning` — это known gap,
  который фиксируется в отчёте, а не прячется.
- Нет playwright/URL → verdict `unverified`, exit 2. Никогда не «passed».
- Baseline скриншотов обновляется только `--update-snapshots` — отдельное действие.
- Найденный journey-ми баг чинится кодом приложения, а не ослаблением шага.

## Когда писать проектный journey

Встроенные покрывают типовой контур. Свой `*.journey.mjs` нужен, когда у продукта есть
уникальная цепочка (checkout, онбординг, мультишаговая форма). Формат контракта —
`docs/journeys.md` в харнессе; фикстуры импортируются из `journeys/fixtures/`.

Полный контракт journey, фикстуры и state-контракты: `~/.agent-harness/docs/journeys.md`.
Base directory for this skill: ~/.agent-harness/opencode/skills/frontend-journeys
