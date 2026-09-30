/*---------------------------------------------------------------------------------------------
 *  Стенд для интеграционных тестов клиента расширения.
 *
 *  Зачем: сервер и клиент покрыты по отдельности (aura-team-server/test, а у расширения —
 *  api-headers.test.mjs), и именно из-за этого зазора баг «DELETE задачи уходит с
 *  content-type: application/json, сервер отвечает 400» жил незамеченным. Здесь
 *  поднимается настоящий сервер, чтобы клиент расширения говорил с ним по HTTP.
 *
 *  Что делает: временный AURA_DATA_DIR, пользователь-владелец, команда, токены —
 *  и одна строка в stdout:
 *    AURA-HARNESS {"port":3210,"token":"…","refreshToken":"…","teamId":"…","userId":"…"}
 *
 *  Запуск (только из тестов): node --import tsx test/http-harness.ts
 *  Реальный ./data не трогается; родительский тест сам убивает процесс.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AURA_DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-harness-'));
process.env.AURA_MASTER_KEY ??= 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
process.env.AURA_JWT_SECRET ??= 'harness-only-jwt-secret-at-least-32-characters';
process.env.AURA_ADMIN_CODE ??= 'AUR-HARNESS';

const [{ createServer }, { database }, { accessToken, digest, token }, { hash }] = await Promise.all([
	import('../src/server.js'),
	import('../src/database.js'),
	import('../src/security.js'),
	import('@node-rs/argon2')
]);

const app = await createServer();
// Логи Fastify не нужны: stdout читает родитель, шум мешает разбирать маркер стенда.
app.log.level = 'silent';

const USER = 'harness-owner';
const now = new Date().toISOString();
database.prepare('INSERT INTO users(id,email,display_name,password_hash,verified_at,created_at) VALUES(?,?,?,?,?,?)')
	.run(USER, 'harness@example.com', 'Harness Owner', await hash('long-test-password'), now, now);

const access = await accessToken(USER);
const authorization = `Bearer ${access}`;
const team = await app.inject({ method: 'POST', url: '/v1/teams', headers: { authorization }, payload: { name: 'Harness Team' } });
if (team.statusCode !== 201) {
	throw new Error(`harness: POST /v1/teams -> ${team.statusCode} ${team.body}`);
}

// Refresh-токен кладём в таблицу так же, как это делает issueTokens в routes/auth.ts:
// нужен, чтобы проверить прозрачное обновление сессии на 401.
const refresh = token();
database.prepare('INSERT INTO refresh_tokens(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)')
	.run('harness-refresh', USER, digest(refresh), new Date(Date.now() + 24 * 60 * 60_000).toISOString());

await app.listen({ host: '127.0.0.1', port: 0 });
const address = app.server.address();
if (!address || typeof address === 'string') {
	throw new Error('harness: сервер не сообщил порт');
}

process.stdout.write(`AURA-HARNESS ${JSON.stringify({ port: address.port, token: access, refreshToken: refresh, teamId: team.json().id, userId: USER })}\n`);

// Страховка от осиротевшего процесса: обычно стенд убивает родитель.
setTimeout(() => process.exit(0), 120_000).unref();

const shutdown = async () => {
	await app.close().catch(() => undefined);
	process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
