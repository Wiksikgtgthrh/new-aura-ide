Ты — билдер роя. Репозиторий: C:\new-aura-ide\vscode-main (форк VS Code). Финальный контур Aura: русификация-остатки + гигиена памяти. Основание: docs/swarm/REVIEW-AURA.md пункты AURA-016, AURA-017, AURA-030, AURA-031 + раздел «Локализация» (таблица покрытия).

1. AURA-016: aura-kotlin/src/avdForm.ts — жёсткие русские строки в HTML → tr()-ключи, строки в package.nls.ru.json и package.nls.json (и bundle, если так устроен плагин).
2. AURA-017: avdForm nonce → crypto.randomUUID().
3. AURA-030/031: aggg-agent — StatusBarAlignment-опечатка (проверь исходник/скомпилированный, где правда) и обрезка sanitizedLog до 10000 символов. Внимание: исходников может не быть в репо (только out/) — тогда правь out/extension.js аккуратно и зафиксируй это как технический долг.
4. aura-serverkit: создать package.nls.ru.json по образцу aura-team (манифест на %ключи%).
5. Память IDE: по разделу «Оптимизация памяти» REVIEW-AURA — дешёвые точечные закрытия: deviceScreen polling уже сделан другим билдером (не трогай deviceScreen.ts!); закрой: logcat-буфер — жёсткий лимит с обрезкой (android.ts:662, осторожно — файл большой, правка точечная), demoBoardCache очистка (aura-team extension.ts:153), onDidChangeConfiguration фильтр по секции (aggg-agent).
6. Настройка aura.language: проверь, что смена языка действительно переключает nls для расширений с package.nls.ru.json (это штатный механизм VS Code по display language — если aura.language отдельная настройка, задокументируй рассинхрон; переезд всей IDE на русский — это display language ядра, НЕ делай глобальных правок ядра).

Границы: только перечисленные расширения. deviceScreen.ts НЕ трогать (зона другого билдера, ACCEPT). Ничего не коммить.
Проверка: tsc по затронутым расширениям; node --check для js; тесты aura-team если тронешь его файлы (node test/run-all.mjs).
Финал: docs/swarm/DONE-a3.md — по пунктам: файл:строка, проверка реальным прогоном. Без «живых проверок» без прогона. До 35 строк.
