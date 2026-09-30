/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — Java Language Server (Eclipse JDT LS, EPL-2.0).
 *  Порядок разрешения сервера:
 *    1. auraKotlin.javaLspPath, если пользователь задал свой путь (каталог jdtls или launcher-jar);
 *    2. комплект поставки: <extension>/java-server (для offline-сборок);
 *    3. автоскачивание: <globalStorage>/java/jdtls (снимок Eclipse, ~51 МБ) по кнопке в IDE.
 *  Важная деталь: свежие снимки jdtls требуют свежий JDK (в снимке 2026-09 это Java 25),
 *  поэтому JDK для сервера выбирается как САМЫЙ НОВЫЙ из доступных на машине, а не тот,
 *  что указан в auraKotlin.javaPath (он обычно 17 и нужен Kotlin-серверу).
 *-------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { tr } from './l10n';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import { ServerLaunch } from './lspClient';
import { javaMajorVersion } from './lspInstall';

const execFileAsync = promisify(execFile);

const SERVER_URL = 'https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz';
export const JAVA_SERVER_SIZE = '~51 MB';

/** Установлен ли jdtls (комплект поставки или скачанный) — нужно онбордингу. */
export function javaServerInstalled(context: vscode.ExtensionContext): boolean {
	return !!(serverDir(context, 'bundled') ?? serverDir(context, 'downloaded'));
}
const DIR_NAME = 'jdtls';
const DECLINED_KEY = 'auraKotlin.javaLspOfferDeclined';
/** Ниже этой версии jdtls не запустится ни в одном снимке (по нашим наблюдениям — 17). */
export const MIN_JAVA_MAJOR = 17;

let cachedJava: { command: string; version: number } | undefined;

/** Каталог скачанного сервера — для чтения логов при падении (см. javaRequirementFromLogs). */
export function serverDirForDiagnostics(context: vscode.ExtensionContext): string {
	return path.join(context.globalStorageUri.fsPath, 'java', DIR_NAME);
}

/** Каталог сервера: комплект поставки или скачанный. */
function serverDir(context: vscode.ExtensionContext, kind: 'bundled' | 'downloaded'): string | undefined {
	const base = kind === 'bundled' ? path.join(context.extensionPath, 'java-server') : path.join(context.globalStorageUri.fsPath, 'java', DIR_NAME);
	return launcherJar(base) ? base : undefined;
}

/** Путь к launcher-jar внутри каталога сервера (именно org.eclipse.equinox.launcher_1.x.jar). */
function launcherJar(dir: string): string | undefined {
	const plugins = path.join(dir, 'plugins');
	if (!fs.existsSync(plugins)) { return undefined; }
	try {
		const name = fs.readdirSync(plugins).find(entry => /^org\.eclipse\.equinox\.launcher_[\d.]+\.v[\d-]+\.jar$/.test(entry));
		return name ? path.join(plugins, name) : undefined;
	} catch {
		return undefined;
	}
}

/** Каталог конфигурации под текущую ОС и архитектуру. */
function configDir(dir: string): string {
	const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
	const candidates = process.arch === 'arm64' ? [`config_${platform}_arm`, `config_${platform}`] : [`config_${platform}`];
	return candidates.map(name => path.join(dir, name)).find(candidate => fs.existsSync(candidate)) ?? path.join(dir, `config_${platform}`);
}

/** Аргументы запуска jdtls: launcher, конфигурация и каталог данных воркспейса. */
export function jdtlsArgs(dir: string, dataDir: string): string[] | undefined {
	const jar = launcherJar(dir);
	if (!jar) { return undefined; }
	return [
		'-Declipse.application=org.eclipse.jdt.ls.core.id1',
		'-Dosgi.bundles.defaultStartLevel=4',
		'-Declipse.product=org.eclipse.jdt.ls.core.product',
		'-Dlog.level=ERROR',
		'-Xmx1G',
		'--add-modules=ALL-SYSTEM',
		'--add-opens', 'java.base/java.util=ALL-UNNAMED',
		'--add-opens', 'java.base/java.lang=ALL-UNNAMED',
		'-jar', jar,
		'-configuration', configDir(dir),
		'-data', dataDir,
	];
}

