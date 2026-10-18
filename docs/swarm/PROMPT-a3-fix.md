Ты — билдер роя на доработке по ревью. Репозиторий: C:\new-aura-ide\vscode-main. Зан вернул REQUEST_CHANGES: docs/swarm/ZAN-zan-a3.md. Два блокера:

1. **Нет эмита**: правки a3 в extensions/aura-kotlin/src/avdForm.ts (tr()-ключи, nonce) не попали в out/avdForm.js — расширение грузится из out/. Прогони эмит: npx tsc -p extensions/aura-kotlin/tsconfig.json (из корня репо, корневой node_modules/.bin/tsc) и проверь, что в out/avdForm.js появились tr( и crypto.randomUUID. Эмитить и aura-serverkit/aggg-agent, если правил их src.
2. **aura-serverkit — функциональный ноль русификации**: package.nls.json (EN-база) исторически русская, а package.nls.ru.json — её байт-копия. Сделай правильно: package.nls.json = АНГЛИЙСКИЕ строки (EN-исходник), package.nls.ru.json = русские. Сверь каждый %ключ% манифеста.
3. Плюс мелочи из ревью: счётчик строк (20, не 18), два мёртвых ключа nls.

Правила: ничего не коммить; после правок — реальные прогоны (tsc эмит + сверка out/, node --check, тесты если тронуты); заявка без прогона = возврат. Номера строк точные.
Финал: docs/swarm/DONE-a3-fix.md — по пунктам + доказательства. До 25 строк.
