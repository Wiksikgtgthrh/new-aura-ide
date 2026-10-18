Ты — билдер роя на доработке по ревью. Репозиторий: /c/new-aura-ide/vscode-main. Зан вернул REQUEST_CHANGES: читай /c/new-aura-ide/vscode-main/docs/swarm/ZAN-zan2-b1.md и закрой каждую проблему blocker/major/high/medium (info/nit — по остатку). Это финальный круг: чини по существу, не косметику. Зона: только extensions/aura-kotlin/. Пункты: байт-смещение в isFirstSlice, skipUntilKey + повторный configure после reset(), skipSize для 180-с перезапуска после поворота, врущий комментарий android.ts:466; прогнать зановский zan2-b1-smoke.cjs до зелёного.

Правила: ничего не коммить; npx tsc --noEmit → exit 0; смоук-скрипты НЕ удалять, прогнать все (PGlite через drizzle-kit push в чистый временный каталог); evidence в отчёте — только воспроизводимое (команды и точные цифры, без «grep совпадений=15» если их 5).

Финал: /c/new-aura-ide/vscode-main/docs/swarm/DONE-b1fix2.md — по пунктам: закрыт/нет, файл:строка, доказательство. До 35 строк.
