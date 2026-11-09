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
function javaCandidates(context?: vscode.ExtensionContext): string[] {
	const candidates: string[] = [];
	const configured = vscode.workspace.getConfiguration('auraKotlin').get<string>('javaPath', 'java').trim();
	if (configured) { candidates.push(configured); }

	// JDK, скачанный расширением под конкретную версию jdtls.
	if (context) {
		try {
			const javaDir = path.join(context.globalStorageUri.fsPath, 'java');
			for (const name of fs.readdirSync(javaDir)) {
				if (name.startsWith('jdk-')) { candidates.push(path.join(javaDir, name, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')); }
			}
		} catch { /* каталога нет */ }
	}

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
 * обычно указывает на 17 ради Kotlin-сервера. Если известна требуемая версия
 * (из лога упавшего сервера), берём JDK не ниже неё.
 */
export async function pickServerJava(required?: number, context?: vscode.ExtensionContext): Promise<{ command: string; version: number } | undefined> {
	if (cachedJava && (!required || cachedJava.version >= required)) { return cachedJava; }
	const probes = await Promise.all(javaCandidates(context).map(async command => ({ command, version: await javaMajorVersion(command) })));
	const minimum = Math.max(MIN_JAVA_MAJOR, required ?? 0);
	const usable = probes.filter(probe => probe.version !== undefined && probe.version >= minimum) as Array<{ command: string; version: number }>;
	if (!usable.length) { return undefined; }
	usable.sort((a, b) => b.version - a.version);
	cachedJava = usable[0];
	return cachedJava;
}

/** Сбросить кэш выбранной Java: после установки JDK его нужно перечитать. */
export function forgetServerJava(): void { cachedJava = undefined; }

/**
 * Скачивает Temurin JDK нужной мажорной версии в globalStorage расширения.
 * Нужен, когда снимок jdtls требует Java новее установленной: без этого сервер
 * падает на старте («Unresolved requirement: osgi.ee … version=25»).
 */
export async function installJdk(context: vscode.ExtensionContext, major: number): Promise<string | undefined> {
	const platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux';
	const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
	const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/${platform}/${arch}/jdk/hotspot/normal/eclipse`;
	const base = path.join(context.globalStorageUri.fsPath, 'java');
	const dest = path.join(base, `jdk-${major}`);
	const javaExe = path.join(dest, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
	if (fs.existsSync(javaExe)) { forgetServerJava(); return dest; }

	return vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: tr('Downloading JDK {0}…', String(major)), cancellable: false },
		async () => {
			const isZip = process.platform === 'win32';
			const archive = path.join(os.tmpdir(), `jdk-${major}-${Date.now()}${isZip ? '.zip' : '.tar.gz'}`);
			let extractDir: string | undefined;
			try {
				fs.mkdirSync(base, { recursive: true });
				await downloadFile(url, archive);
				extractDir = path.join(base, `.jdk-extract-${Date.now()}`);
				fs.mkdirSync(extractDir, { recursive: true });
				if (isZip) {
					await execFileAsync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${extractDir}' -Force`], { timeout: 10 * 60_000 });
				} else {
					await extractTarGz(archive, extractDir);
				}
				// Архив содержит один каталог вида jdk-25.0.x+y — приводим к java/jdk-<major>.
				const unpacked = extractDir;
				const inner = fs.readdirSync(unpacked).map(name => path.join(unpacked, name)).find(candidate => fs.statSync(candidate).isDirectory());
				if (!inner) { throw new Error(tr('JDK archive unpacked to nothing')); }
				fs.rmSync(dest, { recursive: true, force: true });
				fs.renameSync(inner, dest);
				extractDir = undefined;
				forgetServerJava();
				if (!fs.existsSync(javaExe)) { throw new Error(tr('JDK unpacked, but bin/java not found')); }
				return dest;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(tr('Toolchain installation failed: {0}', message));
				return undefined;
			} finally {
				fs.rmSync(archive, { force: true });
				if (extractDir) { fs.rmSync(extractDir, { recursive: true, force: true }); }
			}
		},
	);
}

