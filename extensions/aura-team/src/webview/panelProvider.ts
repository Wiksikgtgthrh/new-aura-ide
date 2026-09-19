/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AuraState } from '../types';

/**
 * Провайдер кастомного (readonly) редактора: открывает панель Aura Team
 * КАК ВКЛАДКУ редактора через виртуальный документ aura-team://panel/main.
 */
export class AuraTeamDocument implements vscode.CustomDocument {
	readonly view: string;
	readonly filter?: Record<string, string>;
	constructor(readonly uri: vscode.Uri) {
		const query = new URLSearchParams(uri.query);
		this.view = query.get('view') ?? 'team';
		let parsed: Record<string, string> | undefined;
		try { parsed = JSON.parse(query.get('filter') ?? '') as Record<string, string>; } catch { parsed = undefined; }
		this.filter = parsed;
	}
	dispose(): void { }
}

export class AuraTeamPanelProvider implements vscode.CustomReadonlyEditorProvider<AuraTeamDocument> {

	private readonly panels = new Set<vscode.WebviewPanel>();
	/** Навигация, пришедшая до того, как вкладка прислала ready (или пока webview ещё грузится). */
	private pendingNavigate: { view: string; filter?: Record<string, string> } | undefined;

	constructor(private readonly extensionUri: vscode.Uri) { }

	async openCustomDocument(uri: vscode.Uri): Promise<AuraTeamDocument> {
		return new AuraTeamDocument(uri);
	}

	async resolveCustomEditor(document: AuraTeamDocument, panel: vscode.WebviewPanel): Promise<void> {
		this.attach(panel, document.view, document.filter);
	}

	/** Фолбэк для случаев, когда кастомный редактор недоступен. */
	attachFallback(panel: vscode.WebviewPanel, view: string, filter?: Record<string, string>): void {
		this.attach(panel, view, filter);
	}

	private attach(panel: vscode.WebviewPanel, initialView: string, filter?: Record<string, string>): void {
		this.panels.add(panel);
		panel.onDidDispose(() => this.panels.delete(panel));

		panel.webview.options = { enableScripts: true };
		const nonce = String(Date.now()) + '-' + Math.floor(Math.random() * 1e9);
		let html = fs.readFileSync(path.join(this.extensionUri.fsPath, 'src', 'webview', 'template.html'), 'utf8');
		html = html.split('__NONCE__').join(nonce);
		html = html.split('__INITIAL_VIEW__').join(initialView);
		if (filter) { html = html.split('__INITIAL_FILTER__').join(JSON.stringify(filter).replace(/</g, '\\u003c')); } else { html = html.split('__INITIAL_FILTER__').join('null'); }
		panel.webview.html = html;

		panel.webview.onDidReceiveMessage(async message => {
			if (message?.type === 'invoke' && typeof message.command === 'string') {
				try {
					const result = await vscode.commands.executeCommand('auraTeam.invoke', message.command, Array.isArray(message.args) ? message.args : []);
					await panel.webview.postMessage({ type: 'response', id: message.id, ok: true, result });
				} catch (error) {
					await panel.webview.postMessage({ type: 'response', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
				}
			} else if (message?.type === 'ready') {
				// Если кнопку нажали, пока вкладка открывалась — применяем навигацию сразу после загрузки.
				if (this.pendingNavigate) {
					const nav = this.pendingNavigate;
					this.pendingNavigate = undefined;
					void panel.webview.postMessage({ type: 'navigate', view: nav.view, filter: nav.filter });
				}
				void vscode.commands.executeCommand('auraTeam.broadcast');
			}
		});
	}

	broadcast(state: AuraState): void {
		for (const panel of this.panels) {
			void panel.webview.postMessage({ type: 'state', state });
		}
	}

	/** Применить фильтр канбана в открытых вкладках (переход из сайдбара). */
	applyFilter(filter?: Record<string, string>): void {
		for (const panel of this.panels) {
			void panel.webview.postMessage({ type: 'board-filter', filter: filter ?? null });
		}
	}

	/** Открыта ли сейчас хотя бы одна вкладка Team. */
	panelsOpen(): boolean { return this.panels.size > 0; }

	/**
	 * Переиспользование уже открытой вкладки: вместо открытия нового URI (новой копии
	 * «Team») переключаем существующий webview на нужный раздел сообщением.
	 */
	navigate(view: string, filter?: Record<string, string>): boolean {
		if (this.panels.size === 0) { return false; }
		for (const panel of this.panels) {
			void panel.webview.postMessage({ type: 'navigate', view, filter });
		}
		return true;
	}

	/** Навигация для вкладки, которая ещё не прислала ready. */
	queueNavigate(view: string, filter?: Record<string, string>): void {
		this.pendingNavigate = { view, filter };
	}
}
