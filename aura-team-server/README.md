# Aura Team Server

Metadata-only collaboration server for the `aura-team` built-in extension. Project code travels through GitHub. The server stores teams, roles, projects, tasks, encrypted provider keys, audit events, and optional short-lived archives.

## Local start

1. Copy `.env.example` to `.env` and export its values. Never commit `.env`.
2. Generate the key encryption secret with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
3. Run `npm install`, `npm run build`, then `npm start`.
4. Set `auraTeam.serverUrl` in Aura IDE.

The registration verification URL is logged only in development when SMTP is absent. Production requires the SMTP settings from `.env.example`. IDE sign-in uses a browser device code, so the password never enters the extension.

## Production

- Run as an unprivileged systemd user behind Caddy using files from `deploy/`.
- Set `AURA_DATA_DIR=/var/lib/aura-team` and allow writes only there.
- Put `AURA_JWT_SECRET` and `AURA_MASTER_KEY` in `/etc/aura-team.env` with mode `0600`.
- Ship the AGGG 5.2 core with `AURA_AGGG_CORE_PATH` (a directory holding `VERSION`, `CLAUDE.md`, `harness/core.txt`) in `/etc/aura-team.env`. It is served only to accounts granted the `aggg52` entitlement (`npm run grant -- --email <email> --feature aggg52`); without the path the IDE stays on the built-in 2.0.0 core.
- Back up the SQLite database using SQLite's online backup mechanism; do not copy a live WAL database as unrelated files.
- For multiple server processes or larger teams, migrate the same domain model to Postgres before horizontal scaling.

## Tests

`npm test` runs `node --test` over `test/*.test.ts` and drives the real Fastify instance through `inject`, so the router, SQLite, JWT and argon2 are the real thing; only the socket is skipped. Each file gets its own temporary `AURA_DATA_DIR`.

`test/bench.ts` is not a test file either: it seeds a realistic dataset (150 users, 3000 tasks, 20k audit events, 41 teams) and reports medians for the hot routes plus their `EXPLAIN QUERY PLAN`. Run it manually — `node --import tsx test/bench.ts` — when a route feels slow or before changing an index.

`test/http-harness.ts` is not a test file. It is a stand-in server for the extension's end-to-end test (`extensions/aura-team/test/server-integration.test.mjs`): it boots on a free port, seeds an owner, a team and a refresh token, prints `AURA-HARNESS {…}` with the port and tokens, and is killed by the caller. Debug it directly with `node --import tsx test/http-harness.ts`.

## Security boundaries

- Team roles are enforced on every server route; hiding a button in the IDE is not authorization.
- Provider keys are encrypted at rest and only decrypted inside the proxy request path.
- The proxy allowlist currently supports OpenAI and Anthropic. Arbitrary origins are rejected.
- Proxy quotas are atomic per user/team/day. Requests and key changes are audited.
- API keys expose metadata only: role-filtered listing, masked hints, priority routing and disablement. Proxy tokens are restricted to their requested model.
- Archive fallback accepts one `.tar.zst`, streams it to disk, caps it at 50 MiB by default, and expires it after seven days.

## Deliberate MVP limits

- SMTP delivery is an adapter seam, not bundled to one provider.
- Presence currently means connected sockets and is not persisted.
- Archive content is treated as opaque transport; add malware scanning before opening uploads on a server.
- Provider usage is request-count based; exact token/cost accounting requires parsing each provider's streaming usage events.
