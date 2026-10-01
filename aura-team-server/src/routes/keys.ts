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
import { BUILTIN_PROVIDERS, getProvider, isAllowedPath, listProviders, providerAuthorization, providerRoutes, type ProviderModel } from '../providers.js';
import { decrypt, encrypt, id, digest, token } from '../security.js';

export async function keyRoutes(app: FastifyInstance): Promise<void> {
	app.post<{ Params: { teamId: string }; Body: { provider?: string; model?: string } }>('/v1/teams/:teamId/proxy-tokens', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'dev'); } catch (error) { mapAccessError(error); }
		if (!request.body.provider || !getProvider(request.params.teamId, request.body.provider) || !request.body.model?.trim()) { return reply.badRequest('Supported provider and model are required'); }
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
		const rows = database.prepare(`SELECT id,label,key_hint AS keyHint,provider,access_role AS accessRole,priority,group_id AS groupId,base_url AS baseUrl,model,
			ping_ms AS pingMs,last_ok AS ok,last_status AS lastStatus,last_error AS lastError,last_checked_at AS lastCheckedAt,disabled_at AS disabledAt,created_at AS createdAt FROM api_keys WHERE team_id=? ORDER BY provider,priority,created_at`).all(request.params.teamId) as Array<Record<string, unknown> & { ok: number | null }>;
		// SQLite отдаёт 1/0 — клиент сравнивает строго с true/false, поэтому приводим к boolean.
		return rows.map(row => ({ ...row, ok: row.ok === null || row.ok === undefined ? null : Boolean(row.ok) }));
	});

	// Группы ключей: клиент давно зовёт эти маршруты, но на сервере их не было —
	// список всегда приходил 404, и группы жили только в демо-режиме.
	app.get<{ Params: { teamId: string } }>('/v1/teams/:teamId/key-groups', async request => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'viewer'); } catch (error) { mapAccessError(error); }
		return database.prepare(`SELECT g.id, g.name, g.priority, g.created_at AS createdAt,
			(SELECT COUNT(*) FROM api_keys k WHERE k.group_id = g.id AND k.disabled_at IS NULL) AS keyCount
			FROM key_groups g WHERE g.team_id=? ORDER BY g.priority, g.name`).all(request.params.teamId);
	});

	app.post<{ Params: { teamId: string }; Body: { name?: string; priority?: number } }>('/v1/teams/:teamId/key-groups', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'maintainer'); } catch (error) { mapAccessError(error); }
		const name = request.body.name?.trim().slice(0, 60);
		if (!name) { return reply.badRequest('Group name is required'); }
		const priority = Number.isInteger(request.body.priority) && request.body.priority! >= 0 && request.body.priority! <= 1000 ? request.body.priority! : 1;
		const duplicate = database.prepare('SELECT id FROM key_groups WHERE team_id=? AND name=?').get(request.params.teamId, name) as { id: string } | undefined;
		if (duplicate) { return reply.conflict('Group with this name already exists'); }
		const groupId = id();
		database.prepare('INSERT INTO key_groups(id,team_id,name,priority,created_at) VALUES(?,?,?,?,?)')
			.run(groupId, request.params.teamId, name, priority, new Date().toISOString());
		audit(user, 'key_group.create', request.params.teamId, 'key_group', groupId, { name, priority });
		return reply.code(201).send({ id: groupId, name, priority });
	});

	app.patch<{ Params: { teamId: string; groupId: string }; Body: { name?: string; priority?: number } }>('/v1/teams/:teamId/key-groups/:groupId', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'maintainer'); } catch (error) { mapAccessError(error); }
		const group = database.prepare('SELECT id FROM key_groups WHERE id=? AND team_id=?').get(request.params.groupId, request.params.teamId) as { id: string } | undefined;
		if (!group) { return reply.notFound(); }
		const updates: Record<string, unknown> = {};
		if (typeof request.body.name === 'string' && request.body.name.trim()) { updates.name = request.body.name.trim().slice(0, 60); }
		if (request.body.priority !== undefined) {
			if (!Number.isInteger(request.body.priority) || request.body.priority < 0 || request.body.priority > 1000) { return reply.badRequest('Invalid priority'); }
			updates.priority = request.body.priority;
		}
		const fields = Object.keys(updates);
		if (fields.length === 0) { return reply.badRequest('Nothing to update'); }
		const setSql = fields.map(f => `${f}=@${f}`).join(',');
		database.prepare(`UPDATE key_groups SET ${setSql} WHERE id=@id AND team_id=@team`).run({ ...updates, id: request.params.groupId, team: request.params.teamId });
		audit(user, 'key_group.update', request.params.teamId, 'key_group', request.params.groupId, updates);
		return { ok: true };
	});

	// Удаление группы: ключи не теряем — они просто остаются без группы.
	app.delete<{ Params: { teamId: string; groupId: string } }>('/v1/teams/:teamId/key-groups/:groupId', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'maintainer'); } catch (error) { mapAccessError(error); }
		const group = database.prepare('SELECT id FROM key_groups WHERE id=? AND team_id=?').get(request.params.groupId, request.params.teamId) as { id: string } | undefined;
		if (!group) { return reply.notFound(); }
		database.transaction(() => {
			database.prepare('UPDATE api_keys SET group_id=NULL WHERE group_id=? AND team_id=?').run(request.params.groupId, request.params.teamId);
			database.prepare('DELETE FROM key_groups WHERE id=? AND team_id=?').run(request.params.groupId, request.params.teamId);
		})();
		audit(user, 'key_group.delete', request.params.teamId, 'key_group', request.params.groupId);
		return { ok: true };
	});

	// Пинг ключа: проба здоровья конкретного провайдера (у каждого своя), замер времени ответа.
	app.post<{ Params: { teamId: string; keyId: string } }>('/v1/teams/:teamId/keys/:keyId/ping', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'dev'); } catch (error) { mapAccessError(error); }
		const row = database.prepare('SELECT id,provider,encrypted_value,base_url,model FROM api_keys WHERE id=? AND team_id=? AND disabled_at IS NULL').get(request.params.keyId, request.params.teamId) as KeyProbeRow | undefined;
		if (!row) { return reply.notFound('Key not found'); }
		const provider = getProvider(request.params.teamId, row.provider);
		if (!provider) { return reply.badRequest('Unsupported provider'); }
		const result = await probeKey(provider, decrypt(row.encrypted_value), { baseUrl: row.base_url, model: row.model });
		saveProbe(row.id, result);
		audit(user, 'api_key.ping', request.params.teamId, 'api_key', row.id, { status: result.status, pingMs: result.pingMs });
		return result;
	});

	// Проверить все ключи команды параллельно: {keyId, ok, status, pingMs} по каждому.
	app.post<{ Params: { teamId: string } }>('/v1/teams/:teamId/keys/check', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'dev'); } catch (error) { mapAccessError(error); }
		const rows = database.prepare('SELECT id,provider,encrypted_value,base_url,model FROM api_keys WHERE team_id=? AND disabled_at IS NULL').all(request.params.teamId) as KeyProbeRow[];
		const results = await Promise.all(rows.map(async row => {
			const provider = getProvider(request.params.teamId, row.provider);
			if (!provider) { return { keyId: row.id, ok: false, status: 0, pingMs: 0, error: 'Провайдер не найден' }; }
			const result = await probeKey(provider, decrypt(row.encrypted_value), { baseUrl: row.base_url, model: row.model });
			saveProbe(row.id, result);
			return { keyId: row.id, ...result };
		}));
		audit(user, 'api_key.check_all', request.params.teamId, undefined, undefined, { checked: results.length });
		return results;
	});

	app.post<{ Params: { teamId: string }; Body: { provider?: string; value?: string; accessRole?: string; label?: string; priority?: number; groupId?: string; baseUrl?: string; model?: string } }>('/v1/teams/:teamId/keys', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'maintainer'); } catch (error) { mapAccessError(error); }
		const provider = request.body.provider?.toLowerCase();
		if (!provider || !getProvider(request.params.teamId, provider) || !request.body.value) { return reply.badRequest('Supported provider and key value are required'); }
		if (!['owner', 'maintainer', 'dev', 'viewer'].includes(request.body.accessRole ?? 'dev')) { return reply.badRequest('Invalid access role'); }
		const priority = Number.isInteger(request.body.priority) && request.body.priority! >= 0 && request.body.priority! <= 1000 ? request.body.priority! : 100;
		const label = request.body.label?.trim().slice(0, 80) || `${provider} key`;
		const groupId = typeof request.body.groupId === 'string' && request.body.groupId.trim() ? request.body.groupId.trim() : null;
		// Чужая группа превратила бы ключ в сироту — проверяем принадлежность команде.
		if (groupId && !database.prepare('SELECT 1 FROM key_groups WHERE id=? AND team_id=?').get(groupId, request.params.teamId)) {
			return reply.badRequest('Unknown key group');
		}
		const baseUrl = normalizeBaseUrl(request.body.baseUrl);
		if (baseUrl === false) { return reply.badRequest('Base URL must be https:// (or http://localhost)'); }
		const model = typeof request.body.model === 'string' ? request.body.model.trim().slice(0, 120) || null : null;
		const keyHint = maskKey(request.body.value);
		const keyId = id();
		database.prepare('INSERT INTO api_keys(id,team_id,owner_id,provider,encrypted_value,access_role,label,key_hint,priority,group_id,base_url,model,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
			.run(keyId, request.params.teamId, user, provider, encrypt(request.body.value), request.body.accessRole ?? 'dev', label, keyHint, priority, groupId, baseUrl, model, new Date().toISOString());
		audit(user, 'api_key.create', request.params.teamId, 'api_key', keyId, { provider, priority, groupId, baseUrl, model });
		return reply.code(201).send({ id: keyId, label, keyHint, provider, accessRole: request.body.accessRole ?? 'dev', priority, groupId, baseUrl, model });
	});

	// Редактирование ключа: лейбл, роль, приоритет, группа (значение ключа не меняется).
	app.patch<{ Params: { teamId: string; keyId: string }; Body: { label?: string; accessRole?: string; priority?: number; groupId?: string | null; baseUrl?: string | null; model?: string | null; value?: string } }>('/v1/teams/:teamId/keys/:keyId', async (request, reply) => {
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
		if (request.body.groupId !== undefined) {
			const nextGroup = request.body.groupId === null ? null : String(request.body.groupId);
			if (nextGroup && !database.prepare('SELECT 1 FROM key_groups WHERE id=? AND team_id=?').get(nextGroup, request.params.teamId)) {
				return reply.badRequest('Unknown key group');
			}
			updates.group_id = nextGroup;
		}
		if (request.body.baseUrl !== undefined) {
			const baseUrl = normalizeBaseUrl(request.body.baseUrl ?? undefined);
			if (baseUrl === false) { return reply.badRequest('Base URL must be https:// (or http://localhost)'); }
			updates.base_url = baseUrl;
		}
		if (request.body.model !== undefined) { updates.model = typeof request.body.model === 'string' ? request.body.model.trim().slice(0, 120) || null : null; }
		const auditable = { ...updates };
		// Замена секрета без пересоздания ключа (как «Изменить ключ» в плагине API); в аудит значение не пишем.
		if (typeof request.body.value === 'string' && request.body.value.trim()) {
			updates.encrypted_value = encrypt(request.body.value.trim());
			updates.key_hint = maskKey(request.body.value);
			updates.last_ok = null;
			updates.last_error = null;
			auditable.secret = 'rotated';
			delete auditable.encrypted_value;
		}
		// Сменился адрес или секрет — прежний результат проверки больше не достоверен.
		if ('base_url' in updates || 'encrypted_value' in updates) { updates.last_ok = null; updates.last_status = null; updates.last_error = null; }
		const fields = Object.keys(updates);
		if (fields.length === 0) { return reply.badRequest('Nothing to update'); }
		const setSql = fields.map(f => `${f}=@${f}`).join(',');
		database.prepare(`UPDATE api_keys SET ${setSql} WHERE id=@id AND team_id=@team`).run({ ...updates, id: request.params.keyId, team: request.params.teamId });
		delete auditable.encrypted_value;
		audit(user, 'api_key.update', request.params.teamId, 'api_key', request.params.keyId, auditable);
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

	// Включение ранее отключённого ключа (снимает disabled_at).
	app.post<{ Params: { teamId: string; keyId: string } }>('/v1/teams/:teamId/keys/:keyId/enable', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'maintainer'); } catch (error) { mapAccessError(error); }
		const result = database.prepare('UPDATE api_keys SET disabled_at=NULL WHERE id=? AND team_id=? AND disabled_at IS NOT NULL').run(request.params.keyId, request.params.teamId);
		if (result.changes !== 1) { return reply.notFound(); }
		audit(user, 'api_key.enable', request.params.teamId, 'api_key', request.params.keyId);
		return reply.code(204).send();
	});

	app.all<{ Params: { teamId: string; provider: string; '*': string } }>('/v1/teams/:teamId/proxy/:provider/*', async (request, reply) => {
		const identity = await proxyIdentity(request, request.params.teamId, request.params.provider);
		const user = identity.userId;
		let role;
		try { role = requireRole(user, request.params.teamId, 'viewer'); } catch (error) { mapAccessError(error); }
		const provider = getProvider(request.params.teamId, request.params.provider);
		if (!provider) { return reply.notFound('Unsupported provider'); }
		const row = database.prepare(`SELECT id,encrypted_value,access_role,base_url FROM api_keys WHERE team_id=? AND provider=? AND disabled_at IS NULL
			AND CASE access_role WHEN 'viewer' THEN 0 WHEN 'dev' THEN 1 WHEN 'maintainer' THEN 2 ELSE 3 END <= ?
			ORDER BY priority ASC, created_at ASC LIMIT 1`).get(request.params.teamId, request.params.provider, ({ viewer: 0, dev: 1, maintainer: 2, owner: 3 })[role!]) as { id: string; encrypted_value: string; access_role: 'owner' | 'maintainer' | 'dev' | 'viewer'; base_url: string | null } | undefined;
		if (!row) { return reply.notFound('No key configured for this provider'); }
		let upstream: URL;
		try { upstream = providerUrl(provider.origin, request.params['*']); } catch { return reply.badRequest('Invalid provider path'); }
		if (!isAllowedPath(provider, request.method, upstream.pathname)) { return reply.forbidden('This provider operation is not available through the team proxy'); }
		if (identity.model && request.method === 'POST' && requestedModel(request.body) !== identity.model) { return reply.forbidden('This proxy token is restricted to another model'); }
		consumeQuota(user, request.params.teamId, row.id);
		const headers = { ...providerAuthorization(provider, decrypt(row.encrypted_value)), 'content-type': request.headers['content-type'] ?? 'application/json' };
		const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : JSON.stringify(request.body ?? {});
		// У ключа свой base URL (шлюз/прокси) — запрос уходит туда, путь уже проверен по белому списку провайдера.
		const target = joinProviderUrl(row.base_url || provider.origin, upstream.pathname + upstream.search);
		const response = await fetch(target, { method: request.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
		audit(user, 'proxy.request', request.params.teamId, 'api_key', row.id, { provider: request.params.provider, status: response.status });
		reply.code(response.status);
		response.headers.forEach((value, name) => {
			if (['content-type', 'cache-control', 'x-request-id'].includes(name.toLowerCase())) { reply.header(name, value); }
		});
		if (!response.body) { return reply.send(); }
		return reply.send(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>));
	});

	// Провайдеры команды (встроенные + кастомные) и их CRUD.
	await providerRoutes(app);

	// Статистика расхода прокси: по дням, пользователям и ключам + остаток дневного лимита.
	app.get<{ Params: { teamId: string }; Querystring: { days?: string } }>('/v1/teams/:teamId/usage', async request => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'maintainer'); } catch (error) { mapAccessError(error); }
		const days = Math.min(Math.max(Number(request.query.days ?? 14) || 14, 1), 90);
		const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
		const today = new Date().toISOString().slice(0, 10);
		const perDay = database.prepare(`SELECT day, SUM(requests) AS requests FROM proxy_usage WHERE team_id=? AND day>=? GROUP BY day ORDER BY day`).all(request.params.teamId, since) as { day: string; requests: number }[];
		const perUser = database.prepare(`SELECT u.id AS userId, u.display_name AS name, SUM(p.requests) AS requests FROM proxy_usage p JOIN users u ON u.id=p.user_id
			WHERE p.team_id=? AND p.day>=? GROUP BY p.user_id ORDER BY requests DESC`).all(request.params.teamId, since) as { userId: string; name: string; requests: number }[];
		const perKey = database.prepare(`SELECT k.id AS keyId, k.label, k.provider, SUM(r.requests) AS requests FROM proxy_usage_keys r JOIN api_keys k ON k.id=r.key_id
			WHERE r.team_id=? AND r.day>=? GROUP BY r.key_id ORDER BY requests DESC`).all(request.params.teamId, since) as { keyId: string; label: string; provider: string; requests: number }[];
		const usedToday = (database.prepare('SELECT requests FROM proxy_usage WHERE team_id=? AND user_id=? AND day=?').get(request.params.teamId, user, today) as { requests: number } | undefined)?.requests ?? 0;
		return { since, days, limitPerUserPerDay: config.proxyRequestsPerDay, usedToday, remainingToday: Math.max(config.proxyRequestsPerDay - usedToday, 0), perDay, perUser, perKey };
	});
}

