/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { mapAccessError, proxyIdentity, requireRole, userId } from '../access.js';
import { config } from '../config.js';
import { audit, database } from '../database.js';
import { decrypt, encrypt, id } from '../security.js';
import { digest, token } from '../security.js';

const providers: Record<string, { origin: string; authorization: (key: string) => Record<string, string> }> = {
	openai: { origin: 'https://api.openai.com', authorization: key => ({ authorization: `Bearer ${key}` }) },
	anthropic: { origin: 'https://api.anthropic.com', authorization: key => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }) }
};

export async function keyRoutes(app: FastifyInstance): Promise<void> {
	app.post<{ Params: { teamId: string }; Body: { provider?: string; model?: string } }>('/v1/teams/:teamId/proxy-tokens', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'dev'); } catch (error) { mapAccessError(error); }
		if (!request.body.provider || !providers[request.body.provider] || !request.body.model?.trim()) { return reply.badRequest('Supported provider and model are required'); }
		const value = `aura_pt_${token(32)}`;
		const tokenId = id();
		database.prepare('INSERT INTO proxy_tokens(id,token_hash,user_id,team_id,provider,model,created_at) VALUES(?,?,?,?,?,?,?)').run(tokenId, digest(value), user, request.params.teamId, request.body.provider, request.body.model.trim(), new Date().toISOString());
		audit(user, 'proxy_token.create', request.params.teamId, 'proxy_token', tokenId);
		return reply.code(201).send({ id: tokenId, token: value });
	});

	app.delete<{ Params: { teamId: string; tokenId: string } }>('/v1/teams/:teamId/proxy-tokens/:tokenId', async (request, reply) => {
		const user = await userId(request);
		const result = database.prepare('UPDATE proxy_tokens SET revoked_at=? WHERE id=? AND team_id=? AND (user_id=? OR EXISTS(SELECT 1 FROM memberships WHERE user_id=? AND team_id=? AND role IN (\'owner\',\'maintainer\')))').run(new Date().toISOString(), request.params.tokenId, request.params.teamId, user, user, request.params.teamId);
		if (result.changes !== 1) { return reply.notFound(); }
		audit(user, 'proxy_token.revoke', request.params.teamId, 'proxy_token', request.params.tokenId);
		return reply.code(204).send();
	});

	app.get<{ Params: { teamId: string } }>('/v1/teams/:teamId/keys', async request => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'viewer'); } catch (error) { mapAccessError(error); }
		return database.prepare(`SELECT id,label,key_hint AS keyHint,provider,access_role AS accessRole,priority,group_id AS groupId,
			ping_ms AS pingMs,last_checked_at AS lastCheckedAt,disabled_at AS disabledAt,created_at AS createdAt FROM api_keys WHERE team_id=? ORDER BY provider,priority,created_at`).all(request.params.teamId);
	});

	// Группы ключей команды.
	app.get<{ Params: { teamId: string } }>('/v1/teams/:teamId/key-groups', async request => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'viewer'); } catch (error) { mapAccessError(error); }
		return database.prepare('SELECT id,name,priority,created_at AS createdAt FROM key_groups WHERE team_id=? ORDER BY priority,name').all(request.params.teamId);
	});

	app.post<{ Params: { teamId: string }; Body: { name?: string; priority?: number } }>('/v1/teams/:teamId/key-groups', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'maintainer'); } catch (error) { mapAccessError(error); }
		const name = request.body.name?.trim().slice(0, 60);
		if (!name) { return reply.badRequest('Group name is required'); }
		const priority = Number.isInteger(request.body.priority) && request.body.priority! >= 0 && request.body.priority! <= 100 ? request.body.priority! : 1;
		const groupId = id();
		database.prepare('INSERT INTO key_groups(id,team_id,name,priority,created_at) VALUES(?,?,?,?,?)').run(groupId, request.params.teamId, name, priority, new Date().toISOString());
		audit(user, 'key_group.create', request.params.teamId, 'key_group', groupId, { name, priority });
		return reply.code(201).send({ id: groupId, name, priority });
	});

	// Пинг ключа: реальный запрос к провайдеру (GET models), замер времени ответа.
	app.post<{ Params: { teamId: string; keyId: string } }>('/v1/teams/:teamId/keys/:keyId/ping', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'dev'); } catch (error) { mapAccessError(error); }
		const row = database.prepare('SELECT id,provider,encrypted_value FROM api_keys WHERE id=? AND team_id=? AND disabled_at IS NULL').get(request.params.keyId, request.params.teamId) as { id: string; provider: string; encrypted_value: string } | undefined;
		if (!row) { return reply.notFound('Key not found'); }
		const provider = providers[row.provider];
		if (!provider) { return reply.badRequest('Unsupported provider'); }
		const secret = decrypt(row.encrypted_value);
		const started = Date.now();
		let status = 0;
		try {
			const response = await fetch(new URL('/v1/models', provider.origin), { headers: provider.authorization(secret), signal: AbortSignal.timeout(10_000) });
			status = response.status;
		} catch {
			status = 0;
		}
		const pingMs = Date.now() - started;
		const ok = status >= 200 && status < 300;
		database.prepare('UPDATE api_keys SET ping_ms=?,last_checked_at=? WHERE id=?').run(pingMs, new Date().toISOString(), row.id);
		audit(user, 'api_key.ping', request.params.teamId, 'api_key', row.id, { status, pingMs });
		return { ok, status, pingMs };
	});

	app.post<{ Params: { teamId: string }; Body: { provider?: string; value?: string; accessRole?: string; label?: string; priority?: number; groupId?: string } }>('/v1/teams/:teamId/keys', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'maintainer'); } catch (error) { mapAccessError(error); }
		const provider = request.body.provider?.toLowerCase();
		if (!provider || !providers[provider] || !request.body.value) { return reply.badRequest('Supported provider and key value are required'); }
		if (!['owner', 'maintainer', 'dev', 'viewer'].includes(request.body.accessRole ?? 'dev')) { return reply.badRequest('Invalid access role'); }
		const priority = Number.isInteger(request.body.priority) && request.body.priority! >= 0 && request.body.priority! <= 1000 ? request.body.priority! : 100;
		const label = request.body.label?.trim().slice(0, 80) || `${provider} key`;
		const groupId = typeof request.body.groupId === 'string' && request.body.groupId.trim() ? request.body.groupId.trim() : null;
		const keyHint = maskKey(request.body.value);
		const keyId = id();
		database.prepare('INSERT INTO api_keys(id,team_id,owner_id,provider,encrypted_value,access_role,label,key_hint,priority,group_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
			.run(keyId, request.params.teamId, user, provider, encrypt(request.body.value), request.body.accessRole ?? 'dev', label, keyHint, priority, groupId, new Date().toISOString());
		audit(user, 'api_key.create', request.params.teamId, 'api_key', keyId, { provider, priority, groupId });
		return reply.code(201).send({ id: keyId, label, keyHint, provider, accessRole: request.body.accessRole ?? 'dev', priority, groupId });
	});

	// Редактирование ключа: лейбл, роль, приоритет, группа (значение ключа не меняется).
	app.patch<{ Params: { teamId: string; keyId: string }; Body: { label?: string; accessRole?: string; priority?: number; groupId?: string | null } }>('/v1/teams/:teamId/keys/:keyId', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'maintainer'); } catch (error) { mapAccessError(error); }
		const key = database.prepare('SELECT id, group_id FROM api_keys WHERE id=? AND team_id=? AND disabled_at IS NULL').get(request.params.keyId, request.params.teamId) as { id: string; group_id: string | null } | undefined;
		if (!key) { return reply.notFound(); }
		const updates: Record<string, unknown> = {};
		if (typeof request.body.label === 'string' && request.body.label.trim()) { updates.label = request.body.label.trim().slice(0, 80); }
		if (request.body.accessRole !== undefined) {
			if (!['owner', 'maintainer', 'dev', 'viewer'].includes(request.body.accessRole)) { return reply.badRequest('Invalid access role'); }
			updates.access_role = request.body.accessRole;
		}
		if (request.body.priority !== undefined) {
			if (!Number.isInteger(request.body.priority) || request.body.priority < 0 || request.body.priority > 1000) { return reply.badRequest('Invalid priority'); }
			updates.priority = request.body.priority;
		}
		if (request.body.groupId !== undefined) { updates.group_id = request.body.groupId === null ? null : String(request.body.groupId); }
		const fields = Object.keys(updates);
		if (fields.length === 0) { return reply.badRequest('Nothing to update'); }
		const setSql = fields.map(f => `${f}=@${f}`).join(',');
		database.prepare(`UPDATE api_keys SET ${setSql} WHERE id=@id AND team_id=@team`).run({ ...updates, id: request.params.keyId, team: request.params.teamId });
		audit(user, 'api_key.update', request.params.teamId, 'api_key', request.params.keyId, updates);
		return { ok: true };
	});

	// Полное удаление ключа из банка (в отличие от disable — строка исчезает навсегда).
	app.delete<{ Params: { teamId: string; keyId: string } }>('/v1/teams/:teamId/keys/:keyId/remove', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'maintainer'); } catch (error) { mapAccessError(error); }
		const key = database.prepare('SELECT id FROM api_keys WHERE id=? AND team_id=?').get(request.params.keyId, request.params.teamId) as { id: string } | undefined;
		if (!key) { return reply.notFound(); }
		database.prepare('DELETE FROM api_keys WHERE id=? AND team_id=?').run(request.params.keyId, request.params.teamId);
		audit(user, 'api_key.delete', request.params.teamId, 'api_key', request.params.keyId);
		return { ok: true };
	});

	app.delete<{ Params: { teamId: string; keyId: string } }>('/v1/teams/:teamId/keys/:keyId', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'maintainer'); } catch (error) { mapAccessError(error); }
		const result = database.prepare('UPDATE api_keys SET disabled_at=? WHERE id=? AND team_id=? AND disabled_at IS NULL').run(new Date().toISOString(), request.params.keyId, request.params.teamId);
		if (result.changes !== 1) { return reply.notFound(); }
		audit(user, 'api_key.disable', request.params.teamId, 'api_key', request.params.keyId);
		return reply.code(204).send();
	});

	app.all<{ Params: { teamId: string; provider: string; '*': string } }>('/v1/teams/:teamId/proxy/:provider/*', async (request, reply) => {
		const identity = await proxyIdentity(request, request.params.teamId, request.params.provider);
		const user = identity.userId;
		let role;
		try { role = requireRole(user, request.params.teamId, 'viewer'); } catch (error) { mapAccessError(error); }
		const provider = providers[request.params.provider];
		if (!provider) { return reply.notFound('Unsupported provider'); }
		const row = database.prepare(`SELECT id,encrypted_value,access_role FROM api_keys WHERE team_id=? AND provider=? AND disabled_at IS NULL
			AND CASE access_role WHEN 'viewer' THEN 0 WHEN 'dev' THEN 1 WHEN 'maintainer' THEN 2 ELSE 3 END <= ?
			ORDER BY priority ASC, created_at ASC LIMIT 1`).get(request.params.teamId, request.params.provider, ({ viewer: 0, dev: 1, maintainer: 2, owner: 3 })[role!]) as { id: string; encrypted_value: string; access_role: 'owner' | 'maintainer' | 'dev' | 'viewer' } | undefined;
		if (!row) { return reply.notFound('No key configured for this provider'); }
		let upstream: URL;
		try { upstream = providerUrl(provider.origin, request.params['*']); } catch { return reply.badRequest('Invalid provider path'); }
		if (!isAllowedProviderRequest(request.params.provider, request.method, upstream.pathname)) { return reply.forbidden('This provider operation is not available through the team proxy'); }
		if (identity.model && request.method === 'POST' && requestedModel(request.body) !== identity.model) { return reply.forbidden('This proxy token is restricted to another model'); }
		consumeQuota(user, request.params.teamId);
		const headers = { ...provider.authorization(decrypt(row.encrypted_value)), 'content-type': request.headers['content-type'] ?? 'application/json' };
		const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : JSON.stringify(request.body ?? {});
		const response = await fetch(upstream, { method: request.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
		audit(user, 'proxy.request', request.params.teamId, 'api_key', row.id, { provider: request.params.provider, status: response.status });
		reply.code(response.status);
		response.headers.forEach((value, name) => {
			if (['content-type', 'cache-control', 'x-request-id'].includes(name.toLowerCase())) { reply.header(name, value); }
		});
		if (!response.body) { return reply.send(); }
		return reply.send(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>));
	});
}