/** Найденный/установленный сервер и команда его запуска. */
export async function resolveJavaServer(context: vscode.ExtensionContext, dataDir: string): Promise<ServerLaunch | undefined> {
	const setting = vscode.workspace.getConfiguration('auraKotlin').get<string>('javaLspPath', '').trim();
	const java = await pickServerJava(undefined, context);
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
	// jdtls пишет лог рядом с конфигурацией (config_win/config_linux/…), а не в dir/config.
	const candidates = [path.join(dir, 'config')];
	try {
		for (const entry of fs.readdirSync(dir)) {
			if (entry.startsWith('config')) { candidates.push(path.join(dir, entry)); }
		}
	} catch { /* каталога нет */ }
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

/** Идущая установка: повторный вызов возвращает тот же промис, а не качает второй раз. */
let javaServerInstall: Promise<string | undefined> | undefined;

/** Скачивает и распаковывает jdtls. Возвращает каталог сервера. */
export async function installJavaServer(context: vscode.ExtensionContext): Promise<string | undefined> {
	const existing = serverDir(context, 'downloaded');
	if (existing) { return existing; }
	// Двойной клик по кнопке или повторная команда раньше запускали вторую загрузку:
	// два архива, два распака в один каталог — и пустой .extract-* после гонки rename.
	javaServerInstall ??= doInstallJavaServer(context).finally(() => { javaServerInstall = undefined; });
	return javaServerInstall;
}

async function doInstallJavaServer(context: vscode.ExtensionContext): Promise<string | undefined> {
	const destBase = path.join(context.globalStorageUri.fsPath, 'java');
	return vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: tr('Downloading Java Language Server ({0})…', JAVA_SERVER_SIZE), cancellable: false },
		async () => {
			const archive = path.join(os.tmpdir(), `jdtls-${Date.now()}.tar.gz`);
			let extractDir: string | undefined;
			try {
				fs.mkdirSync(destBase, { recursive: true });
				// Обломки прерванных распаковок копятся в globalStorage — чистим перед новой.
				for (const entry of fs.readdirSync(destBase)) {
					if (entry.startsWith('.extract-')) { fs.rmSync(path.join(destBase, entry), { recursive: true, force: true }); }
				}
				await downloadFile(SERVER_URL, archive);
				extractDir = path.join(destBase, `.extract-${Date.now()}`);
				fs.mkdirSync(extractDir, { recursive: true });
				await extractTarGz(archive, extractDir);
				const dest = path.join(destBase, DIR_NAME);
				if (fs.existsSync(dest)) { fs.rmSync(dest, { recursive: true, force: true }); }
				fs.renameSync(extractDir, dest);
				extractDir = undefined;
				return launcherJar(dest) ? dest : undefined;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(tr('Java Language Server download failed: {0}', message));
				return undefined;
			} finally {
				fs.rmSync(archive, { force: true });
				if (extractDir) { fs.rmSync(extractDir, { recursive: true, force: true }); }
			}
		},
	);
}

/**
 * Скачивание файла с поддержкой редиректов (download.eclipse.org отдаёт через них).
 *
 * Сервер регулярно обрывает тело за десяток килобайт до конца: соединение просто
 * замолкает, ошибки нет. Поэтому не начинаем заново, а докачиваем остаток
 * Range-запросом — иначе 51 МБ качались заново на каждой попытке и установка
 * не завершалась никогда.
 */
export async function downloadFile(url: string, dest: string, attempts = 6): Promise<void> {
	let lastError: Error | undefined;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const have = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
		try {
			const total = await downloadOnce(url, dest, have);
			const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
			if (total > 0 && size !== total) { throw new Error(`incomplete download: ${size} of ${total} bytes`); }
			return;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			// 404/403 повторять бессмысленно — только сетевые обрывы и 5xx.
			if (/^HTTP (4\d\d)$/.test(lastError.message)) { fs.rmSync(dest, { force: true }); throw lastError; }
			if (attempt < attempts) { await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); }
		}
	}
	fs.rmSync(dest, { force: true });
	throw lastError ?? new Error('download failed');
}

