# Aura Team 0.5 — вкладка, кнопка в титулбаре, полная i18n

## Как устроено сейчас

- **Единственная поверхность — вкладка редактора** (Custom Editor: виртуальный документ
  `aura-team://panel/main`, viewType `auraTeam.panel`). Иконка в activity bar осталась и работает
  **лаунчером**: клик по ней открывает вкладку и сразу закрывает сайдбар — никакой боковой панели-плагина.
  В манифесте прописан `icon` — карточка расширения в маркете снова с иконкой.
- **Запуск вкладки**: команда `Aura Team: Open Aura Team`, статус-бар-аватар (справа внизу),
  и **кнопка «Aura Team» в титулбаре** — она заменила нативный «Sign In».
- Внутри вкладки: **Команды** (участники / доска задач / git), **Банк ключей**, **Профиль**.
- **Авторизация прямо во вкладке**: незалогиненного встречает форма «Вход / Создать аккаунт»
  (email + пароль, `POST /v1/auth/login|register` вашего сервера; регистрация — с верификацией email).
  Демо-режим (`auraTeam.demoMode`) остался только как фолбэк, когда сервер недоступен.
- **i18n**: полные словари `ru` и `en` в webview (язык — из `navigator.language`).
- Безопасность webview: CSP nonce, экранирование всего, что приходит из состояния.
- **Copilot** (пользовательский, не встроен): его «Sign In» и кнопки скрыты фильтром ядра
  (`github.copilot*` в `titlebarPart.ts`, коммит f5f558a); расширение остаётся установленным.
- **Системный чат живой и наш**: модели в штатный чат ядра отдаёт `AuraApiChatProvider`
  (`src/vs/workbench/contrib/auraApi/browser/auraApiChatProvider.ts`, имплементация
  `ILanguageModelChatProvider`) — ключи из банка, маршрут через `resolveKey`/round-robin.
  Copilot — лишь один внешний провайдер, его вход чату не нужен.
- ⛔ **`chat.disableAIFeatures: true` не использовать** — он отключил бы и чат, и наши модели.

## Что сделано по милстоунам

- [x] Реальная регистрация и вход с сервером (0.3–0.4)
- [x] Кнопка профиля в системном титулбаре (0.5 — правка ядра: accounts/Sign In убран,
      добавлен `Action2` в `MenuId.TitleBar` → `workbench.action.auraTeamOpen` → команда `auraTeam.open`)
- [x] Сайдбар убран; иконка activity bar — лаунчер, клик открывает вкладку (0.6)
- [x] Смена роли из UI (селект роли у owner в «Участниках»)
- [x] EN-локализация (полный словарь, хардкоды убраны в T())
- [x] Передача файлов через сервер: UI-витрина архивов во вкладке («Файлы»: список проектов, upload/download из UI, 0.7)
- [x] Передача проекта другому участнику (server PATCH /projects/:projectId, кнопка в «Файлы», владелец в карточке, 0.9)
- [x] Банк ключей: код готов (UI + health-пробы probeModel/cooldown в AuraApiKeysService); остался ручной e2e-прогон на живом сервере (нужна учётка)
- [x] Движение задач: статус, исполнитель и перетаскивание карточек — серверный updateTask (0.8)

## Файлы

- `extensions/aura-team/` — расширение (0.8; вкладка + иконка-лаунчер in activity bar)
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
