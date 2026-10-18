# DONE: a3-fix — доработка по ZAN-zan-a3.md

**Дата:** 2026-10-18 · **Билдер:** a3-fix · **Основание:** `docs/swarm/ZAN-zan-a3.md` (REQUEST_CHANGES)

## 1. Эмит aura-kotlin — AURA-016/017 теперь в билде ✅
`node node_modules/typescript/lib/tsc.js -p extensions/aura-kotlin/tsconfig.json` → exit 0.
`out/avdForm.js`: mtime 22:17 → **18.10 23:03**, 18312 → **18181 байт**.
Доказательства в компиляте: `crypto.randomUUID()` — :56 (1 вхождение); `(0, l10n_1.tr)(` — **28 вызовов**; `Date.now()`-nonce — 0; `<title>Новый эмулятор</title>` хардкода — 0; кириллица — только в комментариях (строки 3–6, 134, 192). `node --check out/avdForm.js` — OK.
aura-serverkit и aggg-agent src не правились (diff 0 строк / src отсутствует) — их эмит не требовался; `node --check aura-serverkit/out/extension.js` — OK.

## 2. aura-serverkit — EN-база + RU-оверлей ✅
`package.nls.json` переписан на **английский** (был русским с ba9fc3eb), `package.nls.ru.json` — **русский** (был байт-копией). Теперь EN-локаль → английский, RU → русский, функциональная дельта ненулевая.
Прогон-сверка каждого `%ключа%` манифеста: 6 используемых (`displayName`, `description`, `configuration.title`, `configuration.serverUrl`, `command.openDashboard`, `command.checkStatus`) — присутствуют в обоих файлах; missing: нет; **dead: нет** (мёртвые `container.title`, `view.home` удалены); кириллица: EN — нет, RU — да; оба JSON валидны.

## 3. Счётчики в DONE-a3.md ✅
«18 строк» → «20 строк (18 новых + 2 существовавших)»; бандл «172–189» → «171–188»; «extension.ts:423» → «425»; serverkit-пункт переписан честно.

## Гейты
| Проверка | Результат |
|---|---|
| tsc emit aura-kotlin | exit 0 |
| tr(/randomUUID/Date.now в out/avdForm.js | 28 / 1 / 0 |
| node --check avdForm.js, serverkit/out/extension.js | OK ×2 |
| nls ключи vs манифест | 6/6, dead 0, JSON valid |
Ничего не закоммичено. Вне зоны (не трогал): экранирование tr() в JS-строках webview; удалённый `icon` в serverkit/package.json — чужой след.
