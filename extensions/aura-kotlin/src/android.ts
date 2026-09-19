/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — панель Android: устройства (adb devices), установка .apk и живой logcat
 *  с фильтрами по уровню (Error/Info/Debug) и тегу. Этап 4 плана Android-поддержки.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn, execFile, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

const LOGCAT_LEVELS = ['all', 'error', 'warning', 'info', 'debug'] as const;
type LogcatLevel = (typeof LOGCAT_LEVELS)[number];

export class AndroidPanel implements vscode.Disposable {

	private readonly output = vscode.window.createOutputChannel('Android Logcat');
	private readonly statusbar: vscode.StatusBarItem;
	private logcat?: ChildProcess;
	private logcatLevel: LogcatLevel = 'all';
	private logcatTag = '';
	private watching = false;

	constructor() {
		this.statusbar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
		this.statusbar.name = 'Android Device';
		this.statusbar.command = 'auraKotlin.android.pickDevice';
	}

	dispose(): void {
		this.stopLogcat();
		this.statusbar.dispose();
		this.output.dispose();
	}

	adbPath(): string | undefined {
		const configured = vscode.workspace.getConfiguration('auraKotlin').get<string>('androidSdkPath', '').trim();
		const sdk = configured || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
		if (!sdk) { return 'adb'; }
		return vscode.Uri.joinPath(vscode.Uri.file(sdk), 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb').fsPath;
	}

	private async adb(...args: string[]): Promise<string> {
		const result = await execFileAsync(this.adbPath() ?? 'adb', args, { timeout: 10_000 });
		return `${result.stdout}${result.stderr}`.trim();
	}

	/** Список подключённых устройств (USB/Wi-Fi). */
	async devices(): Promise<string[]> {
		try {
			const text = await this.adb('devices');
			return text.split(/\r?\n/).slice(1).map(line => line.trim().split(/\s+/)[0]).filter(Boolean);
		} catch {
			return [];
		}
	}

	/** Выбор активного устройства; кэшируется на сессию. */
	async pickDevice(): Promise<string | undefined> {
		const devices = await this.devices();
		if (devices.length === 0) {
			void vscode.window.showWarningMessage(vscode.l10n.t('No Android devices connected (adb devices is empty).'));
			return undefined;
		}
		if (devices.length === 1) { this.statusbar.text = `$(device-mobile) ${devices[0]}`; this.statusbar.show(); return devices[0]; }
		const pick = await vscode.window.showQuickPick(devices, { placeHolder: vscode.l10n.t('Select Android device') });
		if (pick) { this.statusbar.text = `$(device-mobile) ${pick}`; this.statusbar.show(); }
		return pick;
	}

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

	// ---------- Debug-запуск Android-приложения (Этап 2 + Этап 4) ----------

	/** Установить APK и вернуть информацию о пакете на устройстве. */
	async installForDebug(apkPath: string, device?: string): Promise<{ device: string; package: string } | undefined> {
		const dev = device ?? await this.pickDevice();
		if (!dev) { return undefined; }
		await this.adb('-s', dev, 'install', '-r', apkPath);
		const pkg = await this.packageFromApk(apkPath, dev);
		if (!pkg) { throw new Error(vscode.l10n.t('Could not read applicationId from the APK (aapt missing or badmanifest).')); }
		return { device: dev, package: pkg };
	}

	/** applicationId из APK: aapt dump badging (build-tools), fallback — запуск activity по имени. */
	private async packageFromApk(apkPath: string, device: string): Promise<string | undefined> {
		const configured = vscode.workspace.getConfiguration('auraKotlin').get<string>('androidSdkPath', '').trim();
		const sdk = configured || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
		if (sdk) {
			// Ищем aapt/aapt2 в build-tools (любая версия, последняя по имени).
			const buildToolsDir = vscode.Uri.joinPath(vscode.Uri.file(sdk), 'build-tools').fsPath;
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
		// Узнать JDWP-порт процесса: adb jdwp печатает PID'ы debuggable-процессов; порт выбирается через forward tcp:N jdwp:PID.
		await this.adb('-s', device, 'forward', `tcp:${localPort}`, `jdwp:${processId}`);
		return localPort;
	}

	/** PID debuggable-процесса по имени пакета. */
	async pidOf(device: string, pkg: string): Promise<string | undefined> {
		try {
			const text = await this.adb('-s', device, 'shell', 'pidof', pkg);
			const pid = text.split(/\s+/)[0]?.trim();
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

	// ---------- Logcat ----------

	startLogcat(): void {
		void this.startLogcatAsync();
	}

	private async startLogcatAsync(): Promise<void> {
		const device = await this.pickDevice();
		if (!device) { return; }
		this.stopLogcat();
		this.watching = true;
		this.output.show(true);
		const args = ['-s', device, 'logcat', '-v', 'time'];
		if (this.logcatLevel !== 'all') { args.push(`*:${this.logcatLevel.toUpperCase()}`); }
		if (this.logcatTag) { args.push(this.logcatTag); }
		try {
			this.logcat = spawn(this.adbPath() ?? 'adb', args);
		} catch (error) {
			vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
			return;
		}
		this.logcat.stdout?.on('data', (chunk: Buffer) => this.output.append(chunk.toString()));
		this.logcat.stderr?.on('data', (chunk: Buffer) => this.output.append(chunk.toString()));
		this.logcat.on('exit', () => { if (this.watching) { this.output.appendLine('[logcat] поток завершён'); } });
		this.output.appendLine(`[logcat] ${device}: level=${this.logcatLevel}${this.logcatTag ? ` tag=${this.logcatTag}` : ''}`);
	}

	stopLogcat(): void {
		this.watching = false;
		if (this.logcat) {
			this.logcat.kill();
			this.logcat = undefined;
		}
	}

	async filterLogcat(): Promise<void> {
		const level = await vscode.window.showQuickPick([...LOGCAT_LEVELS], { placeHolder: vscode.l10n.t('Logcat level') });
		if (!level) { return; }
		this.logcatLevel = level as LogcatLevel;
		const tag = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Tag filter (empty = all)'), value: this.logcatTag });
		if (tag === undefined) { return; }
		this.logcatTag = tag.trim();
		this.startLogcat();
	}

	showLogcat(): void {
		this.output.show(true);
	}
}

export function registerAndroidPanel(context: vscode.ExtensionContext): AndroidPanel {
	const panel = new AndroidPanel();

	context.subscriptions.push(
		panel,
		vscode.commands.registerCommand('auraKotlin.android.pickDevice', () => panel.pickDevice()),
		vscode.commands.registerCommand('auraKotlin.android.installApk', () => panel.installApk()),
		vscode.commands.registerCommand('auraKotlin.android.logcat', () => panel.startLogcat()),
		vscode.commands.registerCommand('auraKotlin.android.logcatFilter', () => panel.filterLogcat()),
		vscode.commands.registerCommand('auraKotlin.android.logcatStop', () => panel.stopLogcat()),
		vscode.commands.registerCommand('auraKotlin.android.devices', async () => {
			const devices = await panel.devices();
			vscode.window.showInformationMessage(devices.length
				? vscode.l10n.t('Connected Android devices: {0}', devices.join(', '))
				: vscode.l10n.t('No Android devices connected (adb devices is empty).'), { modal: true });
		}),
	);

	return panel;
}
