# VERSION

**Версия:** `2.3.0`

- Проект: AGGG Workspace
- Автор: [@hilartem](https://t.me/hilartem)
- Дата: 2026-10-02

## 2.3.0

- `orchestrator.mjs reopen` — возврат задачи из failed/cancelled в pending (с опциональным сбросом попыток): нужен канбан-доске Aura IDE для перетаскивания карточек обратно в очередь.
- Харнесс упакован как встроенный плагин Aura IDE (`extensions/aura-harness`): маркет-карточка, автоустановка в `~/.agent-harness`, связка с LangGraph-оркестратором (инструменты harness.* и канбан очереди).

## 2.2.0

- Доведение продукта до конца (по разбору VOLTEX-полигона): `full-site-checklist` — навигация без мёртвых ссылок («заявил раздел — построй раздел»), полный профиль, денежные потоки (пополнение баланса с курсом/комиссией и историей транзакций).
- Новый journey `nav-completeness`: запрещены `href="#"`/`aria-disabled` в меню; клик по каждому пункту обязан менять URL, контент или открывать модалку. Ссылки с `aria-current` освобождены.
- `ui-craft`: стандарт микровзаимодействий (active-нажатие кнопок, sliding-табы, анимация модалок) и анти-паттерны «старый сайт» (шапка-полоска, формы 2012 года).
- `media-assets`: в плотных data-UI (терминалы, дашборды) запрещён фотореализм/3D-рендеры — только плоская абстрактная графика в палитре токенов.
- `web-charts`: типографика осей — моноширинный шрифт из токенов, fontSize ≥ 11, локализация дат (ru-RU), контраст подписей, скриншот-гейт крупным планом.

## 2.1.0

- Фронтенд-контур: скиллы `frontend-stack`, `design-system-map`, `a11y-audit`, `web-perf`, `visual-regression`, `docs-lookup`; обновлены `ui-craft`, `visual-qa`, `agent-orchestration`.
- Инструменты: `design-map.mjs` (карта дизайн-системы + drift), `frontend-init.mjs` (Playwright e2e/a11y/visual, Lighthouse CI, Vitest), `worktree.mjs integrate` (слияние роя + gates).
- Gates: `e2e/a11y/visual/perf` обязательны во фронтенд-проектах; обязательный gate без скрипта = `unverified`, а не `passed`.
- Policy: запрет любых команд по секретным файлам (`.env*`, ключи, `.npmrc`), разбор `bash -c` и `$(...)`, обновление baseline и установки через `ask`.
- MCP: chrome-devtools, context7, shadcn, figma; конфиг Pi `mcp.json.example`; вариант OpenCode по официальной схеме.
- Исправлено: OpenCode-копии скиллов без frontmatter (синхронизированы), ложная «битая ссылка» в session-context, имена `docs/` в архиве.
