---
name: web-surf
description: >-
  Use when you need to search the internet or drive a real browser from OpenCode
  on this machine: SearXNG for finding sources (local, no API keys, no quotas)
  and Playwright MCP for navigating, clicking, running JS and taking screenshots.
  Includes MCP config, SearXNG HTTP setup, and the gotchas learned the hard way.
  Триггеры: «поищи в интернете», «загугли», «зайди на сайт», «нажми кнопку»,
  «вытащи со страницы», «сделай скрин», web search, browser, surf.
---

# Как я лазил в интернет: SearXNG + Playwright

Дневник одного ИИ. Машина: Fedora, `<host>`. Тут всё как было: зачем
поставили, как юзал, где наебнулось и как выкрутился. Без прикрас.

## Когда включать

- Надо **найти** что-то в сети, а не «дал ссылку на гугл» → SearXNG.
- Надо **сходить и сделать**: открыть страницу, кликнуть, залогиниться в форме,
  вытащить текст/ссылки из DOM, замерить состояние плеера, снять скрин →
  Playwright.
- Только searxng разрешён (tavily/fetch вырублены по просьбе). Встроенный
  `browser.*` без десктоп-сессии не работает — не полагайся на него.

**Главное правило:** SearXNG **ищет**, Playwright **делает**. Вместе = не «вот
ссылка», а «я сходил и сделал».

## Расклад (что стоит)

| Инструмент | Тип | Зачем | Статус |
|---|---|---|---|
| **searxng** | MCP (local) | поиск, обход 200+ движков | ✅ connected |
| **playwright** | MCP (local) | реальный браузер: навигация, клики, JS | ✅ connected |
| **fetch** | MCP (local) | простой тянщик URL→markdown | ⏸ disabled |
| **tavily** | MCP (local) | extract/crawl/research | ⏸ disabled |
| **browser.\*** | встроенный OpenCode | браузер в Review-панели | ⚠ нужен desktop-коннект |

SearXNG крутится **локально в докере** на `127.0.0.1:8080`.

## Конфиг MCP (`~/.config/opencode/opencode.jsonc`)

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
      }
    }
  }
}
```

Права файла — `600`. Ключи в конфиг зря не торчат.

Поднять движок после ребута (`restart=unless-stopped` уже стоит, но на всякий):

```bash
docker start searxng
```

Проверка, что живо:

```bash
export PATH="$HOME/.opencode/bin:$PATH"
opencode mcp list
```

## SearXNG — свой гугл

Движок агрегирует выдачу с кучи источников, **ключа и квоты нет** — гугли хоть
тысячу раз в день. Юзается через MCP-тул `searxng_web_search`: один вызов — куча
результатов с заголовком, описанием, URL и relevance score.

В `searxng/config/settings.yml` должно быть включено **JSON**, иначе MCP-сервер
получает не то, что ждёт:

```yaml
search:
  formats: [html, json, csv, rss]
server:
  limiter: false
  method: POST
```

Проверка API:

```bash
curl -s -X POST 'http://127.0.0.1:8080/search' --data 'q=searxng&format=json'
```

## Playwright — мои руки

Не «ищет», а **делает**:

- **навигация** — `browser_navigate`
- **JS на странице** — `browser_evaluate` (вытащить текст/ссылки из DOM)
- **клики и клавиши** — `browser_click`, `browser_press_key`
- **скрины** — `browser_take_screenshot`

Пример замера состояния плеера (не на словах, а цифрами):

```js
() => { const v = document.querySelector('video');
        v.muted = false; v.volume = 1; v.play();
        return {paused: v.paused, muted: v.muted, t: v.currentTime}; }
```

Вытащить ссылки из DOM:

```js
() => Array.from(document.querySelectorAll('a.result__a'))
      .map(a => ({t: a.innerText.trim(), u: a.href}))
```

## ГРАБЛИ (самое ценное)

Живой опыт без них не бывает. Вот где наебнулся и как выкрутился:

1. **`desktop browser is disconnected`** — встроенный `browser.*` требует, чтоб
   сессия была открыта в десктоп-приложении. Не подключён — команда падает.
   Для автоматизации юзай **Playwright MCP**, он сам поднимает браузер.
2. **Google прячет ссылки** — выдаёт `/goto?url=<мусор>`, прямого URL нет.
   Решение: юзать `html.duckduckgo.com` и расшифровывать `uddg`:

   ```js
   let h = a.href;
   const m = h.match(/uddg=([^&]+)/);
   if (m) h = decodeURIComponent(m[1]);   // чистый боевой URL
   ```

3. **Хабр сменил классы** — старые селекторы вернули пусто, сайт переверстали.
   Решение: не выпендриваться, добирать другим движком (DDG/SearXNG). Честно
   сказать «пусто», а не выдумать.
4. **В песочнице нет таймеров** — `setTimeout` даёт `ReferenceError`. Не жди
   паузой; `browser_navigate` и так дожидается загрузки.
5. **Скриншот требует `scale`** — `browser_take_screenshot()` без аргументов
   падает: `scale: Missing key`. Решение: `{ scale: "css" }` (или `"device"`
   для HiDPI).
6. **Звук — не гарантия** — плеер играет без мьюта (`muted:false`), но идут ли
   звуки в колонки, зависит от headed/headless. Честный вывод: «вижу, что поёт,
   слышно ли тебе — проверь сам».
7. **`openai.com` → 403** — Cloudflare не пустил `web_url_read`. Решение: идти
   через первоисточники-агрегаторы (API-чейнджлог, System Card, Википедия со
   ссылками на Reuters/CNBC). Не «сдался», а **обошёл**.

## SearXNG vs Playwright — кто за что

| | SearXNG | Playwright |
|---|---|---|
| Что делает | ищет по 200+ движкам | открывает и рендерит страницу |
| Скорость | быстро | медленнее (грузит реально) |
| Ключ/квота | нет | нет |
| JS-сайты | не откроет | ✅ открывает |
| Клики/кнопки | ✗ | ✅ |
| Лучше для | «найди N источников» | «зайди, нажми, вытащи» |

**Вместе:** SearXNG находит широко → Playwright ныряет в конкретную страницу.
Так и набралось **151 ссылка вместо 110** — не «больше», а **меньше дыр**.
