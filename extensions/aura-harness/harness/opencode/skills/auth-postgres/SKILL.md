---
name: auth-postgres
description: >-
  PostgreSQL + регистрация/вход из коробки: поднять БД в docker, схема
  users/sessions, хэширование паролей (scrypt), эндпоинты register/login/logout/me,
  httpOnly-cookie сессии, миграции. Включать, когда сайту нужна «настоящая»
  регистрация, личный кабинет, БД, PostgreSQL, «сделай бэкенд для auth»,
  «сгенерируй бд для сайта», корзина/заказы в базе.
---

# Auth + PostgreSQL из коробки

Сайт просит регистрацию → не лепи localStorage, поднимай настоящий бэкенд.
Готовый шаблон: `~/.agent-harness/templates/backend/auth-postgres/` — копируй
в проект и адаптируй. Стек шаблона: Node + `pg` + scrypt (ноль нативных
зависимостей — работает на Windows без сборки).

## Порядок действий

1. **БД**: `docker compose up -d` из шаблона (postgres:16, порт 5432, volume).
   Docker не запущен → запусти Docker Desktop и подожди демон.
2. **Миграция**: `migrations/001_init.sql` (users + sessions + индексы).
   Применить: `docker exec -i <container> psql -U app -d app < migrations/001_init.sql`.
   Новые изменения схемы — только новыми файлами миграций (см. backend-api).
3. **Сервер**: `server.mjs` из шаблона — эндпоинты `/api/register`,
   `/api/login`, `/api/logout`, `/api/me`. Конфиг через env (`DATABASE_URL`,
   `PORT`), секреты — только env, не в коде.
4. **Фронт**: формы шлют `fetch('/api/login', { credentials: 'include' })` —
   сессия в httpOnly-cookie, JS её не видит (защита от XSS-угона).

## Железные правила схемы

- `users`: `id uuid default gen_random_uuid()`, `email citext unique`,
  `pass_hash text`, `created_at timestamptz default now()`. Пароль — никогда
  plaintext, только хэш.
- scrypt из `node:crypto`: хранить `salt:hash` (hex) в одном поле,
  сравнение — `timingSafeEqual`. bcrypt/argon2 тоже ок, если уже есть в проекте.
- `sessions`: `token_hash` (sha256 от токена, сам токен в БД не храним),
  `user_id` FK, `expires_at`. Протухшие — чистить по запросу или cron.
- Деньги/заказы позже — integer minor units, время UTC (см. backend-api).

## Железные правила API

- Регистрация: валидация (zod или ручная), email lowercase+trim, пароль ≥ 8,
  дубль email → 409 без деталей. После регистрации — сразу сессия (auto-login).
- Логин: ошибка всегда «неверная пара email/пароль» — не палим существование.
- Cookie: `HttpOnly; SameSite=Lax; Path=/; Max-Age=…`; `Secure` — на проде.
- Rate limit на login/register: простейший in-memory счётчик по IP — минимум.
- CORS не открывай на `*` с credentials — same-origin или явный список.

## Проверка (обязательна, curl'ом)

- register → 201 + cookie в заголовках; повторный register → 409.
- login верный → 200 + cookie; неверный → 401 с общим текстом.
- `/api/me` с cookie → пользователь; без cookie → 401.
- Пароль в БД — хэш, не plaintext: `docker exec ... psql -c "select pass_hash from users"` глазами.
- Ошибки не содержат stack trace наружу.
