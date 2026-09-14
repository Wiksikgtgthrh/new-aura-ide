# Changelog

## Unreleased

### Aura API and Aura Team

- **What:** The chat-side Aura API view now shows the current keys as masked metadata, while the main manager has a dedicated masked-key column. Bulk-import errors no longer echo malformed secret input.
- **Where:** Aura API workbench contribution, key service/parser, Aura Team extension and `aura-team-server`.
- **Why:** People need to see which endpoint is active without exposing provider credentials in the chat UI or ordinary metadata.
- **Was:** Keys were visible only in the central manager, team keys had no list/disable flow, and the server selected the newest key regardless of priority.
- Added role-filtered team-key listing, masked hints, priority routing, disablement, HTTPS enforcement for remote servers, and model-scoped proxy tokens.
- Added a five-column Kanban board with in-column task creation, status/assignee controls, team switching, persistent selected team, project opening from the project tree, and Simple/Advanced Git mode.
- Hidden stock Copilot built-ins by default and removed GitHub from the global Accounts menu while preserving the Aura Team GitHub connection path.
- **Rejected:** Returning complete keys to the client was rejected because a chat/webview or compromised extension host would become a credential exfiltration surface. Removing GitHub authentication entirely was rejected because it breaks GitHub-specific Git workflows.
