/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — встроенный экран устройства («красивый эмулятор» внутри IDE).
 *  Webview-панель: живой экран через adb exec-out screencap (периодические кадры),
 *  тапы/свайпы мышью по картинке (координаты масштабируются в разрешение устройства),
 *  панель кнопок (назад/домой/недавние/громкость/power/поворот) и ввод текста.
 *  Панель одна на устройство; при закрытии стрим останавливается.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { tr } from './l10n';
import { AndroidPanel } from './android';

/** Целевая точка входа: строка с id, узел дерева устройства или AVD. */
type ScreenTarget = string | { id?: string; runningDevice?: string } | undefined;

const KEYCODES = { back: 4, home: 3, recents: 187, volDown: 25, volUp: 24, power: 26 } as const;
const FRAME_INTERVAL_MS = 800;

class DeviceScreen implements vscode.Disposable {

	private readonly panel: vscode.WebviewPanel;
	private timer: NodeJS.Timeout | undefined;
	private busy = false;
	private disposed = false;

	constructor(
		private readonly android: AndroidPanel,
		private readonly device: string,
		onDispose: () => void,
	) {
		this.panel = vscode.window.createWebviewPanel(
			'auraKotlin.deviceScreen',
			`${device}`,
			vscode.ViewColumn.Beside,
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		this.panel.iconPath = new vscode.ThemeIcon('device-mobile');
		this.panel.webview.html = this.html();
		this.panel.webview.onDidReceiveMessage(message => void this.onMessage(message));
		this.panel.onDidDispose(() => { this.disposed = true; this.stop(); onDispose(); });
		this.stream();
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
		this.panel.dispose();
	}

	reveal(): void {
		this.panel.reveal();
		if (!this.timer) { this.stream(); }
	}

	private stop(): void {
		if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
	}

	/** Цикл кадров: screencap → base64 → webview; ошибка = «устройство офлайн», ретраи медленнее. */
	private stream(): void {
		const tick = async () => {
			if (this.disposed) { return; }
			if (this.busy) { this.timer = setTimeout(tick, FRAME_INTERVAL_MS); return; }
			this.busy = true;
			let delay = FRAME_INTERVAL_MS;
			try {
				const frame = await this.android.captureScreen(this.device);
				if (frame.length > 100) {
					await this.panel.webview.postMessage({ type: 'frame', data: frame.toString('base64') });
				}
			} catch {
				await this.panel.webview.postMessage({ type: 'offline' });
				delay = FRAME_INTERVAL_MS * 4;
			}
			this.busy = false;
			if (!this.disposed) { this.timer = setTimeout(tick, delay); }
		};
		void tick();
	}

	private async onMessage(message: { type: string; [key: string]: unknown }): Promise<void> {
		try {
			switch (message.type) {
				case 'tap':
					await this.android.inputTap(this.device, Number(message.x), Number(message.y));
					break;
				case 'swipe':
					await this.android.inputSwipe(this.device, Number(message.x1), Number(message.y1), Number(message.x2), Number(message.y2), Number(message.duration));
					break;
				case 'key':
					await this.android.inputKey(this.device, KEYCODES[message.key as keyof typeof KEYCODES]);
					break;
				case 'text':
					await this.android.inputText(this.device, String(message.text ?? ''));
					break;
				case 'rotate':
					await this.android.rotateScreen(this.device);
					break;
				case 'refresh':
					// Просто дожидаемся следующего кадра — цикл и так идёт.
					break;
			}
		} catch (error) {
			void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
		}
	}

	private html(): string {
		const t = (en: string) => tr(en);
		return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
	body { margin: 0; display: flex; flex-direction: column; height: 100vh; background: var(--vscode-sideBar-background); color: var(--vscode-foreground); overflow: hidden; }
	#bar { display: flex; gap: 4px; padding: 6px; align-items: center; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
	button { padding: 4px 8px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
	button:hover { background: var(--vscode-button-secondaryHoverBackground); }
	#text { flex: 1; min-width: 90px; padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; }
	#stage { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; position: relative; }
	#screen { max-width: 96%; max-height: 96%; border-radius: 18px; border: 6px solid #222; box-shadow: 0 6px 30px rgba(0,0,0,.5); cursor: crosshair; user-select: none; touch-action: none; }
	#offline { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; color: var(--vscode-errorForeground); font-size: 14px; }
</style>
</head>
<body>
<div id="bar">
	<button data-key="back" title="${t('Back')}">◀</button>
	<button data-key="home" title="${t('Home')}">●</button>
	<button data-key="recents" title="${t('Recents')}">■</button>
	<button data-key="volDown" title="Vol −">🔉</button>
	<button data-key="volUp" title="Vol +">🔊</button>
	<button data-key="power" title="Power">⏻</button>
	<button id="rotate" title="${t('Rotate')}">⟳</button>
	<input id="text" placeholder="${t('Type text…')}">
	<button id="send">${t('Send')}</button>
</div>
<div id="stage">
	<img id="screen" draggable="false" alt="">
	<div id="offline">${t('Device offline — reconnecting…')}</div>
</div>
<script>
	const vscode = acquireVsCodeApi();
	const img = document.getElementById('screen');
	const offline = document.getElementById('offline');
	window.addEventListener('message', event => {
		const msg = event.data;
		if (msg.type === 'frame') { img.src = 'data:image/png;base64,' + msg.data; offline.style.display = 'none'; }
		if (msg.type === 'offline') { offline.style.display = 'flex'; }
	});
	function toDevice(e) {
		const rect = img.getBoundingClientRect();
		const scaleX = (img.naturalWidth || rect.width) / rect.width;
		const scaleY = (img.naturalHeight || rect.height) / rect.height;
		return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
	}
	let down = null;
	img.addEventListener('mousedown', e => { down = { ...toDevice(e), time: Date.now() }; });
	img.addEventListener('mouseup', e => {
		if (!down) { return; }
		const up = toDevice(e);
		const dist = Math.hypot(up.x - down.x, up.y - down.y);
		if (dist < 12 && Date.now() - down.time < 400) {
			vscode.postMessage({ type: 'tap', x: down.x, y: down.y });
		} else {
			vscode.postMessage({ type: 'swipe', x1: down.x, y1: down.y, x2: up.x, y2: up.y, duration: Math.min(Date.now() - down.time, 1200) });
		}
		down = null;
	});
	for (const btn of document.querySelectorAll('button[data-key]')) {
		btn.addEventListener('click', () => vscode.postMessage({ type: 'key', key: btn.dataset.key }));
	}
	document.getElementById('rotate').addEventListener('click', () => vscode.postMessage({ type: 'rotate' }));
	const text = document.getElementById('text');
	const send = () => { if (text.value) { vscode.postMessage({ type: 'text', text: text.value }); text.value = ''; } };
	document.getElementById('send').addEventListener('click', send);
	text.addEventListener('keydown', e => { if (e.key === 'Enter') { send(); } });
</script>
</body>
</html>`;
	}
}

/** Менеджер панелей: одна на устройство, повторный вызов — reveal. */
export class DeviceScreenManager implements vscode.Disposable {

	private readonly screens = new Map<string, DeviceScreen>();

	constructor(private readonly android: AndroidPanel) { }

	async open(target?: ScreenTarget): Promise<void> {
		let device: string | undefined;
		if (typeof target === 'string') { device = target; }
		else if (target?.id) { device = target.id; }
		else if (target?.runningDevice) { device = target.runningDevice; }
		else { device = await this.android.pickDevice(); }
		if (!device) { return; }

		const existing = this.screens.get(device);
		if (existing) { existing.reveal(); return; }
		const screen = new DeviceScreen(this.android, device, () => this.screens.delete(device));
		this.screens.set(device, screen);
	}

	dispose(): void {
		for (const screen of this.screens.values()) { screen.dispose(); }
		this.screens.clear();
	}
}

export function registerDeviceScreen(context: vscode.ExtensionContext, android: AndroidPanel): DeviceScreenManager {
	const manager = new DeviceScreenManager(android);
	context.subscriptions.push(
		manager,
		vscode.commands.registerCommand('auraKotlin.android.deviceScreen', (target?: ScreenTarget) => manager.open(target)),
	);
	return manager;
}