/** Кандидаты JDK: настройка, JAVA_HOME, каталоги JDK, Android Studio JBR, PATH. */
function javaCandidates(): string[] {
	const candidates: string[] = [];
	const configured = vscode.workspace.getConfiguration('auraKotlin').get<string>('javaPath', 'java').trim();
	if (configured) { candidates.push(configured); }

	const home = process.env.JAVA_HOME;
	if (home) { candidates.push(path.join(home, 'bin', 'java')); }

	const jdkRoot = path.join(os.homedir(), '.jdks');
	try {
		for (const name of fs.readdirSync(jdkRoot)) { candidates.push(path.join(jdkRoot, name, 'bin', 'java')); }
	} catch { /* каталога нет */ }

	for (const studio of [
		'C:/Program Files/Android/Android Studio/jbr/bin/java.exe',
		'/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java',
	]) {
		if (fs.existsSync(studio)) { candidates.push(studio); }
	}
	candidates.push('java');
	return [...new Set(candidates)];
}

/**
 * Самый новый JDK на машине: снимки jdtls требуют свежую Java, а auraKotlin.javaPath
 * обычно указывает на 17 ради Kotlin-сервера.
 */
export async function pickServerJava(): Promise<{ command: string; version: number } | undefined> {
	if (cachedJava) { return cachedJava; }
	const probes = await Promise.all(javaCandidates().map(async command => ({ command, version: await javaMajorVersion(command) })));
	const usable = probes.filter(probe => probe.version !== undefined && probe.version >= MIN_JAVA_MAJOR) as Array<{ command: string; version: number }>;
	if (!usable.length) { return undefined; }
	usable.sort((a, b) => b.version - a.version);
	cachedJava = usable[0];
	return cachedJava;
}

/** Найденный/установленный сервер и команда его запуска. */
export async function resolveJavaServer(context: vscode.ExtensionContext, dataDir: string): Promise<ServerLaunch | undefined> {
	const setting = vscode.workspace.getConfiguration('auraKotlin').get<string>('javaLspPath', '').trim();
	const java = await pickServerJava();
	if (!java) { return undefined; }

	const roots: Array<{ dir?: string; source: ServerLaunch['source'] }> = [
		{ dir: setting ? (setting.endsWith('.jar') ? path.dirname(path.dirname(setting)) : setting) : undefined, source: 'setting' },
		{ dir: serverDir(context, 'bundled'), source: 'bundled' },
		{ dir: serverDir(context, 'downloaded'), source: 'downloaded' },
	];
	for (const root of roots) {
		if (!root.dir) { continue; }
		const args = jdtlsArgs(root.dir, dataDir);
		if (args) { return { command: java.command, args, source: root.source, cwd: root.dir }; }
	}
	return undefined;
}

/** Каталог данных jdtls для воркспейса: метаданные Eclipse держим вне репозитория пользователя. */
export function dataDirFor(context: vscode.ExtensionContext, workspaceRoot?: string): string {
	const key = workspaceRoot ? path.basename(workspaceRoot).replace(/[^\w.-]/g, '_') + '-' + hashString(workspaceRoot) : 'default';
	return path.join(context.globalStorageUri.fsPath, 'java', 'data', key);
}

function hashString(value: string): string {
	let hash = 0;
	for (let index = 0; index < value.length; index++) {
		hash = (hash * 31 + value.charCodeAt(index)) | 0;
	}
	return (hash >>> 0).toString(36);
}

/**
 * Требование по Java из лога jdtls (например `osgi.ee=JavaSE)(version=25)`).
 * Нужно для внятного сообщения, когда сервер не стартует на установленном JDK.
 */
