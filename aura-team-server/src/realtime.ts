/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { WebSocket } from 'ws';

const clients = new Map<string, Set<WebSocket>>();
const users = new Map<WebSocket, string>();
const alive = new Set<WebSocket>();

const PING_INTERVAL_MS = 30_000;

// Отмечаем last_seen_at участника при отключении сокета (для «был в сети …»).
function touchLastSeen(userId: string, teamId: string): void {
	try {
		// Ленивый импорт, чтобы избежать цикла realtime ↔ database.
		import('./database.js').then(({ database }) => {
			database.prepare('UPDATE memberships SET last_seen_at=? WHERE user_id=? AND team_id=?')
				.run(new Date().toISOString(), userId, teamId);
		}).catch(() => undefined);
	} catch { /* база недоступна — presence просто без lastSeen */ }
}

export function addClient(teamId: string, userId: string, socket: WebSocket): void {
	const teamClients = clients.get(teamId) ?? new Set<WebSocket>();
	teamClients.add(socket);
	users.set(socket, userId);
	clients.set(teamId, teamClients);
	broadcast(teamId, 'presence.changed');
	socket.on('close', () => {
		teamClients.delete(socket);
		users.delete(socket);
		alive.delete(socket);
		if (teamClients.size === 0) { clients.delete(teamId); }
		touchLastSeen(userId, teamId);
		broadcast(teamId, 'presence.changed');
	});
}

export function onlineUserIds(teamId: string): Set<string> {
	return new Set([...clients.get(teamId) ?? []].map(socket => users.get(socket)).filter((userId): userId is string => Boolean(userId)));
}

export function broadcast(teamId: string, type: string): void {
	const payload = JSON.stringify({ type, at: new Date().toISOString() });
	for (const socket of clients.get(teamId) ?? []) {
		if (socket.readyState === socket.OPEN) { socket.send(payload); }
	}
}

// Ping/pong: мёртвые соединения (обрыв сети без close) убираем по отсутствию pong,
// иначе человек будет «в сети» до TCP-таймаута (часы).
let pingTimer: NodeJS.Timeout | undefined;
export function startHeartbeat(): void {
	if (pingTimer) { return; }
	pingTimer = setInterval(() => {
		for (const teamClients of clients.values()) {
			for (const socket of teamClients) {
				if (socket.readyState !== socket.OPEN) { continue; }
				if (!alive.has(socket)) {
					socket.terminate();
					continue;
				}
				alive.add(socket);
				socket.ping();
			}
		}
	}, PING_INTERVAL_MS);
	pingTimer.unref?.();
}
