---
name: github
description: >-
  Работа с GitHub через gh CLI: issues, pull requests, ревью, CI-проверки,
  релизы, поиск по коду и истории. Включать, когда задача касается репозитория
  на GitHub, а не только локального git.
---

# GitHub

Инструмент — `gh` (официальный CLI). Нет `gh` или `gh auth status` падает — скажи
об этом и остановись. Не подставляй токен в команды, URL или файлы.

## Шаг 0. Контекст

- `gh auth status`, `gh repo view --json nameWithOwner,defaultBranchRef`.
- Текущая ветка и её PR: `gh pr status`, `gh pr view --json number,state,headRefName`.
- Машинный вывод — всегда `--json <поля>` (+ `--jq`), не парси человекочитаемый текст.

## Чтение (без подтверждения)

- Issues: `gh issue list --state open --label bug --json number,title,labels,updatedAt`.
- PR: `gh pr view <n> --json title,body,files,reviews,statusCheckRollup`, дифф — `gh pr diff <n>`.
- CI: `gh pr checks <n>`; упавший прогон — `gh run view <id> --log-failed`.
  Сначала читай лог упавшего шага, потом чини. Не перезапускай CI вслепую.
- Код и история: `gh search code`, `gh search issues`, `git log -S`/`git blame` локально.
- Любой API: `gh api repos/{owner}/{repo}/...` (только GET без подтверждения).

## Запись (через approval-policy)

Создание и изменение в удалённом репозитории — действие с внешним эффектом:
показать, что будет сделано, и получить подтверждение. Без исключений для:
`gh pr merge`, `gh release create`, `gh repo delete/edit`, `git push --force`,
изменения веток по умолчанию, секретов, workflow-файлов в `.github/workflows/`.

- PR: ветка от актуальной базы → коммиты по смыслу → `gh pr create --title ... --body-file <файл>`.
  Тело PR: что и зачем, как проверено (команды и результат gates), риски, что не сделано.
- Комментарии к ревью: отвечай по существу на каждый, не закрывай разговор без изменения или объяснения.
- Issue: воспроизведение, ожидаемое/фактическое, окружение, ссылка на лог. Без воды.

## Ревью чужого PR

1. `gh pr checkout <n>` в отдельном worktree (скилл agent-orchestration), не в рабочей ветке.
2. Прогнать gates проекта, потом читать дифф (скилл code-review).
3. Замечания с файлом и строкой, разделяя «блокер» и «пожелание». Без похвалы ради похвалы.

## Запрещено

- Мержить свой же PR без явного разрешения пользователя.
- Отключать проверки, branch protection или правила ради «зелёного» статуса.
- Коммитить секреты; при обнаружении — остановиться и сообщить, а не тихо переписывать историю.
