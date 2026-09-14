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
	app.post<{ Params: { teamId: string }; Querystring: { projectName?: string } }>('/v1/teams/:teamId/archives', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'dev'); } catch (error) { mapAccessError(error); }
		const part = await request.file({ limits: { fileSize: config.archiveMaxBytes, files: 1 } });
		if (!part || (!part.filename.endsWith('.tar.zst') && !part.filename.endsWith('.tzst'))) { return reply.badRequest('A .tar.zst file is required'); }
		const archiveId = id();
		const projectId = id();
		const projectName = request.query.projectName?.trim();
		if (!projectName) { return reply.badRequest('Project name is required'); }
		const directory = join(config.dataDir, 'archives');
		mkdirSync(directory, { recursive: true });
		const path = join(directory, `${archiveId}.tar.zst`);
		try {
			await pipeline(part.file, createWriteStream(path, { flags: 'wx' }));
			if (part.file.truncated) { throw Object.assign(new Error('Archive exceeds the configured size limit'), { statusCode: 413 }); }
			const bytes = part.file.bytesRead;
			const expiresAt = new Date(Date.now() + config.archiveTtlDays * 24 * 60 * 60_000).toISOString();
			database.transaction(() => {
				database.prepare('INSERT INTO projects(id,team_id,name,archive_id,default_branch,created_at) VALUES(?,?,?,?,?,?)').run(projectId, request.params.teamId, projectName, archiveId, 'main', new Date().toISOString());
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
		const row = database.prepare('SELECT path FROM archives WHERE id=? AND team_id=? AND expires_at>?').get(request.params.archiveId, request.params.teamId, new Date().toISOString()) as { path: string } | undefined;
		if (!row) { return reply.notFound(); }
		return reply.type('application/zstd').send(createReadStream(row.path));
	});
}

export function cleanupArchives(): number {
	const rows = database.prepare('SELECT id,path FROM archives WHERE expires_at<=?').all(new Date().toISOString()) as { id: string; path: string }[];
	const remove = database.prepare('DELETE FROM archives WHERE id=?');
	database.transaction(() => rows.forEach(row => { rmSync(row.path, { force: true }); remove.run(row.id); }))();
	return rows.length;
}