export function javaRequirementFromLogs(dir: string, configName?: string): number | undefined {
	const candidates = fs.existsSync(path.join(dir, 'config')) ? [path.join(dir, 'config')] : [];
	if (configName && fs.existsSync(configName)) { candidates.push(configName); }
	const logs: Array<{ file: string; time: number }> = [];
	for (const candidate of candidates) {
		try {
			for (const entry of fs.readdirSync(candidate)) {
				if (!entry.endsWith('.log')) { continue; }
				const file = path.join(candidate, entry);
				logs.push({ file, time: fs.statSync(file).mtimeMs });
			}
		} catch { /* каталога нет */ }
	}
	logs.sort((a, b) => b.time - a.time);
	for (const log of logs.slice(0, 2)) {
		try {
			const text = fs.readFileSync(log.file, 'utf8');
			const match = /osgi\.ee\s*=\s*JavaSE\)\s*\(version=(\d+)/.exec(text);
			if (match) { return Number(match[1]); }
		} catch { /* нечитаемый лог */ }
	}
	return undefined;
}

/** Скачивает и распаковывает jdtls. Возвращает каталог сервера. */
export async function installJavaServer(context: vscode.ExtensionContext): Promise<string | undefined> {
	const destBase = path.join(context.globalStorageUri.fsPath, 'java');
	const existing = serverDir(context, 'downloaded');
	if (existing) { return existing; }

	return vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: tr('Downloading Java Language Server ({0})…', JAVA_SERVER_SIZE), cancellable: false },
		async () => {
			try {
				fs.mkdirSync(destBase, { recursive: true });
				const archive = path.join(os.tmpdir(), `jdtls-${Date.now()}.tar.gz`);
				await downloadFile(SERVER_URL, archive);
				const extractDir = path.join(destBase, `.extract-${Date.now()}`);
				fs.mkdirSync(extractDir, { recursive: true });
				await extractTarGz(archive, extractDir);
				const dest = path.join(destBase, DIR_NAME);
				if (fs.existsSync(dest)) { fs.rmSync(dest, { recursive: true, force: true }); }
				fs.renameSync(extractDir, dest);
				fs.rmSync(archive, { force: true });
				return launcherJar(dest) ? dest : undefined;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(tr('Java Language Server download failed: {0}', message));
				return undefined;
			}
		},
	);
}

/** Скачивание файла с поддержкой редиректов (download.eclipse.org отдаёт через них). */
export function downloadFile(url: string, dest: string): Promise<void> {
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

/** Распаковка .tar.gz системным tar (есть на Windows 10+, macOS и Linux). */
export async function extractTarGz(archive: string, destDir: string): Promise<void> {
	try {
		await execFileAsync('tar', ['-xzf', archive, '-C', destDir], { timeout: 10 * 60_000 });
	} catch (error) {
		throw new Error(tr('could not unpack {0}: {1}', path.basename(archive), error instanceof Error ? error.message : String(error)));
	}
	if (fs.readdirSync(destDir).length === 0) {
		throw new Error(tr('archive {0} unpacked to nothing', path.basename(archive)));
	}
}

/** Предложение скачать jdtls (один раз; отказ запоминаем). */
export async function offerJavaServerInstall(context: vscode.ExtensionContext, dataDir: string): Promise<ServerLaunch | undefined> {
	if (!await pickServerJava()) {
		void vscode.window.showErrorMessage(tr('Java {0}+ is required for the Java Language Server. Set auraKotlin.javaPath to a newer JDK.', String(MIN_JAVA_MAJOR)));
		return undefined;
	}
	if (context.globalState.get<boolean>(DECLINED_KEY)) { return undefined; }
	const download = tr('Download ({0})', JAVA_SERVER_SIZE);
	const later = tr('Not now');
	const pick = await vscode.window.showInformationMessage(
		tr('Java Language Server (Eclipse JDT) is not installed. Download it to enable completion, diagnostics and auto-import for .java? ({0})', JAVA_SERVER_SIZE),
		download, later,
	);
	if (pick === download) {
		const dir = await installJavaServer(context);
		if (dir) {
			void vscode.window.showInformationMessage(tr('Java Language Server installed.'));
			return resolveJavaServer(context, dataDir);
		}
		return undefined;
	}
	if (pick === later) { await context.globalState.update(DECLINED_KEY, true); }
	return undefined;
}
