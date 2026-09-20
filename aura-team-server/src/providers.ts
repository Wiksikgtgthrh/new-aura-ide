/*---------------------------------------------------------------------------------------------
 *  Модель провайдеров API-ключей: встроенные (openai, anthropic) + добавляемые командой
 *  OpenAI-совместимые провайдеры (OpenRouter, Together, локальный сервер и т.д.).
 *  Каждый провайдер описывает origin, схему авторизации, разрешённые пути и пробу здоровья.
 *--------------------------------------------------------------------------------------------*/

import { database, audit } from './database.js';
import { requireRole, userId } from './access.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface AllowedPath { method: string; path: string }

export interface ProviderModel {
	id: string;
	name: string;
	origin: string;
	authScheme: 'bearer' | 'x-api-key' | 'header';
	/** Имя кастомного заголовка для authScheme === 'header'. */
	headerName?: string;
	allowedPaths: AllowedPath[];
	/** Проба здоровья: какой запрос считать достоверной проверкой живости ключа. */
	probe: AllowedPath;
	builtin: boolean;
}

export const BUILTIN_PROVIDERS: ProviderModel[] = [
	{
		id: 'openai',
		name: 'OpenAI',
		origin: 'https://api.openai.com',
		authScheme: 'bearer',
		allowedPaths: [
			{ method: 'GET', path: '/v1/models' },
			{ method: 'POST', path: '/v1/chat/completions' }
		],
		probe: { method: 'GET', path: '/v1/models' },
		builtin: true
	},
	{
		id: 'anthropic',
		name: 'Anthropic',
		origin: 'https://api.anthropic.com',
		authScheme: 'x-api-key',
		allowedPaths: [{ method: 'POST', path: '/v1/messages' }],
		// GET /v1/models существует у Anthropic и достовернее пустого POST /v1/messages.
		probe: { method: 'GET', path: '/v1/models' },
		builtin: true
	}
];

// Таблица кастомных провайдеров команды.
database.exec(`CREATE TABLE IF NOT EXISTS team_providers (
	id TEXT PRIMARY KEY,
	team_id TEXT NOT NULL REFERENCES teams(id),
	name TEXT NOT NULL,
	origin TEXT NOT NULL,
	auth_scheme TEXT NOT NULL DEFAULT 'bearer',
	header_name TEXT,
	allowed_paths TEXT NOT NULL DEFAULT '[]',
	probe_method TEXT NOT NULL DEFAULT 'GET',
	probe_path TEXT NOT NULL DEFAULT '/v1/models',
	created_by TEXT NOT NULL,
	created_at TEXT NOT NULL
);`);

interface TeamProviderRow { id: string; team_id: string; name: string; origin: string; auth_scheme: string; header_name: string | null; allowed_paths: string; probe_method: string; probe_path: string }

function fromRow(row: TeamProviderRow): ProviderModel {
	let allowed: AllowedPath[] = [];
	try { allowed = JSON.parse(row.allowed_paths); } catch { allowed = []; }
	return {
		id: row.id,
		name: row.name,
		origin: row.origin,
		authScheme: row.auth_scheme as ProviderModel['authScheme'],
		headerName: row.header_name ?? undefined,
		allowedPaths: allowed,
		probe: { method: row.probe_method, path: row.probe_path },
		builtin: false
	};
}

/** Провайдер команды: встроенный либо добавленный командой. */
export function getProvider(teamId: string, providerId: string): ProviderModel | undefined {
	const builtin = BUILTIN_PROVIDERS.find(candidate => candidate.id === providerId);
	if (builtin) { return builtin; }
	const row = database.prepare('SELECT * FROM team_providers WHERE id=? AND team_id=?').get(providerId, teamId) as TeamProviderRow | undefined;
	return row ? fromRow(row) : undefined;
}

/** Все провайдеры, доступные команде (встроенные + свои). */
export function listProviders(teamId: string): ProviderModel[] {
	const rows = database.prepare('SELECT * FROM team_providers WHERE team_id=? ORDER BY created_at').all(teamId) as TeamProviderRow[];
	return [...BUILTIN_PROVIDERS, ...rows.map(fromRow)];
}

