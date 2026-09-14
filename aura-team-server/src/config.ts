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
	archiveMaxBytes: integer('AURA_ARCHIVE_MAX_BYTES', 50 * 1024 * 1024),
	archiveTtlDays: integer('AURA_ARCHIVE_TTL_DAYS', 7),
	proxyRequestsPerDay: integer('AURA_PROXY_REQUESTS_PER_DAY', 500),
	smtp: process.env.AURA_SMTP_HOST ? {
		host: process.env.AURA_SMTP_HOST,
		port: integer('AURA_SMTP_PORT', 587),
		secure: process.env.AURA_SMTP_SECURE === 'true',
		user: process.env.AURA_SMTP_USER,
		password: process.env.AURA_SMTP_PASSWORD,
		from: process.env.AURA_SMTP_FROM ?? 'Aura Team <noreply@localhost>'
	} : undefined
};
