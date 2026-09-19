/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import { database } from '../database.js';
import { config } from '../config.js';
import { userId } from '../access.js';
import { accessToken, digest, id, token } from '../security.js';

interface Credentials { email: string; password: string; displayName?: string; }

export async function authRoutes(app: FastifyInstance): Promise<void> {
	app.post<{ Body: Credentials }>('/v1/auth/register', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
		const email = request.body.email?.trim().toLowerCase();
		if (!email?.includes('@') || request.body.password?.length < 8) { return reply.badRequest('Use a valid email and a password of at least 8 characters'); }
		const existing = database.prepare('SELECT id,verified_at FROM users WHERE email=?').get(email) as { id: string; verified_at?: string } | undefined;
		if (existing?.verified_at) { return reply.conflict('An account with this email already exists'); }
		const userId = existing?.id ?? id();
		const passwordHash = await hash(request.body.password);
		// Aura: регистрация БЕЗ письма — аккаунт сразу активен (email не проверяем).
		database.transaction(() => {
			if (existing) {
				database.prepare('UPDATE users SET display_name=?,password_hash=?,verified_at=? WHERE id=? AND verified_at IS NULL').run(request.body.displayName?.trim() || email.split('@')[0], passwordHash, new Date().toISOString(), userId);
			} else {
				database.prepare('INSERT INTO users(id,email,display_name,password_hash,created_at,verified_at) VALUES(?,?,?,?,?,?)').run(userId, email, request.body.displayName?.trim() || email.split('@')[0], passwordHash, new Date().toISOString(), new Date().toISOString());
			}
		})();
		return reply.code(201).send({
			ok: true,
			message: 'Account created. You can sign in now.'
		});
	});

	app.get<{ Querystring: { token?: string } }>('/v1/auth/verify', async (request, reply) => {
		const tokenHash = digest(request.query.token ?? '');
		const row = database.prepare('SELECT user_id FROM email_verifications WHERE token_hash=? AND expires_at>? AND consumed_at IS NULL').get(tokenHash, new Date().toISOString()) as { user_id: string } | undefined;
		if (!row) { return reply.badRequest('Verification link is invalid or expired'); }
		const now = new Date().toISOString();
		database.transaction(() => {
			database.prepare('UPDATE users SET verified_at=? WHERE id=?').run(now, row.user_id);
			database.prepare('UPDATE email_verifications SET consumed_at=? WHERE token_hash=?').run(now, tokenHash);
		})();
		return reply.type('text/html').send('<!doctype html><meta charset="utf-8"><h1>Email verified</h1><p>You can return to Aura IDE.</p>');
	});

	app.post<{ Body: Credentials }>('/v1/auth/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
		const row = database.prepare('SELECT id,password_hash,verified_at FROM users WHERE email=?').get(request.body.email?.trim().toLowerCase()) as { id: string; password_hash: string; verified_at?: string } | undefined;
		if (!row || !await verify(row.password_hash, request.body.password ?? '')) { return reply.unauthorized('Invalid email or password'); }
		if (!row.verified_at) { return reply.forbidden('Verify your email first'); }
		return issueTokens(row.id);
	});

	app.post<{ Body: { currentPassword?: string; newPassword?: string } }>('/v1/auth/password', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
		const user = await userId(request);
		if (!request.body.currentPassword || !request.body.newPassword || request.body.newPassword.length < 10) {
			return reply.badRequest('The new password must contain at least 8 characters');
		}
		const row = database.prepare('SELECT password_hash FROM users WHERE id=?').get(user) as { password_hash: string } | undefined;
		if (!row || !await verify(row.password_hash, request.body.currentPassword)) { return reply.unauthorized('Current password is incorrect'); }
		const passwordHash = await hash(request.body.newPassword);
		database.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, user);
		database.prepare('UPDATE refresh_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(new Date().toISOString(), user);
		return { ok: true };
	});

	app.post('/v1/auth/device', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async () => {
		const deviceCode = token();
		const userCode = token(6).slice(0, 8).toUpperCase();
		database.prepare('INSERT INTO device_codes(id,user_code_hash,expires_at) VALUES(?,?,?)').run(digest(deviceCode), digest(userCode), new Date(Date.now() + 10 * 60_000).toISOString());
		return { deviceCode, userCode, verificationUri: `${config.publicUrl}/device`, expiresIn: 600, interval: 5 };
	});

	app.get('/device', async (_request, reply) => reply.type('text/html').send(devicePage()));
	app.get('/register', async (_request, reply) => reply.type('text/html').send(registerPage()));
	app.post<{ Body: Credentials & { code: string } }>('/v1/auth/device/authorize', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
		const row = database.prepare('SELECT id,password_hash,verified_at FROM users WHERE email=?').get(request.body.email?.trim().toLowerCase()) as { id: string; password_hash: string; verified_at?: string } | undefined;
		if (!row || !row.verified_at || !await verify(row.password_hash, request.body.password ?? '')) { return reply.unauthorized('Invalid or unverified account'); }
		const result = database.prepare('UPDATE device_codes SET user_id=? WHERE user_code_hash=? AND expires_at>? AND consumed_at IS NULL AND user_id IS NULL').run(row.id, digest(request.body.code?.trim().toUpperCase()), new Date().toISOString());
		if (result.changes !== 1) { return reply.badRequest('Code is invalid or expired'); }
		return { ok: true };
	});

	app.post<{ Body: { deviceCode?: string } }>('/v1/auth/device/token', { config: { rateLimit: { max: 150, timeWindow: '15 minutes' } } }, async (request, reply) => {
		const deviceId = digest(request.body.deviceCode ?? '');
		const row = database.prepare('SELECT user_id FROM device_codes WHERE id=? AND expires_at>? AND consumed_at IS NULL').get(deviceId, new Date().toISOString()) as { user_id?: string } | undefined;
		if (!row?.user_id) { return reply.code(202).send({ pending: true }); }
		const claimed = database.prepare('UPDATE device_codes SET consumed_at=? WHERE id=? AND consumed_at IS NULL').run(new Date().toISOString(), deviceId);
		if (claimed.changes !== 1) { return reply.unauthorized('Device code was already consumed'); }
		return issueTokens(row.user_id);
	});

	app.post<{ Body: { refreshToken?: string } }>('/v1/auth/refresh', async (request, reply) => {
		const row = database.prepare('SELECT id,user_id FROM refresh_tokens WHERE token_hash=? AND expires_at>? AND revoked_at IS NULL').get(digest(request.body.refreshToken ?? ''), new Date().toISOString()) as { id: string; user_id: string } | undefined;
		if (!row) { return reply.unauthorized(); }
		const claimed = database.prepare('UPDATE refresh_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(new Date().toISOString(), row.id);
		if (claimed.changes !== 1) { return reply.unauthorized(); }
		return issueTokens(row.user_id);
	});
}

