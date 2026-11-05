
# Windows-порт и доставка изменений

Живой процесс, которым мы реально портируем и отдаём код. Без TDD — только
живая проверка: запустил, увидел, показал. Каждый шаг проверяем, не верим на слово.

## Часть 1. Разведка (не гадать — смотреть)

Прежде чем резать код, выясни факты командой:

```powershell
node -v; npm -v
(Get-Command ffmpeg, tar, curl, python, 7z, gh -ErrorAction SilentlyContinue).Source
Test-Path "$env:SystemRoot\System32\clip.exe"      # буфер обмена
wsl -l -v 2>$null                                   # есть ли линуксовый слой
```

Ищи по коду ВСЁ, что завязано на ОС:
- внешние бинари (`pw-record`, `wl-copy`, `ydotool`, `gsettings`, `ffmpeg`);
- пути/устройства (`/dev/input`, `:` в PATH как разделитель);
- системные сервисы (`systemd`, `udev`, `launchd`);
- скрипты-обёртки (`.sh`, лаунчеры, PID-файлы);
- нативные зависимости (проверь, есть ли пребилд под Windows).

Правило: ядро (логика, сеть, UI) чинить не надо. Пересаживаем только «руки-ноги».

## Часть 2. Архитектура — platform-слой (главный приём)

Не раскидывай `if (isWindows)` по коду. Спрячь платформу за фасад. Ядро о ОС не
знает и не меняется.

```
src/platform/
  index.mjs      ← выбирает адаптер по process.platform
  posix.mjs      ← ре-экспорт СТАРЫХ модулей как есть (поведение Linux не меняется)
  win/…          ← новые адаптеры
```

```js
// src/platform/index.mjs
import * as posix from './posix.mjs';
import * as win from './win/index.mjs';
const impl = process.platform === 'win32' ? win : posix;
export const Recorder = impl.Recorder;
export const injectText = impl.injectText;
export const HotkeyListener = impl.HotkeyListener;
export const setFallbackBinding = impl.setFallbackBinding;
```

```js
// src/platform/posix.mjs — ноль изменений в поведении Linux
export { Recorder } from '../recorder.mjs';
export { injectText, injectionStatus } from '../inject.mjs';
export { HotkeyListener } from '../evdev.mjs';
export { setGnomeBinding as setFallbackBinding, disableGnomeBinding as disableFallbackBinding } from '../gnome.mjs';
```

Ядро просто меняет одну строку импорта на фасад. Всё.

### Типовые замены Linux → Windows

| Задача | Linux | Windows |
|---|---|---|
| запись микрофона | `pw-record` | `ffmpeg -f dshow -i audio="<dev>"` (можно `ffmpeg-static`) |
| вставка в окно | `wl-copy` + `ydotool` | `Set-Clipboard` + `SendKeys('^v')` (PowerShell) |
| глобальный хоткей | `evdev` (`/dev/input`) | `uiohook-napi` (keydown+keyup) |
| автозапуск | systemd user unit | `schtasks /Create /SC ONLOGON` |
| запасной хоткей ОС | `gsettings` (GNOME) | не нужен (no-op) |
| загрузка модели | `curl` + `tar` | `fetch` + (tar → python → 7z) |

Совет: `ffmpeg-static` и `uiohook-napi` — нативные, но тянут пребилды; проверь
загрузку `require`/`import` на актуальном Node, до того как строить на них всё.

## Часть 3. Живая верифа (обязательна на КАЖДОМ куске)

Не «должно работать», а прогнал и увидел. Наш набор:

```powershell
# 1) нативное грузится
node -e "require('uiohook-napi'); console.log('uiohook ok')"
node -e "const p=require('ffmpeg-static'); const fs=require('fs'); console.log(fs.existsSync(p))"

# 2) модель/движок — на готовых сэмплах, без микрофона
node --input-type=module -e "import {createRecognizer,transcribeWav} from './src/stt.mjs'; import fs from 'node:fs'; const r=createRecognizer(); console.log(transcribeWav(r, fs.readFileSync('models/.../test_wavs/en.wav')))"

# 3) сервер
curl -s http://127.0.0.1:7777/health
curl -s http://127.0.0.1:7777/state

# 4) запись: start → пауза → stop → длина PCM
#    (проверяй через прямой вызов класса, а не вслепую через /toggle)
```

**Проверка буфера обмена (кириллица) — сравнивание ВНУТРИ PowerShell.** Читать
`Get-Clipboard` наружу нельзя: Windows PowerShell отдаёт OEM-кодировку и всё
мангается. Делай так: положи через `Set-Clipboard`, тут же прочти и выведи только
ASCII-результат `same=True/False`.

