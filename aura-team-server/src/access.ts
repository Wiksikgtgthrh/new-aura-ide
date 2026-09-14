/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FastifyRequest } from 'fastify';
import { database } from './database.js';
import { verifyAccess } from './security.js';
import { digest } from './security.js';

export type Role = 'owner' | 'maintainer' | 'dev' | 'viewer';
const rank: Record<Role, number> = { viewer: 0, dev: 1, maintainer: 2, owner: 3 };

export async function userId(request: FastifyRequest): Promise<string> {
	const authorization = request.headers.authorization;
	if (!authorization?.startsWith('Bearer ')) { throw statusError(401, 'Authentication required'); }
	const credential = authorization.slice(7);
	try { return await verifyAccess(credential); } catch { throw statusError(401, 'Invalid or expired token'); }
}

export interface ProxyIdentity { userId: string; model?: string; tokenId?: string }

export async function proxyIdentity(request: FastifyRequest, teamId: string, provider: string): Promise<ProxyIdentity> {
	const authorization = request.headers.authorization;
	const apiKey = request.headers['x-api-key'];
	const credential = authorization?.startsWith('Bearer ') ? authorization.slice(7) : typeof apiKey === 'string' ? apiKey : '';
	if (!credential) { throw statusError(401, 'Authentication required'); }
	if (!credential.startsWith('aura_pt_')) { return { userId: await userId(request) }; }
	const row = database.prepare('SELECT id,user_id,model FROM proxy_tokens WHERE token_hash=? AND team_id=? AND provider=? AND revoked_at IS NULL').get(digest(credential), teamId, provider) as { id: string; user_id: string; model: string } | undefined;
	if (!row) { throw statusError(401, 'Invalid or revoked proxy token'); }
	return { userId: row.user_id, model: row.model, tokenId: row.id };
}

function statusError(statusCode: number, message: string): Error {
	return Object.assign(new Error(message), { statusCode });
}

export function requireRole(user: string, teamId: string, minimum: Role): Role {
	const row = database.prepare('SELECT role FROM memberships WHERE user_id=? AND team_id=?').get(user, teamId) as { role: Role } | undefined;
	if (!row || rank[row.role] < rank[minimum]) { throw new Error('FORBIDDEN'); }
	return row.role;
}

export function mapAccessError(error: unknown): never {
	if (error instanceof Error && error.message === 'FORBIDDEN') {
		const forbidden = new Error('You do not have permission for this action') as Error & { statusCode: number };
		forbidden.statusCode = 403;
		throw forbidden;
	}
	throw error;
}
