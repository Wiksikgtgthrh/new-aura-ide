import * as vscode from 'vscode';
import { OrchestratorHost } from '../host';

export const ORCHESTRATOR_VIEW_ID = 'auraOrchestrator.home';

/**
 * Сайдбар-лаунчер оркестратора.
 *
 * Иконка в activity bar живёт по флагу `auraPlugin.langgraph-orchestrator.enabled`
 * (when-клауза во вкладке views) — значит, плагином можно управлять из Aura Market
 * без перезагрузки окна. Сама панель оркестратора остаётся центральной вкладкой
 * (CustomReadonlyEditorProvider), а вью лишь открывает её и показывает состояние.
 */
export class OrchestratorLauncherProvider implements vscode.WebviewViewProvider {

	constructor(private readonly host: OrchestratorHost) {}

	static register(host: OrchestratorHost): vscode.Disposable {
		return vscode.window.registerWebviewViewProvider(ORCHESTRATOR_VIEW_ID, new OrchestratorLauncherProvider(host), {
			webviewOptions: { retainContextWhenHidden: true },
		});
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		view.webview.options = { enableScripts: true };
		view.webview.html = this.renderHtml(view.webview);

		view.webview.onDidReceiveMessage(message => {
			if (message?.type === 'open') {
				void vscode.commands.executeCommand('auraOrchestrator.open');
			}
		});

		const sub = this.host.onDidChangeState(() => this.pushState(view));
		view.onDidDispose(() => sub.dispose());
		view.onDidChangeVisibility(() => {
			if (view.visible) { this.pushState(view); }
		});
		this.pushState(view);
	}

	private pushState(view: vscode.WebviewView): void {
		const state = this.host.panelState();
		void view.webview.postMessage({ type: 'state', running: state.running, paused: state.paused });
	}

	private renderHtml(webview: vscode.Webview): string {
		const nonce = String(Date.now()) + String(Math.random()).slice(2);
		return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
	body {
		margin: 0;
		padding: 12px;
		font-family: var(--vscode-font-family);
		font-size: 13px;
		color: var(--vscode-foreground);
	}
	.title { font-weight: 600; margin-bottom: 4px; }
	.sub { color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.5; }
	.state { margin-top: 12px; font-size: 11px; color: var(--vscode-descriptionForeground); }
	.state.running { color: var(--vscode-charts-blue); }
	button {
		margin-top: 12px;
		width: 100%;
		padding: 6px 10px;
		border: none;
		border-radius: 6px;
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		font-size: 12px;
		cursor: pointer;
	}
	button:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
	<div class="title">Оркестратор</div>
	<div class="sub">Мультиагентная команда работает на API-ключах Team с тир-маршрутизацией.</div>
	<div id="state" class="state">Ожидание</div>
	<button id="open">Открыть оркестратор</button>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		document.getElementById('open').addEventListener('click', () => vscode.postMessage({ type: 'open' }));
		window.addEventListener('message', (event) => {
			const message = event.data;
			if (message?.type !== 'state') { return; }
			const el = document.getElementById('state');
			el.classList.toggle('running', message.running === true);
			el.textContent = message.running ? (message.paused ? 'Пауза' : 'Работает') : 'Ожидание';
		});
	</script>
</body>
</html>`;
	}
}