**Через `/toggle` вслепую не дёргай** — это вставит текст в активное окно. Для
отладки ставь `NO_INJECT=1` или зови классы напрямую.

## Часть 4. Грабли Windows (мы на них наступали — не повторяй)

1. **npm 11+ блокирует install-скрипты** → нативные бинарники не ставятся.
   Лечение: `npm rebuild <pkg>` (наши: `uiohook-napi ffmpeg-static`).
2. **`Out-File` в PowerShell подменяет LF→CRLF** и **ломает git-патч**.
   Патч выпускай байт-в-байт через cmd-редирект:
   `cmd /c "git -C <repo> diff main..feat > out.patch"`.
3. **`$` в двойных кавычках pwsh съедается шеллом** до того, как долетит до
   `node -e`. Тесты и скрипты с `$` пиши файлом, а не однострочником.
4. **Новый ffmpeg не печатает заголовок** `DirectShow audio devices` — тип помечен
   в строке: `"Имя" (audio)`. Парси оба формата.
5. **Разделитель PATH** на Windows `;`, на Linux `:`. `which()` руками не пиши —
   бери готовое или учитывай ОС.
6. Запись файлов из PowerShell — через
   `[System.IO.File]::WriteAllText(path, s, [System.Text.UTF8Encoding]::new($false))`,
   иначе BOM ломает сборку (Vite/Rolldown: «stream did not contain valid UTF-8»).
7. `SendKeys`/хоткей не работают через границу UAC (в элевированные окна не
   вставит). Хоткей `ctrl+v` + вставка Ctrl+V = рекурсия (предупреди в README).

## Часть 5. Git: коммит и проверка патча

```powershell
git checkout -b feat/<тема>            # main не трогаем
git add -A; git commit -m "feat(win): …"
git diff --stat origin/main..feat/<тема>
```

**Всегда проверяй патч на чистом `main` через worktree** — не отдавай непроверенное:

```powershell
git worktree add -q --detach $tmp origin/main
git -C $tmp apply --check $patch       # должно быть 0 ошибок
git worktree remove --force $tmp
```

Три артефакта для передачи (по возрастанию удобства, по убыванию строгости):

| Артефакт | Команда | Плюс | Минус |
|---|---|---|---|
| bundle 🥇 | `git bundle create x.bundle feat` | точный коммит + автор | нужен git у получателя |
| patch 🥈 | `git diff … > x.patch` | `git apply` | автор/история теряются |
| zip 🥉 | `git archive … --add-file=NOTE.txt` | просто распаковать | без git вообще |

```powershell
# zip только с изменениями (без node_modules/models/.git)
$files = git diff --name-only origin/main..feat/<тема>
git archive --format=zip -o out.zip --add-file=NOTE.txt feat/<тема> -- $files
```

## Часть 6. Доставка, когда нет прав на репозиторий

Права коллаборатора для PR **не нужны**. Нужен свой GitHub-аккаунт.

- **Форк** чужого публичного репо → push в свой форк → **PR** из форка в оригинал.
- Форк и push — **тихо**, владелец уведомлений не получает (виден лишь счётчик
  Forks).
- **Открытие PR — заметно**: владелец получает уведомление, PR публичен (ник,
  коммиты, diff).
- Нет аккаунта GitHub → PR невозможен. Тогда патч/zip **в личку владельцу**.
- Авторизация на машине: Git Credential Manager (окно браузера при `git push`)
  или `gh auth login`. Токен **не** кидать в чат/argv.

```powershell
git remote add fork https://github.com/<ник>/<repo>.git
git push -u fork feat/<тема>
# дальше на GitHub: Compare & pull request
```

## Часть 7. Память по итогу

- Выжимку сессии — в `Projects\Session-Context\<проект>\<дата>-<тема>.md`:
  что делали, решения, грабли, что проверено, что осталось.
- Сводку — в `AGENTS-SUMMARY.md` (раздел проекта + журнал изменений).
- Не выдумывать; факт / вывод / гипотезу держать раздельно.

## Чек-лист (короткий)

- [ ] Разведка: окружение + список ОС-зависимостей
- [ ] platform-слой; Linux-модули перенесены как есть
- [ ] win-адаптеры: recorder / inject / hotkey / autostart
- [ ] Живая верифа: нативка, движок, сервер, запись, буфер
- [ ] Лаунчер + универсальный загрузчик модели + README-раздел
- [ ] Ветка + коммит; патч проверен на чистом main (worktree)
- [ ] Артефакты bundle/patch/zip; проверить каждый
- [ ] Доставка: fork→PR или патч в личку
- [ ] Выжимка в Session-Context + AGENTS-SUMMARY.md