/** Заголовки авторизации ключа для конкретного провайдера. */
export function providerAuthorization(provider: ProviderModel, key: string): Record<string, string> {
	switch (provider.authScheme) {
		case 'bearer': return { authorization: `Bearer ${key}` };
		case 'x-api-key': return provider.id === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { 'x-api-key': key };
		case 'header': return { [provider.headerName ?? 'authorization']: key };
	}
}

export function isAllowedPath(provider: ProviderModel, method: string, path: string): boolean {
	return provider.allowedPaths.some(allowed => allowed.method === method && allowed.path === path);
}

const VALID_URL = /^https:\/\/[a-z0-9.-]+(:\d+)?(\/.*)?$/i;

/** CRUD кастомных провайдеров — вешается на fastify-инстанс. */
export function providerRoutes(app: { get: Function; post: Function; delete: Function }): void {
	app.get('/v1/teams/:teamId/providers', async (request: FastifyRequest<{ Params: { teamId: string } }>) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'viewer'); } catch (error) { mapAccess(error); }
		return listProviders(request.params.teamId).map(provider => ({
			id: provider.id, name: provider.name, origin: provider.origin, authScheme: provider.authScheme,
			allowedPaths: provider.allowedPaths, probe: provider.probe, builtin: provider.builtin
		}));
	});

	app.post('/v1/teams/:teamId/providers', async (request: FastifyRequest<{ Params: { teamId: string }; Body: { name?: string; origin?: string; authScheme?: string; headerName?: string; allowedPaths?: AllowedPath[]; probePath?: string } }>, reply: FastifyReply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'maintainer'); } catch (error) { mapAccess(error); }
		const name = request.body.name?.trim().slice(0, 60);
		const origin = request.body.origin?.trim();
		if (!name || !origin || !VALID_URL.test(origin)) { return reply.badRequest('Provider name and https origin are required'); }
		const authScheme = ['bearer', 'x-api-key', 'header'].includes(request.body.authScheme ?? '') ? request.body.authScheme! : 'bearer';
		if (authScheme === 'header' && !request.body.headerName?.trim()) { return reply.badRequest('headerName is required for header auth scheme'); }
		const allowedPaths = (request.body.allowedPaths ?? [
			{ method: 'GET', path: '/v1/models' },
			{ method: 'POST', path: '/v1/chat/completions' }
		]).slice(0, 20).map(entry => ({ method: String(entry.method ?? 'GET').toUpperCase(), path: String(entry.path ?? '') })).filter(entry => entry.path.startsWith('/'));
		const probePath = request.body.probePath?.startsWith('/') ? request.body.probePath : '/v1/models';
		const providerId = `custom_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
		database.prepare('INSERT INTO team_providers(id,team_id,name,origin,auth_scheme,header_name,allowed_paths,probe_method,probe_path,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
			.run(providerId, request.params.teamId, name, origin.replace(/\/+$/, ''), authScheme, authScheme === 'header' ? request.body.headerName!.trim() : null, JSON.stringify(allowedPaths), 'GET', probePath, user, new Date().toISOString());
		audit(user, 'provider.create', request.params.teamId, 'provider', providerId, { name, origin });
		return reply.code(201).send({ id: providerId, name, origin, authScheme, allowedPaths, probe: { method: 'GET', path: probePath }, builtin: false });
	});

	app.delete('/v1/teams/:teamId/providers/:providerId', async (request: FastifyRequest<{ Params: { teamId: string; providerId: string } }>, reply: FastifyReply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'maintainer'); } catch (error) { mapAccess(error); }
		const result = database.prepare('DELETE FROM team_providers WHERE id=? AND team_id=?').run(request.params.providerId, request.params.teamId);
		if (result.changes !== 1) { return reply.notFound(); }
		audit(user, 'provider.delete', request.params.teamId, 'provider', request.params.providerId);
		return reply.code(204).send();
	});
}

function mapAccess(error: unknown): never {
	throw error;
}
