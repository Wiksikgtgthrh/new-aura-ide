# Aura Team

Built-in Aura IDE extension for teams, projects, tasks and safe Git workflows. It uses the built-in `vscode.git` API rather than implementing Git.

Set `auraTeam.serverUrl` to the metadata server. To connect private GitHub repositories, create a GitHub OAuth App with Device Flow enabled and set its Client ID in `auraTeam.githubClientId`. The resulting token is stored in VS Code `SecretStorage`.

The extension deliberately never offers `reset --hard`. Uncommitted changes use `restore`; committed work uses `revert`, which preserves history. Every mapped Git operation is printed in the **Aura Team** Output channel.

The default **Simple Mode** exposes only the safe project flow: clone/open, update, save work, history, and switch mode. Advanced recovery commands remain available from the Command Palette. GitHub is connected only from Aura Team; the stock Accounts entry is hidden, but the built-in GitHub providers remain available to the team integration.

Team API keys are stored and routed by the server. The extension receives only masked metadata (`keyHint`, provider, role and priority); provider secrets are never returned by the list endpoint.

## Тесты

`npm test` внутри `extensions/aura-team` собирает `out/` и прогоняет `test/*.test.mjs`.

- **Сквозной тест** `server-integration.test.mjs`: настоящий `AuraApiClient` из `out/` говорит по HTTP с настоящим `aura-team-server`, который поднимает стенд `aura-team-server/test/http-harness.ts` (`node --import tsx`, временный `AURA_DATA_DIR`). Нужны установленные зависимости сервера: `npm --prefix aura-team-server install`. Именно этот зазор (клиент ✅ сервер ✅, а вместе — нет) пропустил баг «DELETE задачи с `content-type: application/json` → 400 → „задачи не удаляются“».
- **Рендер вебвью**: JSDOM на настоящем `src/webview/template.html` — `kanban.render`, `admin.render`, `git.render`, `invite.sidebar`, `sidebar.render`, `demo-mode`.
- **Манифест против кода** `manifest.test.mjs`: ключи `%…%` в `package.nls.json`, объявленные команды против зарегистрированных (команда в палитре, которой нет в коде, молча ничего не делает), события активации, `main`, представления.
- **Статические контракты**: `commands-wired` (что зовёт интерфейс — зарегистрировано), `api-headers`, `archives-rules`, `git-branch-name`, `keys-import`, `sidebar-syntax`, `refresh-batching` (обновление состояния идёт одним залпом, а не шестью кругами подряд).

Чего тесты не видят: раскладку (у JSDOM нет движка вёрстки — «слипшиеся» элементы ловятся только аудитом CSS-правил), реальный API VS Code (`showQuickPick`, secrets, активация) и упаковку расширения.
