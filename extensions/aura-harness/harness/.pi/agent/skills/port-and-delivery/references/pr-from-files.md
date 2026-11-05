
# PR из файлов: bundle / patch / zip → PR → merge

Воркфлоу для случая, когда у автора наработок **нет доступа на push** в репу, и он
присылает их файлами. Задача — влить аккуратно, через PR, ничего не сломав.

## Когда подключать

- «Пришёл PR» / «скинули файлы» / «долей в репу» — а на деле это bundle/patch/zip.
- Надо влить чужую ветку, проверить и смержить.

## Выбор формата

| | Формат | Чем хорош |
|---|---|---|
| 🥇 | **git bundle** | ветка + история + авторство, тянется `git fetch` |
| 🥈 | **.patch** | то же текстом; `git am` сохранит коммит |
| 🥉 | **.zip / просто файлы** | снапшот; накладывать поверх клона и смотреть дифф глазами |

Проверка bundle:

```bash
git bundle verify voiceog.bundle
git bundle list-heads voiceog.bundle          # какие ветки/коммиты внутри
git fetch voiceog.bundle refs/heads/<br>:refs/heads/<tmp>   # тащим во временный ref (main не трогаем)
```

## Главное: понять связь с `main`

Не верь заголовку. «Полная история» не значит «поверх main».

```bash
git rev-parse --short main <tmp>
git merge-base main <tmp>
git log --oneline main..<tmp>     # что нового у них
git log --oneline <tmp>..main     # что у нас сверх них
git diff main...<tmp>             # итоговый дифф
```

- `merge-base == main` → ветка **поверх** нашей → чистое продолжение.
- `merge-base == старый коммит`, а мы уже влили похожее → возможно **параллельная
  версия**; merge может молча откатить наши правки (проверь `git diff main...<tmp>`).

## Patch

```bash
git apply --stat x.patch      # что заденет
git apply --summary x.patch   # что создаёт/удаляет
git am x.patch                # наложить С коммитом (формат git format-patch)
git apply x.patch             # просто наложить (сделаешь свой коммит)
```

## Zip / просто файлы

Распаковать **поверх клона** (заменит те же файлы) → `git diff` глазами → коммит.
Если есть текстовый readme с инструкциями (типа `WINDOWS-PORT.txt`) — прочитай,
там шаги установки.

## Обязательно: живая верификация ДО мержа

- Ядро проверяем **живьём** на этой машине (наши правила: тесты не пишем, запускаем).
- Чужую ОС (Windows и т.п.) отсюда не проверить → **PR как гейт**, тест на целевой
  машине, мерж после подтверждения.
- Не мешать работающему сервису — сообразить временную копию:

```bash
git worktree add --detach /tmp/opencode/check <tmp>
cd /tmp/opencode/check && ln -sfn <repo>/models models && npm install
# запустить на ДРУГОМ порту, проверить /health и /api/*, потом убрать:
git worktree remove --force /tmp/opencode/check
```

## Влить: ветка → PR → merge

```bash
git push origin refs/heads/<tmp>:refs/heads/feat/<name>
gh pr create --base main --head feat/<name> --title "..." --body "..."
gh pr view <N> --json mergeable,state
gh pr merge <N> --merge --delete-branch
git checkout main && git pull && git fetch --prune
git branch -D <tmp>
```

## После мержа — не забыть

- **Новые зависимости** → `npm install`, иначе сервис упадёт при следующем старте.
- **Нативные модули** → грузить **лениво** только под своей ОС (`await import()` под
  `win32`/`linux`), чтобы чужая не тянулась вхолостую.
- **Перезапустить сервис** и проверить лог/`/health`.
- **Свои фиксы могли откатиться** merge'ом — проверь, что на месте.

## Грабли-сводка

| Грабля | Решение |
|---|---|
| merge молча откатил твои правки | сначала `merge-base`: continuation vs parallel |
| «полная история» ≠ «поверх main» | смотри `merge-base`, а не заголовок |
| после мержа сервис падает | `npm install` для новых зависимостей |
| нативный модуль чужой ОС в процессе | ленивый импорт |
| проверка ломает рабочий сервис | `git worktree` + другой порт |
| чужую ОС здесь не проверить | PR как гейт + тест на целевой машине |

## Чек-лист

1. `bundle verify` / `list-heads` → `fetch` во временный ref.
2. `merge-base` → это продолжение?
3. `diff` глазами + живая верификация во временной копии.
4. Пушить ветку → `gh pr create`.
5. `gh pr merge --merge --delete-branch` → `pull main` → `prune`.
6. `npm install` + рестарт сервиса + проверка.
