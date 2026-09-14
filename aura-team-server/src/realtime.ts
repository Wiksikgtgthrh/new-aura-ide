/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { WebSocket } from 'ws';

const clients = new Map<string, Set<WebSocket>>();
const users = new Map<WebSocket, string>();

export function addClient(teamId: string, userId: string, socket: WebSocket): void {
	const teamClients = clients.get(teamId) ?? new Set<WebSocket>();
	teamClients.add(socket);
	users.set(socket, userId);
	clients.set(teamId, teamClients);
	broadcast(teamId, 'presence.changed');
	socket.on('close', () => {
		teamClients.delete(socket);
		users.delete(socket);
		if (teamClients.size === 0) { clients.delete(teamId); }
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
