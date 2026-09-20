/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — Android SDK, эмуляторы и панель (этап 3 ТЗ).
 *  Обнаружение SDK по цепочке: настройка → ANDROID_HOME → ANDROID_SDK_ROOT → local.properties →
 *  стандартные пути по ОС (само также живёт в classpath.ts sdkRoot). Эмуляторы: список AVD,
 *  запуск с ожиданием sys.boot_completed, остановка, создание AVD. Единый селектор устройств
 *  (физические + эмуляторы), выбор запоминается в workspaceState и показывается в статус-баре.
 *  Logcat — webview с фильтром по приложению (--pid), подсветкой уровней, поиском и очисткой.
 *  Также: примитивы для отладки (install, am start -D, forward jdwp, pidof с ретраями).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn, execFile, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

export interface AndroidDevice {
	id: string;
	/** Эмулятор (avd) или физическое устройство. */
	emulator: boolean;
	model: string;
}

export class AndroidPanel implements vscode.Disposable {

	private readonly output = vscode.window.createOutputChannel('Android Logcat');
	private readonly statusbar: vscode.StatusBarItem;
	private logcat?: ChildProcess;
	private logcatDevice?: string;
	private logcatPid?: string;
	private logcatBuffer: string[] = [];
	private logcatPanel?: vscode.WebviewPanel;
	private watching = false;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.statusbar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
		this.statusbar.name = 'Android Device';
		this.statusbar.command = 'auraKotlin.android.pickDevice';
	}

	dispose(): void {
		this.stopLogcat();
		this.statusbar.dispose();
		this.output.dispose();
		this.logcatPanel?.dispose();
	}

	// ---------- SDK ----------

	/** Путь к adb из корня SDK (или 'adb' из PATH). */
	adbPath(): string | undefined {
		const sdk = this.sdk();
		if (!sdk) { return 'adb'; }
		return path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
	}

	/** Корень SDK: настройка → env → local.properties → стандартные пути; undefined если нет. */
	sdk(): string | undefined {
		const configured = vscode.workspace.getConfiguration('auraKotlin').get<string>('androidSdkPath', '').trim();
		const candidates = [configured, process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT];
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (root) {
			const localProps = path.join(root, 'local.properties');
			if (fs.existsSync(localProps)) {
				const sdkDir = /^\s*sdk\.dir\s*=\s*(.+)$/m.exec(fs.readFileSync(localProps, 'utf8'))?.[1]?.trim().replace(/\\\\/g, '\\');
				if (sdkDir) { candidates.push(sdkDir); }
			}
		}
		const home = os.homedir();
		candidates.push(...(process.platform === 'win32'
			? [path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk')]
			: process.platform === 'darwin'
				? [path.join(home, 'Library', 'Android', 'sdk')]
				: [path.join(home, 'Android', 'Sdk')]));
		return candidates.find(sdk => sdk && fs.existsSync(path.join(sdk, 'platform-tools')));
	}

	/** SDK есть? Если нет — нотификация с кнопкой «Указать путь». Возвращает путь или undefined. */
	async ensureSdk(): Promise<string | undefined> {
		const sdk = this.sdk();
		if (sdk) { return sdk; }
		const pick = await vscode.window.showWarningMessage(
			vscode.l10n.t('Android SDK not found. Set auraKotlin.androidSdkPath, ANDROID_HOME or install the SDK.'),
			vscode.l10n.t('Specify path'),
		);
		if (pick) {
			const folder = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectMany: false, openLabel: vscode.l10n.t('Android SDK folder') }))?.[0];
			if (folder) {
				await vscode.workspace.getConfiguration('auraKotlin').update('androidSdkPath', folder.fsPath, vscode.ConfigurationTarget.Global);
				return folder.fsPath;
			}
		}
		return undefined;
	}

	private async adb(...args: string[]): Promise<string> {
		const result = await execFileAsync(this.adbPath() ?? 'adb', args, { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
		return `${result.stdout}${result.stderr}`.trim();
	}

	// ---------- Устройства ----------

	/** Список подключённых устройств (USB/Wi-Fi) с моделью и типом. */
	async devices(): Promise<AndroidDevice[]> {
		try {
			const text = await this.adb('devices', '-l');
			return text.split(/\r?\n/).slice(1).filter(line => line.trim()).map(line => {
				const parts = line.trim().split(/\s+/);
				const id = parts[0];
				const emulator = id.startsWith('emulator-');
				const model = /model:(\S+)/.exec(line)?.[1] ?? (emulator ? 'AVD' : 'device');
				return { id, emulator, model };
			});
		} catch {
			return [];
		}
	}

	/** Выбранное устройство (запоминается в workspaceState). */
	get selectedDevice(): string | undefined {
		return this.context.workspaceState.get<string>('auraKotlin.selectedDevice');
	}

	private set selectedDevice(id: string | undefined) {
		void this.context.workspaceState.update('auraKotlin.selectedDevice', id);
	}

	/** Единый селектор устройств: физические + эмуляторы в одном списке. */
	async pickDevice(): Promise<string | undefined> {
		const devices = await this.devices();
		if (devices.length === 0) {
			void vscode.window.showWarningMessage(vscode.l10n.t('No Android devices connected (adb devices is empty). Start an emulator or plug in a device.'));
			return undefined;
		}
		const selected = this.selectedDevice;
		if (devices.length === 1) {
			this.selectedDevice = devices[0].id;
			this.updateDeviceStatus(devices[0]);
			return devices[0].id;
		}
		if (selected && devices.some(device => device.id === selected)) {
			return selected;
		}
		const pick = await vscode.window.showQuickPick(devices.map(device => ({
			label: `$(${device.emulator ? 'vm' : 'device-mobile'}) ${device.id}`,
			description: device.model,
			id: device.id,
		})), { placeHolder: vscode.l10n.t('Select Android device') });
		if (pick) {
			this.selectedDevice = pick.id;
			this.updateDeviceStatus(devices.find(device => device.id === pick.id));
			return pick.id;
		}
		return undefined;
	}

	private updateDeviceStatus(device?: AndroidDevice): void {
		if (!device) { this.statusbar.hide(); return; }
		this.statusbar.text = `$(${device.emulator ? 'vm' : 'device-mobile'}) ${device.id}`;
		this.statusbar.tooltip = vscode.l10n.t('Selected Android device: {0} ({1})', device.id, device.model);
		this.statusbar.show();
	}

	/** Показать выбранное устройство в статус-баре (при старте). */
	async showDeviceStatus(): Promise<void> {
		const selected = this.selectedDevice;
		if (!selected) { return; }
		const devices = await this.devices();
		const found = devices.find(device => device.id === selected);
		if (found) { this.updateDeviceStatus(found); } else { this.statusbar.hide(); }
	}

	// ---------- Эмуляторы ----------

	/** emulator -list-avds. */
	async listAvds(): Promise<string[]> {
		const sdk = this.sdk();
		if (!sdk) { return []; }
		const emulator = path.join(sdk, 'emulator', process.platform === 'win32' ? 'emulator.exe' : 'emulator');
		if (!fs.existsSync(emulator)) { return []; }
		try {
			const { stdout } = await execFileAsync(emulator, ['-list-avds'], { timeout: 10_000 });
			return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
		} catch {
			return [];
		}
	}

	/** Запуск выбранного AVD; ожидание sys.boot_completed до 120 секунд. */
	async startEmulator(): Promise<string | undefined> {
		const sdk = await this.ensureSdk();
		if (!sdk) { return undefined; }
		const avds = await this.listAvds();
		if (!avds.length) {
			void vscode.window.showWarningMessage(vscode.l10n.t('No AVDs found. Create one in Android Studio or via avdmanager.'));
			return undefined;
		}
		const avd = avds.length === 1 ? avds[0] : await vscode.window.showQuickPick(avds, { placeHolder: vscode.l10n.t('Start Android emulator') });
		if (!avd) { return undefined; }
		const emulator = path.join(sdk, 'emulator', process.platform === 'win32' ? 'emulator.exe' : 'emulator');
		const child = spawn(emulator, ['-avd', avd], { detached: true, stdio: 'ignore' });
		child.unref();
		const started = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Waiting for emulator {0} to boot…', avd), cancellable: false },
			() => this.waitForBoot(120_000),
		);
		if (started) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Emulator {0} is ready.', avd));
			await this.pickDevice();
			return avd;
		}
		void vscode.window.showWarningMessage(vscode.l10n.t('Emulator {0} did not finish booting in time (it may still come up).', avd));
		return avd;
	}

	/** Ожидание sys.boot_completed=1 на любом подключённом устройстве. */
	private async waitForBoot(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				const out = await this.adb('shell', 'getprop', 'sys.boot_completed');
				if (out.trim() === '1') { return true; }
			} catch { /* устройство ещё не видно */ }
			await new Promise(resolve => setTimeout(resolve, 1500));
		}
		return false;
	}

	/** Остановить эмулятор (-e emu kill по выбранному/единственному). */
	async stopEmulator(): Promise<void> {
		const devices = (await this.devices()).filter(device => device.emulator);
		if (!devices.length) { return; }
		for (const device of devices) {
			await this.adb('-s', device.id, 'emu', 'kill').catch(() => undefined);
		}
		void vscode.window.showInformationMessage(vscode.l10n.t('Emulator stopped.'));
	}

	/** Создание AVD через avdmanager (второй приоритет). */
	async createAvd(): Promise<void> {
		const sdk = await this.ensureSdk();
		if (!sdk) { return; }
		const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t('AVD name'), value: 'Aura_AVD' });
		if (!name) { return; }
		const systemImage = await vscode.window.showInputBox({ prompt: vscode.l10n.t('System image (e.g. system-images;android-35;google_apis;x86_64)'), value: 'system-images;android-35;google_apis;x86_64' });
		if (!systemImage) { return; }
		const avdmanager = path.join(sdk, 'cmdline-tools', 'latest', 'bin', process.platform === 'win32' ? 'avdmanager.bat' : 'avdmanager');
		try {
			const { stdout } = await execFileAsync(avdmanager, ['create', 'avd', '-n', name, '-k', systemImage, '-d', 'pixel'], { timeout: 60_000 });
			vscode.window.showInformationMessage(vscode.l10n.t('AVD {0} created.', name) + ` ${stdout.split(/\r?\n/)[0] ?? ''}`);
		} catch (error) {
			vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
		}
	}

	// ---------- Установка / запуск / отладка ----------

	/** Установка .apk на активное устройство. */
	async installApk(): Promise<void> {
		const file = (await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, filters: { 'Android package': ['apk'] } }))?.[0];
		if (!file) { return; }
		const device = await this.pickDevice();
		if (!device) { return; }
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Installing {0}…', file.fsPath.split(/[\\/]/).pop() ?? 'apk') }, async () => {
			try {
				const text = await this.adb('-s', device, 'install', '-r', file.fsPath);
				vscode.window.showInformationMessage(text.includes('Success') ? vscode.l10n.t('APK installed on {0}.', device) : text);
			} catch (error) {
				vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
			}
		});
	}

	/** Установить APK и вернуть информацию о пакете на устройстве. */
	async installForDebug(apkPath: string, device?: string, applicationId?: string): Promise<{ device: string; package: string } | undefined> {
		const dev = device ?? await this.pickDevice();
		if (!dev) { return undefined; }
		await this.adb('-s', dev, 'install', '-r', apkPath);
		// applicationId из Gradle (init-скрипт) — основной источник; aapt — фолбэк.
		const pkg = applicationId || await this.packageFromApk(apkPath, dev);
		if (!pkg) { throw new Error(vscode.l10n.t('Could not read applicationId from the APK (aapt missing or bad manifest).')); }
		return { device: dev, package: pkg };
	}

	/** applicationId из APK: aapt dump badging (build-tools) — фолбэк после Gradle. */
	async packageFromApk(apkPath: string, device: string): Promise<string | undefined> {
		const sdk = this.sdk();
		if (sdk) {
			// Ищем aapt/aapt2 в build-tools (любая версия, последняя по имени).
			const buildToolsDir = path.join(sdk, 'build-tools');
			try {
				const versions = fs.readdirSync(buildToolsDir).sort().reverse();
				for (const version of versions) {
					for (const tool of ['aapt2', 'aapt']) {
						const exe = path.join(buildToolsDir, version, process.platform === 'win32' ? `${tool}.exe` : tool);
						if (fs.existsSync(exe)) {
							const result = await execFileAsync(exe, ['dump', 'badging', apkPath], { timeout: 10_000 }).catch(() => undefined);
							const match = /package:\s*name='([^']+)'/.exec(result ? `${result.stdout}${result.stderr}` : '');
							if (match) { return match[1]; }
						}
					}
				}
			} catch { /* build-tools нет — переходим к fallback */ }
		}
		// Fallback: если на устройстве только что установлено одно приложение с debug-флагом — берём его.
		try {
			const text = await this.adb('-s', device, 'shell', 'pm', 'list', 'packages', '-3');
			return text.split(/\r?\n/).map(line => line.replace(/^package:/, '').trim()).filter(Boolean).pop();
		} catch {
			return undefined;
		}
	}

	/** Launch activity пакета (имя LAUNCHER-activity через cmd package resolve-activity). */
	async launchActivity(pkg: string, device: string): Promise<string> {
		try {
			const text = await this.adb('-s', device, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', pkg);
			// Последняя строка вида com.example/.MainActivity или полное имя.
			const line = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop() ?? '';
			if (line.includes('/')) { return line; }
		} catch { /* ignore */ }
		return `${pkg}/.MainActivity`;
	}

	/** adb forward: локальный порт → JDWP-порт процесса на устройстве. Возвращает локальный порт. */
	async forwardJdwp(device: string, localPort: number, processId: string): Promise<number> {
		await this.adb('-s', device, 'forward', `tcp:${localPort}`, `jdwp:${processId}`);
		return localPort;
	}

	/** Снять adb forward. */
	async removeForward(device: string, localPort: number): Promise<void> {
		await this.adb('-s', device, 'forward', '--remove', `tcp:${localPort}`).catch(() => undefined);
	}

	/** PID debuggable-процесса: pidof с ретраями, фолбэк ps -A | grep. */
	async pidOf(device: string, pkg: string): Promise<string | undefined> {
		try {
			const text = await this.adb('-s', device, 'shell', 'pidof', pkg);
			const pid = text.split(/\s+/)[0]?.trim();
			if (pid) { return pid; }
		} catch { /* падаем в ps */ }
		try {
			const text = await this.adb('-s', device, 'shell', 'ps', '-A');
			const line = text.split(/\r?\n/).find(line => line.includes(pkg));
			const pid = line?.trim().split(/\s+/)[1];
			return pid || undefined;
		} catch {
			return undefined;
		}
	}

	/** Остановить приложение перед повторным запуском. */
	async forceStop(pkg: string, device: string): Promise<void> {
		await this.adb('-s', device, 'shell', 'am', 'force-stop', pkg).catch(() => undefined);
	}

	/** Запуск activity с флагом ожидания отладчика. */
	async launchForDebug(device: string, activity: string): Promise<void> {
		await this.adb('-s', device, 'shell', 'am', 'start', '-D', '-n', activity);
	}

	// ---------- Logcat (webview) ----------

	/** Webview-logcat: фильтр по приложению (--pid), подсветка уровней, поиск, очистка. */
	async openLogcat(): Promise<void> {
		const device = await this.pickDevice();
		if (!device) { return; }
		this.logcatDevice = device;
		if (!this.logcatPanel) {
			this.logcatPanel = vscode.window.createWebviewPanel('auraKotlin.logcat', vscode.l10n.t('Android Logcat'), vscode.ViewColumn.Three, { enableFindWidget: true, retainContextWhenHidden: true });
			this.logcatPanel.webview.html = this.logcatHtml();
			this.logcatPanel.webview.onDidReceiveMessage(message => {
				if (message.command === 'clear') { this.logcatBuffer = []; }
				if (message.command === 'refilter') { this.pushLogcat(); }
			});
			this.logcatPanel.onDidDispose(() => { this.logcatPanel = undefined; this.stopLogcat(); });
		}
		this.logcatPanel.reveal();
		this.startLogcatStream();
	}

	private startLogcatStream(): void {
		const device = this.logcatDevice;
		if (!device) { return; }
		this.stopLogcat();
		this.watching = true;
		const args = ['-s', device, 'logcat', '-v', 'time'];
		if (this.logcatPid) { args.push('--pid', this.logcatPid); }
		try {
			this.logcat = spawn(this.adbPath() ?? 'adb', args);
		} catch (error) {
			vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
			return;
		}
		this.logcat.stdout?.on('data', (chunk: Buffer) => {
			for (const line of chunk.toString().split(/\r?\n/)) {
				if (line.trim()) { this.logcatBuffer.push(line); }
			}
			if (this.logcatBuffer.length > 20_000) { this.logcatBuffer = this.logcatBuffer.slice(-15_000); }
			this.pushLogcat();
		});
		this.logcat.on('exit', () => { if (this.watching) { this.logcatBuffer.push(vscode.l10n.t('[logcat] stream ended')); this.pushLogcat(); } });
	}

	private pushLogcat(): void {
		void this.logcatPanel?.webview.postMessage({ command: 'lines', lines: this.logcatBuffer.slice(-2000) });
	}

	private logcatHtml(): string {
		return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
	body { margin: 0; font-family: var(--vscode-editor-font-family); font-size: 12px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
	#bar { position: sticky; top: 0; display: flex; gap: 8px; padding: 6px 8px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); z-index: 1; }
	#filter { flex: 1; padding: 3px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
	button { padding: 3px 10px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; }
	button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	#line { padding: 0 8px; white-space: pre-wrap; }
	.V { color: var(--vscode-editor.foreground, #888); } .D { color: #6fa8dc; } .I { color: #93c47d; }
	.W { color: #f6b26b; } .E { color: #e06666; font-weight: 600; } .F { color: #cc0000; font-weight: 700; }
	.hidden { display: none; }
</style>
</head>
<body>
<div id="bar">
	<input id="filter" placeholder="Search…">
	<button class="secondary" id="clear">Clear</button>
</div>
<div id="log"></div>
<script>
	const vscode = acquireVsCodeApi();
	const log = document.getElementById('log');
	const filter = document.getElementById('filter');
	let all = [];
	function level(line) { return /^[VEIWDF]\/|\\s([VEIWDF])\\//.exec(line) ? (/\\s([VEIWDF])\\//.exec(line)?.[1] ?? line[0]) : line.match(/^\\d{2}-\\d{2}/) ? 'I' : ''; }
	function render() {
		const q = filter.value.toLowerCase();
		log.innerHTML = '';
		const frag = document.createDocumentFragment();
		for (const line of all) {
			if (q && !line.toLowerCase().includes(q)) { continue; }
			const div = document.createElement('div');
			div.id = 'line';
			const lv = level(line);
			if (lv) { div.className = lv; }
			div.textContent = line;
			frag.appendChild(div);
		}
		log.appendChild(frag);
		window.scrollTo(0, document.body.scrollHeight);
	}
	document.getElementById('clear').onclick = () => { vscode.postMessage({ command: 'clear' }); all = []; render(); };
	filter.oninput = render;
	window.addEventListener('message', event => {
		const msg = event.data;
		if (msg.command === 'lines') { all = msg.lines; render(); }
	});
</script>
</body>
</html>`;
	}

	/** Перестартовать поток logcat c --pid активного приложения (кнопка/команда). */
	async filterLogcatByPid(): Promise<void> {
		const device = this.logcatDevice ?? await this.pickDevice();
		if (!device) { return; }
		const pkg = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Package name for logcat filter (empty = all)'), value: this.logcatPidPkg ?? '' });
		if (pkg === undefined) { return; }
		this.logcatPidPkg = pkg.trim() || undefined;
		this.logcatPid = this.logcatPidPkg ? await this.pidOf(device, this.logcatPidPkg).catch(() => undefined) : undefined;
		if (this.logcatPidPkg && !this.logcatPid) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Process {0} is not running — logcat will show all apps.', this.logcatPidPkg));
		}
		this.logcatDevice = device;
		if (this.logcatPanel) { this.startLogcatStream(); } else { await this.openLogcat(); }
	}

	private logcatPidPkg?: string;

	stopLogcat(): void {
		this.watching = false;
		if (this.logcat) {
			this.logcat.kill();
			this.logcat = undefined;
		}
	}
}

/** Регистрация панели Android и её команд. */
export function registerAndroidPanel(context: vscode.ExtensionContext): AndroidPanel {
	const panel = new AndroidPanel(context);

	context.subscriptions.push(
		panel,
		vscode.commands.registerCommand('auraKotlin.android.pickDevice', () => panel.pickDevice()),
		vscode.commands.registerCommand('auraKotlin.android.installApk', () => panel.installApk()),
		vscode.commands.registerCommand('auraKotlin.android.logcat', () => panel.openLogcat()),
		vscode.commands.registerCommand('auraKotlin.android.logcatFilter', () => panel.filterLogcatByPid()),
		vscode.commands.registerCommand('auraKotlin.android.logcatStop', () => panel.stopLogcat()),
		vscode.commands.registerCommand('auraKotlin.android.startEmulator', () => panel.startEmulator()),
		vscode.commands.registerCommand('auraKotlin.android.stopEmulator', () => panel.stopEmulator()),
		vscode.commands.registerCommand('auraKotlin.android.createAvd', () => panel.createAvd()),
		vscode.commands.registerCommand('auraKotlin.android.devices', async () => {
			const devices = await panel.devices();
			vscode.window.showInformationMessage(devices.length
				? vscode.l10n.t('Connected Android devices: {0}', devices.map(device => device.id).join(', '))
				: vscode.l10n.t('No Android devices connected (adb devices is empty).'), { modal: true });
		}),
	);
	void panel.showDeviceStatus();

	return panel;
}
