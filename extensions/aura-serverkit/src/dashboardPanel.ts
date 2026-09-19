/*---------------------------------------------------------------------------------------------
 *  Aura ServerKit — вкладка редактора с приложением ServerKit.
 *  Приложение (React-фронтенд ServerKit) крутится на сервере и показывается
 *  в полноценной вкладке редактора через iframe; связь — postMessage.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export class DashboardPanel {
	private panel?: vscode.WebviewPanel;

	constructor(private readonly extensionUri: vscode.Uri) { }

	/** Открыть вкладку (или переиспользовать уже открытую). */
	async show(): Promise<void> {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
			return;
		}
		this.panel = vscode.window.createWebviewPanel('auraServerkit.dashboard', 'ServerKit', vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [this.extensionUri]
		});
		this.panel.onDidDispose(() => { this.panel = undefined; });
		this.panel.webview.html = this.html();

		// Мост IPC: вкладка → расширение (проверка статуса, перезагрузка).
		const activePanel = this.panel;
		activePanel.webview.onDidReceiveMessage(async message => {
			if (message?.type === 'checkStatus') {
				const status = await probeServer();
				void activePanel.webview.postMessage({ type: 'status', ...status });
			} else if (message?.type === 'reload') {
				activePanel.webview.html = this.html();
			}
		});
	}

	private html(): string {
		const serverUrl = vscode.workspace.getConfiguration('auraServerkit').get<string>('serverUrl', 'https://serverkit.auraide.xyz').replace(/\/$/, '');
		const nonce = String(Date.now()) + '-' + Math.floor(Math.random() * 1e9);
		return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${serverUrl} http: https:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;">
<style>
	html, body { height: 100%; margin: 0; overflow: hidden; }
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); display: flex; flex-direction: column; }
	.bar { display: flex; gap: 10px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); flex: none; }
	.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-descriptionForeground); opacity: .5; transition: background .3s ease, box-shadow .3s ease; }
	.dot.on { background: #3fb950; box-shadow: 0 0 6px #3fb95088; }
	.dot.off { background: #f85149; box-shadow: 0 0 6px #f8514988; }
	.status { font-size: 12px; opacity: .75; }
	.spacer { flex: 1; }
	.bar a, .bar button { font-size: 12px; color: var(--vscode-foreground); background: transparent; border: none; cursor: pointer; padding: 3px 8px; border-radius: 5px; text-decoration: none; }
	.bar a:hover, .bar button:hover { background: var(--vscode-list-hoverBackground); }
	iframe { flex: 1; border: none; width: 100%; }
	.fallback { padding: 40px; text-align: center; }
</style></head><body>
<div class="bar">
	<span class="dot" id="dot"></span>
	<span class="status" id="status">Проверка соединения…</span>
	<span class="spacer"></span>
	<button id="reload" title="Перезагрузить">⟳ Обновить</button>
	<a href="${serverUrl}" target="_blank">Открыть в браузере</a>
</div>
<iframe id="frame" src="${serverUrl}" allow="clipboard-read; clipboard-write"></iframe>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const dot = document.getElementById('dot');
	const status = document.getElementById('status');
	function setState(cls, text) { dot.className = 'dot ' + cls; status.textContent = text; }
	function check() { setState('', 'Проверка соединения…'); vscode.postMessage({ type: 'checkStatus' }); }
	document.getElementById('reload').addEventListener('click', () => { document.getElementById('frame').src = document.getElementById('frame').src; check(); });
	vscode.postMessage({ type: 'checkStatus' });
	setInterval(check, 30000);
	window.addEventListener('message', event => {
		const m = event.data;
		if (m?.type === 'status') { setState(m.ok ? 'on' : 'off', m.text); }
	});
</script>
</body></html>`;
	}
}

/** Проверка доступности ServerKit: GET /api/v1/system/health. */
async function probeServer(): Promise<{ ok: boolean; text: string }> {
	const url = vscode.workspace.getConfiguration('auraServerkit').get<string>('serverUrl', 'https://serverkit.auraide.xyz').replace(/\/$/, '');
	try {
		const response = await fetch(`${url}/api/v1/system/health`, { signal: AbortSignal.timeout(5000) });
		if (response.ok) {
			return { ok: true, text: `ServerKit онлайн — ${url}` };
		}
		return { ok: false, text: `ServerKit ответил HTTP ${response.status} — ${url}` };
	} catch (error) {
		return { ok: false, text: `ServerKit недоступен (${error instanceof Error ? error.message : String(error)}) — ${url}` };
	}
}
