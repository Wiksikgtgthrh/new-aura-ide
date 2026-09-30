/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { secretDigest } from './security.js';
import { roleAtLeast, type Role } from './features.js';

mkdirSync(config.dataDir, { recursive: true });
export const database = new Database(join(config.dataDir, 'aura-team.db'));
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.pragma('busy_timeout = 30000');

database.exec(`
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, verified_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memberships (user_id TEXT NOT NULL REFERENCES users(id), team_id TEXT NOT NULL REFERENCES teams(id), role TEXT NOT NULL CHECK(role IN ('owner','maintainer','dev','viewer')), PRIMARY KEY(user_id, team_id));
CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), code_hash TEXT UNIQUE NOT NULL, role TEXT NOT NULL, expires_at TEXT NOT NULL, created_by TEXT NOT NULL, used_by TEXT, used_at TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), name TEXT NOT NULL, git_url TEXT, archive_id TEXT, default_branch TEXT NOT NULL DEFAULT 'main', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo', assignee_id TEXT REFERENCES users(id), position INTEGER NOT NULL DEFAULT 0, due_at TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), owner_id TEXT NOT NULL, provider TEXT NOT NULL, encrypted_value TEXT NOT NULL, access_role TEXT NOT NULL DEFAULT 'dev', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT, user_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT, target_id TEXT, details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS refresh_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT UNIQUE NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS device_codes (id TEXT PRIMARY KEY, user_code_hash TEXT UNIQUE NOT NULL, user_id TEXT REFERENCES users(id), expires_at TEXT NOT NULL, interval_seconds INTEGER NOT NULL DEFAULT 5, consumed_at TEXT);
CREATE TABLE IF NOT EXISTS email_verifications (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, consumed_at TEXT);
CREATE TABLE IF NOT EXISTS archives (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), project_id TEXT REFERENCES projects(id), path TEXT NOT NULL, bytes INTEGER NOT NULL, expires_at TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS proxy_usage (user_id TEXT NOT NULL, team_id TEXT NOT NULL, day TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, team_id, day));
CREATE TABLE IF NOT EXISTS task_commits (task_id TEXT NOT NULL REFERENCES tasks(id), commit_hash TEXT NOT NULL, repository_url TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, PRIMARY KEY(task_id, commit_hash));
CREATE TABLE IF NOT EXISTS websocket_tickets (ticket_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), team_id TEXT NOT NULL REFERENCES teams(id), expires_at TEXT NOT NULL, consumed_at TEXT);
CREATE TABLE IF NOT EXISTS proxy_tokens (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), team_id TEXT NOT NULL REFERENCES teams(id), provider TEXT NOT NULL, model TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tasks_team_status_position ON tasks(team_id, status, position);
CREATE INDEX IF NOT EXISTS audit_team_created ON audit_log(team_id, created_at);
-- Первичный ключ memberships — (user_id, team_id), то есть «в каких командах состоит человек».
-- Обратный вопрос («кто в этой команде») им не покрыт: доска, сводка и каталог сканировали
-- ВСЮ таблицу членств сервера на каждый запрос, и цена росла от общего числа людей в базе,
-- а не от размера команды. Замерено на 6k членств: сводка 1.5 → 2.4 мс только на этом скане.
CREATE INDEX IF NOT EXISTS memberships_team ON memberships(team_id);
`);