/** Одна попытка: докачивает с offset, возвращает полный размер файла (0 — неизвестен). */
function downloadOnce(url: string, dest: string, from = 0): Promise<number> {
	return new Promise((resolve, reject) => {
		const follow = (target: string, redirects: number, offset: number): void => {
			if (redirects > 5) { reject(new Error('too many redirects')); return; }
			const mod = target.startsWith('https:') ? https : http;
			let settled = false;
			const fail = (error: Error): void => { if (!settled) { settled = true; reject(error); } };
			const done = (total: number): void => { if (!settled) { settled = true; resolve(total); } };
			const headers: Record<string, string> = offset > 0 ? { Range: `bytes=${offset}-` } : {};
			const request = mod.get(target, { headers }, response => {
				if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
					response.resume();
					follow(new URL(response.headers.location, target).toString(), redirects + 1, offset);
					return;
				}
				// 206 — сервер согласился докачивать; 200 — отдаёт файл целиком с нуля.
				const resume = response.statusCode === 206;
				if (response.statusCode !== 200 && !resume) { fail(new Error(`HTTP ${response.statusCode}`)); return; }
				const expected = Number(response.headers['content-length'] ?? 0);
				const total = expected > 0 ? (resume ? offset + expected : expected) : 0;
				let received = 0;
				const file = fs.createWriteStream(dest, { flags: resume ? 'a' : 'w' });
				const truncated = (): void => {
					file.destroy();
					fail(new Error(`incomplete download: ${(resume ? offset : 0) + received} of ${total || '?'} bytes`));
				};
				// Соединение может просто замолчать на середине (прокси, CDN): без таймаута
				// прогресс висел вечно, а архив оставался недокачанным. Тишина дольше 45 с — обрыв.
				request.setTimeout(45_000, () => { request.destroy(); truncated(); });
				response.on('data', chunk => { received += chunk.length; request.setTimeout(45_000); });
				response.on('aborted', truncated);
				response.on('error', truncated);
				response.pipe(file);
				file.on('finish', () => file.close(() => {
					if (expected > 0 && received !== expected) { truncated(); return; }
					done(total);
				}));
				file.on('error', error => fail(error));
			});
			request.on('timeout', () => { request.destroy(); fail(new Error('download timed out')); });
			request.on('error', error => fail(error));
		};
		follow(url, 0, from);
	});
}

/**
 * Распаковка .tar.gz системным tar (есть на Windows 10+, macOS и Linux).
 *
 * На Windows «tar» из PATH часто оказывается GNU tar из Git/MSYS: он читает «C:»
 * в пути как имя удалённого хоста и падает с «Cannot connect to C». Поэтому берём
 * системный bsdtar из System32, а если его нет — просим GNU tar не разбирать двоеточия.
 */
export async function extractTarGz(archive: string, destDir: string): Promise<void> {
	const systemTar = process.platform === 'win32'
		? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
		: undefined;
	const candidates = systemTar && fs.existsSync(systemTar)
		? [{ command: systemTar, args: [] as string[] }, { command: 'tar', args: ['--force-local'] }]
		: [{ command: 'tar', args: process.platform === 'win32' ? ['--force-local'] : [] }];
	let lastError: unknown;
	for (const candidate of candidates) {
		try {
			await execFileAsync(candidate.command, [...candidate.args, '-xzf', archive, '-C', destDir], { timeout: 10 * 60_000 });
			lastError = undefined;
			break;
		} catch (error) {
			lastError = error;
			// GNU tar без поддержки --force-local: повторяем без флага, чтобы не терять рабочий случай.
			if (candidate.args.length && /unrecognized option|invalid option/i.test(String(error))) {
				try {
					await execFileAsync(candidate.command, ['-xzf', archive, '-C', destDir], { timeout: 10 * 60_000 });
					lastError = undefined;
					break;
				} catch (retryError) { lastError = retryError; }
			}
		}
	}
	if (lastError) {
		throw new Error(tr('could not unpack {0}: {1}', path.basename(archive), lastError instanceof Error ? lastError.message : String(lastError)));
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
