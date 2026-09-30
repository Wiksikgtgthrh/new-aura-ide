/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — форма создания эмулятора (AVD) во вкладке редактора.
 *  Вместо цепочки quick-pick'ов: модель телефона, системный образ (установленные
 *  + скачивание по API-уровню), имя и запуск после создания — всё на одном экране,
 *  на русском. Создание идёт с живым статусом прямо в форме.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AndroidPanel } from './android';
import { tr } from './l10n';

interface InitData {
	ok: boolean;
	error?: string;
	profiles: Array<{ id: string; name: string }>;
	images: string[];
	arch: string;
}

export class AvdCreateForm {

	private static current: AvdCreateForm | undefined;

	private readonly panel: vscode.WebviewPanel;
	private busy = false;

	private constructor(
		private readonly android: AndroidPanel,
		private readonly onCreated: (name: string) => void,
	) {
		this.panel = vscode.window.createWebviewPanel(
			'auraKotlin.avdCreate',
			tr('New emulator (AVD)'),
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		this.panel.iconPath = new vscode.ThemeIcon('device-mobile');
		const nonce = String(Date.now()) + '-' + Math.floor(Math.random() * 1e9);
		this.panel.webview.html = this.html(nonce);
		this.panel.onDidDispose(() => { if (AvdCreateForm.current === this) { AvdCreateForm.current = undefined; } });
		this.panel.webview.onDidReceiveMessage(message => void this.onMessage(message));
	}

	static show(android: AndroidPanel, onCreated: (name: string) => void): void {
		if (AvdCreateForm.current) {
			AvdCreateForm.current.panel.reveal();
			return;
		}
		AvdCreateForm.current = new AvdCreateForm(android, onCreated);
	}

	private async onMessage(message: { type?: string; profileId?: string; image?: string; downloadApi?: string; name?: string; start?: boolean }): Promise<void> {
		if (message?.type === 'init') {
			await this.sendInit();
			return;
		}
		if (message?.type !== 'create' || this.busy) { return; }
		this.busy = true;
		const post = (msg: object) => void this.panel.webview.postMessage(msg);
		try {
			const tools = await this.android.avdTools();
			if (!tools) { throw new Error(tr('Android SDK is not configured. Open Android Doctor and set the SDK path.')); }

			let image = String(message.image ?? '');
			if (!image && message.downloadApi) {
				const arch = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
				image = `system-images;android-${message.downloadApi};google_apis;${arch}`;
				post({ type: 'status', text: tr('Downloading system image {0}… (licenses are accepted automatically)', image) });
				if (!await this.android.installSystemImage(tools.sdkmanager, image)) {
					throw new Error(tr('Failed to download {0}. Run sdkmanager manually and accept licenses.', image));
				}
			}
			if (!image) { throw new Error(tr('Select a system image.')); }

			post({ type: 'status', text: tr('Creating emulator {0}…', String(message.name ?? '')) });
			await this.android.createAvdAdvanced({ name: String(message.name ?? '').trim(), image, profileId: String(message.profileId ?? '') });

			if (message.start) {
				post({ type: 'status', text: tr('Starting the emulator…') });
				await this.android.startAvd(String(message.name ?? '').trim());
			}
			post({ type: 'done', name: String(message.name ?? '').trim() });
			this.onCreated(String(message.name ?? '').trim());
		} catch (error) {
			post({ type: 'error', text: error instanceof Error ? error.message : String(error) });
		} finally {
			this.busy = false;
		}
	}

	private async sendInit(): Promise<void> {
		const data: InitData = { ok: false, profiles: [], images: [], arch: process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64' };
		try {
			const tools = await this.android.avdTools();
			if (!tools) {
				data.error = tr('Android SDK is not configured. Run "Android: Doctor" and set the SDK path, then reopen this form.');
			} else {
				const [profiles, images] = await Promise.all([
					this.android.listDeviceProfiles(tools.avdmanager),
					this.android.listSystemImages(tools.sdkmanager),
				]);
				data.ok = true;
				data.profiles = profiles;
				data.images = images;
			}
		} catch (error) {
			data.error = error instanceof Error ? error.message : String(error);
		}
		void this.panel.webview.postMessage({ type: 'init', data });
	}

	// Форма статичная: строки только русские (продукт Russian-first), скрипт под nonce.
	private html(nonce: string): string {
		return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Новый эмулятор</title>
<style>
:root {
	--sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 24px; --sp-6: 32px;
	--r-ctl: 6px; --r-card: 10px;
	--dur-1: 90ms; --dur-2: 160ms; --dur-3: 240ms;
	--ease-out: cubic-bezier(.2, 0, 0, 1);
	--text: var(--vscode-foreground);
	--muted: var(--vscode-descriptionForeground);
	--surface: color-mix(in srgb, var(--vscode-editor-foreground) 4%, var(--vscode-editor-background));
	--border: color-mix(in srgb, var(--vscode-editor-foreground) 14%, transparent);
	--focus: var(--vscode-focusBorder);
	--danger: var(--vscode-errorForeground);
	--ok: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
}
* { box-sizing: border-box; }
body {
	margin: 0; padding: var(--sp-5) var(--sp-5) var(--sp-6);
	font-family: var(--vscode-font-family); font-size: 13px; color: var(--text);
	background: var(--vscode-editor-background);
}
.shell { max-width: 560px; margin-inline: auto; }
h1 { font-size: 20px; font-weight: 600; margin: 0 0 var(--sp-1); animation: fadeUp .3s var(--ease-out) both; }
.sub { color: var(--muted); font-size: 13px; margin: 0 0 var(--sp-5); animation: fadeUp .3s var(--ease-out) both; animation-delay: 40ms; }

.card {
	background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-card);
	padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-4);
	animation: fadeUp .35s var(--ease-out) both; animation-delay: 80ms;
}
@keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

.field { display: flex; flex-direction: column; gap: var(--sp-1); }
.field label { font-size: 11px; color: var(--muted); letter-spacing: .02em; }
.field .hint { font-size: 11px; color: var(--muted); }
input[type=text], select {
	width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--r-ctl);
	background: var(--vscode-input-background); color: var(--vscode-input-foreground);
	font-family: inherit; font-size: 13px; outline: none;
	transition: border-color var(--dur-2) var(--ease-out), box-shadow var(--dur-2) var(--ease-out);
}
input[type=text]:hover, select:hover { border-color: color-mix(in srgb, var(--focus) 50%, var(--border)); }
input[type=text]:focus, select:focus {
	border-color: var(--focus);
	box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus) 25%, transparent);
}
.row { display: flex; gap: var(--sp-3); }
.row .field { flex: 1; min-width: 0; }

