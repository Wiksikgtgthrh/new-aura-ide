/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — автоустановка тулчейна (этап «из коробки»).
 *  Без этого модуля пользователь обязан был вручную ставить JDK, kotlinc, Gradle и
 *  Android SDK — на чистой машине плагин был нерабочим. Теперь одна команда
 *  «Kotlin: Install Toolchain» скачивает всё в globalStorage (ничего системного не трогаем):
 *    <globalStorage>/toolchain/jdk          — Temurin JDK 21
 *    <globalStorage>/toolchain/kotlinc      — Kotlin compiler
 *    <globalStorage>/toolchain/gradle       — Gradle (проверенная пара к AGP из мастера)
 *    <globalStorage>/toolchain/android-sdk  — cmdline-tools + platform-tools + emulator + platform
 *  После установки (и при каждой активации) пути инъектируются в process.env — все
 *  резолверы (lspInstall по JAVA_HOME, android по ANDROID_HOME, gradle по PATH)
 *  подхватывают тулчейн без правок. Системный env пользователя не перетираем:
 *  JAVA_HOME/ANDROID_HOME ставим только если их не было.
 *-------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { tr } from './l10n';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { downloadFile, extractTarGz } from './javaInstall';
import { extractZip } from './lspInstall';
import { execTool } from './gradle';

// Версии зафиксированы: связка AGP 8.7.x + Kotlin 2.1 + Gradle 8.10 проверена,
// «самое свежее из сети» ломало бы сборки у пользователей непредсказуемо.
const JDK_MAJOR = 21;
const KOTLIN_VERSION = '2.4.21';
/** Версия Gradle — нужна и мастеру проектов для генерации wrapper. */
export const GRADLE_VERSION = '8.10.2';
const CMDLINE_TOOLS_BUILD = '13114758';
const SDK_PLATFORM = 'platforms;android-35';
const SDK_BUILD_TOOLS = 'build-tools;35.0.0';
const SDK_PACKAGES = ['platform-tools', 'emulator', SDK_PLATFORM, SDK_BUILD_TOOLS];

const KOTLIN_URL = `https://github.com/JetBrains/kotlin/releases/download/v${KOTLIN_VERSION}/kotlin-compiler-${KOTLIN_VERSION}.zip`;
const GRADLE_URL = `https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip`;

function jdkUrl(): string {
	const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
	const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
	return `https://api.adoptium.net/v3/binary/latest/${JDK_MAJOR}/ga/${platform}/${arch}/jdk/hotspot/normal/eclipse`;
}

function cmdlineToolsUrl(): string {
	const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
	return `https://dl.google.com/android/repository/commandlinetools-${platform}-${CMDLINE_TOOLS_BUILD}_latest.zip`;
}

export interface ToolchainStatus {
	jdk: boolean;
	kotlinc: boolean;
	gradle: boolean;
	sdk: boolean;
}

export class Toolchain {
	constructor(private readonly context: vscode.ExtensionContext) { }

	root(): string {
		return path.join(this.context.globalStorageUri.fsPath, 'toolchain');
	}

