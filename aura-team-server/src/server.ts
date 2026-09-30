/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import websocket from '@fastify/websocket';
import { mapAccessError, requireRole } from './access.js';
import { config } from './config.js';
import { cleanupDeletedTasks, database, seedAdminCode } from './database.js';
import { addClient, startHeartbeat } from './realtime.js';
import { adminRoutes } from './routes/admin.js';
import { agggRoutes } from './routes/aggg.js';
import { archiveRoutes, cleanupArchives } from './routes/archives.js';
import { authRoutes } from './routes/auth.js';
import { keyRoutes } from './routes/keys.js';
import { teamRoutes } from './routes/teams.js';
import { digest, token } from './security.js';

export async function createServer() {
	const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
	// Пустое тело с content-type: application/json — не ошибка, а «нет данных»: так уходят
	// запросы без нагрузки (DELETE задачи, снятие ключа), и старые сборки клиента.
	// Дефолтный парсер Fastify отвечал на это 400 FST_ERR_CTP_EMPTY_JSON_BODY
	// («Body cannot be empty when content-type is set to 'application/json'»), из-за чего
	// удаление не доходило до обработчика и задача оставалась на доске.
	// Непустое тело по-прежнему разбирает штатный парсер Fastify — со защитой от
	// prototype pollution: свой JSON.parse здесь был бы шагом назад по безопасности.
	const parseJson = app.getDefaultJsonParser('error', 'error');
	app.removeContentTypeParser('application/json');
	app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
		const raw = typeof body === 'string' ? body : body.toString('utf8');
		if (raw.trim() === '') { done(null, {}); return; }
		parseJson(request, raw, done);
	});
	await app.register(sensible);
	await app.register(rateLimit, { global: false });
	await app.register(multipart, { limits: { fileSize: config.archiveMaxBytes, files: 1 } });
	await app.register(websocket);
	await app.register(authRoutes);
	await app.register(teamRoutes);
	await app.register(keyRoutes);
	await app.register(archiveRoutes);
	await app.register(adminRoutes);
	await app.register(agggRoutes);
	// Код администратора сеем хэшем: один раз и до погашения. Уже использованный
	// код повторно не появляется, а значение кода в базе не хранится вовсе.
	seedAdminCode(config.adminCode, 'bootstrap from AURA_ADMIN_CODE');
	app.get('/health', async () => ({ ok: true }));

	if (process.env.AURA_DEBUG_ADMIN === 'true') {
		app.get('/v1/debug/status', async () => ({
			db: { file: 'aura-team.db', WAL: true },
			uptime: process.uptime(),
			env: process.env.NODE_ENV
		}));
	}

	app.post<{ Params: { teamId: string } }>('/v1/teams/:teamId/events-ticket', async request => {
		const { userId } = await import('./access.js');
		const user = await userId(request);
		requireRole(user, request.params.teamId, 'viewer');
		const ticket = token(24);
		database.prepare('INSERT INTO websocket_tickets(ticket_hash,user_id,team_id,expires_at) VALUES(?,?,?,?)').run(digest(ticket), user, request.params.teamId, new Date(Date.now() + 30_000).toISOString());
		return { ticket, expiresIn: 30 };
	});
	app.get<{ Params: { teamId: string }; Querystring: { ticket?: string } }>('/v1/teams/:teamId/events', { websocket: true }, async (socket, request) => {
		try {
			const ticketHash = digest(request.query.ticket ?? '');
			const ticket = database.prepare('SELECT user_id FROM websocket_tickets WHERE ticket_hash=? AND team_id=? AND expires_at>? AND consumed_at IS NULL').get(ticketHash, request.params.teamId, new Date().toISOString()) as { user_id: string } | undefined;
			if (!ticket) { throw new Error('Invalid WebSocket ticket'); }
			const result = database.prepare('UPDATE websocket_tickets SET consumed_at=? WHERE ticket_hash=? AND consumed_at IS NULL').run(new Date().toISOString(), ticketHash);
			if (result.changes !== 1) { throw new Error('Invalid WebSocket ticket'); }
			addClient(request.params.teamId, ticket.user_id, socket);
			socket.send(JSON.stringify({ type: 'connected', at: new Date().toISOString() }));
		} catch (error) {
			try { mapAccessError(error); } catch { socket.close(1008, 'Unauthorized'); }
		}
	});
	return app;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
	const app = await createServer();
	cleanupArchives();
	setInterval(cleanupArchives, 60 * 60_000).unref();
	cleanupDeletedTasks(); // очистить корзину сразу при старте (накопилось за время простоя)
	setInterval(cleanupDeletedTasks, 6 * 60 * 60_000).unref(); // затем раз в 6 часов
	setInterval(() => database.prepare('DELETE FROM device_codes WHERE expires_at<=?').run(new Date().toISOString()), 60 * 60_000).unref();
	startHeartbeat();
	await app.listen({ host: config.host, port: config.port });
}

process.on('SIGTERM', () => database.close());
