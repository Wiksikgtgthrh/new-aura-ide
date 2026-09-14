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
- Back up the SQLite database using SQLite's online backup mechanism; do not copy a live WAL database as unrelated files.
- For multiple server processes or larger teams, migrate the same domain model to Postgres before horizontal scaling.

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
