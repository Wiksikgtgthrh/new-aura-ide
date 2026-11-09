# Проверка сборки Aura IDE: Java/Kotlin/Android, ИИ-чат, Team — 2026-11-09

Проверялось на реальной сборке `../VSCode-win32-x64` (запуск с CDP, Playwright) и на живом
сервере `auraide.xyz` (94.141.160.70). Всё ниже — воспроизведено и перепроверено после правок.

## Что было сломано и что исправлено

| # | Проблема | Файл | Проверка |
|---|---|---|---|
| 1 | Вкладка «Ключи API» вообще не открывалась: `TypeError: This document requires 'TrustedHTML' assignment` (innerHTML в SVG-иконке) | `src/vs/workbench/contrib/auraApi/browser/auraApiEditorPane.ts` | вкладка рендерится, иконка-ключ на месте |
| 2 | Локальные OpenAI-совместимые шлюзы (Ollama, LM Studio, свои прокси) недоступны: CSP воркбенча запрещал `http:` | `src/vs/code/electron-browser/workbench/workbench.html` | ключ на `http://127.0.0.1:8799` проходит проверку (38 мс), чат отвечает |
| 3 | `aura-kotlin` падал при активации без открытой папки: `workspaceFolders![0]` | `extensions/aura-kotlin/src/classpath.ts` | расширение активируется в окне Welcome |
| 4 | Установка Java LSP не завершалась никогда: скачивание 51 МБ обрывалось на середине, попытки начинались с нуля, у запроса не было таймаута | `extensions/aura-kotlin/src/javaInstall.ts` | докачка Range-запросами, таймаут 45 с простоя, до 6 попыток; архив 50 357 408 Б |
| 5 | Распаковка падала: `tar` из Git Bash (GNU) принимает `C:` за удалённый хост («Cannot connect to C») | `extensions/aura-kotlin/src/javaInstall.ts` | берётся `System32\tar.exe`, фолбэк `--force-local` |
| 6 | Свежий jdtls-snapshot требует Java 25 — сервер молча выходил с кодом 13, в сообщении не было версии | `extensions/aura-kotlin/src/javaInstall.ts`, `javaLsp.ts` | читается требование из лога, предлагается и ставится Temurin JDK 25, статус «Java LSP работает» |
| 7 | 20 строк установки тулчейна уходили в интерфейс по-английски | `extensions/aura-kotlin/l10n/bundle.l10n.ru.json` | новый тест `test/l10n.test.mjs`: 179 ключей, 0 без перевода |
| 8 | Остановка эмулятора объявлялась «готово» раньше реального гашения (20 с < холодного выключения) | `extensions/aura-kotlin/src/android.ts` (STOP_TIMEOUT_MS 60 с) | эмулятор-тест 10/10 |
| 9 | Тесты `aura-kotlin` не запускались: отсутствовал стаб `vscode`, тесты ждали английские строки | `test/`, `package.json` | `npm test` в расширении: 5 наборов зелёные |
| 10 | Сборка падала на `rcedit` (косметика PE-ресурсов) при пути с не-ASCII | `build/gulpfile.vscode.ts`, `gulpfile.vscode.win32.ts` | сборка проходит, предупреждение в лог |

## Что проверено вживую

- **Эмулятор**: AVD Pixel_6_API_35 поднимается, `sys.boot_completed=1` за 5–11 с, серийник
  в статус-баре, остановка с ожиданием исчезновения, повторный запуск после остановки.
- **Kotlin**: LSP работает, диагностика на `Broken.kt` (ошибка типа видна), панель Android
  показывает устройства/эмуляторы/файлы.
- **Java**: jdtls поставлен и запущен, `Java LSP работает`, файлы `.java` открываются.
- **Чат**: ключ → проверка → модель в пикере → потоковый ответ (мок-сервер, SSE).
- **Team**: панель открывается, регистрация/вход через UI работают, сервер отвечает
  (регистрация, команда, проект, задачи, доска, ключи, приглашения, архивы, корзина).
- **Оркестратор**: панель и sidecar (`sidecar: ready`) работают.
- **Сервер**: `aura-team`, `ide-update`, `serverkit`, Caddy, Postgres — активны;
  `/health` 200; фид обновлений отдаёт 204 (обновлений нет).

## Тесты

| Набор | Результат |
|---|---|
| `extensions/aura-kotlin` — `npm test` | 5 наборов, все зелёные (classpath, l10n, состояние эмулятора, logcat 17/17, эмулятор 10/10) |
| `auraApi` (mocha, `out/.../*.test.js`) | 85 passing |
| `extensions/aura-team` — `npm test` | ALL 19 STEPS PASSED |
| `aura-team-server` — `npm test` | 23 pass, 0 fail |

## Не проверено

- Живой прогон Java-отладчика (JDWP) на устройстве и `Run Android App` с реальным APK.
- Запуск задач оркестратора (нужен API-ключ модели) и слияние worktree в Team.
- Многооконная работа Team (два клиента одновременно).

## Замечено, но не трогалось

В рабочем дереве параллельно появились правки, которых не было на старте проверки:
`extensions/aura-kotlin/src/android.ts`, `ui.ts`, `extension.ts`, `extensions/aura-serverkit/*`,
`extensions/aura-team/*`. Они типизируются чисто (`tsc --noEmit` = 0) и входят в сборку,
но их авторство не моё — стоит сверить с тем, кто их делал.
