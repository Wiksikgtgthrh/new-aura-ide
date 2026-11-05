# Web-MCP: SearXNG, Playwright, Fetch, Tavily

Веб-набор: поиск + реальный браузер + тянщик страниц. Все — `type: "local"`.

## Что за что

| Сервер | Пакет | Роль | Зависимость |
|---|---|---|---|
| **searxng** | `mcp-searxng` (npx) | поиск по 200+ движкам, без ключей/квот | работающий SearXNG c JSON |
| **playwright** | `@playwright/mcp@latest` (npx) | реальный браузер: навигация, клики, JS, скрины | Node (браузер тянет сам) |
| **fetch** | `mcp-server-fetch` (uvx) | URL → markdown, простые страницы | Python / `uvx` |
| **tavily** | `tavily-mcp@latest` (npx) | extract/crawl/research по API | ключ Tavily |

## Конфиг (собрать вместе)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "searxng": {
        "type": "local",
        "command": ["npx", "-y", "mcp-searxng"],
        "environment": { "SEARXNG_URL": "http://127.0.0.1:8080" }
      },
      "playwright": {
        "type": "local",
        "command": ["npx", "-y", "@playwright/mcp@latest"]
      },
      "fetch": {
        "type": "local",
        "command": ["uvx", "mcp-server-fetch"],
        "disabled": true
      },
      "tavily": {
        "type": "local",
        "command": ["npx", "-y", "tavily-mcp@latest"],
        "environment": {
          "TAVILY_API_KEY": "<TAVILY_API_KEY>",
          "DEFAULT_PARAMETERS": "{\"max_results\": 10, \"search_depth\": \"advanced\"}"
        },
        "disabled": true
      }
    }
  }
}
```

Проверка: `opencode mcp list`.

## searxng — свой гугл

- Нужен **работающий SearXNG** (обычно локально в докере на `127.0.0.1:8080`).
- В `searxng/config/settings.yml` включить **JSON** — иначе MCP получает не то:

  ```yaml
  search:
    formats: [html, json, csv, rss]
  server:
    limiter: false
    method: POST
  ```

- Поднять: `docker start searxng`. Проверка API:
  `curl -s -X POST 'http://127.0.0.1:8080/search' --data 'q=searxng&format=json'`
- Тул: `searxng_web_search`. Ключей и квот нет.
- Грабли: `SEARXNG_URL` не тот порт; JSON выключен; движок не запущен после ребута.

## playwright — руки агента

- `browser_navigate`, `browser_evaluate` (JS в DOM), `browser_click`,
  `browser_press_key`, `browser_take_screenshot`.
- Скрин без аргументов падает — нужен `{ scale: "css" }` (или `"device"`).
- JS-сайты, клики, формы — только он. Для «просто вытащить текст» хватит fetch.
- Грабли: в песочнице нет таймеров (`setTimeout` → ReferenceError); не жди паузой,
  `browser_navigate` и так ждёт загрузку.

## fetch — URL → markdown

- Команда: `uvx mcp-server-fetch` (Python-сервер, нужен `uv`/`uvx`).
- Простой тянщик: отдать URL, получить markdown. Легче Playwright для статики.
- Грабли: `403` от Cloudflare/anti-bot (напр. `openai.com`) — идти через
  первоисточники/агрегаторы или Playwright. Скрипты JS не выполняет.

## tavily — API поиск/краулинг

- Команда: `npx -y tavily-mcp@latest`, ключ `TAVILY_API_KEY` (с tavily.com, формат `tvly-…`).
- Умеет search/extract/crawl/research. `DEFAULT_PARAMETERS` — JSON-строка с дефолтами
  (`max_results`, `search_depth`).
- Ключ — только в `environment`; в git/скиллы не тащить, держать плейсхолдером.
- Грабли: ключ кончился/лимит; ключ в открытом виде в конфиге (файл `600`).

## Когда что

| Задача | Инструмент |
|---|---|
| «найди N источников» | searxng |
| «зайди, нажми, вытащи» | playwright |
| «дай markdown по URL» | fetch |
| «research/crawl по API» | tavily |

Связка: **searxng находит широко → playwright ныряет в страницу**. fetch/tavily —
когда не нужен живой браузер.