.check { display: flex; align-items: center; gap: var(--sp-2); cursor: pointer; user-select: none; color: var(--muted); transition: color var(--dur-1) var(--ease-out); }
.check:hover { color: var(--text); }
.check input { accent-color: var(--vscode-button-background); }

/* Кнопки: подъём при наведении, микро-сжатие при нажатии, фокус-кольцо */
.actions { display: flex; gap: var(--sp-2); align-items: center; }
.btn {
	padding: 7px 18px; border: 1px solid transparent; border-radius: var(--r-ctl);
	background: var(--vscode-button-background); color: var(--vscode-button-foreground);
	font-family: inherit; font-size: 13px; cursor: pointer;
	transition: background var(--dur-2) var(--ease-out), transform var(--dur-1) var(--ease-out), box-shadow var(--dur-2) var(--ease-out), opacity var(--dur-2) var(--ease-out);
}
.btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); transform: translateY(-1px); box-shadow: 0 3px 8px color-mix(in srgb, #000 30%, transparent); }
.btn:active:not(:disabled) { transform: translateY(0) scale(.97); box-shadow: none; transition-duration: var(--dur-1); }
.btn:disabled { opacity: .6; cursor: default; }
.btn:focus-visible { outline: 1px solid var(--focus); outline-offset: 2px; }
.btn.ghost {
	background: transparent; color: var(--muted); border-color: var(--border);
}
.btn.ghost:hover:not(:disabled) { background: color-mix(in srgb, var(--focus) 8%, transparent); color: var(--text); border-color: var(--focus); box-shadow: none; }

.status { display: none; align-items: center; gap: var(--sp-2); font-size: 12px; color: var(--muted); }
.status.show { display: flex; animation: fadeUp .25s var(--ease-out); }
.spinner { width: 14px; height: 14px; flex: none; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--muted) 30%, transparent); border-top-color: var(--text); animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.banner { display: none; padding: var(--sp-3) var(--sp-4); border-radius: var(--r-card); font-size: 12.5px; animation: fadeUp .25s var(--ease-out); }
.banner.show { display: block; }
.banner.error { background: color-mix(in srgb, var(--danger) 10%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent); color: var(--danger); }
.banner.ok { background: color-mix(in srgb, var(--ok) 10%, transparent); border: 1px solid color-mix(in srgb, var(--ok) 40%, transparent); color: var(--ok); }

.api-row { display: none; }
.api-row.show { display: flex; animation: fadeUp .25s var(--ease-out); }

.skeleton { height: 34px; border-radius: var(--r-ctl); background: linear-gradient(90deg, var(--surface) 25%, color-mix(in srgb, var(--vscode-editor-foreground) 8%, var(--surface)) 50%, var(--surface) 75%); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; }
@keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }

