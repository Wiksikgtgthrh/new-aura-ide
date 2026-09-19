/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FastifyInstance } from 'fastify';
import { createReadStream, createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { mapAccessError, requireRole, userId } from '../access.js';
import { config } from '../config.js';
import { audit, database } from '../database.js';
import { id } from '../security.js';
import { broadcast } from '../realtime.js';

export async function archiveRoutes(app: FastifyInstance): Promise<void> {
	// Список архивов команды (вкладка «Файлы»): без него UI всегда показывал «пусто».
	app.get<{ Params: { teamId: string } }>('/v1/teams/:teamId/archives', async request => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'viewer'); } catch (error) { mapAccessError(error); }
		return (database.prepare(`
			SELECT a.id, a.project_id AS projectId, p.name AS projectName, a.bytes, a.created_at AS createdAt, a.expires_at AS expiresAt,
				u.display_name AS createdBy
			FROM archives a
			LEFT JOIN projects p ON p.id = a.project_id
			LEFT JOIN users u ON u.id = a.created_by
			WHERE a.team_id = ? AND a.expires_at > ?
			ORDER BY a.created_at DESC
		`).all(request.params.teamId, new Date().toISOString()) as unknown[]);
	});

	// Удаление архива: файл с диска + строка из БД (dev+, только свои либо maintainer+).
	app.delete<{ Params: { teamId: string; archiveId: string } }>('/v1/teams/:teamId/archives/:archiveId', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'dev'); } catch (error) { mapAccessError(error); }
		const row = database.prepare('SELECT id, path, created_by FROM archives WHERE id=? AND team_id=?').get(request.params.archiveId, request.params.teamId) as { id: string; path: string; created_by: string } | undefined;
		if (!row) { return reply.notFound(); }
		if (row.created_by !== user) {
			try { requireRole(user, request.params.teamId, 'maintainer'); } catch (error) { mapAccessError(error); }
		}
		rmSync(row.path, { force: true });
		database.prepare('DELETE FROM archives WHERE id=?').run(row.id);
		audit(user, 'archive.delete', request.params.teamId, 'archive', row.id);
		broadcast(request.params.teamId, 'project.changed');
		return { ok: true };
	});

	app.post<{ Params: { teamId: string }; Querystring: { projectName?: string; projectId?: string } }>('/v1/teams/:teamId/archives', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'dev'); } catch (error) { mapAccessError(error); }
		const part = await request.file({ limits: { fileSize: config.archiveMaxBytes, files: 1 } });
		if (!part || !part.filename) { return reply.badRequest('A file with a name is required'); }
		// Любой тип файла: имя сохраняем как есть (санитизация — только безопасные символы).
		const safeName = part.filename.replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'archive';
		const archiveId = id();
		// Загрузка в существующий проект (новая версия) — иначе создаём новый проект.
		let projectId = request.query.projectId?.trim() ?? '';
		if (projectId) {
			const existing = database.prepare('SELECT id FROM projects WHERE id=? AND team_id=?').get(projectId, request.params.teamId) as { id: string } | undefined;
			if (!existing) { return reply.badRequest('Project not found'); }
		} else {
			const projectName = request.query.projectName?.trim();
			if (!projectName) { return reply.badRequest('Project name is required'); }
			projectId = id();
			database.prepare('INSERT INTO projects(id,team_id,name,owner_id,default_branch,created_at) VALUES(?,?,?,?,?,?)').run(projectId, request.params.teamId, projectName, user, 'main', new Date().toISOString());
		}
		const directory = join(config.dataDir, 'archives');
		mkdirSync(directory, { recursive: true });
		const path = join(directory, `${archiveId}__${safeName}`);
		try {
			await pipeline(part.file, createWriteStream(path, { flags: 'wx' }));
			if (part.file.truncated) { throw Object.assign(new Error('Archive exceeds the configured size limit'), { statusCode: 413 }); }
			const bytes = part.file.bytesRead;
			const expiresAt = new Date(Date.now() + config.archiveTtlDays * 24 * 60 * 60_000).toISOString();
			database.transaction(() => {
				database.prepare('INSERT INTO archives(id,team_id,project_id,path,bytes,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)').run(archiveId, request.params.teamId, projectId, path, bytes, expiresAt, user, new Date().toISOString());
				audit(user, 'archive.upload', request.params.teamId, 'archive', archiveId, { bytes, projectId });
			})();
			broadcast(request.params.teamId, 'project.changed');
			return reply.code(201).send({ id: archiveId, projectId, bytes, expiresAt });
		} catch (error) {
			rmSync(path, { force: true });
			throw error;
		}
	});

	app.get<{ Params: { teamId: string; archiveId: string } }>('/v1/teams/:teamId/archives/:archiveId', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'viewer'); } catch (error) { mapAccessError(error); }
		const row = database.prepare('SELECT path,bytes FROM archives WHERE id=? AND team_id=? AND expires_at>?').get(request.params.archiveId, request.params.teamId, new Date().toISOString()) as { path: string; bytes: number } | undefined;
		if (!row) { return reply.notFound(); }
		const storedName = row.path.split(/[\\/]/).pop() ?? 'archive';
		const originalName = storedName.includes('__') ? storedName.slice(storedName.indexOf('__') + 2) : storedName;
		return reply.header('content-disposition', `attachment; filename="${encodeURIComponent(originalName)}"`).type('application/octet-stream').send(createReadStream(row.path));
	});
}

export function cleanupArchives(): number {
	const rows = database.prepare('SELECT id,path FROM archives WHERE expires_at<=?').all(new Date().toISOString()) as { id: string; path: string }[];
	const remove = database.prepare('DELETE FROM archives WHERE id=?');
	database.transaction(() => rows.forEach(row => { rmSync(row.path, { force: true }); remove.run(row.id); }))();
	return rows.length;
}