interface KeyProbeRow { id: string; provider: string; encrypted_value: string; base_url: string | null; model: string | null }
export interface ProbeResult { ok: boolean; status: number; pingMs: number; error?: string; limited?: boolean; url?: string }

function saveProbe(keyId: string, result: ProbeResult): void {
	database.prepare('UPDATE api_keys SET ping_ms=?,last_ok=?,last_status=?,last_error=?,last_checked_at=? WHERE id=?')
		.run(result.pingMs, result.ok ? 1 : 0, result.status, result.error ?? null, new Date().toISOString(), keyId);
}

/** Base URL ключа: https (или http только для localhost). '' / null → без переопределения; false — невалидно. */
export function normalizeBaseUrl(value: string | null | undefined): string | null | false {
	const raw = String(value ?? '').trim();
	if (!raw) { return null; }
	let parsed: URL;
	try { parsed = new URL(raw); } catch { return false; }
	const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
	if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) { return false; }
	if (parsed.username || parsed.password) { return false; }
	return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * Склейка base URL и пути провайдера по правилам OpenAI-совместимых SDK:
 * base «https://openrouter.ai/api/v1» + «/v1/models» → «…/api/v1/models» (без двойного /v1),
 * base без пути «https://api.openai.com» + «/v1/models» → «…/v1/models».
 */