@media (prefers-reduced-motion: reduce) {
	*, *::before, *::after { animation-duration: 1ms !important; transition-duration: 1ms !important; }
}
</style></head><body>
<div class="shell">
	<h1>Новый эмулятор (AVD)</h1>
	<p class="sub">Модель телефона, версия Android и имя — эмулятор появится в панели Android.</p>

	<div class="banner error" id="bannerError"></div>
	<div class="banner ok" id="bannerOk"></div>

	<div class="card" id="form" style="display:none">
		<div class="field">
			<label for="profile">Модель устройства</label>
			<select id="profile"></select>
		</div>
		<div class="field">
			<label for="image">Системный образ</label>
			<select id="image"></select>
			<span class="hint" id="archHint"></span>
		</div>
		<div class="field api-row" id="apiRow">
			<label for="api">API-уровень для скачивания</label>
			<input type="text" id="api" value="35" maxlength="2" inputmode="numeric">
			<span class="hint">Образ скачается через sdkmanager (~1 ГБ), лицензии подтверждаются автоматически.</span>
		</div>
		<div class="field">
			<label for="name">Имя эмулятора</label>
			<input type="text" id="name" maxlength="40">
			<span class="hint">Буквы, цифры, точка, дефис и подчёркивание.</span>
		</div>
		<label class="check"><input type="checkbox" id="startAfter" checked> Запустить эмулятор после создания</label>
		<div class="actions">
			<button class="btn" id="btnCreate">Создать эмулятор</button>
			<div class="status" id="status"><span class="spinner"></span><span id="statusText"></span></div>
		</div>
	</div>
	<div class="card" id="loading"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>
</div>
<script nonce="${nonce}">
'use strict';
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const state = { profiles: [], images: [], arch: 'x86_64', busy: false, nameTouched: false };

function showBanner(id, text) {
	for (const other of ['bannerError', 'bannerOk']) { $(other).classList.remove('show'); }
	const el = $(id);
	el.textContent = text;
	el.classList.add('show');
}
function setStatus(text) {
	$('status').classList.toggle('show', !!text);
	$('statusText').textContent = text ?? '';
}
function setBusy(busy) {
	state.busy = busy;
	$('btnCreate').disabled = busy;
	for (const el of document.querySelectorAll('#form select, #form input')) { el.disabled = busy; }
	if (!busy) { setStatus(''); }
}
function apiOf(image) {
	const m = /android-(\\d+)/.exec(image ?? '');
	return m ? m[1] : '';
}
function suggestName() {
	if (state.nameTouched) { return; }
	const profile = $('profile').value || 'pixel';
	const image = $('image').value;
	const api = image ? apiOf(image) : $('api').value.trim();
	$('name').value = profile.replace(/\\s+/g, '_') + (api ? '_api_' + api : '');
}
function fillForm(data) {
	state.profiles = data.profiles;
	state.images = data.images;
	state.arch = data.arch;
	$('profile').innerHTML = data.profiles.map(p => '<option value="' + p.id + '">' + p.name + '</option>').join('');
	const pixel = data.profiles.findIndex(p => /pixel/i.test(p.name));
	if (pixel >= 0) { $('profile').selectedIndex = pixel; }
	const sorted = [...data.images].sort((a, b) => Number(apiOf(b)) - Number(apiOf(a)));
	$('image').innerHTML = sorted.map(i => '<option value="' + i + '">API ' + apiOf(i) + ' · ' + i + '</option>').join('')
		+ '<option value="">Скачать новый образ…</option>';
	$('archHint').textContent = 'Архитектура: ' + data.arch;
	$('loading').style.display = 'none';
	$('form').style.display = '';
	suggestName();
}

$('image').addEventListener('change', () => {
	$('apiRow').classList.toggle('show', !$('image').value);
	suggestName();
});
$('profile').addEventListener('change', suggestName);
$('api').addEventListener('input', suggestName);
$('name').addEventListener('input', () => { state.nameTouched = true; });

$('btnCreate').addEventListener('click', () => {
	if (state.busy) { return; }
	const name = $('name').value.trim();
	if (!/^[\\w.-]+$/.test(name)) { showBanner('bannerError', 'Имя: только буквы, цифры, точка, дефис и подчёркивание.'); return; }
	const image = $('image').value;
	const api = $('api').value.trim();
	if (!image && !/^\\d{2}$/.test(api)) { showBanner('bannerError', 'API-уровень — две цифры, например 35.'); return; }
	setBusy(true);
	setStatus(image ? 'Создание эмулятора…' : 'Скачивание системного образа…');
	vscode.postMessage({
		type: 'create',
		profileId: $('profile').value,
		image,
		downloadApi: image ? undefined : api,
		name,
		start: $('startAfter').checked
	});
});

window.addEventListener('message', (event) => {
	const msg = event.data;
	if (msg.type === 'init') {
		if (msg.data.ok) { fillForm(msg.data); }
		else {
			$('loading').style.display = 'none';
			showBanner('bannerError', msg.data.error || 'Не удалось получить данные SDK.');
		}
	} else if (msg.type === 'status') {
		setStatus(msg.text);
	} else if (msg.type === 'error') {
		setBusy(false);
		showBanner('bannerError', msg.text || 'Ошибка создания эмулятора.');
	} else if (msg.type === 'done') {
		setBusy(false);
		setStatus('');
		showBanner('bannerOk', 'Эмулятор «' + msg.name + '» создан и уже в списке панели Android.');
	}
});

vscode.postMessage({ type: 'init' });
</script>
</body></html>`;
	}
}
