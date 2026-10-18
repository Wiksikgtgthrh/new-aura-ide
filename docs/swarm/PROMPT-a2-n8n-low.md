Ты — билдер роя. Репозиторий: C:\new-aura-ide\vscode-main. Контур: LOW-хвост n8n-panel по ревью Зана docs/swarm/ZAN-b2.md, раздел 5, пункты 1-6:

1. §5.1: postMessage {type:'load'} принимается от любого источника → per-render токен: вшей случайный токен в HTML, extension шлёт его в сообщении, webview сверяет; чужие сообщения отбрасывать.
2. §5.2: checkStatus не защищён от синхронного throw (URL без схемы) → try/catch внутри executor + автодополнение https:// в getUrl для голого хоста.
3. §5.3: JSON.stringify(strings) в <script> — экранировать `<` (.replace(/</g, '\u003c')) после stringify.
4. §5.4: привести настройки к одному префиксу (n8nPanel.*), софт-миграция: читать старый ключ как фолбэк.
5. §5.5: reveal() без ViewColumn.One — не таскать вкладку из колонки пользователя.
6. §5.6: описание n8n.allowSelfSigned дописать честно: «на загрузку вкладки (iframe) не влияет».

Границы: только extensions/n8n-panel. Ничего не коммить. Проверка: node --check extension.js, все JSON валидны.
Финал: docs/swarm/DONE-a2-n8n-low.md — по пунктам: файл:строка, проверка. До 20 строк.
