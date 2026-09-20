/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — установка Kotlin Language Server (fwcd, MIT) (этап 6 ТЗ: «поставка LSP»).
 *  Порядок разрешения сервера:
 *    1. auraKotlin.kotlinLspPath, если пользователь задал свою команду/скрипт;
 *    2. комплект поставки: <extension>/server/lib (для offline-сборок, см. scripts/fetch-lsp.mjs);
 *    3. автоскачивание: <globalStorage>/lsp/server-<version>/lib (по кнопке в IDE);
 *    4. 'kotlin-language-server' из PATH (старое поведение).
 *  Сервер запускается напрямую: java -cp "lib/*" org.javacs.kt.MainKt — без скриптов-обёрток
 *  и без завязки на JAVA_HOME. Требуется JDK 11+ (kotlin-compiler 2.1); при Java ниже —
 *  понятное сообщение с указанием пути к JDK (например, из Android Studio).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';

const execFileAsync = promisify(execFile);

const SERVER_VERSION = '1.3.13';
const SERVER_URL = `https://github.com/fwcd/kotlin-language-server/releases/download/${SERVER_VERSION}/server.zip`;
const SERVER_MAIN_CLASS = 'org.javacs.kt.MainKt';
/** Минимальная версия Java для сервера (class file 55 = Java 11). */
const MIN_JAVA_MAJOR = 11;
const DECLINED_KEY = 'auraKotlin.lspOfferDeclined';
const LSP_DIR_NAME = `server-${SERVER_VERSION}`;

/** Способ запуска найденного/установленного сервера. */
export interface ServerLaunch {
	/** java (или полный путь) либо команда сервера из PATH/настройки. */
	command: string;
	args: string[];
	/** Откуда взят сервер — для лога и статус-бара. */
	source: 'setting' | 'bundled' | 'downloaded' | 'path';
}

/** Где лежит распакованный сервер: каталог с lib/*.jar. */
function serverLibDir(context: vscode.ExtensionContext, kind: 'bundled' | 'downloaded'): string | undefined {
	const base = kind === 'bundled'
		? path.join(context.extensionPath, 'server')
		: path.join(context.globalStorageUri.fsPath, 'lsp', LSP_DIR_NAME);
	const lib = path.join(base, 'lib');
	return fs.existsSync(path.join(lib, `server-${SERVER_VERSION}.jar`)) || fs.existsSync(lib) && fs.readdirSync(lib).some(name => name.startsWith('server-') && name.endsWith('.jar')) ? lib : undefined;
}

/**
 * Ищет сервер в порядке приоритета. Возвращает undefined, если нигде нет.
 * Настройка со значением по умолчанию ('kotlin-language-server') считается «не заданной»,
 * чтобы сработали комплект/автоскачивание; PATH проверяется последним.
 */
export async function resolveServer(context: vscode.ExtensionContext): Promise<ServerLaunch | undefined> {
	const setting = vscode.workspace.getConfiguration('auraKotlin').get<string>('kotlinLspPath', 'kotlin-language-server');

	// 1. Явно заданный пользователем путь/команда.
	if (setting && setting !== 'kotlin-language-server') {
		return { command: setting, args: [], source: 'setting' };
	}

	// 2/3. Комплект поставки или автоскачивание — запускаем java -cp "lib/*".
	for (const kind of ['bundled', 'downloaded'] as const) {
		const lib = serverLibDir(context, kind);
		if (lib) {
			return { command: javaPath(), args: ['-cp', path.join(lib, '*'), SERVER_MAIN_CLASS], source: kind };
		}
	}

	// 4. PATH.
	if (await findOnPath(setting || 'kotlin-language-server')) {
		return { command: setting || 'kotlin-language-server', args: [], source: 'path' };
	}
	return undefined;
}

function javaPath(): string {
	return vscode.workspace.getConfiguration('auraKotlin').get<string>('javaPath', 'java');
}

