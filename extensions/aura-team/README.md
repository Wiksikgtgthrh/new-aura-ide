# Aura Team

Built-in Aura IDE extension for teams, projects, tasks and safe Git workflows. It uses the built-in `vscode.git` API rather than implementing Git.

Set `auraTeam.serverUrl` to the metadata server. To connect private GitHub repositories, create a GitHub OAuth App with Device Flow enabled and set its Client ID in `auraTeam.githubClientId`. The resulting token is stored in VS Code `SecretStorage`.

The extension deliberately never offers `reset --hard`. Uncommitted changes use `restore`; committed work uses `revert`, which preserves history. Every mapped Git operation is printed in the **Aura Team** Output channel.

The default **Simple Mode** exposes only the safe project flow: clone/open, update, save work, history, and switch mode. Advanced recovery commands remain available from the Command Palette. GitHub is connected only from Aura Team; the stock Accounts entry is hidden, but the built-in GitHub providers remain available to the team integration.

Team API keys are stored and routed by the server. The extension receives only masked metadata (`keyHint`, provider, role and priority); provider secrets are never returned by the list endpoint.
