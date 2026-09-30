#!/usr/bin/env node
/*
 * Выдача прав аккаунту без ручного SQL.
 *
 *   npm run grant -- --email wiks@example.com --feature aggg52
 *   npm run grant -- --email wiks@example.com --feature aggg52 --revoke
 *   npm run grant -- --team "Aura Studio" --feature aggg52 --min-role maintainer
 *   npm run grant -- --email wiks@example.com --admin
 *   npm run grant -- --list
 *
 * Права лежат в таблице entitlements и не выдаются ни регистрацией, ни командой:
 * возможность 5.2 должна включаться осознанно, по аккаунту.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// Собираем dist, если его нет: скрипт запускается и на живой VPS из репозитория.
const { existsSync } = await import('node:fs');
if (!existsSync(join(root, 'dist', 'database.js'))) {
	console.error('Соберите сервер: npm run build');
	process.exit(1);
}

const { database, entitlementsOf, setEntitlement, setTeamEntitlement, teamEntitlements, grantAdmin, revokeAdmin, admins } = require(join(root, 'dist', 'database.js'));
const { ROLES } = require(join(root, 'dist', 'features.js'));

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
};

/** Известные возможности: опечатка в имени не должна молча выдавать пустое право. */
const KNOWN_FEATURES = {
	aggg52: 'Внешнее ядро AGGG 5.2 (каталог агента)',
};

const target = value('--team') ?? value('--email');
if (flag('--help') || (!flag('--list') && !target)) {
	console.log('Использование: npm run grant -- --email <почта> --feature <возможность> [--revoke]');
	console.log('               npm run grant -- --team <id или название> --feature <возможность> [--min-role owner|maintainer|dev|viewer] [--revoke]');
	console.log('               npm run grant -- --email <почта> --admin [--revoke]   — выдать или снять админку');
	console.log('               npm run grant -- --list');
	console.log('Возможности: ' + Object.entries(KNOWN_FEATURES).map(([id, title]) => `${id} — ${title}`).join('; '));
	process.exit(flag('--help') ? 0 : 1);
}

if (flag('--list')) {
	const rows = database.prepare('SELECT u.email, e.feature, e.granted_at FROM entitlements e JOIN users u ON u.id=e.user_id ORDER BY e.feature, u.email').all();
	if (!rows.length) { console.log('Права аккаунтов не выданы.'); }
	for (const row of rows) { console.log(`АККАУНТ\t${row.feature}\t${row.email}\t${row.granted_at}`); }
	for (const row of teamEntitlements()) { console.log(`КОМАНДА\t${row.feature}\t${row.teamName}\tот роли ${row.minRole}\t${row.grantedAt}`); }
	for (const row of admins()) { console.log(`АДМИН\t—\t${row.email}\t${row.grantedAt}`); }
	process.exit(0);
}

const email = String(value('--email') ?? '').trim().toLowerCase();
const revoke = flag('--revoke');

// Админка выдаётся только по email: аккаунт должен существовать.
if (flag('--admin') || flag('--revoke-admin')) {
	const user = database.prepare('SELECT id, display_name FROM users WHERE email=?').get(email);
	if (!user) { console.error(`Аккаунт не найден: ${email}`); process.exit(1); }
	if (flag('--revoke-admin')) {
		if (!revokeAdmin(user.id)) { console.error('Последнего администратора снять нельзя.'); process.exit(1); }
		console.log(`Админка снята: ${email}`);
	} else {
		grantAdmin(user.id, 'granted from CLI');
		console.log(`Админка выдана: ${email} (${user.display_name})`);
	}
	console.log('Администраторы: ' + (admins().map(row => row.email).join(', ') || '—'));
	process.exit(0);
}

const feature = String(value('--feature') ?? '').trim();
if (!KNOWN_FEATURES[feature]) {
	console.error(`Неизвестная возможность: ${feature || '(пусто)'}. Известные: ${Object.keys(KNOWN_FEATURES).join(', ')}`);
	process.exit(1);
}

// Команда: право наследуют участники не ниже указанной роли (по умолчанию dev).
if (value('--team')) {
	const wanted = String(value('--team')).trim();
	const team = database.prepare('SELECT id, name FROM teams WHERE id=? OR lower(name)=lower(?)').get(wanted, wanted);
	if (!team) { console.error(`Команда не найдена: ${wanted}`); process.exit(1); }
	const minRole = String(value('--min-role') ?? 'dev').trim();
	if (!ROLES.includes(minRole)) { console.error(`--min-role должен быть одним из: ${ROLES.join(', ')}`); process.exit(1); }
	setTeamEntitlement(team.id, feature, minRole, !revoke, KNOWN_FEATURES[feature]);
	console.log(`${revoke ? 'Отозвано' : 'Выдано'}: ${feature} → команда «${team.name}» (роль ${minRole} и выше)`);
	process.exit(0);
}

const user = database.prepare('SELECT id, display_name FROM users WHERE email=?').get(email);
if (!user) {
	console.error(`Аккаунт не найден: ${email}`);
	process.exit(1);
}

setEntitlement(user.id, feature, !revoke, KNOWN_FEATURES[feature]);
console.log(`${revoke ? 'Отозвано' : 'Выдано'}: ${feature} → ${email} (${user.display_name})`);
console.log('Сейчас у аккаунта: ' + (entitlementsOf(user.id).map(item => item.feature).join(', ') || '—'));
