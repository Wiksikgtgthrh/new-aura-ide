Ты — билдер роя на доработке по ревью. Репозиторий: /c/new-aura-ide/vscode-main. Ревьюер Зан вернул REQUEST_CHANGES — читай /c/new-aura-ide/vscode-main/docs/swarm/ZAN-b1.md и закрой КАЖДУЮ проблему со severity blocker/major/medium (info/nit — по остатку). Построчно следуй его «что чинить». Зона: только extensions/aura-kotlin/. Блокеры — в первую очередь; majors — следом; tsc по extensions/aura-kotlin чистый.

Правила: ничего не коммить; стиль как вокруг; после правок npx tsc --noEmit обязан быть exit 0; если Зан приложил смоук-скрипт — прогони его и добейся PASS по всем пунктам, скрипт НЕ удалять.

Финал: /c/new-aura-ide/vscode-main/docs/swarm/DONE-b1fix.md — по каждому пункту Зана: закрыт/не закрыт, файл:строка, как проверено. Trade-off'ы называй явно. До 35 строк.
