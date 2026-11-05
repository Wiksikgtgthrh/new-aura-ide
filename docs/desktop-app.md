# Aura IDE как настольное приложение (ярлык на рабочем столе + обновления)

Сейчас вы запускаете редактор из терминала (`./scripts/code.sh`). Aura IDE — это
форк VS Code, а значит его можно собрать в обычное настольное приложение
(Electron), которое запускается по двойному клику на иконке, как любое другое.

## Linux

```bash
./scripts/install-desktop.sh
```

Скрипт:
1. собирает приложение (`npm run gulp vscode-linux-x64`);
2. ставит его в `~/.local/share/aura-ide`;
3. создаёт ярлык `Aura IDE` в меню приложений и на рабочем столе.

После этого просто кликаете по иконке — приложение открывается как обычное окно.

## Windows

```bat
scripts\install-desktop.bat
```

Собирает `vscode-win32-x64` и создаёт ярлык «Aura IDE» на рабочем столе
(устанавливается в `%LOCALAPPDATA%\Programs\AuraIDE`).

## Обновления

Основной механизм — **встроенный авто-апдейт VS Code через свой сервер**.
Установленная копия при старте и раз в час запрашивает

```
GET https://auraide.xyz/api/update/win32-x64-user/ide/<commit>
```

и получает либо `204` («обновлений нет»), либо JSON с url установщика и
sha256. При наличии обновления клиент сам скачивает `IDESetup.exe`, сверяет
хеш и ставит его поверх в фоне — рассылать exe вручную больше не нужно.

Что где лежит:

| Что | Где |
| --- | --- |
| Фид обновлений (204/JSON) | `scripts/ide-update-server.mjs`, systemd-юнит `scripts/ide-updates/ide-update.service`, порт 3211 |
| Установщик | `/opt/ide-updates/public/IDESetup.exe` → `https://auraide.xyz/updates/IDESetup.exe` |
| Дескриптор релиза | `/opt/ide-updates/latest.json` (`version` = commit, `productVersion`, `url`, `sha256hash`) |
| Маршруты Caddy | `scripts/ide-updates/Caddyfile.snippet` |
| Публикация | `bash scripts/publish-ide-update.sh` |

Порядок публикации: **commit → push в GitHub → `publish-ide-update.sh`**.
Commit — это версия: если собрать поверх незакоммиченных изменений, клиенты
не увидят разницы и обновление не предложат (скрипт такую сборку запрещает).

Резервный механизм для разработки — `./scripts/update-aura.sh`: `git pull`,
пересборка и переустановка локально.

## Что это значит

- Икон на рабочем столе — да, после `install-desktop.sh` / `install-desktop.bat`.
- Изменения доходят до пользователей сами: закоммитили, запустили
  `publish-ide-update.sh` — у всех появилось «Доступно обновление».
- Кто не хочет ждать — «Проверить обновления» в редакторе.
