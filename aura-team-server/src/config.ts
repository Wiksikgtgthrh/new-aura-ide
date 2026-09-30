/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { resolve } from 'node:path';

function integer(name: string, fallback: number): number {
	const value = Number(process.env[name] ?? fallback);
	if (!Number.isSafeInteger(value) || value <= 0) { throw new Error(`${name} must be a positive integer`); }
	return value;
}

const jwtSecret = process.env.AURA_JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) { throw new Error('AURA_JWT_SECRET is required and must contain at least 32 characters'); }
if (process.env.NODE_ENV === 'production') {
	const decoded = Buffer.from(jwtSecret, 'base64');
	if (decoded.length < 32 || jwtSecret.startsWith('REPLACE_') || jwtSecret.includes('development')) { throw new Error('AURA_JWT_SECRET must be a random base64 value of at least 32 bytes'); }
}

export const config = {
	host: process.env.AURA_HOST ?? '127.0.0.1',
	port: integer('AURA_PORT', 3210),
	publicUrl: process.env.AURA_PUBLIC_URL ?? 'http://localhost:3210',
	dataDir: resolve(process.env.AURA_DATA_DIR ?? './data'),
	jwtSecret,
	masterKey: process.env.AURA_MASTER_KEY,
	// Архивы проектов: до 1 ГиБ на файл (раньше 50 МиБ — большие сборки не проходили).
	archiveMaxBytes: integer('AURA_ARCHIVE_MAX_BYTES', 1024 * 1024 * 1024),
	archiveTtlDays: integer('AURA_ARCHIVE_TTL_DAYS', 7),
	/** Задачи в корзине (мягко удалённые) старше этого срока удаляются физически. */
	trashTtlDays: integer('AURA_TRASH_TTL_DAYS', 30),
	proxyRequestsPerDay: integer('AURA_PROXY_REQUESTS_PER_DAY', 500),
	// Код администратора: при старте сервер сеет его хэш (код сгорает после
	// первого погашения). В продакшене дефолт не работает специально: литерал из
	// репозитория — не секрет, любой читатель репозитория мог бы погасить его первым.
	// На живом сервере задайте AURA_ADMIN_CODE в окружении и погасьте код сразу
	// либо выдайте админку из CLI: npm run grant -- --email <почта> --admin.
	adminCode: process.env.AURA_ADMIN_CODE ?? (process.env.NODE_ENV === 'production' ? '' : 'AUR-L2SY6CAL'),
	// Каталог внешнего ядра AGGG 5.2 на сервере: файл отдаётся только по праву,
	// поэтому лицензия проверяется на сервере, а не патчем клиента.
	agggCorePath: process.env.AURA_AGGG_CORE_PATH,
	smtp: process.env.AURA_SMTP_HOST ? {
		host: process.env.AURA_SMTP_HOST,
		port: integer('AURA_SMTP_PORT', 587),
		secure: process.env.AURA_SMTP_SECURE === 'true',
		user: process.env.AURA_SMTP_USER,
		password: process.env.AURA_SMTP_PASSWORD,
		from: process.env.AURA_SMTP_FROM ?? 'Aura Team <noreply@localhost>'
	} : undefined
};
