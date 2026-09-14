/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BoardSnapshot, Session, TeamApiKey } from '../types';

export type TreeKind = 'members' | 'project' | 'tasks' | 'keys';

export class AuraTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changeEmitter.event;

	constructor(private readonly kind: TreeKind, private readonly getState: () => { session?: Session; board?: BoardSnapshot; keys?: TeamApiKey[] }) { }

	refresh(): void { this.changeEmitter.fire(); }
	getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

	getChildren(): vscode.TreeItem[] {
		const { session, board, keys } = this.getState();
		if (!session) {
			const item = new vscode.TreeItem(vscode.l10n.t('Sign in to Aura Team'));
			item.command = { command: 'auraTeam.signIn', title: vscode.l10n.t('Sign In') };
			return [item];
		}
		if (this.kind === 'members') {
			return board?.members.map(member => {
				const item = new vscode.TreeItem(member.displayName, vscode.TreeItemCollapsibleState.None);
				item.description = `${member.role}${member.online ? ' · online' : ''}`;
				item.iconPath = new vscode.ThemeIcon(member.online ? 'pass-filled' : 'circle-outline');
				return item;
			}) ?? [];
		}
		if (this.kind === 'project') {
			return board?.projects.map(project => {
				const item = new vscode.TreeItem(project.name);
				item.description = project.gitUrl ? project.defaultBranch : vscode.l10n.t('Archive');
				item.tooltip = project.gitUrl ?? vscode.l10n.t('Archive fallback');
				if (project.archiveId) {
					item.command = { command: 'auraTeam.downloadArchive', title: vscode.l10n.t('Download Archive'), arguments: [project] };
				} else if (project.gitUrl) {
					item.command = { command: 'auraTeam.getProject', title: vscode.l10n.t('Get Project'), arguments: [project] };
				}
				return item;
			}) ?? [];
		}
		if (this.kind === 'keys') {
			return keys?.map(key => {
				const item = new vscode.TreeItem(`${key.label} · ${key.keyHint}`);
				item.description = `${key.provider} · P${key.priority} · ${key.accessRole}+`;
				item.iconPath = new vscode.ThemeIcon(key.disabledAt ? 'circle-slash' : 'key');
				item.contextValue = key.disabledAt ? 'disabledTeamKey' : 'teamKey';
				item.command = key.disabledAt ? undefined : { command: 'auraTeam.disableApiKey', title: vscode.l10n.t('Disable Team API Key'), arguments: [key] };
				return item;
			}) ?? [];
		}
		return board?.tasks.map(task => {
			const item = new vscode.TreeItem(task.title);
			item.description = `${task.status}${task.assigneeName ? ` · ${task.assigneeName}` : ''}`;
			item.iconPath = new vscode.ThemeIcon(task.status === 'done' ? 'pass-filled' : 'issues');
			return item;
		}) ?? [];
	}
}