async function findOnPath(command: string): Promise<boolean> {
	try {
		await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [command], { timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

/** Java-версия (major): 1.8 → 8, 11 → 11, 17.0.4 → 17. undefined — java не найден. */
export async function javaMajorVersion(javaCommand: string): Promise<number | undefined> {
	try {
		const result = await execFileAsync(javaCommand, ['-version'], { timeout: 10_000 });
		const text = `${result.stderr}${result.stdout}`;
		const match = /(?:version\s+)?(\d+)(?:\.(\d+))?/.exec(text.split(/\r?\n/)[0] ?? '') ?? /"(\d+)(?:\.(\d+))?/.exec(text);
		if (!match) { return undefined; }
		const major = Number(match[1]);
		if (major === 1 && match[2]) { return Number(match[2]); }
		return major;
	} catch {
		return undefined;
	}
}

/** Проверяет java: найдена ли и достаточно ли новая для сервера. */
export async function checkJava(): Promise<{ ok: boolean; version?: number }> {
	const version = await javaMajorVersion(javaPath());
	return { ok: version !== undefined && version >= MIN_JAVA_MAJOR, version };
}

/**
 * Скачивает и распаковывает сервер в globalStorage (один раз на версию).
 * Возвращает каталог lib или undefined при неудаче.
 */
export async function installServer(context: vscode.ExtensionContext): Promise<string | undefined> {
	const java = await checkJava();
	if (!java.ok) {
		void vscode.window.showErrorMessage(
			java.version === undefined
				? vscode.l10n.t('Java not found — the Kotlin Language Server needs JDK {0}+. Set auraKotlin.javaPath to a JDK (e.g. the one bundled with Android Studio).', String(MIN_JAVA_MAJOR))
				: vscode.l10n.t('Java {0} is too old — the Kotlin Language Server needs JDK {1}+. Set auraKotlin.javaPath to a newer JDK.', String(java.version), String(MIN_JAVA_MAJOR)),
		);
		return undefined;
	}
	const destBase = path.join(context.globalStorageUri.fsPath, 'lsp');
	if (serverLibDir(context, 'downloaded')) { return path.join(destBase, LSP_DIR_NAME, 'lib'); }

	return vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Downloading Kotlin Language Server ({0}, ~83 MB)…', SERVER_VERSION), cancellable: false },
		async () => {
			try {
				fs.mkdirSync(destBase, { recursive: true });
				const zip = path.join(os.tmpdir(), `kotlin-language-server-${SERVER_VERSION}.zip`);
				await downloadFile(SERVER_URL, zip);
				const extractDir = path.join(destBase, `.extract-${Date.now()}`);
				fs.mkdirSync(extractDir, { recursive: true });
				await extractZip(zip, extractDir);
				// Zip содержит каталог server/{bin,lib}. Приводим к server-<version>/lib.
				const inner = fs.existsSync(path.join(extractDir, 'server')) ? path.join(extractDir, 'server') : extractDir;
				const dest = path.join(destBase, LSP_DIR_NAME);
				if (fs.existsSync(dest)) { fs.rmSync(dest, { recursive: true, force: true }); }
				fs.renameSync(inner, dest);
				fs.rmSync(extractDir, { recursive: true, force: true });
				fs.rmSync(zip, { force: true });
				const lib = path.join(dest, 'lib');
				return fs.existsSync(lib) ? lib : undefined;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(vscode.l10n.t('Kotlin Language Server download failed: {0}', message));
				return undefined;
			}
		},
	);
}

function downloadFile(url: string, dest: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const follow = (target: string, redirects: number): void => {
			if (redirects > 5) { reject(new Error('too many redirects')); return; }
			const mod = target.startsWith('https:') ? https : http;
			mod.get(target, response => {
				if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
					response.resume();
					follow(new URL(response.headers.location, target).toString(), redirects + 1);
					return;
				}
				if (response.statusCode !== 200) { reject(new Error(`HTTP ${response.statusCode}`)); return; }
				const file = fs.createWriteStream(dest);
				response.pipe(file);
				file.on('finish', () => file.close(() => resolve()));
				file.on('error', reject);
			}).on('error', reject);
		};
		follow(url, 0);
	});
}

/** Распаковка zip встроенными средствами ОС (tar → unzip → PowerShell). */
export async function extractZip(zip: string, destDir: string): Promise<void> {
	const attempts: Array<{ command: string; args: string[] }> = [
		{ command: 'tar', args: ['-xf', zip, '-C', destDir] },
		{ command: 'unzip', args: ['-q', '-o', zip, '-d', destDir] },
	];
	if (process.platform === 'win32') {
		attempts.push({ command: 'powershell', args: ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${zip}" -DestinationPath "${destDir}" -Force`] });
	}
	for (const attempt of attempts) {
		try {
			await execFileAsync(attempt.command, attempt.args, { timeout: 10 * 60_000 });
			if (fs.readdirSync(destDir).length > 0) { return; }
		} catch { /* пробуем следующий способ */ }
	}
	throw new Error(vscode.l10n.t('no zip extractor available (tar/unzip/PowerShell)'));
}

/** Предложение скачать сервер (показывается один раз; запоминаем отказ). */
export async function offerServerInstall(context: vscode.ExtensionContext): Promise<ServerLaunch | undefined> {
	if (context.globalState.get<boolean>(DECLINED_KEY)) { return undefined; }
	const download = vscode.l10n.t('Download (~83 MB)');
	const later = vscode.l10n.t('Not now');
	const pick = await vscode.window.showInformationMessage(
		vscode.l10n.t('Kotlin Language Server is not installed. Download it automatically to enable completion, diagnostics and rename for .kt? (Requires JDK {0}+.)', String(MIN_JAVA_MAJOR)),
		download, later,
	);
	if (pick === download) {
		const lib = await installServer(context);
		if (lib) {
			vscode.window.showInformationMessage(vscode.l10n.t('Kotlin Language Server {0} installed.', SERVER_VERSION));
			return { command: javaPath(), args: ['-cp', path.join(lib, '*'), SERVER_MAIN_CLASS], source: 'downloaded' };
		}
		return undefined;
	}
	if (pick === later) { await context.globalState.update(DECLINED_KEY, true); }
	return undefined;
}
