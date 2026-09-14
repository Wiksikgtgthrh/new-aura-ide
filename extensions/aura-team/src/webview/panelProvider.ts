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
	constructor(readonly uri: vscode.Uri) {
		const query = new URLSearchParams(uri.query);
		this.view = query.get('view') ?? 'team';
	}
	dispose(): void { }
}

export class AuraTeamPanelProvider implements vscode.CustomReadonlyEditorProvider<AuraTeamDocument> {

	private readonly panels = new Set<vscode.WebviewPanel>();

	constructor(private readonly extensionUri: vscode.Uri) { }

	async openCustomDocument(uri: vscode.Uri): Promise<AuraTeamDocument> {
		return new AuraTeamDocument(uri);
	}

	async resolveCustomEditor(document: AuraTeamDocument, panel: vscode.WebviewPanel): Promise<void> {
		this.attach(panel, document.view);
	}

	/** Фолбэк для случаев, когда кастомный редактор недоступен. */
	attachFallback(panel: vscode.WebviewPanel, view: string): void {
		this.attach(panel, view);
	}

	private attach(panel: vscode.WebviewPanel, initialView: string): void {
		this.panels.add(panel);
		panel.onDidDispose(() => this.panels.delete(panel));

		panel.webview.options = { enableScripts: true };
		const nonce = String(Date.now()) + '-' + Math.floor(Math.random() * 1e9);
		let html = fs.readFileSync(path.join(this.extensionUri.fsPath, 'src', 'webview', 'template.html'), 'utf8');
		html = html.split('__NONCE__').join(nonce);
		html = html.split('__INITIAL_VIEW__').join(initialView);
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
				void vscode.commands.executeCommand('auraTeam.broadcast');
			}
		});
	}

	broadcast(state: AuraState): void {
		for (const panel of this.panels) {
			void panel.webview.postMessage({ type: 'state', state });
		}
	}
}
