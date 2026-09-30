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
import { tr } from './l10n';
import { AvdCreateForm } from './avdForm';
import { spawn, execFile, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execTool } from './gradle';

const execFileAsync = promisify(execFile);

export interface AndroidDevice {
	id: string;
	/** Эмулятор (avd) или физическое устройство. */
	emulator: boolean;
	model: string;
}

export class AndroidPanel implements vscode.Disposable {

	private readonly output = vscode.window.createOutputChannel('Android Logcat');
	/** Лог самого эмулятора: без него падение запуска выглядит как «не загрузился за 120 секунд». */
	private readonly emulatorOutput = vscode.window.createOutputChannel('Android Emulator');
	private readonly statusbar: vscode.StatusBarItem;
	private logcat?: ChildProcess;
	private logcatDevice?: string;
	private logcatPid?: string;
	/** Слежение за PID: приложение перезапускается при каждой сборке — поток logcat нужно перецепить. */
	private logcatWatch?: NodeJS.Timeout;
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
		this.emulatorOutput.dispose();
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
			tr('Android SDK not found. Set auraKotlin.androidSdkPath, ANDROID_HOME or install the SDK.'),
			tr('Specify path'),
		);
		if (pick) {
			const folder = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectMany: false, openLabel: tr('Android SDK folder') }))?.[0];
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
			void vscode.window.showWarningMessage(tr('No Android devices connected (adb devices is empty). Start an emulator or plug in a device.'));
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
		})), { placeHolder: tr('Select Android device') });
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
		this.statusbar.tooltip = tr('Selected Android device: {0} ({1})', device.id, device.model);
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
			void vscode.window.showWarningMessage(tr('No AVDs found. Create one in Android Studio or via avdmanager.'));
			return undefined;
		}
		const avd = avds.length === 1 ? avds[0] : await vscode.window.showQuickPick(avds, { placeHolder: tr('Start Android emulator') });
		if (!avd) { return undefined; }
		await this.startAvd(avd);
		return avd;
	}

	/** Серийные номера запущенных эмуляторов (emulator-5554…). */
	private async emulatorSerials(): Promise<string[]> {
		return (await this.devices()).filter(device => device.emulator).map(device => device.id);
	}

	/**
	 * Ждём появления нового серийника эмулятора в `adb devices`.
	 * Нужен, чтобы следить именно за запущенным эмулятором: без `-s` adb отвечает от первого
	 * подключённого устройства (подключённый телефон делал эмулятор «мгновенно загруженным»,
	 * а при двух устройствах команда просто падала).
	 */
	private async waitForEmulatorSerial(before: string[], hasExited: () => number | undefined, timeoutMs: number): Promise<string | undefined> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (hasExited() !== undefined) { return undefined; }
			const fresh = (await this.emulatorSerials()).find(id => !before.includes(id));
			if (fresh) { return fresh; }
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
		return undefined;
	}

	/** Ожидание sys.boot_completed=1 именно на указанном устройстве. */
	private async waitForBoot(device: string, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const out = await this.adb('-s', device, 'shell', 'getprop', 'sys.boot_completed').catch(() => '');
			if (out.trim() === '1') { return true; }
			await new Promise(resolve => setTimeout(resolve, 1500));
		}
		return false;
	}

	/**
	 * Остановить эмулятор: конкретный AVD (target с полем name) или все сразу.
	 * Раньше команда всегда гасила все запущенные эмуляторы, даже нажатая у одного AVD.
	 */
	async stopEmulator(target?: { name?: string } | string): Promise<void> {
		const avd = typeof target === 'string' ? target : target?.name;
		if (avd) {
			const serial = (await this.runningAvds()).get(avd);
			if (!serial) {
				void vscode.window.showInformationMessage(tr('Emulator {0} is not running.', avd));
				return;
			}
			await this.adb('-s', serial, 'emu', 'kill').catch(() => undefined);
			if (this.selectedDevice === serial) { this.selectedDevice = undefined; this.statusbar.hide(); }
			void vscode.window.showInformationMessage(tr('Emulator {0} stopped.', avd));
			return;
		}
		const devices = (await this.devices()).filter(device => device.emulator);
		if (!devices.length) { return; }
		for (const device of devices) {
			await this.adb('-s', device.id, 'emu', 'kill').catch(() => undefined);
		}
		this.statusbar.hide();
		void vscode.window.showInformationMessage(tr('Emulators stopped.'));
	}

	/** Имена запущенных эмуляторов: AVD name → device id (через emu avd name). */
	async runningAvds(): Promise<Map<string, string>> {
		const map = new Map<string, string>();
		for (const device of (await this.devices()).filter(d => d.emulator)) {
			try {
				const text = await this.adb('-s', device.id, 'emu', 'avd', 'name');
				const name = text.split(/\r?\n/)[0]?.trim();
				if (name && name !== 'OK') { map.set(name, device.id); }
			} catch { /* старый эмулятор без emu avd name */ }
		}
		return map;
	}

	/** Запуск конкретного AVD по имени: появление серийника → готовность sys.boot_completed. */
	async startAvd(avd: string): Promise<void> {
		const sdk = await this.ensureSdk();
		if (!sdk) { return; }
		const emulator = path.join(sdk, 'emulator', process.platform === 'win32' ? 'emulator.exe' : 'emulator');
		const alreadyRunning = (await this.runningAvds()).get(avd);
		const before = await this.emulatorSerials();
		let exited: number | undefined;
		let log = '';
		if (!alreadyRunning) {
			// stdout/stderr эмулятора собираем: без них провал запуска (нет системного образа,
			// нет аппаратного ускорения, занят порт) выглядел как «не загрузился за 120 секунд».
			const child = spawn(emulator, ['-avd', avd], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
			child.unref();
			const collect = (chunk: Buffer) => { log = (log + chunk.toString()).slice(-4000); };
			child.stdout?.on('data', collect);
			child.stderr?.on('data', collect);
			// На Windows emulator.exe часто отдаёт управление qemu-system-* и завершается с кодом 0 —
			// это не провал запуска, поэтому фатальным считаем только ненулевой код.
			child.on('exit', code => { if (code) { exited = code; } });
		}
		const serial = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: tr('Waiting for emulator {0} to boot…', avd), cancellable: false },
			async () => {
				const found = alreadyRunning ?? await this.waitForEmulatorSerial(before, () => exited, 90_000);
				if (!found) { return undefined; }
				return await this.waitForBoot(found, 180_000) ? found : undefined;
			},
		);
		if (serial) {
			// Запущенный эмулятор сразу становится выбранным устройством: без этого
			// pickDevice() при нескольких устройствах каждый раз спрашивал заново.
			this.selectedDevice = serial;
			this.updateDeviceStatus({ id: serial, emulator: true, model: avd });
			void vscode.window.showInformationMessage(tr('Emulator {0} is ready.', avd));
			return;
		}
		if (log.trim()) {
			this.emulatorOutput.appendLine(`--- emulator -avd ${avd} ---`);
			this.emulatorOutput.appendLine(log.trim());
			this.emulatorOutput.show(true);
		}
		void vscode.window.showWarningMessage(exited !== undefined
			? tr('Emulator {0} exited during startup (code {1}). See the “Android Emulator” output for the reason.', avd, String(exited))
			: tr('Emulator {0} did not finish booting in time (it may still come up).', avd));
	}

	private sdkTool(sdk: string, tool: 'avdmanager' | 'sdkmanager'): string {
		return path.join(sdk, 'cmdline-tools', 'latest', 'bin', process.platform === 'win32' ? `${tool}.bat` : tool);
	}

	/** Профили устройств из avdmanager list device (Pixel 6, Pixel Tablet…); статичный фолбэк. */
	async listDeviceProfiles(avdmanager: string): Promise<{ id: string; name: string }[]> {
		try {
			const { stdout } = await execTool(avdmanager, ['list', 'device'], { timeout: 30_000 });
			const profiles: { id: string; name: string }[] = [];
			const re = /id:\s*\d+\s+or\s+"([^"]+)"[\s\S]*?Name:\s*(.+)/g;
			let match: RegExpExecArray | null;
			while ((match = re.exec(stdout)) !== null) {
				profiles.push({ id: match[1], name: match[2].trim() });
			}
			if (profiles.length) { return profiles; }
		} catch { /* avdmanager недоступен — фолбэк ниже */ }
		return [
			{ id: 'pixel_8', name: 'Pixel 8' },
			{ id: 'pixel_7', name: 'Pixel 7' },
			{ id: 'pixel_6', name: 'Pixel 6' },
			{ id: 'pixel_fold', name: 'Pixel Fold' },
			{ id: 'pixel_tablet', name: 'Pixel Tablet' },
			{ id: 'medium_phone', name: 'Medium Phone (Generic)' },
			{ id: 'small_phone', name: 'Small Phone (Generic)' },
		];
	}

	/** Установленные системные образы (sdkmanager --list_installed). */
	async listSystemImages(sdkmanager: string): Promise<string[]> {
		try {
			const { stdout, stderr } = await execTool(sdkmanager, ['--list_installed'], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
			return `${stdout}${stderr}`.split(/\r?\n/)
				.map(line => line.trim().split(/\s+/)[0])
				.filter(cell => cell?.startsWith('system-images;'));
		} catch {
			return [];
		}
	}

	/** Установка образа через sdkmanager с авто-подтверждением лицензий. */
	async installSystemImage(sdkmanager: string, image: string): Promise<boolean> {
		return vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: tr('Downloading system image {0}…', image), cancellable: false },
			() => new Promise<boolean>(resolve => {
				const child = spawn(sdkmanager, [image], { shell: process.platform === 'win32' });
				// Лицензии sdkmanager спрашивает интерактивно — отвечаем "y" заранее и по таймеру.
				const answer = setInterval(() => child.stdin?.write('y\n'), 1000);
				child.stdin?.write('y\n');
				child.on('exit', code => { clearInterval(answer); resolve(code === 0); });
				child.on('error', () => { clearInterval(answer); resolve(false); });
			}),
		);
	}

	/** Пути к SDK-инструментам для формы создания AVD (undefined — SDK не настроен). */
	async avdTools(): Promise<{ avdmanager: string; sdkmanager: string } | undefined> {
		const sdk = await this.ensureSdk();
		if (!sdk) { return undefined; }
		return { avdmanager: this.sdkTool(sdk, 'avdmanager'), sdkmanager: this.sdkTool(sdk, 'sdkmanager') };
	}

	/** Создать AVD по готовым параметрам из формы; ошибки летят наружу текстом. */
	async createAvdAdvanced(input: { name: string; image: string; profileId: string }): Promise<void> {
		const tools = await this.avdTools();
		if (!tools) { throw new Error(tr('Android SDK is not configured.')); }
		await execTool(tools.avdmanager, ['create', 'avd', '-n', input.name, '-k', input.image, '-d', input.profileId, '--force'], { timeout: 120_000 });
	}

	/** Мастер создания AVD: профиль телефона → системный образ (со скачиванием) → имя. */
	async createAvd(): Promise<void> {
		const sdk = await this.ensureSdk();
		if (!sdk) { return; }
		const avdmanager = this.sdkTool(sdk, 'avdmanager');
		const sdkmanager = this.sdkTool(sdk, 'sdkmanager');

		const profiles = await this.listDeviceProfiles(avdmanager);
		const profile = await vscode.window.showQuickPick(
			profiles.map(p => ({ label: p.name, description: p.id, id: p.id })),
			{ placeHolder: tr('Device profile (phone model)') });
		if (!profile) { return; }

		const installed = await this.listSystemImages(sdkmanager);
		const downloadLabel = `$(cloud-download) ${tr('Download new system image…')}`;
		const imagePick = await vscode.window.showQuickPick(
			[...installed.map(image => ({ label: image, id: image })), { label: downloadLabel, id: '' }],
			{ placeHolder: tr('System image (installed)') });
		if (!imagePick) { return; }

		let image = imagePick.id;
		if (!image) {
			const api = await vscode.window.showInputBox({ prompt: tr('API level to download (e.g. 35)'), value: '35', validateInput: v => /^\d{2}$/.test(v.trim()) ? undefined : tr('Two digits, e.g. 35') });
			if (!api) { return; }
			const arch = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
			image = `system-images;android-${api.trim()};google_apis;${arch}`;
			if (!await this.installSystemImage(sdkmanager, image)) {
				vscode.window.showErrorMessage(tr('Failed to download {0}. Run sdkmanager manually and accept licenses.', image));
				return;
			}
		}

		const apiMatch = /android-(\d+)/.exec(image)?.[1] ?? '';
		const name = await vscode.window.showInputBox({
			prompt: tr('AVD name'),
			value: `${profile.id}${apiMatch ? `_api_${apiMatch}` : ''}`,
			validateInput: v => /^[\w.-]+$/.test(v.trim()) ? undefined : tr('Only letters, digits, dot, dash and underscore'),
		});
		if (!name) { return; }

		try {
			await execTool(avdmanager, ['create', 'avd', '-n', name.trim(), '-k', image, '-d', profile.id, '--force'], { timeout: 120_000 });
			const start = tr('Start now');
			if (await vscode.window.showInformationMessage(tr('AVD {0} created.', name.trim()), start) === start) {
				await this.startAvd(name.trim());
			}
		} catch (error) {
			vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
		}
	}

	// ---------- Экран устройства (встроенный «эмулятор») ----------

	/** Скриншот экрана (PNG-буфер) через adb exec-out screencap. */
	async captureScreen(device: string): Promise<Buffer> {
		const result = await (promisify(execFile) as unknown as (cmd: string, args: string[], opts: object) => Promise<{ stdout: Buffer }>)(
			this.adbPath() ?? 'adb', ['-s', device, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 15_000 });
		return result.stdout;
	}

	/** Разрешение экрана устройства (wm size). */
	async screenSize(device: string): Promise<{ width: number; height: number } | undefined> {
		try {
			const text = await this.adb('-s', device, 'shell', 'wm', 'size');
			const match = /(\d+)x(\d+)/.exec(text);
			if (match) { return { width: Number(match[1]), height: Number(match[2]) }; }
		} catch { /* устройство недоступно */ }
		return undefined;
	}

	async inputTap(device: string, x: number, y: number): Promise<void> {
		await this.adb('-s', device, 'shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y)));
	}

	async inputSwipe(device: string, x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
		await this.adb('-s', device, 'shell', 'input', 'swipe', String(Math.round(x1)), String(Math.round(y1)), String(Math.round(x2)), String(Math.round(y2)), String(Math.round(durationMs)));
	}

	/** keyevent: back=4, home=3, recents=187, power=26, volUp=24, volDown=25. */
	async inputKey(device: string, keycode: number): Promise<void> {
		await this.adb('-s', device, 'shell', 'input', 'keyevent', String(keycode));
	}

	async inputText(device: string, text: string): Promise<void> {
		const escaped = text.replace(/ /g, '%s').replace(/(['"\\$&|;<>()])/g, '\\$1');
		await this.adb('-s', device, 'shell', 'input', 'text', escaped);
	}

	/** Поворот экрана: автоповорот выключается, user_rotation крутится по кругу 0→3. */
	async rotateScreen(device: string): Promise<void> {
		const current = await this.adb('-s', device, 'shell', 'settings', 'get', 'system', 'user_rotation').catch(() => '0');
		const next = ((parseInt(current.trim(), 10) || 0) + 1) % 4;
		await this.adb('-s', device, 'shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
		await this.adb('-s', device, 'shell', 'settings', 'put', 'system', 'user_rotation', String(next));
	}

	// ---------- Установка / запуск / отладка ----------

	/** Установка .apk на активное устройство. */
	async installApk(): Promise<void> {
		const file = (await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, filters: { 'Android package': ['apk'] } }))?.[0];
		if (!file) { return; }
		const device = await this.pickDevice();
		if (!device) { return; }
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: tr('Installing {0}…', file.fsPath.split(/[\\/]/).pop() ?? 'apk') }, async () => {
			try {
				const text = await this.adb('-s', device, 'install', '-r', file.fsPath);
				vscode.window.showInformationMessage(text.includes('Success') ? tr('APK installed on {0}.', device) : text);
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
		if (!pkg) { throw new Error(tr('Could not read applicationId from the APK (aapt missing or bad manifest).')); }
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

	/**
	 * Webview-logcat: фильтр по приложению (--pid), фильтр по уровню, поиск, автопрокрутка
	 * с возможностью читать историю, очистка. В webview уходят ТОЛЬКО новые строки: раньше
	 * на каждый чанк adb пересылались последние 2000 строк целиком, и панель тормозила.
	 */
	async openLogcat(): Promise<void> {
		const device = await this.pickDevice();
		if (!device) { return; }
		if (this.logcatDevice && this.logcatDevice !== device) { this.logcatBuffer = []; }
		this.logcatDevice = device;
		if (!this.logcatPanel) {
			this.logcatPanel = vscode.window.createWebviewPanel('auraKotlin.logcat', tr('Android Logcat'), vscode.ViewColumn.Three, { enableFindWidget: true, retainContextWhenHidden: true });
			this.logcatPanel.webview.html = this.logcatHtml();
			this.logcatPanel.webview.onDidReceiveMessage(message => {
				if (message.command === 'clear') {
					this.logcatBuffer = [];
					void this.logcatPanel?.webview.postMessage({ command: 'reset' });
				}
			});
			this.logcatPanel.onDidDispose(() => { this.logcatPanel = undefined; this.stopLogcat(); });
		}
		this.logcatPanel.reveal();
		this.startLogcatStream();
		this.pushLogcatBuffer();
	}

	private startLogcatStream(): void {
		const device = this.logcatDevice;
		if (!device) { return; }
		// Предыдущий поток гасим всегда: иначе при переходе на фильтр по приложению,
		// которое ещё не запущено, старый поток продолжал лить логи всех приложений.
		this.stopLogcat();
		this.watching = true;
		// Пакет выбран, но ещё не запущен: ждём PID, а не льём в панель логи всех приложений.
		if (this.logcatPidPkg && !this.logcatPid) {
			this.ensurePidWatch(device);
			return;
		}
		const args = ['-s', device, 'logcat', '-v', 'time'];
		if (this.logcatPid) { args.push('--pid', this.logcatPid); }
		let child: ChildProcess;
		try {
			child = spawn(this.adbPath() ?? 'adb', args);
		} catch (error) {
			vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
			return;
		}
		this.logcat = child;
		// Данные и выход старого процесса после kill() ещё какое-то время приходят: без этой
		// проверки в панель попадали строки уже заменённого потока и чужих приложений.
		const isCurrent = () => this.watching && this.logcat === child;
		child.stdout?.on('data', (chunk: Buffer) => {
			if (!isCurrent()) { return; }
			const fresh = chunk.toString().split(/\r?\n/).filter(line => line.trim());
			if (!fresh.length) { return; }
			this.logcatBuffer.push(...fresh);
			if (this.logcatBuffer.length > 20_000) { this.logcatBuffer = this.logcatBuffer.slice(-15_000); }
			void this.logcatPanel?.webview.postMessage({ command: 'append', lines: fresh });
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			const text = chunk.toString().trim();
			if (text) { this.output.appendLine(`[logcat] ${text}`); }
		});
		child.on('exit', () => {
			if (!isCurrent()) { return; }
			const line = tr('[logcat] stream ended');
			this.logcatBuffer.push(line);
			void this.logcatPanel?.webview.postMessage({ command: 'append', lines: [line] });
		});
		this.ensurePidWatch(device);
	}

	/**
	 * Слежение за PID выбранного приложения. Приложение перезапускается при каждой сборке —
	 * PID меняется, и поток с `--pid` замолкал навсегда. Заодно это ловит запуск приложения
	 * после выбора фильтра: поток подхватывается, как только процесс появился.
	 */
	private ensurePidWatch(device: string): void {
		if (this.logcatWatch) { clearInterval(this.logcatWatch); this.logcatWatch = undefined; }
		const pkg = this.logcatPidPkg;
		if (!pkg) { return; }
		this.logcatWatch = setInterval(async () => {
			const pid = await this.pidOf(device, pkg).catch(() => undefined);
			if (!pid || pid === this.logcatPid) { return; }
			this.logcatPid = pid;
			this.output.appendLine(`[logcat] ${pkg}: pid ${pid}`);
			this.startLogcatStream();
		}, 3000);
	}

	/** Полная пересылка буфера: панель открылась заново или сменилось устройство. */
	private pushLogcatBuffer(): void {
		void this.logcatPanel?.webview.postMessage({ command: 'reset' });
		const lines = this.logcatBuffer.slice(-5000);
		if (lines.length) { void this.logcatPanel?.webview.postMessage({ command: 'append', lines }); }
	}

	/** Установленные сторонние пакеты (pm list packages -3) — список для фильтра logcat. */
	private async thirdPartyPackages(device: string): Promise<string[]> {
		try {
			const text = await this.adb('-s', device, 'shell', 'pm', 'list', 'packages', '-3');
			return text.split(/\r?\n/).map(line => line.replace(/^package:/, '').trim()).filter(Boolean).sort();
		} catch {
			return [];
		}
	}

	/** Фильтр по приложению: выбор из установленных пакетов вместо ручного ввода имени. */
	async filterLogcatByPid(): Promise<void> {
		const device = this.logcatDevice ?? await this.pickDevice();
		if (!device) { return; }
		const packages = await this.thirdPartyPackages(device);
		const pick = await vscode.window.showQuickPick(
			[
				{ label: tr('All applications'), id: '' },
				...packages.map(pkg => ({ label: pkg, id: pkg })),
			],
			{ placeHolder: tr('Logcat filter: application') },
		);
		if (!pick) { return; }
		this.logcatDevice = device;
		this.logcatPidPkg = pick.id || undefined;
		this.logcatPid = this.logcatPidPkg ? await this.pidOf(device, this.logcatPidPkg).catch(() => undefined) : undefined;
		if (this.logcatPidPkg && !this.logcatPid) {
			void vscode.window.showInformationMessage(tr('{0} is not running yet — logcat will attach as soon as it starts.', this.logcatPidPkg));
		}
		this.logcatBuffer = [];
		if (this.logcatPanel) {
			this.startLogcatStream();
			this.pushLogcatBuffer();
		} else {
			await this.openLogcat();
		}
	}

	/** Перецепить открытый logcat на приложение (вызывается после запуска по F5). */
	async attachLogcatTo(device: string, pkg: string): Promise<void> {
		if (!this.logcatPanel) { return; }
		this.logcatDevice = device;
		this.logcatPidPkg = pkg;
		this.logcatPid = await this.pidOf(device, pkg).catch(() => undefined);
		this.logcatBuffer = [];
		this.startLogcatStream();
		this.pushLogcatBuffer();
	}

	private logcatPidPkg?: string;

	stopLogcat(): void {
		this.watching = false;
		if (this.logcatWatch) { clearInterval(this.logcatWatch); this.logcatWatch = undefined; }
		if (this.logcat) {
			this.logcat.kill();
			this.logcat = undefined;
		}
	}

	private logcatHtml(): string {
		const t = (en: string) => tr(en);
		return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<style>
	body { margin: 0; font-family: var(--vscode-editor-font-family); font-size: 12px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
	#bar { position: sticky; top: 0; display: flex; gap: 6px; align-items: center; padding: 6px 8px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); z-index: 1; flex-wrap: wrap; }
	#device { color: var(--vscode-descriptionForeground); }
	.levels { display: flex; gap: 2px; }
	.levels button { min-width: 26px; padding: 2px 6px; background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 11px; }
	.levels button[aria-pressed="true"] { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
	#filter { flex: 1; min-width: 120px; padding: 3px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; font-family: inherit; }
	label { display: flex; align-items: center; gap: 4px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
	#count { font-variant-numeric: tabular-nums; }
	button.secondary { padding: 3px 10px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 4px; cursor: pointer; font-family: inherit; }
	button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
	#log { padding: 2px 0 12px; }
	.ln { display: grid; grid-template-columns: max-content max-content max-content minmax(0, 1fr); gap: 8px; padding: 1px 8px; }
	.ln .time { color: var(--vscode-descriptionForeground); }
	.ln .lv { font-weight: 600; }
	.ln .tag { color: var(--vscode-descriptionForeground); max-width: 22ch; overflow: hidden; text-overflow: ellipsis; }
	.ln .msg { white-space: pre-wrap; word-break: break-word; }
	.ln.raw .msg { grid-column: 1 / -1; color: var(--vscode-descriptionForeground); }
	.V .lv { color: var(--vscode-disabledForeground); }
	.D .lv { color: var(--vscode-charts-blue); }
	.I .lv { color: var(--vscode-charts-green); }
	.W .lv { color: var(--vscode-editorWarning-foreground); }
	.E .lv { color: var(--vscode-editorError-foreground); }
	.F .lv { color: var(--vscode-errorForeground); font-weight: 700; }
</style>
</head>
<body>
<div id="bar">
	<span id="device">${t('Device')}: ${this.logcatDevice ?? ''}${this.logcatPidPkg ? ` · ${this.logcatPidPkg}` : ''}</span>
	<div class="levels" role="group" aria-label="${t('Level')}">
		<button data-level="A" aria-pressed="true" title="${t('All levels')}">${t('All')}</button>
		<button data-level="V" aria-pressed="false" title="Verbose">V</button>
		<button data-level="D" aria-pressed="false" title="Debug">D</button>
		<button data-level="I" aria-pressed="false" title="Info">I</button>
		<button data-level="W" aria-pressed="false" title="Warning">W</button>
		<button data-level="E" aria-pressed="false" title="Error">E</button>
		<button data-level="F" aria-pressed="false" title="Fatal">F</button>
	</div>
	<input id="filter" placeholder="${t('Filter by text or tag…')}" aria-label="${t('Filter by text or tag…')}">
	<label><input type="checkbox" id="follow" checked> ${t('Auto-scroll')}</label>
	<label>${t('Lines')} <span id="count">0</span></label>
	<button class="secondary" id="clear" title="${t('Clear')}">${t('Clear')}</button>
</div>
<div id="log"></div>
<script>
	const vscode = acquireVsCodeApi();
	const log = document.getElementById('log');
	const filterEl = document.getElementById('filter');
	const countEl = document.getElementById('count');
	const followEl = document.getElementById('follow');
	const MAX_ROWS = 5000;
	// Формат вывода «logcat -v time»: 09-22 17:43:15.123  1234  1250 I Tag     : message
	const RE = /^(?:\d{2}-\d{2}\s+)?(\d{2}:\d{2}:\d{2}\.\d{3})\s+\d+\s+\d+\s+([VDIWEF])\s+([^:]*):\s?([\s\S]*)$/;
	const RANK = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5 };
	const state = { level: 'A', text: '', rows: [] };

	function parse(line) {
		const m = RE.exec(line);
		if (!m) { return { raw: line, time: '', level: '', tag: '', msg: line }; }
		return { raw: line, time: m[1], level: m[2], tag: m[3].trim(), msg: m[4] };
	}

	function matches(row) {
		if (state.level !== 'A' && (!row.level || RANK[row.level] < RANK[state.level])) { return false; }
		return !state.text || row.raw.toLowerCase().indexOf(state.text) !== -1;
	}

	function rowNode(row) {
		const div = document.createElement('div');
		div.className = 'ln' + (row.level ? ' ' + row.level : ' raw');
		if (!row.level) {
			const span = document.createElement('span');
			span.className = 'msg';
			span.textContent = row.raw;
			div.appendChild(span);
			return div;
		}
		for (const pair of [['time', row.time], ['lv', row.level], ['tag', row.tag], ['msg', row.msg]]) {
			const span = document.createElement('span');
			span.className = pair[0];
			span.textContent = pair[1];
			div.appendChild(span);
		}
		return div;
	}

	function atBottom() {
		return window.scrollY + window.innerHeight >= document.body.scrollHeight - 4;
	}

	function follow(wasAtBottom) {
		if (followEl.checked && wasAtBottom) { window.scrollTo(0, document.body.scrollHeight); }
	}

	function trim() {
		while (log.childElementCount > MAX_ROWS) { log.firstElementChild.remove(); }
	}

	function updateCount() {
		countEl.textContent = log.childElementCount + ' / ' + state.rows.length;
	}

	function rebuild() {
		const wasAtBottom = atBottom();
		log.textContent = '';
		const frag = document.createDocumentFragment();
		for (const row of state.rows) { if (matches(row)) { frag.appendChild(rowNode(row)); } }
		log.appendChild(frag);
		updateCount();
		follow(wasAtBottom);
	}

	function append(lines) {
		const wasAtBottom = atBottom();
		const frag = document.createDocumentFragment();
		for (const line of lines) {
			const row = parse(line);
			state.rows.push(row);
			if (matches(row)) { frag.appendChild(rowNode(row)); }
		}
		if (state.rows.length > 20000) { state.rows = state.rows.slice(-15000); }
		log.appendChild(frag);
		trim();
		updateCount();
		follow(wasAtBottom);
	}

	for (const button of document.querySelectorAll('.levels button')) {
		button.addEventListener('click', () => {
			state.level = button.dataset.level;
			for (const other of document.querySelectorAll('.levels button')) {
				other.setAttribute('aria-pressed', String(other === button));
			}
			rebuild();
		});
	}
	filterEl.addEventListener('input', () => { state.text = filterEl.value.trim().toLowerCase(); rebuild(); });
	filterEl.addEventListener('keydown', event => { if (event.key === 'Escape') { filterEl.value = ''; state.text = ''; rebuild(); } });
	document.getElementById('clear').addEventListener('click', () => {
		state.rows = [];
		log.textContent = '';
		updateCount();
		vscode.postMessage({ command: 'clear' });
	});
	window.addEventListener('message', event => {
		const msg = event.data;
		if (msg.command === 'append') { append(msg.lines); }
		else if (msg.command === 'reset') { state.rows = []; rebuild(); }
	});
</script>
</body>
</html>`;
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
		vscode.commands.registerCommand('auraKotlin.android.startAvd', async (target?: { name?: string } | string) => {
			const name = typeof target === 'string' ? target : target?.name;
			if (name) { await panel.startAvd(name); } else { await panel.startEmulator(); }
		}),
		vscode.commands.registerCommand('auraKotlin.android.stopEmulator', (target?: { name?: string } | string) => panel.stopEmulator(target)),
		vscode.commands.registerCommand('auraKotlin.android.createAvd', () => {
			// Форма во вкладке вместо цепочки quick-pick'ов; после создания — обновить дерево.
			AvdCreateForm.show(panel, () => void vscode.commands.executeCommand('auraKotlin.refreshAndroidView'));
		}),
		vscode.commands.registerCommand('auraKotlin.android.devices', async () => {
			const devices = await panel.devices();
			vscode.window.showInformationMessage(devices.length
				? tr('Connected Android devices: {0}', devices.map(device => device.id).join(', '))
				: tr('No Android devices connected (adb devices is empty).'), { modal: true });
		}),
	);
	void panel.showDeviceStatus();

	return panel;
}