export function joinProviderUrl(base: string, path: string): URL {
	const parsed = new URL(base);
	const basePath = parsed.pathname.replace(/\/+$/, '');
	const [pathname, search = ''] = path.split('?');
	let tail = pathname.startsWith('/') ? pathname : `/${pathname}`;
	if (basePath) {
		const last = basePath.split('/').pop() ?? '';
		const first = tail.split('/')[1] ?? '';
		// Версия уже в base (…/v1, …/v1beta/openai не трогаем) — убираем её из пути, чтобы не было /v1/v1.
		if (/^v\d+[a-z0-9]*$/i.test(last) && first === last) { tail = tail.slice(last.length + 1) || '/'; }
	}
	const url = new URL(`${parsed.origin}${basePath}${tail}`);
	url.search = search ? `?${search}` : '';
	return url;
}

/**
 * Проба здоровья ключа. Раньше любой не-2xx считался «ключ не работает», а base URL с путём
 * терялся (new URL('/v1/models', 'https://x/api') → https://x/v1/models → 404). Теперь:
 * 2xx — работает; 429 — ключ валиден, но упёрся в лимит; 401/403 — ключ отклонён;
 * 404/405 на списке моделей — пробуем минимальный запрос к чату, если известна модель.
 */
async function probeKey(provider: ProviderModel, secret: string, options: { baseUrl?: string | null; model?: string | null } = {}): Promise<ProbeResult> {
	const started = Date.now();
	const base = options.baseUrl || provider.origin;
	const headers = providerAuthorization(provider, secret);
	const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; url: string; error?: string }> => {
		const url = joinProviderUrl(base, path);
		try {
			const response = await fetch(url, {
				method,
				headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body),
				redirect: 'manual',
				signal: AbortSignal.timeout(10_000),
			});
			return { status: response.status, url: url.toString() };
		} catch (error) {
			const reason = error instanceof Error ? (error.name === 'TimeoutError' ? 'таймаут 10 с' : error.message) : String(error);
			return { status: 0, url: url.toString(), error: `Сеть: ${reason}` };
		}
	};
	let attempt = await call(provider.probe.method, provider.probe.path);
	if ((attempt.status === 404 || attempt.status === 405) && options.model) {
		const chatPath = provider.authScheme === 'x-api-key' && provider.id === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
		const body = chatPath === '/v1/messages'
			? { model: options.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
			: { model: options.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
		const fallback = await call('POST', chatPath, body);
		if (fallback.status !== 404 && fallback.status !== 405) { attempt = fallback; }
	}
	const pingMs = Date.now() - started;
	const { status } = attempt;
	if (status >= 200 && status < 300) { return { ok: true, status, pingMs, url: attempt.url }; }
	if (status === 429) { return { ok: true, limited: true, status, pingMs, url: attempt.url, error: 'HTTP 429: ключ рабочий, но упёрся в лимит запросов' }; }
	const error = attempt.error
		?? (status === 401 || status === 403 ? `HTTP ${status}: ключ отклонён (недействителен или нет доступа)`
			: status === 404 ? `HTTP 404: по адресу ${attempt.url} нет API — проверьте base URL`
				: status >= 300 && status < 400 ? `HTTP ${status}: редирект — укажите точный base URL`
					: status >= 500 ? `HTTP ${status}: сервер провайдера недоступен`
						: `HTTP ${status}`);
	return { ok: false, status, pingMs, url: attempt.url, error };
}

function requestedModel(body: unknown): string | undefined {
	return body && typeof body === 'object' && 'model' in body && typeof body.model === 'string' ? body.model : undefined;
}

function maskKey(value: string): string {
	const key = value.trim();
	return key.length <= 8 ? '••••' : `${key.slice(0, 3)}…${key.slice(-4)}`;
}

// Обратная совместимость: старые сигнатуры для тестов.
export function isAllowedProviderRequest(provider: string, method: string, path: string): boolean {
	const model = BUILTIN_PROVIDERS.find(candidate => candidate.id === provider);
	return model ? isAllowedPath(model, method, path) : false;
}

export function providerUrl(origin: string, path: string): URL {
	const decoded = decodeURIComponent(path);
	if (!decoded || decoded.includes(':') || decoded.includes('\\') || decoded.startsWith('//')) { throw new Error('Invalid provider path'); }
	const upstream = new URL(`/${decoded.replace(/^\/+/, '')}`, origin);
	if (upstream.origin !== origin) { throw new Error('Invalid provider origin'); }
	return upstream;
}

function consumeQuota(userId: string, teamId: string, keyId?: string): void {
	const day = new Date().toISOString().slice(0, 10);
	const result = database.prepare(`INSERT INTO proxy_usage(user_id,team_id,day,requests) VALUES(?,?,?,1)
		ON CONFLICT(user_id,team_id,day) DO UPDATE SET requests=requests+1 WHERE requests<?`).run(userId, teamId, day, config.proxyRequestsPerDay);
	if (result.changes !== 1) { throw Object.assign(new Error('Daily proxy request limit reached'), { statusCode: 429 }); }
	if (keyId) {
		database.prepare(`INSERT INTO proxy_usage_keys(team_id,key_id,day,requests) VALUES(?,?,?,1)
			ON CONFLICT(team_id,key_id,day) DO UPDATE SET requests=requests+1`).run(teamId, keyId, day);
	}
}

// listProviders экспортируется для будущих экранов выбора провайдера.
export { listProviders };
