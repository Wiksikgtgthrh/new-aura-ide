---
name: security-audit
description: >-
  Аудит безопасности кода и конфигурации: секреты, auth и авторизация, инъекции,
  SSRF, XSS, CSRF, зависимости, заголовки, права MCP и агентов. Включать перед
  релизом, при ревью auth/платежей/загрузки файлов и при подозрении на утечку.
---

# Security Audit

## Автоматически

```bash
node "$HOME/.agent-harness/tools/policy.mjs" scan          # секреты в git-файлах
node "$HOME/.agent-harness/tools/policy.mjs" scan --staged # перед коммитом
pnpm audit --prod || npm audit --omit=dev                  # уязвимые зависимости
```

Нашёл секрет: удалить из кода, ротировать ключ у провайдера, проверить историю git (`git log -S '<префикс>'`). Удаления из последнего коммита мало.

## Вручную, по приоритету

1. **Авторизация**: каждый эндпоинт и server action проверяет сессию и владельца ресурса (IDOR). Запросы фильтруются по user id.
2. **Инъекции**: SQL только параметризованно, shell без конкатенации пользовательского ввода, пути через `path.resolve` + проверка префикса.
3. **SSRF**: fetch по URL от пользователя только по allowlist хостов, без 127.0.0.0/8, 169.254.169.254, приватных сетей.
4. **XSS**: нет `dangerouslySetInnerHTML`/`innerHTML` с пользовательскими данными без санитайзера.
5. **CSRF и cookies**: `HttpOnly`, `Secure`, `SameSite`, state-changing только POST с проверкой origin.
6. **Загрузка файлов**: лимит размера, проверка типа по содержимому, хранение вне web root.
7. **Заголовки**: `X-Content-Type-Options`, `Referrer-Policy`, HSTS, CSP сначала report-only.
8. **Rate limit** на логин, регистрацию, AI- и платёжные эндпоинты.

## Агенты и MCP

- MCP с least privilege: браузер и поиск для QA и ресёрча, проектные MCP только по задаче.
- Ключи MCP только через `{env:VAR}` в OpenCode-конфиге, не открытым текстом. `doctor.mjs` это проверяет.
- Субагенты без нужды не получают `edit`/`bash`.

## Отчёт

Findings: severity, file:line, сценарий атаки одной строкой, фикс. Blocker/high блокируют релиз.
