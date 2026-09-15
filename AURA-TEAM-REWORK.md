# Aura Team 0.5 — вкладка, кнопка в титулбаре, полная i18n

## Как устроено сейчас

- **Единственная поверхность — вкладка редактора** (Custom Editor: виртуальный документ
  `aura-team://panel/main`, viewType `auraTeam.panel`). Activity-bar сайдбар **полностью удалён**
  (`viewsContainers`/`views`/лаунчер выпилены) — клик по иконке/команде больше не открывает боковую панель.
- **Запуск вкладки**: команда `Aura Team: Open Aura Team`, статус-бар-аватар (справа внизу),
  и **кнопка «Aura Team» в титулбаре** — она заменила нативный «Sign In».
- Внутри вкладки: **Команды** (участники / доска задач / git), **Банк ключей**, **Профиль**.
- **Авторизация прямо во вкладке**: незалогиненного встречает форма «Вход / Создать аккаунт»
  (email + пароль, `POST /v1/auth/login|register` вашего сервера; регистрация — с верификацией email).
  Демо-режим (`auraTeam.demoMode`) остался только как фолбэк, когда сервер недоступен.
- **i18n**: полные словари `ru` и `en` в webview (язык — из `navigator.language`).
- Безопасность webview: CSP nonce, экранирование всего, что приходит из состояния.

## Что сделано по милстоунам

- [x] Реальная регистрация и вход с сервером (0.3–0.4)
- [x] Кнопка профиля в системном титулбаре (0.5 — правка ядра: accounts/Sign In убран,
      добавлен `Action2` в `MenuId.TitleBar` → `workbench.action.auraTeamOpen` → команда `auraTeam.open`)
- [x] Сайдбар убран, вкладка — единственная поверхность (0.5)
- [x] Смена роли из UI (селект роли у owner в «Участниках»)
- [x] EN-локализация (полный словарь, хардкоды убраны в T())
- [ ] Передача файлов через сервер: UI-витрина архивов (команды uploadArchive/downloadArchive готовы, витрины во вкладке нет)
- [ ] Банк ключей: UI готов (добавление/disable), прогнать end-to-end на живом сервере
- [ ] Движение задач между статусами — сейчас optimistic + серверный updateTask

## Файлы

- `extensions/aura-team/` — расширение (0.5; только вкладка, сайдбара нет)
- `src/vs/workbench/browser/parts/titlebar/titlebarActions.ts`, `titlebarPart.ts` — кнопка титулбара
- `aura-team-server/` — сервер (деплой на VPS: `deploy/server-setup.sh`)

## Как собрать у себя (C:\new-aura-ide\vscode-main)

```bash
git pull upstream main
npm install
npm run compile          # перекомпиляция ядра (затронут titlebar)
./scripts/code.bat
```

Расширение отдельно: `npm run gulp -- compile-extension:aura-team`.
