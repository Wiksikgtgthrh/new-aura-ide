---
name: mcp-setup
description: >-
  Как ставить и настраивать MCP-серверы в OpenCode2 (v2): где лежит конфиг, формат
  mcp.servers (local/remote), включение/выключение, проверка через `opencode mcp list`,
  зависимости (npx/uvx/docker), секреты и грабли. Референсы по темам — рядом
  (напр. references/web.md про fetch/playwright/searxng/tavily).
  Триггеры: «подключи MCP», «настрой mcp», «добавь mcp сервер», «opencode.jsonc mcp»,
  «mcp не работает», «mcp list», «tavily/searxng/playwright/fetch mcp».
---

# MCP в OpenCode2 — установка и настройка

MCP (Model Context Protocol) — способ дать агенту «органы»: поиск, браузер, тянщик
URL и т.п. Каждый сервер — отдельный процесс, который OpenCode поднимает при старте
сессии и отдаёт его тулы модели.

## Где конфиг

- Глобальный: `~/.config/opencode/opencode.jsonc` (Windows: `%APPDATA%\opencode\`).
- Проектный: `opencode.jsonc/json` в корне проекта.
- JSONC — комментарии и хвостовые запятые разрешены.

## Формат (проверено на opencode v2.0.17)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "имя-сервера": {
        "type": "local",
        "command": ["npx", "-y", "<пакет>"],
        "environment": { "КЛЮЧ": "значение" },
        "disabled": true
      }
    }
  }
}
```

- `type: "local"` — запускаем процесс. `type: "remote"` — ходим на URL (`"url": "https://…"`, при нужде `"headers": {}`).
- `command` — массив (команда + аргументы), напр. `["npx","-y","mcp-searxng"]`.
- `environment` — переменные для процесса (ключи API — сюда, не в argv!).
- `disabled: true` — выключен; `false`/отсутствует — включён.

> Нюанс: опубликованная схема `opencode.ai/config.json` описывает `mcp.<имя>` и
> `enabled`. Наш рабочий v2.0.17 читает именно `mcp.servers.<имя>` и `disabled` —
> держимся проверенного варианта.

## Жизненный цикл

1. Правишь `opencode.jsonc`.
2. Перезапускаешь сессию/OpenCode (серверы поднимаются при старте).
3. Проверяешь: `opencode mcp list` → `✓ <имя> connected` или `○ <имя> disabled`.

```bash
opencode mcp list
# ✓ playwright  connected
# ✓ searxng     connected
# ○ tavily      disabled
```

## Зависимости

| Чем запускается | Нужно в PATH |
|---|---|
| JS-сервера (`npx …`) | `node` + `npx` |
| Python-сервера (`uvx …`) | `uv` / `uvx` |
| Докер-сервера | `docker` |

Ставь то, чем реально запускаешь: `npm i -g` не обязателен, `npx -y` скачает сам.

## Включить / выключить

- Вкл/выкл — `"disabled": true` ↔ убрать/`false`.
- Быстрый тумблер без удаления: оставляешь блок, меняешь только `disabled`.

## Секреты

- API-ключи — только в `environment`; файл конфига держи `600`.
- В git не коммитить; в скиллах/доках — плейсхолдеры (`<TAVILY_API_KEY>`), не реальные.
- В argv и логи ключи не пихать.

## Грабли

- **Сервер `disabled` в `mcp list`** → забыл снять `disabled` (или поставил `true`).
- **Не `connected`** → нет команды/пакета (`npx`/`uvx` не в PATH), опечатка в имени пакета, нет сети на первую закачку.
- **Тул не появился у модели** → сессию не перезапустил после правки конфига.
- **Таймауты** → у local/remote есть `timeout` (мс); тяжёлым серверам можно поднять.
- **`mcp.servers` vs `mcp`** → если твоя версия не понимает `servers`, переноси сервера на верхний уровень `mcp` и `disabled` → `enabled: false`.

## Референсы

- [`references/web.md`](references/web.md) — веб-набор: **searxng, playwright, fetch, tavily** — что делают, команды, зависимости, как включить.
- [`references/frontend.md`](references/frontend.md) — фронтенд-набор: **playwright, chrome-devtools, context7, shadcn, figma** — зачем, команды, грабли.
