/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AuraApiClient } from '../api/client';
import { BoardSnapshot, TaskStatus } from '../types';

const statuses: TaskStatus[] = ['backlog', 'todo', 'doing', 'review', 'done'];

export class BoardPanel {
	private panel: vscode.WebviewPanel | undefined;

	constructor(private readonly api: AuraApiClient, private readonly getTeamId: () => string | undefined, private readonly refresh: () => Promise<void>) { }

	async show(board: BoardSnapshot): Promise<void> {
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel('auraTeam.board', vscode.l10n.t('Aura Team Board'), vscode.ViewColumn.One, { enableScripts: true });
			this.panel.onDidDispose(() => this.panel = undefined);
			this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message));
		}
		this.panel.webview.html = this.render(board);
		this.panel.reveal();
	}

	update(board: BoardSnapshot): void {
		if (this.panel) { this.panel.webview.html = this.render(board); }
	}

	private async handleMessage(message: { type?: string; taskId?: string; status?: TaskStatus; assigneeId?: string; title?: string }): Promise<void> {
		const teamId = this.getTeamId();
		if (!teamId) { return; }
		try {
			if (message.taskId && message.type === 'move' && message.status && statuses.includes(message.status)) {
				await this.api.updateTask(teamId, message.taskId, { status: message.status });
			} else if (message.taskId && message.type === 'assign') {
				await this.api.updateTask(teamId, message.taskId, { assigneeId: message.assigneeId || null });
			} else if (message.type === 'create' && message.status && statuses.includes(message.status) && message.title?.trim()) {
				await this.api.createTask(teamId, message.title.trim(), message.status);
			}
			await this.refresh();
			await this.panel?.webview.postMessage({ type: 'result', ok: true, text: vscode.l10n.t('Board updated.') });
		} catch (error) {
			await this.panel?.webview.postMessage({ type: 'result', ok: false, text: error instanceof Error ? error.message : String(error) });
		}
	}

	private render(board: BoardSnapshot): string {
		const nonce = String(Date.now());
		const labels: Record<TaskStatus, string> = { backlog: 'Backlog', todo: 'To Do', doing: 'In Progress', review: 'Review', done: 'Done' };
		const statusOptions = (current: TaskStatus) => statuses.map(status => `<option value="${status}"${status === current ? ' selected' : ''}>${labels[status]}</option>`).join('');
		const memberOptions = (current?: string) => `<option value="">Unassigned</option>${board.members.map(member => `<option value="${escapeHtml(member.id)}"${member.id === current ? ' selected' : ''}>${escapeHtml(member.displayName)}</option>`).join('')}`;
		const columns = statuses.map(status => `<section data-status="${status}"><header><h2>${labels[status]}</h2><span>${board.tasks.filter(task => task.status === status).length}</span></header><form class="new-task"><input aria-label="New task" placeholder="Add a task…"><button title="Add task">+</button></form>${board.tasks.filter(task => task.status === status).map(task => `<article class="card" data-id="${escapeHtml(task.id)}"><strong>${escapeHtml(task.title)}</strong>${task.description ? `<p>${escapeHtml(task.description)}</p>` : ''}<select class="status" aria-label="Status">${statusOptions(task.status)}</select><select class="assignee" aria-label="Assignee">${memberOptions(task.assigneeId)}</select></article>`).join('')}</section>`).join('');
		return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px}h1{font-size:20px}.notice{min-height:20px;color:var(--vscode-descriptionForeground)}.notice.error{color:var(--vscode-errorForeground)}.board{display:grid;grid-template-columns:repeat(5,minmax(210px,1fr));gap:12px;overflow:auto}section{background:var(--vscode-sideBar-background);padding:10px;border-radius:8px;min-height:60vh}section>header{display:flex;align-items:center;justify-content:space-between}h2{font-size:13px}.new-task{display:flex;margin:8px 0}.new-task input,.new-task button,.card select{box-sizing:border-box;color:inherit;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-widget-border));padding:6px}.new-task input{min-width:0;flex:1}.card{display:block;padding:10px;margin:8px 0;background:var(--vscode-list-hoverBackground);border:1px solid var(--vscode-widget-border);border-radius:6px}.card p{color:var(--vscode-descriptionForeground);font-size:12px}.card select{display:block;width:100%;margin-top:7px}</style></head><body><h1>Aura Team</h1><div class="notice" role="status"></div><div class="board">${columns}</div><script nonce="${nonce}">const vscode=acquireVsCodeApi();const notice=document.querySelector('.notice');document.querySelectorAll('.card').forEach(card=>{card.querySelector('.status').onchange=event=>vscode.postMessage({type:'move',taskId:card.dataset.id,status:event.target.value});card.querySelector('.assignee').onchange=event=>vscode.postMessage({type:'assign',taskId:card.dataset.id,assigneeId:event.target.value})});document.querySelectorAll('.new-task').forEach(form=>form.onsubmit=event=>{event.preventDefault();const input=form.querySelector('input');if(input.value.trim()){vscode.postMessage({type:'create',status:form.closest('section').dataset.status,title:input.value.trim()});input.value=''}});window.addEventListener('message',event=>{if(event.data.type==='result'){notice.textContent=event.data.text;notice.className='notice'+(event.data.ok?'':' error')}});</script></body></html>`;
	}
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
}
