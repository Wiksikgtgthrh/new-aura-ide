/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.AURA_DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-team-trash-'));
process.env.AURA_MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
process.env.AURA_JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters';
process.env.AURA_TRASH_TTL_DAYS = '30';

test('cleanupDeletedTasks physically removes tasks soft-deleted older than the TTL and keeps fresh ones', async () => {
	const [{ database, cleanupDeletedTasks }] = await Promise.all([
		import('../src/database.js')
	]);
	const now = Date.now();
	// foreign_keys = ON: нужна реальная команда и реальный автор.
	database.prepare("INSERT INTO users(id,email,display_name,password_hash,verified_at,created_at) VALUES('someone','someone@example.com','Someone','x','now','now')").run();
	database.prepare("INSERT INTO teams(id,name,created_by,created_at) VALUES('team','Test Team','someone','now')").run();
	const insert = database.prepare('INSERT INTO tasks(id,team_id,title,status,created_by,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?)');
	insert.run('t-old', 'team', 'Old deleted', 'todo', 'someone', 'now', 'now', new Date(now - 31 * 864e5).toISOString());
	insert.run('t-fresh', 'team', 'Fresh deleted', 'todo', 'someone', 'now', 'now', new Date(now - 2 * 864e5).toISOString());
	insert.run('t-live', 'team', 'Live task', 'todo', 'someone', 'now', 'now', null);
	database.prepare('INSERT INTO task_commits(task_id,commit_hash,repository_url,author_id,created_at) VALUES(?,?,?,?,?)').run('t-old', 'abc123', 'https://github.com/example/repo', 'someone', 'now');

	const removed = cleanupDeletedTasks();

	assert.equal(removed, 1, 'only the 31-day-old task should be removed');
	const leftovers = database.prepare('SELECT id FROM tasks WHERE id IN (?,?,?)').all('t-old', 't-fresh', 't-live');
	assert.deepEqual(leftovers.map((row: { id: string }) => row.id).sort(), ['t-fresh', 't-live'], 'fresh deleted and live tasks survive');
	const commits = database.prepare('SELECT COUNT(*) AS n FROM task_commits WHERE task_id=?').get('t-old') as { n: number };
	assert.equal(commits.n, 0, 'commits of the purged task are cleaned up');

	// Повторный запуск — удалять больше нечего.
	assert.equal(cleanupDeletedTasks(), 0);
});
