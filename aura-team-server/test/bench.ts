/*---------------------------------------------------------------------------------------------
 *  Замеры горячих маршрутов на реалистичных объёмах. Не тест (в `npm test` не входит):
 *  нужен, чтобы «сервер тормозит» превращать в число, а оптимизации — в до/после.
 *
 *  Что уже нашлось этим стендом: `GET activity` читал ВСЕ события команды и сортировал
 *  их ради 20 строк (10.7 → 0.55 мс); поиск участников сканировал всю таблицу членств
 *  сервера (индекс `memberships_team`); реордер колонки компилировал один и тот же
 *  UPDATE на каждую задачу (4.9 → 1.9 мс на 250 задач).
 *
 *  Запуск: node --import tsx test/bench.ts
 *--------------------------------------------------------------------------------------------*/
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AURA_DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-bench-'));
process.env.AURA_MASTER_KEY ??= 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
process.env.AURA_JWT_SECRET ??= 'bench-only-jwt-secret-at-least-32-characters';
process.env.AURA_ADMIN_CODE ??= 'AUR-BENCH';

const [{ createServer }, { database }, { accessToken, digest }, { hash }] = await Promise.all([
	import('../src/server.js'),
	import('../src/database.js'),
	import('../src/security.js'),
	import('@node-rs/argon2')
]);

const app = await createServer();
app.log.level = 'silent';

const USERS = 150;
const TASKS = 3000;
const AUDIT = 20_000;
const PROJECTS = 200;
const EXTRA_TEAMS = 40;
const now = new Date().toISOString();
const passwordHash = await hash('long-test-password');

