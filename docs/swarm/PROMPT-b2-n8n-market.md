Ты — билдер роя. Проект: Aura IDE (форк VS Code), C:\new-aura-ide\vscode-main. Твоя задача — расширение extensions/n8n-panel: сделать видимым в маркете и удобным в IDE.

Основание: docs/swarm/REVIEW-AURA.md, раздел «n8n в маркете» + пункты AURA-001..006.

Конкретно:
1. package.json: publisher "aura", icon "media/n8n-icon.png" (создай файл media/n8n-icon.png 128x128 — можешь сгенерировать простую брендовую иконку программно через node-скрипт с записью PNG; фирменный цвет n8n #ff6d5a), galleryBanner, repository (заглушка github.com/aura-ide/n8n-panel), categories ["Visualization","Other"], keywords ["n8n","workflow","automation"].
2. viewsContainers.activitybar + views: иконка n8n в activity bar, открытие панели-вкладки по клику (как лаунчер), сохрани команду n8nPanel.openTab.
3. AURA-003: CSP — убрать 'unsafe-inline' для script-src, перейти на nonce.
4. AURA-004: убрать rejectUnauthorized:false; для самоподписанных — настройка `n8n.allowSelfSigned` (по умолчанию false).
5. AURA-005: кнопка «Переподключиться» при таймауте/ошибке + таймаут 10с с прогрессом.
6. AURA-006: onDidDispose для webview, убрать утечку retainContextWhenHidden.
7. Русские строки вынести через vscode.l10n / nls (AURA-028 миграцию на TS НЕ делай — останется JS, но аккуратный).
8. Зарегистрируй расширение в product.json → builtInExtensions, если там регистрируются встроенные (посмотри, как оформлены соседи). Если там только ссылки на галерею — оформи аналогично.

Границы:
- Трогай extensions/n8n-panel/ целиком + точечно product.json. Ничего не коммить.
- После правок: node --check на изменённые js-файлы; package.json — валидный JSON.
- URL сервера n8n по умолчанию: настройка уже есть (см. код), не хардкодь IP.

Финал: запиши docs/swarm/DONE-b2.md — что сделано по каждому ID, файлы:строки, как проверял, что НЕ проверено (например, отображение в маркете без сборки IDE). До 40 строк.
