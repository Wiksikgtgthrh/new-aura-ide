import * as vscode from 'vscode';
import * as fs from 'fs';
import type { OrchestratorHost } from '../host';
import { logError } from '../util/log';

export const ORCHESTRATOR_SCHEME = 'aura-orchestrator';
export const ORCHESTRATOR_VIEW_TYPE = 'auraOrchestrator.panel';

class OrchestratorDocument implements vscode.CustomDocument {
	constructor(readonly uri: vscode.Uri) {}
	dispose(): void {
		// состояние не привязано к документу
	}
}

/**
 * Вкладка оркестратора по паттерну aura-team: CustomReadonlyEditorProvider
 * поверх виртуального документа, HTML из template.html с CSP nonce,
 * invoke/response с корреляцией id, пуши {type:'state'}.
 */
export class OrchestratorPanelProvider implements vscode.CustomReadonlyEditorProvider {
	private panel?: vscode.WebviewPanel;
	/** Webview загрузил скрипт и прислал `ready`: можно слать просьбы о вкладке. */
	private ready = false;
	/** Вкладка, запрошенная до готовности webview — доставляется на `ready`. */
	private pendingTab?: string;

	constructor(
		private context: vscode.ExtensionContext,
		private host: OrchestratorHost,
	) {}

	static register(context: vscode.ExtensionContext, host: OrchestratorHost): vscode.Disposable[] {
		const provider = new OrchestratorPanelProvider(context, host);
		const disposables: vscode.Disposable[] = [];
		disposables.push(vscode.window.registerCustomEditorProvider(ORCHESTRATOR_VIEW_TYPE, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}));
		// Виртуальные документы: содержимое файлов на git-ссылке для multi-diff
		// финального патча и запасного единого диффа. Данные берёт хост (git show).
		disposables.push(vscode.workspace.registerTextDocumentContentProvider(ORCHESTRATOR_SCHEME, new (class implements vscode.TextDocumentContentProvider {
			provideTextDocumentContent(uri: vscode.Uri): Thenable<string> {
				return host.provideVirtualContent(uri);
			}
		})()));
		return disposables;
	}

	static panelUri(): vscode.Uri {
		// Имя виртуального документа = подпись вкладки редактора, поэтому оно русское.
		return vscode.Uri.from({ scheme: ORCHESTRATOR_SCHEME, authority: 'panel', path: '/Оркестратор' });
	}

	async openCustomDocument(uri: vscode.Uri): Promise<OrchestratorDocument> {
		return new OrchestratorDocument(uri);
	}

	async resolveCustomEditor(_document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
		this.panel = webviewPanel;
		this.ready = false;
		webviewPanel.webview.options = { enableScripts: true };
		webviewPanel.webview.html = this.renderHtml(webviewPanel.webview);

		// Сайдкар прогревается при открытии панели: если прогрев при активации не удался
		// (например, сайдкар только что собран), панель — очевидное место для повтора.
		if (this.host.panelState().sidecar.state !== 'ready') {
			void this.host.startSidecar();
		}

		webviewPanel.webview.onDidReceiveMessage(async message => {
			if (message?.type === 'ready') {
				this.ready = true;
				this.pushState(webviewPanel.webview);
				this.flushTab(webviewPanel.webview);
				return;
			}
			if (message?.type === 'invoke') {
				// Типизированный протокол: полезная нагрузка всегда в payload.
				const payload = (message.payload ?? {}) as { command?: string; args?: Record<string, unknown>; id?: number };
				try {
					const result = await this.host.invoke(String(payload.command), payload.args ?? {});
					await webviewPanel.webview.postMessage({ type: 'response', payload: { id: payload.id, ok: true, result } });
				} catch (err) {
					logError(`invoke ${payload.command} failed`, err);
					await webviewPanel.webview.postMessage({
						type: 'response',
						payload: { id: payload.id, ok: false, error: err instanceof Error ? err.message : String(err) },
					});
				}
			}
		}, undefined, this.context.subscriptions);

		const stateSub = this.host.onDidChangeState(() => {
			if (this.panel === webviewPanel) {
				this.pushState(webviewPanel.webview);
			}
		});
		// Команды палитры/клавиш просят переключить вкладку — сообщаем webview.
		const tabSub = this.host.onDidRequestTab(tab => {
			this.pendingTab = String(tab || 'run');
			if (this.panel === webviewPanel) {
				this.flushTab(webviewPanel.webview);
			}
		});
		webviewPanel.onDidDispose(() => {
			stateSub.dispose();
			tabSub.dispose();
			if (this.panel === webviewPanel) {
				this.panel = undefined;
				this.ready = false;
			}
		});
	}

	/** Доставить отложенную просьбу о вкладке, когда webview уже готов. */
	private flushTab(webview: vscode.Webview): void {
		if (!this.ready || !this.pendingTab) {
			return;
		}
		void webview.postMessage({ type: 'tab', payload: this.pendingTab });
		this.pendingTab = undefined;
	}

	private pushState(webview: vscode.Webview): void {
		void webview.postMessage({ type: 'state', payload: this.host.panelState() });
	}

	private renderHtml(webview: vscode.Webview): string {
		const templatePath = vscode.Uri.joinPath(this.context.extensionUri, 'src', 'panel', 'template.html');
		let html: string;
		try {
			html = fs.readFileSync(templatePath.fsPath, 'utf8');
		} catch (err) {
			logError('template.html read failed', err);
			return `<html><body>template missing: ${String(err)}</body></html>`;
		}
		const nonce = String(Date.now()) + String(Math.random()).slice(2);
		return html
			.replace(/__NONCE__/g, nonce)
			.replace(/__CSP_SOURCE__/g, webview.cspSource);
	}
}