const seed = database.transaction(() => {
	const user = database.prepare('INSERT INTO users(id,email,display_name,password_hash,verified_at,created_at) VALUES(?,?,?,?,?,?)');
	const member = database.prepare('INSERT INTO memberships(user_id,team_id,role) VALUES(?,?,?)');
	user.run('owner', 'owner@example.com', 'Owner', passwordHash, now, now);
	const team = database.prepare('INSERT INTO teams(id,name,created_by,created_at) VALUES(?,?,?,?)');
	team.run('team', 'Bench Team', 'owner', now);
	member.run('owner', 'team', 'owner');
	for (let i = 0; i < USERS; i++) {
		const id = `u${i}`;
		user.run(id, `${id}@example.com`, `User ${String(i).padStart(3, '0')}`, passwordHash, now, now);
		member.run(id, 'team', i % 10 === 0 ? 'maintainer' : 'dev');
	}
	// Соседние команды: сервер общий, и цена «найти участников одной команды» растёт от
	// общего числа членств в базе — именно это и ловим.
	for (let t = 0; t < EXTRA_TEAMS; t++) {
		team.run(`other${t}`, `Other ${t}`, 'owner', now);
		for (let i = 0; i < USERS; i++) { member.run(`u${i}`, `other${t}`, 'dev'); }
	}
	const project = database.prepare('INSERT INTO projects(id,team_id,name,git_url,owner_id,default_branch,created_at) VALUES(?,?,?,?,?,?,?)');
	for (let i = 0; i < PROJECTS; i++) { project.run(`p${i}`, 'team', `Project ${i}`, 'https://example.com/r.git', 'owner', 'main', now); }
	const task = database.prepare('INSERT INTO tasks(id,team_id,title,description,status,assignee_id,position,due_at,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
	const statuses = ['todo', 'doing', 'review', 'done'];
	for (let i = 0; i < TASKS; i++) {
		task.run(`t${i}`, 'team', `Задача ${i}`, 'описание '.repeat(5), statuses[i % 4], i % 150 === 0 ? 'owner' : `u${i % USERS}`, i % 800, i % 5 === 0 ? now : null, 'owner', now, now);
	}
	const audit = database.prepare('INSERT INTO audit_log(team_id,user_id,action,target_type,target_id,details,created_at) VALUES(?,?,?,?,?,?,?)');
	for (let i = 0; i < AUDIT; i++) {
		audit.run('team', `u${i % USERS}`, i % 3 === 0 ? 'task.update' : i % 3 === 1 ? 'task.create' : 'membership.role', 'task', `t${i % TASKS}`, JSON.stringify({ i }), new Date(Date.now() - i * 60_000).toISOString());
	}
});
seed();

const authorization = `Bearer ${await accessToken('owner')}`;
const headers = { authorization };

const time = async (name: string, url: string, count = 30) => {
	const samples: number[] = [];
	for (let i = 0; i < count; i++) {
		const started = performance.now();
		const response = await app.inject({ method: 'GET', url, headers });
		samples.push(performance.now() - started);
		if (response.statusCode !== 200) { throw new Error(`${name}: HTTP ${response.statusCode} ${response.body.slice(0, 200)}`); }
	}
	samples.sort((a, b) => a - b);
	const median = samples[Math.floor(samples.length / 2)];
	console.log(`${name.padEnd(34)} median ${median.toFixed(2)} ms   p90 ${samples[Math.floor(samples.length * 0.9)].toFixed(2)} ms   bytes ${(await app.inject({ method: 'GET', url, headers })).rawPayload.length}`);
};

console.log(`\nданные: ${USERS} пользователей, ${TASKS} задач, ${AUDIT} событий, ${PROJECTS} проектов, ${EXTRA_TEAMS + 1} команд (${USERS * (EXTRA_TEAMS + 1) + 1} членств)\n`);
await time('GET /v1/me', '/v1/me');
await time('GET board', '/v1/teams/team/board');
await time('GET summary', '/v1/teams/team/summary');
await time('GET activity (20)', '/v1/teams/team/activity?limit=20');
await time('GET activity (100)', '/v1/teams/team/activity?limit=100');
await time('GET usage', '/v1/teams/team/usage');
await time('GET trash', '/v1/teams/team/tasks/trash');
await time('GET directory', '/v1/teams/team/directory?q=User');
await time('GET invites', '/v1/teams/team/invite');
await time('GET limits', '/v1/teams/team/limits');

// Реордер колонки на 250 задач — самый тяжёлый из клиентских сценариев канбана.
const column = database.prepare("SELECT id FROM tasks WHERE team_id='team' AND status='todo' ORDER BY position LIMIT 250").all() as Array<{ id: string }>;
const ordered = column.map(row => row.id);
const reorderSamples: number[] = [];
for (let i = 0; i < 5; i++) {
	const started = performance.now();
	const response = await app.inject({ method: 'POST', url: '/v1/teams/team/tasks/reorder', headers, payload: { status: 'todo', orderedIds: ordered } });
	reorderSamples.push(performance.now() - started);
	if (response.statusCode !== 200) { throw new Error(`reorder: HTTP ${response.statusCode}`); }
}
reorderSamples.sort((a, b) => a - b);
console.log(`${'POST reorder (250 задач)'.padEnd(34)} median ${reorderSamples[2].toFixed(2)} ms`);

const plan = (label: string, sql: string, ...params: unknown[]) => {
	console.log(`EXPLAIN ${label}`);
	for (const row of database.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params)) { console.log('   ' + JSON.stringify(row)); }
};
plan('activity', 'SELECT a.id FROM audit_log a WHERE a.team_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT ?', 'team', 20);
plan('members (board/summary)', 'SELECT u.id,u.display_name,u.email,m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY u.display_name', 'team');
const memberStatement = database.prepare('SELECT u.id,u.display_name,u.email,m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY u.display_name');
const memberSamples: number[] = [];
for (let i = 0; i < 200; i++) { const started = performance.now(); memberStatement.all('team'); memberSamples.push(performance.now() - started); }
memberSamples.sort((a, b) => a - b);
console.log(`${'   (только запрос участников)'.padEnd(34)} median ${memberSamples[100].toFixed(3)} ms`);
plan('board tasks', 'SELECT t.id FROM tasks t WHERE t.team_id = ? AND t.deleted_at IS NULL ORDER BY t.status, t.position', 'team');
plan('my tasks', "SELECT id FROM tasks WHERE team_id = ? AND assignee_id = ? AND status != 'done' AND deleted_at IS NULL ORDER BY due_at IS NULL, due_at LIMIT ?", 'team', 'owner', 10);
plan('members', 'SELECT u.id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY u.display_name', 'team');

const size = database.prepare('SELECT page_count*page_size AS bytes FROM pragma_page_count(), pragma_page_size()').get() as { bytes: number };
console.log(`\nБД: ${(size.bytes / 1024 / 1024).toFixed(2)} МБ\n`);
await app.close();