	/** Каталог установленного JDK (с bin/java внутри) или undefined. */
	jdkHome(): string | undefined {
		const home = path.join(this.root(), 'jdk');
		return fs.existsSync(path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')) ? home : undefined;
	}

	kotlincBin(): string | undefined {
		const bin = path.join(this.root(), 'kotlinc', 'bin', process.platform === 'win32' ? 'kotlinc.bat' : 'kotlinc');
		return fs.existsSync(bin) ? bin : undefined;
	}

	gradleBin(): string | undefined {
		const bin = path.join(this.root(), 'gradle', 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle');
		return fs.existsSync(bin) ? bin : undefined;
	}

	/** Корень автоустановленного Android SDK (с platform-tools внутри) или undefined. */
	androidSdk(): string | undefined {
		const sdk = path.join(this.root(), 'android-sdk');
		return fs.existsSync(path.join(sdk, 'platform-tools')) ? sdk : undefined;
	}

	status(): ToolchainStatus {
		return { jdk: !!this.jdkHome(), kotlinc: !!this.kotlincBin(), gradle: !!this.gradleBin(), sdk: !!this.androidSdk() };
	}

	/**
	 * Инъекция путей тулчейна в process.env extension-хоста. Покрывает все дочерние
	 * процессы расширения (LSP, sdkmanager, adb, gradle) без правок каждого резолвера.
	 * Вызывается при активации и после установки.
	 */
	activateEnv(): void {
		const jdk = this.jdkHome();
		if (jdk && !process.env.JAVA_HOME) { process.env.JAVA_HOME = jdk; }
		const sdk = this.androidSdk();
		if (sdk) {
			if (!process.env.ANDROID_HOME) { process.env.ANDROID_HOME = sdk; }
			if (!process.env.ANDROID_SDK_ROOT) { process.env.ANDROID_SDK_ROOT = sdk; }
		}
		const pathSep = process.platform === 'win32' ? ';' : ':';
		const prepend: string[] = [];
		if (jdk) { prepend.push(path.join(jdk, 'bin')); }
		const kotlinc = this.kotlincBin();
		if (kotlinc) { prepend.push(path.dirname(kotlinc)); }
		const gradle = this.gradleBin();
		if (gradle) { prepend.push(path.dirname(gradle)); }
		if (sdk) {
			prepend.push(
				path.join(sdk, 'platform-tools'),
				path.join(sdk, 'emulator'),
				path.join(sdk, 'cmdline-tools', 'latest', 'bin'),
			);
		}
		const current = (process.env.PATH ?? '').split(pathSep).filter(Boolean);
		const missing = prepend.filter(dir => !current.includes(dir) && fs.existsSync(dir));
		if (missing.length) { process.env.PATH = [...missing, ...current].join(pathSep); }
	}

	/** Абсолютный путь к java тулчейна, если он есть — иначе undefined (смотреть дальше). */
	javaBinary(): string | undefined {
		const home = this.jdkHome();
		return home ? path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : undefined;
	}

	/** Полная установка: JDK → kotlinc → Gradle → cmdline-tools → пакеты SDK. Идемпотентна. */
	async installAll(): Promise<boolean> {
		const result = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: tr('Installing Kotlin/Android toolchain…'), cancellable: false },
			async progress => {
				const step = (message: string, increment: number) => progress.report({ message, increment });
				try {
					if (!this.jdkHome()) {
						step(tr('JDK {0} (~190 MB)…', String(JDK_MAJOR)), 5);
						await this.installJdk();
					}
					if (!this.kotlincBin()) {
						step(tr('Kotlin compiler {0} (~90 MB)…', KOTLIN_VERSION), 20);
						await this.installKotlinc();
					}
					if (!this.gradleBin()) {
						step(tr('Gradle {0} (~130 MB)…', GRADLE_VERSION), 20);
						await this.installGradle();
					}
					if (!this.androidSdk()) {
						step(tr('Android SDK command line tools (~130 MB)…'), 20);
						await this.installCmdlineTools();
						step(tr('Android SDK packages (platform-tools, emulator, platform)…'), 15);
						await this.installSdkPackages();
					}
					step(tr('Finishing…'), 20);
					this.activateEnv();
					return true;
				} catch (error) {
					void vscode.window.showErrorMessage(tr('Toolchain installation failed: {0}', error instanceof Error ? error.message : String(error)));
					return false;
				}
			},
		);
		return result;
	}

	private async installJdk(): Promise<void> {
		const archive = path.join(os.tmpdir(), `jdk-${Date.now()}${process.platform === 'win32' ? '.zip' : '.tar.gz'}`);
		const extractDir = path.join(this.root(), `.jdk-extract-${Date.now()}`);
		try {
			fs.mkdirSync(extractDir, { recursive: true });
			await downloadFile(jdkUrl(), archive);
			if (process.platform === 'win32') { await extractZip(archive, extractDir); } else { await extractTarGz(archive, extractDir); }
			// Архив содержит единственный каталог вида jdk-21.0.x+y — приводим к toolchain/jdk.
			const inner = fs.readdirSync(extractDir).map(name => path.join(extractDir, name)).find(entry => fs.statSync(entry).isDirectory());
			if (!inner) { throw new Error(tr('JDK archive unpacked to nothing')); }
			this.replaceDir(process.platform === 'darwin' && fs.existsSync(path.join(inner, 'Contents', 'Home')) ? path.join(inner, 'Contents', 'Home') : inner, path.join(this.root(), 'jdk'));
			if (!this.jdkHome()) { throw new Error(tr('JDK unpacked, but bin/java not found')); }
		} finally {
			fs.rmSync(archive, { force: true });
			fs.rmSync(extractDir, { recursive: true, force: true });
		}
	}

