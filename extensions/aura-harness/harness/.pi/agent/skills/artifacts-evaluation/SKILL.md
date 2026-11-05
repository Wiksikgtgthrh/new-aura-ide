---
name: artifacts-evaluation
description: >-
  Evidence bundle для каждого результата: gates-артефакты, дифф, ревью,
  скриншоты, release/rollback. Правило «нет доказательства, значит
  unverified». Включать перед сдачей задачи, перед итоговым отчётом и при
  оценке работы субагента.
---

# Artifacts & Evaluation

## Где лежит

```
.agent-state/
  tasks.json                 очередь задач и статусы
  events.jsonl               журнал событий (claim, finish, fail, approve)
  artifacts/
    gates-latest.json        последний verdict quality gates
    gates-<run>/summary.json + <gate>.log
    qa/<task-id>/*.png       скриншоты desktop и mobile
  approvals/release.json     approval релиза (кто, когда, HEAD)
  release/rollback.md        план отката
  bench/*.json               прогоны бенчмарка
```

`.agent-state/` не коммитится (`.git/info/exclude` и `.gitignore`).

## Bundle по типу задачи

| Задача | Обязательно |
|---|---|
| любая с кодом | `gates-latest.json` с verdict, `git diff --stat` |
| после ревью | вердикт reviewer + список findings |
| UI | скриншоты 1440 и 375 из qa |
| релиз | gates passed, scan 0, rollback.md, approval, `policy.mjs release` = OPEN |

## Вердикты

- `passed`: хотя бы один gate реально запускался и обязательные прошли.
- `failed`: обязательный gate упал или вышел по таймауту.
- `unverified`: ничего не запускалось (нет scripts или package.json). Это не passed.
- `finish --unverified` помечает задачу UNVERIFIED в статусе. Так и пиши в отчёте.

## Проверка чужой сдачи

1. Открой каждый путь из `evidence`. Нет файла значит claim ложный.
2. Сверь verdict в `gates-latest.json` с текстом отчёта.
3. Время `finishedAt` позже последнего изменения кода? Иначе gates устарели, перезапусти.

## Бенчмарк harness

`node "$HOME/.agent-harness/tools/bench.mjs" list` показывает 6 сценариев. `start <id> --agent pi --model <id>`, затем `score --run <file> --pass 1,2 --fail 3` и `report`. Сравнивай версии harness на одной модели.
