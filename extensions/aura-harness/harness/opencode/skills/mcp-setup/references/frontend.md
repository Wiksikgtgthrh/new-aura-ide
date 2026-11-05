# Фронтенд-набор MCP

| сервер | зачем | команда | зависимость | скилл |
|---|---|---|---|---|
| playwright | клики, snapshot, скриншоты, консоль, сеть | `npx -y @playwright/mcp@latest --isolated` | node | visual-qa |
| chrome-devtools | performance trace, Lighthouse, CPU/network throttling | `npx -y chrome-devtools-mcp@latest --isolated` | node + Chrome | web-perf |
| context7 | docs библиотеки по версии | `npx -y @upstash/context7-mcp@latest` | node, ключ опционален | docs-lookup |
| shadcn | поиск и добавление компонентов реестра | `npx -y shadcn@latest mcp` | node, `components.json` | frontend-stack |
| figma | контекст фрейма, переменные, скриншот | remote `http://127.0.0.1:3845/mcp` | Figma Desktop, Dev Mode | ui-craft |

## Конфиги

- OpenCode: `opencode/opencode.jsonc.example` (проверенный `mcp.servers`) или `opencode.official.jsonc.example` (`mcp.<имя>` + `enabled`).
- Pi (pi-mcp-adapter): `.pi/agent/mcp.json.example` → `~/.config/mcp/mcp.json`. Формат стандартный `mcpServers`.

## Грабли

- `--isolated` у playwright/chrome-devtools: чистый профиль на сессию, параллельные qa не делят куки и не дерутся за lock профиля.
- chrome-devtools нужен установленный Chrome (stable). На headless-VPS добавь `--headless`.
- figma работает, только пока открыт Figma Desktop с включённым Dev Mode MCP Server. Иначе держи его выключенным, чтобы сессия не ждала таймаут.
- context7 без ключа упирается в rate limit. `CONTEXT7_API_KEY` передавай через окружение, не в argv.
- После правки конфига перезапусти сессию и проверь `opencode mcp list` / `pi` → `/mcp`.