	private async installKotlinc(): Promise<void> {
		const zip = path.join(os.tmpdir(), `kotlin-compiler-${Date.now()}.zip`);
		const extractDir = path.join(this.root(), `.kotlinc-extract-${Date.now()}`);
		try {
			fs.mkdirSync(extractDir, { recursive: true });
			await downloadFile(KOTLIN_URL, zip);
			await extractZip(zip, extractDir);
			const inner = path.join(extractDir, 'kotlinc');
			this.replaceDir(fs.existsSync(inner) ? inner : extractDir, path.join(this.root(), 'kotlinc'));
			this.makeExecutable(path.join(this.root(), 'kotlinc', 'bin'));
			if (!this.kotlincBin()) { throw new Error(tr('Kotlin compiler unpacked, but bin/kotlinc not found')); }
		} finally {
			fs.rmSync(zip, { force: true });
			fs.rmSync(extractDir, { recursive: true, force: true });
		}
	}

	private async installGradle(): Promise<void> {
		const zip = path.join(os.tmpdir(), `gradle-${Date.now()}.zip`);
		const extractDir = path.join(this.root(), `.gradle-extract-${Date.now()}`);
		try {
			fs.mkdirSync(extractDir, { recursive: true });
			await downloadFile(GRADLE_URL, zip);
			await extractZip(zip, extractDir);
			const inner = path.join(extractDir, `gradle-${GRADLE_VERSION}`);
			this.replaceDir(fs.existsSync(inner) ? inner : extractDir, path.join(this.root(), 'gradle'));
			this.makeExecutable(path.join(this.root(), 'gradle', 'bin'));
			if (!this.gradleBin()) { throw new Error(tr('Gradle unpacked, but bin/gradle not found')); }
		} finally {
			fs.rmSync(zip, { force: true });
			fs.rmSync(extractDir, { recursive: true, force: true });
		}
	}

	private async installCmdlineTools(): Promise<void> {
		const zip = path.join(os.tmpdir(), `cmdline-tools-${Date.now()}.zip`);
		const extractDir = path.join(this.root(), `.ct-extract-${Date.now()}`);
		try {
			fs.mkdirSync(extractDir, { recursive: true });
			await downloadFile(cmdlineToolsUrl(), zip);
			await extractZip(zip, extractDir);
			// sdkmanager требует раскладку <sdk>/cmdline-tools/latest/bin.
			const inner = path.join(extractDir, 'cmdline-tools');
			const dest = path.join(this.root(), 'android-sdk', 'cmdline-tools', 'latest');
			this.replaceDir(fs.existsSync(inner) ? inner : extractDir, dest);
			this.makeExecutable(path.join(dest, 'bin'));
			if (!fs.existsSync(this.sdkmanager())) { throw new Error(tr('cmdline-tools unpacked, but sdkmanager not found')); }
		} finally {
			fs.rmSync(zip, { force: true });
			fs.rmSync(extractDir, { recursive: true, force: true });
		}
	}