function requestedModel(body: unknown): string | undefined {
	return body && typeof body === 'object' && 'model' in body && typeof body.model === 'string' ? body.model : undefined;
}

function maskKey(value: string): string {
	const key = value.trim();
	return key.length <= 8 ? '••••' : `${key.slice(0, 3)}…${key.slice(-4)}`;
}

export function isAllowedProviderRequest(provider: string, method: string, path: string): boolean {
	if (provider === 'openai') { return (method === 'GET' && path === '/v1/models') || (method === 'POST' && path === '/v1/chat/completions'); }
	if (provider === 'anthropic') { return method === 'POST' && path === '/v1/messages'; }
	return false;
}

export function providerUrl(origin: string, path: string): URL {
	const decoded = decodeURIComponent(path);
	if (!decoded || decoded.includes(':') || decoded.includes('\\') || decoded.startsWith('//')) { throw new Error('Invalid provider path'); }
	const upstream = new URL(`/${decoded.replace(/^\/+/, '')}`, origin);
	if (upstream.origin !== origin) { throw new Error('Invalid provider origin'); }
	return upstream;
}

function consumeQuota(userId: string, teamId: string): void {
	const day = new Date().toISOString().slice(0, 10);
	const result = database.prepare(`INSERT INTO proxy_usage(user_id,team_id,day,requests) VALUES(?,?,?,1)
		ON CONFLICT(user_id,team_id,day) DO UPDATE SET requests=requests+1 WHERE requests<?`).run(userId, teamId, day, config.proxyRequestsPerDay);
	if (result.changes !== 1) { throw Object.assign(new Error('Daily proxy request limit reached'), { statusCode: 429 }); }
}
