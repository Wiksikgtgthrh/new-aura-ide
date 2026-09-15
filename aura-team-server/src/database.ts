/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

mkdirSync(config.dataDir, { recursive: true });
export const database = new Database(join(config.dataDir, 'aura-team.db'));
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.pragma('busy_timeout = 30000');

database.exec(`
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, verified_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memberships (user_id TEXT NOT NULL REFERENCES users(id), team_id TEXT NOT NULL REFERENCES teams(id), role TEXT NOT NULL CHECK(role IN ('owner','maintainer','dev','viewer')), PRIMARY KEY(user_id, team_id));
CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), code_hash TEXT UNIQUE NOT NULL, role TEXT NOT NULL, expires_at TEXT NOT NULL, created_by TEXT NOT NULL, used_by TEXT, used_at TEXT);
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
`);

// Additive migrations keep existing VPS databases usable across Aura Team updates.
const apiKeyColumns = new Set((database.prepare('PRAGMA table_info(api_keys)').all() as { name: string }[]).map(column => column.name));
for (const [name, definition] of [
	['label', "TEXT NOT NULL DEFAULT 'Team key'"],
	['key_hint', "TEXT NOT NULL DEFAULT '••••'"],
	['priority', 'INTEGER NOT NULL DEFAULT 100'],
	['disabled_at', 'TEXT'],
] as const) {
	if (!apiKeyColumns.has(name)) { database.exec(`ALTER TABLE api_keys ADD COLUMN ${name} ${definition}`); }
}
database.exec('CREATE INDEX IF NOT EXISTS api_keys_team_provider_priority ON api_keys(team_id, provider, priority, created_at)');
const projectColumns = new Set((database.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map(column => column.name));
if (!projectColumns.has('owner_id')) { database.exec('ALTER TABLE projects ADD COLUMN owner_id TEXT'); }

export function audit(userId: string, action: string, teamId?: string, targetType?: string, targetId?: string, details: object = {}): void {
	database.prepare('INSERT INTO audit_log(team_id,user_id,action,target_type,target_id,details,created_at) VALUES(?,?,?,?,?,?,?)')
		.run(teamId ?? null, userId, action, targetType ?? null, targetId ?? null, JSON.stringify(details), new Date().toISOString());
}
