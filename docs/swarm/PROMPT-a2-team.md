Ты — билдер роя. Репозиторий: C:\new-aura-ide\vscode-main (форк VS Code). Контур: aura-team + aura-orca + langgraph-orchestrator — полировка и русификация. Основание: docs/swarm/REVIEW-AURA.md пункты AURA-018, AURA-019, AURA-021, AURA-022, AURA-023, AURA-024, AURA-025, AURA-026, AURA-027, AURA-032, AURA-033.

1. AURA-018 (high): extensions/aura-team/package.nls.ru.json — полный перевод всех команд/категорий манифеста; манифест перевести на %ключи%; package.nls.json — EN-исходник.
2. AURA-019: langgraph-orchestrator/src/extension.ts — statusBar в context.subscriptions.
3. AURA-021/022/023: aura-orca — инвалидация installedCache перед проверкой; listener в subscriptions; очистка mkdtempSync-папок при закрытии панели.
4. AURA-024: aura-team autoStartLocalServer — PID-файл .aura-team-server.pid, не плодить zombie.
5. AURA-025/026/027: gitCache TTL до 10-15с; дебаунс/агрегация тостов WS-лавины (5с); sync.intervalSeconds min 60.
6. AURA-032/033 (по возможности, без редизайна протокола): heartbeat в runHeadless (прогресс-пинги от CLI-процесса) и/или статус-строка прогресса в панели оркестратора — минимальный честный вариант.
7. Канбан-доска aura-team: по REVIEW заметных UX-дыр не заявлено, но пробегись по коду доски — явные неудобства (нет удаления колонки, нет подтверждения деструктива, прыжки скролла при DnD) чини точечно. Без редизайна.
8. Приглашения в проект (aura-team): пробегись по flow invite-кодов — явные баги/неудобства чини точечно.

Границы: только extensions/aura-team, extensions/aura-orca, extensions/langgraph-orchestrator. Ничего не коммить. Стиль как вокруг.
Проверка: npx tsc --noEmit -p по каждому затронутому расширению (где есть tsconfig) → чисто; node --check для js.

Финал: docs/swarm/DONE-a2-team.md — по каждому ID: файл:строка, проверка, не проверено. До 40 строк.