async function issueTokens(userId: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
	const refreshToken = token();
	database.prepare('INSERT INTO refresh_tokens(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)').run(id(), userId, digest(refreshToken), new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString());
	return { accessToken: await accessToken(userId), refreshToken, expiresIn: 900 };
}

function devicePage(): string {
	return `${pageHead('Aura Team sign in')}<h1>Connect Aura IDE</h1><form><input name="code" placeholder="Code from Aura IDE" required><input name="email" type="email" placeholder="Email" required><input name="password" type="password" placeholder="Password" required><button>Connect</button></form><p id="result"></p><p><a href="/register">Create an account</a></p><script>document.querySelector("form").onsubmit=async event=>{event.preventDefault();const body=Object.fromEntries(new FormData(event.target));const response=await fetch("/v1/auth/device/authorize",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});document.querySelector("#result").textContent=response.ok?"Connected. Return to Aura IDE.":await response.text()}</script>`;
}

function registerPage(): string {
	return `${pageHead('Create Aura Team account')}<h1>Create Account</h1><form><input name="displayName" placeholder="Display name" required><input name="email" type="email" placeholder="Email" required><input name="password" type="password" minlength="8" placeholder="Password (8+ characters)" required><button>Create Account</button></form><p id="result"></p><script>document.querySelector("form").onsubmit=async event=>{event.preventDefault();const body=Object.fromEntries(new FormData(event.target));const response=await fetch("/v1/auth/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});document.querySelector("#result").textContent=response.ok?"Account created. You can sign in now.":await response.text()}</script>`;
}

function pageHead(title: string): string {
	return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:16px system-ui;max-width:420px;margin:10vh auto;padding:24px}input,button{box-sizing:border-box;width:100%;padding:12px;margin:6px 0}</style>`;
}