	private sdkmanager(): string {
		return path.join(this.root(), 'android-sdk', 'cmdline-tools', 'latest', 'bin', process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager');
	}

	/** sdkmanager с авто-принятием лицензий: отвечаем «y» на каждый запрос. */
	private async runSdkmanager(args: string[]): Promise<void> {
		const sdkRoot = path.join(this.root(), 'android-sdk');
		const env = { ...process.env, JAVA_HOME: this.jdkHome() ?? process.env.JAVA_HOME ?? '', ANDROID_SDK_ROOT: sdkRoot, ANDROID_HOME: sdkRoot };
		await new Promise<void>((resolve, reject) => {
			// shell: true — sdkmanager.bat на Windows без этого не стартует (EINVAL).
			const child = spawn(this.sdkmanager(), ['--sdk_root=' + sdkRoot, ...args], { shell: process.platform === 'win32', env });
			let tail = '';
			const capture = (data: Buffer): void => { tail = (tail + data.toString()).slice(-4000); };
			child.stdout?.on('data', capture);
			child.stderr?.on('data', capture);
			child.on('error', reject);
			child.on('exit', code => code === 0 ? resolve() : reject(new Error(`sdkmanager exited with code ${code}: ${tail.trim().split(/\r?\n/).pop() ?? ''}`)));
			// Ответы на лицензионные промпты уходят в stdin заранее — буфер их выстроит в очередь.
			child.stdin?.write('y\n'.repeat(50));
			child.stdin?.end();
		});
	}

	private async installSdkPackages(): Promise<void> {
		await this.runSdkmanager(['--licenses']);
		await this.runSdkmanager(SDK_PACKAGES);
		if (!this.androidSdk()) { throw new Error(tr('SDK packages installed, but platform-tools not found')); }
	}

	/** Атомарная замена каталога назначения (установка идемпотентна: повтор = чистая установка). */
	private replaceDir(from: string, to: string): void {
		if (fs.existsSync(to)) { fs.rmSync(to, { recursive: true, force: true }); }
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.renameSync(from, to);
	}

	/** tar/unzip сохраняют exec-биты, PowerShell Expand-Archive — нет; чиним на unix. */
	private makeExecutable(binDir: string): void {
		if (process.platform === 'win32' || !fs.existsSync(binDir)) { return; }
		for (const entry of fs.readdirSync(binDir)) {
			try { fs.chmodSync(path.join(binDir, entry), 0o755); } catch { /* не критично */ }
		}
	}
}

// ---------- Модульный синглтон: резолверы без протаскивания context по всей цепочке ----------

let current: Toolchain | undefined;

/** Инициализация при активации расширения: запоминает экземпляр и инъектирует env. */
export function initToolchain(context: vscode.ExtensionContext): Toolchain {
	current = new Toolchain(context);
	current.activateEnv();
	return current;
}

export function toolchain(): Toolchain | undefined { return current; }

/**
 * Бинарь java для запуска (run.ts, compileFile): явная настройка → тулчейн → 'java' из PATH.
 * Абсолютный путь важен для терминала: integrated terminal не видит process.env extension-хоста.
 */
export function resolveJavaBinary(): string {
	const configured = vscode.workspace.getConfiguration('auraKotlin').get<string>('javaPath', 'java').trim();
	if (configured && configured !== 'java') { return configured; }
	return current?.javaBinary() ?? configured ?? 'java';
}

/** Бинарь kotlinc: явная настройка → тулчейн → 'kotlinc' из PATH. */
export function resolveKotlincBinary(): string {
	const configured = vscode.workspace.getConfiguration('auraKotlin').get<string>('compilerPath', 'kotlinc').trim();
	if (configured && configured !== 'kotlinc') { return configured; }
	return current?.kotlincBin() ?? configured ?? 'kotlinc';
}

/** Корень Android SDK из тулчейна (для android.ts sdk() — добавляется кандидатом). */
export function toolchainSdkRoot(): string | undefined { return current?.androidSdk(); }

/** Ошибка «команда не найдена» → предлагаем автоустановку тулчейна вместо мёртвого сообщения. */
export async function reportToolFailure(error: unknown, tool: string): Promise<void> {
	const message = error instanceof Error ? error.message : String(error);
	const looksMissing = /ENOENT|not found|is not recognized|не является/i.test(message);
	if (looksMissing && !path.isAbsolute(tool)) {
		const install = tr('Install automatically');
		const pick = await vscode.window.showErrorMessage(
			tr('{0} — the required tool is not installed.', message),
			install,
		);
		if (pick === install) { await vscode.commands.executeCommand('auraKotlin.installToolchain'); }
		return;
	}
	vscode.window.showErrorMessage(message);
}

/** Сводка «чего не хватает» для онбординга и статуса. */
export async function missingToolchain(panel: { sdk(): string | undefined }): Promise<string[]> {
	const missing: string[] = [];
	if (!current?.jdkHome() && !await javaOnPath()) { missing.push('JDK'); }
	if (!current?.kotlincBin() && !await commandOnPath('kotlinc')) { missing.push('kotlinc'); }
	if (!panel.sdk()) { missing.push('Android SDK'); }
	return missing;
}

async function javaOnPath(): Promise<boolean> {
	try {
		const result = await execTool('java', ['-version'], { timeout: 10_000 });
		return /version|openjdk/i.test(`${result.stdout}${result.stderr}`);
	} catch {
		return false;
	}
}

async function commandOnPath(command: string): Promise<boolean> {
	try {
		await execTool(process.platform === 'win32' ? 'where' : 'which', [command], { timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}
