# DONE a2-team — REVIEW-AURA: AURA-018..027, 032, 033 + kanban/invite UX

Проверка: `tsc --noEmit` чисто для aura-team, aura-orca, langgraph-orchestrator; `node test/run-all.mjs` (aura-team) — ALL 19 STEPS PASSED (tsc + 18 тест-файлов, вкл. invite.modal и скролл-рестор в kanban.render). Не проверено: живая IDE-сессия (heartbeat/тосты/pid — по коду и типам).

| ID | Статус | Файл:строка | Что сделано / не проверено |
|---|---|---|---|
| AURA-018 | done | aura-team/package.nls.ru.json:1 (новый, 58 ключей); package.nls.json:45-60 (15 новых EN; 16-я строка диффа — тронутый command.getState); package.json — все category/title/description → %keys%; test/manifest.test.mjs:68-70 (category резолвится через EN-map) | Тест «нет мёртвых ключей» + «RU покрывает EN» зелёный |
| AURA-019 | already done | langgraph-orchestrator/src/extension.ts:70 | statusBar уже в `context.subscriptions` — подтверждено глазами |
| AURA-021 | already done | aura-orca/src/extension.ts:457,472 | `installedCache.delete(binary)` уже есть при смене настроек/бинаря |
| AURA-022 | done | aura-orca/src/extension.ts:149 | listener shell-integration добавлен в `context.subscriptions` (dispose идемпотентен с таймаут-веткой) |
| AURA-023 | done | aura-orca/src/extension.ts:62-67 (tempDirs+cleanupTempDirs+disposable), 301-304 (cleanup перед новым снапшотом), 370 (panel.onDidDispose) | rmSync(recursive,force); ошибки чистки глушатся |
| AURA-024 | done | aura-team/src/extension.ts:47-53 (убить stale pid до spawn), 78-84 (pid пишется только после probe), 87-88 (timeout → kill своего child) | pid в globalStorageUri, не в репо; живой процесс проверяется signal 0 |
| AURA-025 | done | aura-team/src/extension.ts:220-241 (TTL 10_000, `gitSnapshot()`, WeakSet + `repo.state.onDidChange` → сброс кэша); buildState: `git: await gitSnapshot()` | Ошибочные снапшоты не кэшируются (семантика сохранена) |
| AURA-026 | done | aura-team/src/extension.ts:336-364 (агрегатор: первый сразу, окно 5с → `{0} (+{1} more)`, backlog ≤10 + overflow, таймер в subscriptions); вызовы 376, 387 | Текст агрегата через l10n.t |
| AURA-027 | done | aura-team/package.json:70 (`minimum: 60`) + src/git/teamSync.ts:63 (`Math.max(60, …)`) — код и манифест согласованы | — |
| AURA-032 | done | aura-orca/src/extension.ts:181-186 (`setInterval` 30с: dim-строка `… ♥ running for Ns, output X KB` + log), clearInterval в close/error (197, 205) | Без изменения протокола; в живом терминале не гонял |
| AURA-033 | done | langgraph-orchestrator/src/tools/index.ts:573-581 (poll `auraOrca.getState` 20с, матч по точному title, logInfo аптайм/объём), clearInterval в finally (592) | `.then(ok, err)` вместо `.catch` — executeCommand возвращает Thenable |
| kanban scroll | done | aura-team/src/webview/template.html:1810-1833 (mount: scrollTop viewBody + scrollLeft `.board` + scrollTop `.column-body[data-status]`, только если route не сменился) | Покрыто kanban.render.test.mjs секцией 15 (рестор на свежих узлах + гвард lastMountedRoute); вживую не гонял |
| kanban deleteArchive | done | template.html:3325-3332 — удаление архива через существующий `confirmAction` (было без подтверждения) | Колонок-удаления нет: 4 фиксированных статуса — N/A |
| invite regen | done | template.html:1677-1694 (wireInviteActions: revoke→createInvite одним кликом, честит `{cancelled}`); disabled-гарды: gen 1664-1674, send 1708-1721 | Покрыто test/invite.modal.test.mjs (22 проверки: цепочка revoke→create, {cancelled}, даблклик-гарды, copy); сайдбар-путь — invite.sidebar.test.mjs |

Коммитов нет — все изменения в рабочем дереве.