// Additive migrations keep existing VPS databases usable across Aura Team updates.
const apiKeyColumns = new Set((database.prepare('PRAGMA table_info(api_keys)').all() as { name: string }[]).map(column => column.name));
for (const [name, definition] of [
	['label', "TEXT NOT NULL DEFAULT 'Team key'"],
	['key_hint', "TEXT NOT NULL DEFAULT '••••'"],
	['priority', 'INTEGER NOT NULL DEFAULT 100'],
	['disabled_at', 'TEXT'],
	['group_id', 'TEXT'],
	['ping_ms', 'INTEGER'],
	['last_checked_at', 'TEXT'],
	['last_ok', 'INTEGER'],
] as const) {
	if (!apiKeyColumns.has(name)) { database.exec(`ALTER TABLE api_keys ADD COLUMN ${name} ${definition}`); }
}
database.exec('CREATE INDEX IF NOT EXISTS api_keys_team_provider_priority ON api_keys(team_id, provider, priority, created_at)');
const projectColumns = new Set((database.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map(column => column.name));
if (!projectColumns.has('owner_id')) { database.exec('ALTER TABLE projects ADD COLUMN owner_id TEXT'); }

// Мягкое удаление задач: колонка deleted_at + фильтр в выборках канбана/summary.
const taskColumns = new Set((database.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(column => column.name));
if (!taskColumns.has('deleted_at')) { database.exec('ALTER TABLE tasks ADD COLUMN deleted_at TEXT'); }
// Колонка last_seen_at в memberships: когда участник был в сети последний раз (для presence).
const membershipColumns = new Set((database.prepare('PRAGMA table_info(memberships)').all() as { name: string }[]).map(column => column.name));
if (!membershipColumns.has('last_seen_at')) { database.exec('ALTER TABLE memberships ADD COLUMN last_seen_at TEXT'); }
// Убираем статус backlog: канбан теперь todo → doing → review → done.
database.prepare("UPDATE tasks SET status='todo' WHERE status='backlog'").run();
// Колонка created_at у invites: активный код выбирался сортировкой по ней, и на базах
// без этой колонки GET /invite падал с SQLITE_ERROR «no such column» — панель
// показывала «кода нет», хотя код был жив.
const inviteColumns = new Set((database.prepare('PRAGMA table_info(invites)').all() as { name: string }[]).map(column => column.name));
if (!inviteColumns.has('created_at')) {
	database.exec('ALTER TABLE invites ADD COLUMN created_at TEXT');
	// Срок жизни кода всегда 7 суток, поэтому порядок по expires_at совпадает с порядком создания.
	database.exec('UPDATE invites SET created_at = expires_at WHERE created_at IS NULL');
}

// Регистрация без письма: активируем всех, кто не успел подтвердить email до отказа от верификации.
database.prepare("UPDATE users SET verified_at=COALESCE(verified_at, created_at)").run();

// Группы ключей команды (как в Aura API: имя + приоритет).
database.exec(`CREATE TABLE IF NOT EXISTS key_groups (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), name TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS key_groups_team ON key_groups(team_id, priority);`);

// Открытый текст текущего инвайт-кода (для показа в UI; хэш живёт в invites).
database.exec(`CREATE TABLE IF NOT EXISTS invite_reveals (invite_id TEXT PRIMARY KEY REFERENCES invites(id), team_id TEXT NOT NULL REFERENCES teams(id), value TEXT NOT NULL);`);

// Расход прокси по ключам: для экрана статистики (GET /usage).
database.exec(`CREATE TABLE IF NOT EXISTS proxy_usage_keys (team_id TEXT NOT NULL, key_id TEXT NOT NULL, day TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(team_id, key_id, day));`);

// Права на отдельные возможности (например, внешнее ядро AGGG 5.2): выдаются
// конкретному аккаунту, а не всей команде, и не появляются от регистрации.
database.exec(`CREATE TABLE IF NOT EXISTS entitlements (user_id TEXT NOT NULL REFERENCES users(id), feature TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', granted_at TEXT NOT NULL, PRIMARY KEY(user_id, feature));`);

// Командная выдача тех же возможностей: право наследуют участники не ниже min_role.
database.exec(`CREATE TABLE IF NOT EXISTS team_entitlements (team_id TEXT NOT NULL REFERENCES teams(id), feature TEXT NOT NULL, min_role TEXT NOT NULL DEFAULT 'dev', note TEXT NOT NULL DEFAULT '', granted_at TEXT NOT NULL, PRIMARY KEY(team_id, feature, min_role));`);

// Администраторы: выдавать закрытые возможности аккаунтам и командам может
// только админ, и только он видит список чужих прав.
database.exec(`CREATE TABLE IF NOT EXISTS admins (user_id TEXT PRIMARY KEY REFERENCES users(id), granted_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');`);

// Коды администратора: хранится только HMAC, строка после погашения остаётся
// как след (redeemed_by/redeemed_at) — повторно код не срабатывает.
database.exec(`CREATE TABLE IF NOT EXISTS admin_codes (code_hash TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, redeemed_by TEXT REFERENCES users(id), redeemed_at TEXT);`);

/** Право аккаунта или команды: источник виден в UI, а не только факт «есть/нет». */
export interface EntitlementRow {
	feature: string;
	grantedAt: string;
	note: string;
	/** 'account' — выдано аккаунту, 'team' — унаследовано от команды с нужной ролью. */
	source: 'account' | 'team';
	/** Для командной выдачи: откуда именно пришло право. */
	teamId?: string;
	teamName?: string;
	minRole?: string;
}

/**
 * Список выданных возможностей аккаунта: собственные права плюс унаследованные
 * от команд, где роль не ниже min_role. Дубликат (право и у аккаунта, и у команды)
 * остаётся одним элементом — источник главнее аккаунтный.
 */
export function entitlementsOf(userId: string): EntitlementRow[] {
	const own = (database.prepare('SELECT feature, granted_at, note FROM entitlements WHERE user_id=?').all(userId) as Array<{ feature: string; granted_at: string; note: string }>)
		.map(row => ({ feature: row.feature, grantedAt: row.granted_at, note: row.note, source: 'account' as const }));
	const teamRows = database.prepare(
		`SELECT e.feature, e.granted_at, e.note, e.team_id, e.min_role, t.name AS team_name, m.role AS my_role
		 FROM team_entitlements e
		 JOIN teams t ON t.id = e.team_id
		 JOIN memberships m ON m.team_id = e.team_id AND m.user_id = ?`
	).all(userId) as Array<{ feature: string; granted_at: string; note: string; team_id: string; min_role: string; team_name: string; my_role: string }>;
	const inherited = teamRows
		.filter(row => roleAtLeast(row.my_role, (row.min_role || 'dev') as Role))
		.map(row => ({ feature: row.feature, grantedAt: row.granted_at, note: row.note, source: 'team' as const, teamId: row.team_id, teamName: row.team_name, minRole: row.min_role }));
	const byFeature = new Map<string, EntitlementRow>();
	for (const row of [...inherited, ...own]) { byFeature.set(row.feature, row); }
	return [...byFeature.values()].sort((a, b) => a.feature.localeCompare(b.feature));
}

/** Есть ли у аккаунта возможность — с учётом командных выдач. */
export function hasEntitlement(userId: string, feature: string): boolean {
	return entitlementsOf(userId).some(row => row.feature === feature);
}

/** Выдать или отозвать возможность. Используется CLI-скриптом grant и админ-панелью. */
export function setEntitlement(userId: string, feature: string, granted: boolean, note = ''): void {
	if (granted) {
		database.prepare('INSERT INTO entitlements(user_id,feature,note,granted_at) VALUES(?,?,?,?) ON CONFLICT(user_id,feature) DO UPDATE SET note=excluded.note').run(userId, feature, note, new Date().toISOString());
	} else {
		database.prepare('DELETE FROM entitlements WHERE user_id=? AND feature=?').run(userId, feature);
	}
}

/** Командные права: выдаются команде и наследуются участниками не ниже min_role. */
export function setTeamEntitlement(teamId: string, feature: string, minRole: string, granted: boolean, note = ''): void {
	if (granted) {
		database.prepare('INSERT INTO team_entitlements(team_id,feature,min_role,note,granted_at) VALUES(?,?,?,?,?) ON CONFLICT(team_id,feature,min_role) DO UPDATE SET note=excluded.note').run(teamId, feature, minRole, note, new Date().toISOString());
	} else {
		database.prepare('DELETE FROM team_entitlements WHERE team_id=? AND feature=? AND min_role=?').run(teamId, feature, minRole);
	}
}

/** Все командные выдачи — для админ-панели. */
export function teamEntitlements(): Array<{ teamId: string; teamName: string; feature: string; minRole: string; note: string; grantedAt: string }> {
	return (database.prepare('SELECT e.team_id, t.name AS team_name, e.feature, e.min_role, e.note, e.granted_at FROM team_entitlements e JOIN teams t ON t.id=e.team_id ORDER BY t.name, e.feature').all() as Array<{ team_id: string; team_name: string; feature: string; min_role: string; note: string; granted_at: string }>)
		.map(row => ({ teamId: row.team_id, teamName: row.team_name, feature: row.feature, minRole: row.min_role, note: row.note, grantedAt: row.granted_at }));
}

/* ------------------------------------------------------------------ */
/* Администраторы: право выдавать закрытые возможности другим аккаунтам. */
/* ------------------------------------------------------------------ */

/**
 * Коды администратора лежат только хэшами и сгорают после первого использования:
 * в базе нет значения, которое можно подсмотреть, а утёкший код нельзя применить
 * дважды — повторная попытка получает отказ, а факт попытки виден в аудите.
 */
export function seedAdminCode(code: string, note = 'bootstrap'): boolean {
	const value = code.trim();
	if (!value) { return false; }
	const result = database.prepare('INSERT OR IGNORE INTO admin_codes(code_hash,note,created_at) VALUES(?,?,?)').run(secretDigest(value), note, new Date().toISOString());
	return result.changes === 1;
}

/** Погасить код и выдать аккаунту админку. Повторное использование невозможно. */
export function redeemAdminCode(code: string, userId: string): boolean {
	const hash = secretDigest(code.trim());
	return database.transaction(() => {
		const row = database.prepare('SELECT note FROM admin_codes WHERE code_hash=? AND redeemed_at IS NULL').get(hash) as { note: string } | undefined;
		if (!row) { return false; }
		const now = new Date().toISOString();
		const claimed = database.prepare('UPDATE admin_codes SET redeemed_by=?, redeemed_at=? WHERE code_hash=? AND redeemed_at IS NULL').run(userId, now, hash);
		if (claimed.changes !== 1) { return false; }
		database.prepare('INSERT OR REPLACE INTO admins(user_id,granted_at,note) VALUES(?,?,?)').run(userId, now, row.note);
		audit(userId, 'admin.redeem', undefined, 'admin', userId, { note: row.note });
		return true;
	})();
}

export function isAdmin(userId: string): boolean {
	return Boolean(database.prepare('SELECT 1 FROM admins WHERE user_id=?').get(userId));
}

export function grantAdmin(userId: string, note = ''): void {
	database.prepare('INSERT OR REPLACE INTO admins(user_id,granted_at,note) VALUES(?,?,?)').run(userId, new Date().toISOString(), note);
}

/** Отозвать админку. Последнего администратора снять нельзя — иначе некому выдавать права. */
export function revokeAdmin(userId: string): boolean {
	const total = (database.prepare('SELECT COUNT(*) AS n FROM admins').get() as { n: number }).n;
	if (total <= 1) { return false; }
	database.prepare('DELETE FROM admins WHERE user_id=?').run(userId);
	return true;
}

export function admins(): Array<{ userId: string; email: string; displayName: string; grantedAt: string; note: string }> {
	return (database.prepare('SELECT a.user_id, u.email, u.display_name, a.granted_at, a.note FROM admins a JOIN users u ON u.id=a.user_id ORDER BY a.granted_at').all() as Array<{ user_id: string; email: string; display_name: string; granted_at: string; note: string }>)
		.map(row => ({ userId: row.user_id, email: row.email, displayName: row.display_name, grantedAt: row.granted_at, note: row.note }));
}

/** Права аккаунтов — для списка в админ-панели (командные идут отдельно). */
export function accountEntitlements(): Array<{ userId: string; email: string; feature: string; note: string; grantedAt: string }> {
	return (database.prepare('SELECT e.user_id, u.email, e.feature, e.note, e.granted_at FROM entitlements e JOIN users u ON u.id=e.user_id ORDER BY e.feature, u.email').all() as Array<{ user_id: string; email: string; feature: string; note: string; granted_at: string }>)
		.map(row => ({ userId: row.user_id, email: row.email, feature: row.feature, note: row.note, grantedAt: row.granted_at }));
}

export function audit(userId: string, action: string, teamId?: string, targetType?: string, targetId?: string, details: object = {}): void {
	database.prepare('INSERT INTO audit_log(team_id,user_id,action,target_type,target_id,details,created_at) VALUES(?,?,?,?,?,?,?)')
		.run(teamId ?? null, userId, action, targetType ?? null, targetId ?? null, JSON.stringify(details), new Date().toISOString());
	// Живая лента в сайдбаре: уведомляем подписчиков команды о новом событии.
	if (teamId) {
		import('./realtime.js').then(({ broadcast }) => broadcast(teamId, 'activity.changed')).catch(() => undefined);
	}
}

/**
 * Автоочистка корзины: задачи, мягко удалённые больше N дней назад, удаляются физически
 * (вместе со связанными коммитами). Возвращает число удалённых задач.
 */
export function cleanupDeletedTasks(): number {
	const cutoff = new Date(Date.now() - config.trashTtlDays * 24 * 60 * 60_000).toISOString();
	const expired = database.prepare('SELECT id FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at<=?').all(cutoff) as { id: string }[];
	if (expired.length === 0) { return 0; }
	return database.transaction(() => {
		let removed = 0;
		for (const { id } of expired) {
			// task_commits ссылается на tasks — чистим до удаления задачи (foreign_keys = ON).
			database.prepare('DELETE FROM task_commits WHERE task_id=?').run(id);
			removed += database.prepare('DELETE FROM tasks WHERE id=? AND deleted_at IS NOT NULL').run(id).changes;
		}
		return removed;
	})();
}
