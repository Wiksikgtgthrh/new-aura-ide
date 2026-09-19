/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Profile } from './types';

const STORAGE_KEY = 'auraTeam.profile';

const AVATAR_COLORS = [
	'#6366f1', '#8b5cf6', '#d946ef', '#ec4899', '#f43f5e',
	'#f97316', '#f59e0b', '#10b981', '#14b8a6', '#0ea5e9', '#3b82f6'
];

function generateId(): string {
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let value = '';
	for (let i = 0; i < 10; i++) {
		value += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return value;
}

function colorForId(id: string): string {
	let hash = 0;
	for (const character of id) { hash = (hash * 31 + character.charCodeAt(0)) >>> 0; }
	return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export class ProfileManager {
	private profile: Profile;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.profile = context.globalState.get<Profile>(STORAGE_KEY) ?? {
			id: generateId(),
			nickname: '',
			email: '',
			description: '',
			avatarColor: colorForId('00000000'),
			createdAt: Date.now()
		};
		this.profile.avatarColor = this.profile.avatarColor || colorForId(this.profile.id);
	}

	get(): Profile { return this.profile; }

	async save(patch: Partial<Pick<Profile, 'nickname' | 'email' | 'description' | 'avatar'>>): Promise<Profile> {
		if (patch.nickname) { this.profile.nickname = patch.nickname.trim().slice(0, 40); }
		if (patch.email !== undefined) { this.profile.email = patch.email.trim().slice(0, 120); }
		if (patch.description !== undefined) { this.profile.description = patch.description.trim().slice(0, 240); }
		if (patch.avatar !== undefined) { this.profile.avatar = patch.avatar || undefined; }
		if (!this.profile.avatarColor) { this.profile.avatarColor = colorForId(this.profile.id); }
		await this.context.globalState.update(STORAGE_KEY, this.profile);
		return this.profile;
	}

	initials(): string {
		const parts = (this.profile.nickname || 'Aura').trim().split(/\s+/);
		const first = parts[0]?.[0] ?? 'A';
		const second = parts.length > 1 ? parts[1][0] : (parts[0]?.[1] ?? '');
		return (first + second).toUpperCase();
	}
}
