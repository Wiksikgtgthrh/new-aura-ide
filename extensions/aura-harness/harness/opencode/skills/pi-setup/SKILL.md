---
name: pi-setup
description: >-
  Как поставить и настроить агент-харнесс Pi (pi.dev) и его пакеты: где бинарь
  и agent-dir, как ставятся пакеты (`pi install npm:<pkg>`), какие поставили
  (pi-web-access, pi-mcp-adapter, pi-subagents, pi-background-tasks), где лежат
  конфиги (settings.json, web-search.json, mcp.json), как скиллы
  переезжают в Pi, и грабли (SSRF на локальный SearXNG, адаптер не читает
  mcp.json Пи, /reload). Триггеры: «pi», «pi.dev», «поставь пакет для pi»,
  «pi install», «pi list», «скиллы для pi», «pi не видит скиллы», «настрой pi».
---

# Pi — установка, пакеты, скиллы

Дневник одного ИИ. Машина: Fedora, `admin1`. Harness **Pi** (pi.dev) — минимальный
агент-харнесс от Earendil Works (Mario Zechner, MIT, TypeScript). Здесь: как ставили,
чего наставили, где спотыкались. Без прикрас.

**Главное:** Pi — это ещё один харнесс рядом с opencode2. Скиллы у них в разных
каталогах, поэтому наши скиллы надо **копировать** в Pi отдельно.

## Расклад (что и где)

| Что | Где |
|---|---|
| Бинарь | `~/.local/bin/pi` (npm-global `@earendil-works/pi-coding-agent`) |
| Agent-dir | `~/.pi/agent/` |
| Настройки | `~/.pi/agent/settings.json` |
| Скиллы Pi | `~/.pi/agent/skills/` |
| Пакеты (node_modules) | `~/.pi/agent/npm/node_modules/` |
| Сессии | `~/.pi/agent/sessions/` |
| Доки (поставка) | `~/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/` |

Версия на момент записи: `0.87.1`, Node v22. Ставили:
`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`.

## Как Pi находит скиллы (важное)

Pi **не** смотрит в `~/.config/opencode/skills/`. Его каталоги:

- `<agent-dir>/skills/` → `~/.pi/agent/skills/`
- `.pi/skills/` в проекте
- `~/.agents/skills/` и `.agents/skills/` (спека Agent Skills, портативно)
- плюс массив `"skills"` в `~/.pi/agent/settings.json`

При старте Pi кидает в промпт только `name + description + path` скилла. Тело
инструкций подгружается, когда задача совпала. Форс — `/skill:name`.

**Переезд наших скиллов в Pi (копия):**
```bash
mkdir -p ~/.pi/agent/skills
rsync -a --delete ~/.config/opencode/skills/ ~/.pi/agent/skills/
```
Правки в исходных скиллах в Pi **сами не приедут** — это копия, не симлинк.
Скиллы — `~/.config/opencode/skills/`, копию для Pi обновляем
руками по просьбе. **Симлинки запрещены** (Windows, чужие тулы, харнесс правит свою
копию) — только копирование.

## Пакеты Pi (что поставили)

Ставится в `~/.pi/agent/settings.json`, блок `packages`. После правки конфигов/скиллов
в Pi жми **`/reload`**.

| Пакет | Что даёт | Конфиг |
|---|---|---|
| **pi-web-access** | `web_search`, `fetch_content`: поиск (Exa/Brave/Tavily/Firecrawl/SearXNG…), парсинг URL, GitHub-клоны, PDF, YouTube. **Zero-config через Exa, без ключей** | `~/.pi/agent/web-search.json` (опц.) |
| **pi-mcp-adapter** | MCP-серваки без пожирания контекста: 1 прокси-тул (~200 токенов) | `~/.config/mcp/mcp.json` |
| **pi-subagents** | дочерние агенты: ревью, разведка, параллельные аудиты, фон | — |
| **pi-background-tasks** | долгие шеллы/агенты в фоне, Pi не стоит | — |

Команды установки (как ставили):
```bash
pi install npm:pi-web-access
pi install npm:pi-mcp-adapter
pi install npm:pi-subagents
pi install npm:pi-background-tasks
```

