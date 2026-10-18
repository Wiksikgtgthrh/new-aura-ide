const vscode = require('vscode');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

/** Таймаут ожидания загрузки iframe во вкладке (AURA-005: было 20с без прогресса). */
const LOAD_TIMEOUT_MS = 10000;
/** Таймаут проверки доступности сервера из extension-хоста. */
const STATUS_TIMEOUT_MS = 6000;

/**
 * Единственная вкладка n8n: повторный вызов openTab reveal'ит её, а не плодит
 * webview с retainContextWhenHidden — это и была утечка из AURA-006.
 */
let currentPanel;

/** Зан-ревью §5 п.2: голый хост/IP без схемы → автодополняем https://, иначе http.get бросает Invalid URL. */
function getUrl() {
	const configured = (vscode.workspace.getConfiguration('n8nPanel').get('url') || '').trim().replace(/\/+$/, '');
	if (configured && !/^https?:\/\//i.test(configured)) {
		return `https://${configured}`;
	}
	// ZAN-zan-a2 §4.1: нормализуем регистр схемы — checkStatus различает её чувствительным startsWith,
	// «HTTPS://host» уходил в http-клиент, Node синхронно кидал Protocol-not-supported → offline при живом сервере.
	return configured.replace(/^(https?):/i, (match, scheme) => `${scheme.toLowerCase()}:`);
}

/** AURA-004: самоподписанные — только по явной n8nPanel.allowSelfSigned.
 * ZAN-zan-a2 §6.1: софт-миграция через get()-фолбэк была мертва в реальном VS Code — незаданный ключ даёт
 * не undefined, а манифест-дефолт false (extHostConfiguration.ts: lookUp, undefined → только тогда defaultValue),
 * поэтому `typeof val === 'boolean'` всегда true и старый ключ не читался. Теперь смотрим ТОЛЬКО юзеровские
 * значения по scope через inspect(): не задан ни в одном scope → читаем старый n8n.allowSelfSigned. */
function isSelfSignedAllowed() {
	const insp = vscode.workspace.getConfiguration('n8nPanel').inspect('allowSelfSigned');
	// приоритет совпадает с эффективным значением VS Code: workspaceFolder > workspace > global
	const userVal = insp && (insp.workspaceFolderValue ?? insp.workspaceValue ?? insp.globalValue);
	if (typeof userVal === 'boolean') {
		return userVal;
	}
	return vscode.workspace.getConfiguration('n8n').get('allowSelfSigned', false);
}

/** Проверка доступности из extension-хоста (Node): без CORS и ограничений webview. */
function checkStatus(url) {
	return new Promise((resolve) => {
		try {
			const client = url.startsWith('https') ? https : http;
			const options = { timeout: STATUS_TIMEOUT_MS };
			if (url.startsWith('https')) {
				options.rejectUnauthorized = !isSelfSignedAllowed();
			}
			const req = client.get(url, options, (res) => {
				res.resume();
				resolve(res.statusCode >= 200 && res.statusCode < 500);
			});
			req.on('timeout', () => { req.destroy(); resolve(false); });
			req.on('error', () => resolve(false));
		} catch {
			// синхронный throw (например невалидный URL) = сервер недоступен, не unhandled rejection
			resolve(false);
		}
	});
}

/** AURA-003: nonce на каждый рендер — 'unsafe-inline' из script-src убран. */
function cspNonce() {
	return crypto.randomBytes(16).toString('base64');
}

