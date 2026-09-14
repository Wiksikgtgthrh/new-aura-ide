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
		return database.prepare(`SELECT id,label,key_hint AS keyHint,provider,access_role AS accessRole,priority,
			disabled_at AS disabledAt,created_at AS createdAt FROM api_keys WHERE team_id=? ORDER BY provider,priority,created_at`).all(request.params.teamId);
	});

	app.post<{ Params: { teamId: string }; Body: { provider?: string; value?: string; accessRole?: string; label?: string; priority?: number } }>('/v1/teams/:teamId/keys', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'maintainer'); } catch (error) { mapAccessError(error); }
		const provider = request.body.provider?.toLowerCase();
		if (!provider || !providers[provider] || !request.body.value) { return reply.badRequest('Supported provider and key value are required'); }
		if (!['owner', 'maintainer', 'dev', 'viewer'].includes(request.body.accessRole ?? 'dev')) { return reply.badRequest('Invalid access role'); }
		const priority = Number.isInteger(request.body.priority) && request.body.priority! >= 0 && request.body.priority! <= 1000 ? request.body.priority! : 100;
		const label = request.body.label?.trim().slice(0, 80) || `${provider} key`;
		const keyHint = maskKey(request.body.value);
		const keyId = id();
		database.prepare('INSERT INTO api_keys(id,team_id,owner_id,provider,encrypted_value,access_role,label,key_hint,priority,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
			.run(keyId, request.params.teamId, user, provider, encrypt(request.body.value), request.body.accessRole ?? 'dev', label, keyHint, priority, new Date().toISOString());
		audit(user, 'api_key.create', request.params.teamId, 'api_key', keyId, { provider, priority });
		return reply.code(201).send({ id: keyId, label, keyHint, provider, accessRole: request.body.accessRole ?? 'dev', priority });
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
