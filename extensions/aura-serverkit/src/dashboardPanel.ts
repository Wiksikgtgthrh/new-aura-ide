/*---------------------------------------------------------------------------------------------
 *  Aura ServerKit — вкладка редактора с приложением ServerKit.
 *  Приложение (React-фронтенд ServerKit) крутится на сервере и показывается
 *  в полноценной вкладке редактора через iframe; связь — postMessage.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { isLoopback, probeServer, serverUrl } from './server';

const STATUS_INTERVAL_MS = 30_000;

export class DashboardPanel {
	private panel?: vscode.WebviewPanel;
	/** Адрес, для которого сейчас построен html вкладки. */
	private currentUrl?: string;
	private timer?: ReturnType<typeof setInterval>;

	constructor(private readonly extensionUri: vscode.Uri) { }

	/** Открыть вкладку (или переиспользовать уже открытую) с указанным адресом панели. */
	async show(url: string): Promise<void> {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
			if (this.currentUrl !== url) {
				this.mount(url);
			}
			return;
		}
		this.panel = vscode.window.createWebviewPanel('auraServerkit.dashboard', 'ServerKit', vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [this.extensionUri]
		});
		this.panel.onDidDispose(() => {
			this.panel = undefined;
			this.currentUrl = undefined;
			clearInterval(this.timer);
			this.timer = undefined;
		});

		// Мост IPC: вкладка → расширение (проверка статуса, перезагрузка).
		const activePanel = this.panel;
		activePanel.webview.onDidReceiveMessage(async message => {
			if (message?.type === 'checkStatus') {
				const url = typeof message.url === 'string' && message.url ? message.url : this.currentUrl ?? serverUrl();
				const status = await probeServer(url, 5000);
				void activePanel.webview.postMessage({ type: 'status', ...status });
			} else if (message?.type === 'reload' || message?.type === 'retry') {
				this.mount(this.currentUrl ?? serverUrl());
			}
		});

		this.mount(url);
		this.timer = setInterval(async () => {
			if (!activePanel.visible) {
				return;
			}
			const status = await probeServer(this.currentUrl ?? serverUrl(), 5000);
			void activePanel.webview.postMessage({ type: 'status', ...status });
		}, STATUS_INTERVAL_MS);
	}

	private mount(url: string): void {
		if (!this.panel) {
			return;
		}
		this.currentUrl = url;
		this.panel.webview.html = this.html(url);
	}

	private html(serverUrl: string): string {
		const nonce = String(Date.now()) + '-' + Math.floor(Math.random() * 1e9);
		const loopback = isLoopback(serverUrl);
		// Локальная панель по http — свой случай в CSP: при https-панели http вообще не нужен.
		const frameSources = loopback ? `${serverUrl} http: https:` : `${serverUrl} https:`;
		return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${frameSources}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;">
<style>
	html, body { height: 100%; margin: 0; overflow: hidden; }
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); display: flex; flex-direction: column; background: var(--vscode-editor-background); }
	.bar { display: flex; gap: 10px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); flex: none; }
	.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-descriptionForeground); opacity: .5; transition: background .3s ease, box-shadow .3s ease; }
	.dot.on { background: #3fb950; box-shadow: 0 0 6px #3fb95088; opacity: 1; }
	.dot.off { background: #f85149; box-shadow: 0 0 6px #f8514988; opacity: 1; }
	.status { font-size: 12px; opacity: .75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.spacer { flex: 1; }
	.bar a, .bar button { font-size: 12px; color: var(--vscode-foreground); background: transparent; border: none; cursor: pointer; padding: 3px 8px; border-radius: 5px; text-decoration: none; }
	.bar a:hover, .bar button:hover { background: var(--vscode-list-hoverBackground); }
	iframe { flex: 1; border: none; width: 100%; }
</style></head><body>
<div class="bar">
	<span class="dot" id="dot"></span>
	<span class="status" id="status">Проверка соединения…</span>
	<span class="spacer"></span>
	<button id="reload" title="Перезагрузить панель">⟳ Обновить</button>
	<a href="${serverUrl}" target="_blank" rel="noreferrer">Открыть в браузере</a>
</div>
<iframe id="frame" src="${serverUrl}" allow="clipboard-read; clipboard-write"></iframe>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const url = ${JSON.stringify(serverUrl)};
	const dot = document.getElementById('dot');
	const status = document.getElementById('status');
	const frame = document.getElementById('frame');
	function setState(cls, text) { dot.className = 'dot ' + cls; status.textContent = text; }
	function check() { setState('', 'Проверка соединения…'); vscode.postMessage({ type: 'checkStatus', url: url }); }
	document.getElementById('reload').addEventListener('click', () => {
		frame.src = 'about:blank';
		setTimeout(() => { frame.src = url; check(); }, 50);
	});
	vscode.postMessage({ type: 'checkStatus', url: url });
	window.addEventListener('message', event => {
		const m = event.data;
		if (m?.type === 'status') {
			if (m.ok) {
				setState('on', 'ServerKit онлайн — ' + url + (m.version ? ' · v' + m.version : ''));
			} else if (typeof m.code === 'number') {
				setState('off', 'ServerKit ответил HTTP ' + m.code + ' — ' + url);
			} else {
				setState('off', 'ServerKit недоступен (' + (m.error || 'нет ответа') + ') — ' + url);
			}
		}
	});
</script>
</body></html>`;
	}
}