function escapeHtml(s) {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Зан-ревью §5 п.3: `</script>` в строке перевода иначе выводит из скрипт-контекста в обход nonce-CSP. */
function jsonForScript(value) {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** Полная вкладка: iframe + спиннер с прогрессом + фолбэк с кнопкой переподключения. */
function tabHtml(url, renderToken) {
	const nonce = cspNonce();
	const strings = {
		loading: vscode.l10n.t('Loading n8n… {0}s'),
		failed: vscode.l10n.t('Could not load n8n at'),
		reconnect: vscode.l10n.t('Reconnect'),
	};
	const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-src https: http:;`;
	return `<!DOCTYPE html>
<html lang="${escapeHtml(vscode.env.language)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
	html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: #1e1e1e; }
	iframe { border: 0; width: 100%; height: 100%; display: block; }
	#loader { position: fixed; inset: 0; z-index: 10; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; color: #999; font-family: sans-serif; font-size: 13px; background: #1e1e1e; }
	#loader.hidden { display: none; }
	.spin { width: 26px; height: 26px; border: 3px solid #3c3c3c; border-top-color: #ff6d5a; border-radius: 50%; animation: r .8s linear infinite; }
	@keyframes r { to { transform: rotate(360deg); } }
	#track { width: 180px; height: 3px; border-radius: 2px; background: #3c3c3c; overflow: hidden; }
	#bar { height: 100%; width: 0%; background: #ff6d5a; transition: width .2s linear; }
	#error { display: none; position: fixed; inset: 0; z-index: 11; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: #ccc; font-family: sans-serif; background: #1e1e1e; text-align: center; padding: 20px; }
	#error button { padding: 7px 16px; border: 0; border-radius: 5px; cursor: pointer; background: #ff6d5a; color: #1e1e1e; font-weight: 600; }
</style>
</head>
<body>
<div id="loader"><div class="spin"></div><div id="status"></div><div id="track"><div id="bar"></div></div></div>
<div id="error">
	<div><span id="failed"></span><br><b id="errurl">${escapeHtml(url)}</b></div>
	<button id="reconnect" type="button"></button>
</div>
<iframe id="f" src="${escapeHtml(url)}"></iframe>
<script nonce="${nonce}">
	const vscodeApi = acquireVsCodeApi();
	const STR = ${jsonForScript(strings)};
	const RENDER_TOKEN = ${jsonForScript(renderToken)}; // Зан-ревью §5 п.1: per-render токен, сообщения без него — мусор из чужих источников
	const TIMEOUT = ${LOAD_TIMEOUT_MS};
	const frame = document.getElementById('f');
	const loader = document.getElementById('loader');
	const status = document.getElementById('status');
	const bar = document.getElementById('bar');
	const error = document.getElementById('error');
	const errurl = document.getElementById('errurl');
	document.getElementById('failed').textContent = STR.failed;
	const reconnectBtn = document.getElementById('reconnect');
	reconnectBtn.textContent = STR.reconnect;

	let done = false;
	let timer = 0;
	let ticker = 0;
	let startedAt = 0;

	function startLoading() {
		done = false;
		startedAt = Date.now();
		clearTimeout(timer);
		clearInterval(ticker);
		error.style.display = 'none';
		loader.classList.remove('hidden');
		bar.style.width = '0%';
		ticker = setInterval(updateProgress, 200);
		updateProgress();
		timer = setTimeout(() => { if (!done) { showError(); } }, TIMEOUT);
	}
	function updateProgress() {
		const left = Math.max(0, TIMEOUT - (Date.now() - startedAt));
		status.textContent = STR.loading.replace('{0}', String(Math.ceil(left / 1000)));
		bar.style.width = Math.min(100, (Date.now() - startedAt) / TIMEOUT * 100) + '%';
	}
	function showError() {
		clearTimeout(timer);
		clearInterval(ticker);
		loader.classList.add('hidden');
		error.style.display = 'flex';
	}
	frame.addEventListener('load', () => {
		done = true;
		clearTimeout(timer);
		clearInterval(ticker);
		loader.classList.add('hidden');
	});
	// AURA-005: переподключение — просим расширение перечитать URL из настроек и отдать свежий.
	reconnectBtn.addEventListener('click', () => {
		startLoading();
		vscodeApi.postMessage({ type: 'reconnect' });
	});
	window.addEventListener('message', (event) => {
		const msg = event.data;
		// Зан-ревью §5 п.1: сверка токена отклоняет postMessage от cross-origin iframe — чужие сообщения отбрасываются.
		if (msg && msg.type === 'load' && msg.token === RENDER_TOKEN && typeof msg.url === 'string' && msg.url) {
			errurl.textContent = msg.url;
			frame.src = msg.url; // reassignment всегда перезагружает iframe
			startLoading();
		}
	});
	startLoading();
</script>
</body>
</html>`;
}

/** Лаунчер в activity bar (AURA-002): статус сервера + кнопки открытия. */
function launcherHtml(url) {
	const nonce = cspNonce();
	const strings = {
		open: vscode.l10n.t('Open n8n'),
		openExternal: vscode.l10n.t('Open in Browser'),
		checking: vscode.l10n.t('Checking…'),
		online: vscode.l10n.t('Server is reachable'),
		offline: vscode.l10n.t('Server is not reachable'),
		notConfigured: vscode.l10n.t('n8n URL is not configured — set it in the n8nPanel.url setting.'),
	};
	const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
	const body = url
		? `<div class="url">${escapeHtml(url)}</div>
<div class="status" id="status"><span class="dot"></span><span id="stext"></span></div>
<button id="open" type="button" class="primary"></button>
<button id="external" type="button"></button>`
		: `<div class="status off">${escapeHtml(strings.notConfigured)}</div>`;
	return `<!DOCTYPE html>
<html lang="${escapeHtml(vscode.env.language)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
	body { padding: 12px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
	.url { word-break: break-all; opacity: .75; margin-bottom: 10px; }
	.status { display: flex; align-items: center; gap: 7px; margin-bottom: 12px; }
	.status.off { opacity: .75; }
	.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); flex: none; }
	.dot.ok { background: #3fb950; }
	.dot.bad { background: #f85149; }
	button { display: block; width: 100%; margin-bottom: 8px; padding: 6px 10px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	button.primary { background: #ff6d5a; color: #1e1e1e; font-weight: 600; }
	button:hover { filter: brightness(1.1); }
</style>
</head>
<body>
${body}
<script nonce="${nonce}">
	const vscodeApi = acquireVsCodeApi();
	const STR = ${jsonForScript(strings)};
	const openBtn = document.getElementById('open');
	const externalBtn = document.getElementById('external');
	if (openBtn) {
		openBtn.textContent = STR.open;
		openBtn.addEventListener('click', () => vscodeApi.postMessage({ type: 'openTab' }));
	}
	if (externalBtn) {
		externalBtn.textContent = STR.openExternal;
		externalBtn.addEventListener('click', () => vscodeApi.postMessage({ type: 'openExternal' }));
	}
	const stext = document.getElementById('stext');
	if (stext) { stext.textContent = STR.checking; }
	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (msg && msg.type === 'status' && stext) {
			const dot = document.querySelector('.dot');
			dot.classList.add(msg.online ? 'ok' : 'bad');
			stext.textContent = msg.online ? STR.online : STR.offline;
		}
	});
</script>
</body>
</html>`;
}

/** WebviewView-лаунчер: перерисовывается при каждом показе, статус — свежая проверка. */
class LauncherViewProvider {
	resolveWebviewView(webviewView) {
		webviewView.webview.options = { enableScripts: true };
		const render = async () => {
			const url = getUrl();
			webviewView.webview.html = launcherHtml(url);
			if (url) {
				const online = await checkStatus(url);
				webviewView.webview.postMessage({ type: 'status', online });
			}
		};
		webviewView.webview.onDidReceiveMessage((msg) => {
			if (msg && msg.type === 'openTab') {
				vscode.commands.executeCommand('n8nPanel.openTab');
			} else if (msg && msg.type === 'openExternal') {
				vscode.commands.executeCommand('n8nPanel.openExternal');
			}
		});
		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				render();
			}
		});
		render();
	}
}

function activate(context) {
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('n8nPanel.launcher', new LauncherViewProvider()),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('n8nPanel.openTab', async () => {
			const url = getUrl();
			if (!url) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('n8n URL is not configured — set it in the n8nPanel.url setting.'),
				);
				return;
			}
			// AURA-006: не плодим retained webview — открываем заново существующую вкладку.
			if (currentPanel) {
				currentPanel.reveal(); // Зан-ревью §5 п.5: без ViewColumn.One — не таскаем вкладку из колонки пользователя
				return;
			}
			const panel = vscode.window.createWebviewPanel(
				'n8nPanel.tab',
				'n8n',
				vscode.ViewColumn.One,
				{ enableScripts: true, retainContextWhenHidden: true },
			);
			currentPanel = panel;
			panel.onDidDispose(() => { currentPanel = undefined; }, null, context.subscriptions);
			// Зан-ревью §5 п.1: per-render токен — webview принимает load-сообщения только с ним.
			const renderToken = crypto.randomBytes(16).toString('hex');
			panel.webview.onDidReceiveMessage((msg) => {
				if (msg && msg.type === 'reconnect') {
					const freshUrl = getUrl();
					if (freshUrl) {
						panel.webview.postMessage({ type: 'load', url: freshUrl, token: renderToken });
					}
				}
			});
			panel.webview.html = tabHtml(url, renderToken);
			if (!await checkStatus(url)) {
				vscode.window.showWarningMessage(
					vscode.l10n.t('n8n is not responding at {0} — the tab may stay empty.', url),
				);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('n8nPanel.openExternal', () => {
			const url = getUrl();
			if (!url) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('n8n URL is not configured — set it in the n8nPanel.url setting.'),
				);
				return;
			}
			vscode.env.openExternal(vscode.Uri.parse(url));
		}),
	);
}

function deactivate() {}

module.exports = { activate, deactivate };