## Команды Pi (управление пакетами)

```bash
pi list                 # что стоит (user + project)
pi install npm:<pkg>    # + запись в settings.json; -l = в проект .pi/
pi remove <source>      # снести
pi update --extensions  # пересобрать/освежить пакеты
pi -e npm:<pkg>         # ПОПРОБОВАТЬ на один запуск, БЕЗ установки
pi config               # вкл/выкл ресурсы (Tab — смена scope)
```
Пин версии: `pi install npm:<pkg>@1.2.3` (версионированный npm фиксируется).
Источники: `npm:`, `git:github.com/user/repo@v1`, `https://…`, локальный `./path`.

## Конфиг MCP для адаптера

Адаптер читает **стандартные** MCP-файлы, а **не** `<agent-dir>/mcp.json` Пи:
- проектный `.mcp.json`
- глобальный `~/.config/mcp/mcp.json` (для всех проектов)
- `~/.agents/mcp.json` / `~/.agents/mcp/mcp.json`
- свои оверрайды `~/.pi/agent/mcp-adapter.json`

Формат — обычный `mcpServers` (как Claude/стандарт):
```json
{
  "mcpServers": {
    "searxng": {
      "command": "npx", "args": ["-y", "mcp-searxng"],
      "env": { "SEARXNG_URL": "http://127.0.0.1:8080" }
    },
    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }
  }
}
```
Онбординг: `/mcp-adapter setup` в Pi, или `pi-mcp-adapter init` из терминала —
сам найдёт чужие конфиги (Cursor/Claude/Codex) и предложит импорт.

## Наш статус (залито и проверено)

| Файл | Содержимое | Проверка |
|---|---|---|
| `~/.pi/agent/settings.json` | `packages`: web-access, mcp-adapter, subagents, background-tasks | `pi list` ✅ |
| `~/.config/mcp/mcp.json` | `searxng` + `playwright` | адаптер видит, оба отвечают MCP-хендшейком ✅ |
| `~/.pi/agent/web-search.json` | `searxngBaseUrl` + `ssrf.allowRanges: ["127.0.0.0/8"]` | — |
| `~/.pi/agent/skills/` | 9 скиллов — копия из `~/.config/opencode/skills/` | `diff -r` чист ✅ |

Живая проверка MCP-серваков (stdlib, без Пи):
```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  | SEARXNG_URL=http://127.0.0.1:8080 timeout 90 npx -y mcp-searxng
```

## Грабли (собрано кровью)

- **Локальный SearXNG упирается в SSRF-guard.** `127.0.0.1:8080` — приватный адрес,
  `pi-web-access` его блочит. Лечение — в `~/.pi/agent/web-search.json`:
  ```json
  { "searxngBaseUrl": "http://127.0.0.1:8080",
    "ssrf": { "allowRanges": ["127.0.0.0/8"] } }
  ```
  В `auto`-режиме настроенный SearXNG идёт **первым**, дальше Exa (MCP, ключ не нужен).
- **`pi-mcp-adapter` НЕ читает `<agent-dir>/mcp.json`** и `.pi/mcp.json` — это файлы
  «встроенного MCP» Пи. Для адаптера — `.mcp.json` / `~/.config/mcp/mcp.json`.
- **После правки скиллов/конфигов/пакетов → `/reload`** в Pi. Без него не подхватит.
- **Пакеты — исполняемый код.** Ставь с пином, читай что лезет. Откат — `pi remove`.
- **`pi -e npm:<pkg>`** — глотнуть пакет на один запуск без установки, чтобы не
  засорять контекст. Полезно «пощупать».
- Полный список паков — галерея `https://pi.dev/packages` (топ по закачкам),
  рядом `references/packages.md` с нашей выжимкой.

## Docs Pi (что читать про сам харнесс)

```
~/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/
├── packages.md       ← пакеты
├── skills.md         ← скиллы
├── settings.md       ← настройки (в т.ч. resources: skills/extensions/prompts/themes)
├── configuration.md  ← agent-dir, project .pi/, приоритеты
├── extensions.md     ← расширения
├── models.md         ← модели и провайдеры
└── custom-provider.md
```
