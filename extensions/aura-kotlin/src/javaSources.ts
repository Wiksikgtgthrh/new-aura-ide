/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — приложение исходников к classpath Java Language Server.
 *
 *  Без source attachment (sourcepath) Eclipse JDT знает только сигнатуры: переход к определению
 *  по android.jar и androidx уводит в «сгенерированный» класс, а hover пустой, потому что javadoc
 *  JDT берёт из исходников. Исходники берём оттуда же, откуда их берёт Android Studio:
 *    • android.jar      → пакет `sources;android-<api>` из репозитория Android SDK;
 *    • androidx/Google  → `-sources.jar` из Google Maven (Maven Central — для остального);
 *    • уже скачанные    → файлы в кэше Gradle (modules-2) рядом с самим артефактом.
 *
 *  Скачивание не блокирует старт сервера: сначала подключаем то, что уже есть на диске,
 *  остальное догружается фоном и подключается перезапуском (см. javaLsp.ts).
 *-------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import { extractZipAll } from './zipMember';
import { downloadFile } from './javaInstall';

const GOOGLE_MAVEN = 'https://dl.google.com/dl/android/maven2';
const MAVEN_CENTRAL = 'https://repo1.maven.org/maven2';
const ANDROID_REPOSITORY = 'https://dl.google.com/android/repository/';
const SOURCES_JAR_SUFFIX = '-sources.jar';
/** Пакет исходников платформы весит ~45 МБ — предупреждаем заранее. */
export const PLATFORM_SOURCES_SIZE = '~45 MB';

export interface Coordinates { group: string; artifact: string; version: string }

export interface MissingPlatform { api: number; dir: string; entries: string[] }

export interface SourcesPlan {
	/** classpath-запись → исходники (каталог дерева исходников или sources-jar). */
	attached: Map<string, string>;
	/** Исходники платформы, которых нет: api и каталог, куда их ставить. */
	platform: MissingPlatform[];
	/** Артефакты, которые можно скачать из репозиториев. */
	downloadable: Array<{ file: string; candidates: string[]; coords: Coordinates }>;
	/** Записи, для которых исходников не найти (ни локально, ни в репозиториях). */
	unresolved: string[];
}

function exists(value: string): boolean {
	try {
		return fs.existsSync(value);
	} catch {
		return false;
	}
}

function slash(value: string): string {
	return value.replace(/\\/g, '/');
}

/**
 * Координаты артефакта из пути кэша Gradle: `…/files-2.1/<group>/<artifact>/<version>/<sha1>/<file>`.
 * Тот же http-URL из координат восстанавливается однозначно, поэтому кэш и есть наш индекс.
 */
export function coordinatesOf(file: string): Coordinates | undefined {
	const marker = '/files-2.1/';
	const normalized = slash(file);
	const index = normalized.lastIndexOf(marker);
	if (index < 0) { return undefined; }
	const parts = normalized.slice(index + marker.length).split('/');
	if (parts.length < 4) { return undefined; }
	return { group: parts[0], artifact: parts[1], version: parts[2] };
}

/** Исходники, уже лежащие в кэше Gradle рядом с артефактом (их кладёт Android Studio). */
export function cachedSourcesOf(file: string): string | undefined {
	const coords = coordinatesOf(file);
	const entry = exists(file) ? (fs.statSync(file).isDirectory() ? file : path.dirname(file)) : path.dirname(file);
	if (!coords) {
		// Плоский jar: `lib/foo-1.2.3.jar` + `lib/foo-1.2.3-sources.jar`.
		const candidate = path.join(path.dirname(file), `${path.basename(file).replace(/\.(jar|aar)$/i, '')}${SOURCES_JAR_SUFFIX}`);
		return exists(candidate) ? candidate : undefined;
	}
	// Gradle раскладывает файлы одного артефакта по подкаталогам с sha1, поэтому смотрим
	// и каталог самого файла, и все соседние подкаталоги каталога версии.
	const versionDir = path.dirname(entry);
	const wanted = `${coords.artifact}-${coords.version}${SOURCES_JAR_SUFFIX}`;
	const direct = path.join(entry, wanted);
	if (exists(direct)) { return direct; }
	let subdirs: fs.Dirent[] = [];
	try {
		subdirs = fs.readdirSync(versionDir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	for (const child of subdirs) {
		if (!child.isDirectory()) { continue; }
		const candidate = path.join(versionDir, child.name, wanted);
		if (exists(candidate)) { return candidate; }
	}
	return undefined;
}

/** URL-кандидаты sources-jar: сначала Google Maven (androidx), затем Maven Central. */
export function sourcesUrls(coords: Coordinates): string[] {
	const relative = `${coords.group.replace(/\./g, '/')}/${coords.artifact}/${coords.version}/${coords.artifact}-${coords.version}${SOURCES_JAR_SUFFIX}`;
	const google = `${GOOGLE_MAVEN}/${relative}`;
	const central = `${MAVEN_CENTRAL}/${relative}`;
	const googleGroup = /^(androidx|com\.android|com\.google\.android|com\.google\.firebase)/.test(coords.group);
	return googleGroup ? [google, central] : [central, google];
}

/** Уровень API платформы из пути `…/platforms/android-<n>/android.jar`. */
export function platformApiOf(file: string): number | undefined {
	if (path.basename(file).toLowerCase() !== 'android.jar') { return undefined; }
	const parent = path.basename(path.dirname(file));
	const match = /^android-(\d+)/.exec(parent);
	return match ? Number(match[1]) : undefined;
}

/**
 * Корень дерева исходников внутри каталога пакета: у пакетов платформы файлы лежат
 * и в `android-<api>/`, и в `android-<api>/src/` — ищем каталог, где есть android/widget/TextView.java.
 */
function sourceTreeRoot(dir: string): string | undefined {
	for (const candidate of [dir, path.join(dir, 'src')]) {
		if (exists(path.join(candidate, 'android', 'widget', 'TextView.java'))) { return candidate; }
	}
	try {
		for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!child.isDirectory()) { continue; }
			const nested = path.join(dir, child.name);
			if (exists(path.join(nested, 'android', 'widget', 'TextView.java'))) { return nested; }
		}
	} catch { /* каталога нет */ }
	return undefined;
}

/** Установленные пакеты исходников платформы: api → корень дерева исходников. */
export function installedPlatformSources(sdkRoot: string | undefined): Map<number, string> {
	const found = new Map<number, string>();
	if (!sdkRoot) { return found; }
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(path.join(sdkRoot, 'sources'), { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) { continue; }
		const match = /^android-(\d+)/.exec(entry.name);
		if (!match) { continue; }
		const root = sourceTreeRoot(path.join(sdkRoot, 'sources', entry.name));
		if (root) { found.set(Number(match[1]), root); }
	}
	return found;
}

/** Каталог, куда ставится пакет исходников: SDK, а если он недоступен на запись — globalStorage. */
export function platformSourcesDir(sdkRoot: string | undefined, storageRoot: string, api: number): string {
	const inSdk = sdkRoot ? path.join(sdkRoot, 'sources', `android-${api}`) : undefined;
	if (inSdk && writableDirectory(path.dirname(inSdk))) { return inSdk; }
	return path.join(storageRoot, 'java', 'sources', `android-${api}`);
}

function writableDirectory(dir: string): boolean {
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.accessSync(dir, fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

let manifestCache: string[] | undefined;

/** Текст манифеста репозитория Android SDK (там же, где sdkmanager берёт пакеты). */
async function repositoryManifest(): Promise<string[]> {
	if (manifestCache) { return manifestCache; }
	const names = ['repository2-3.xml', 'repository2-1.xml'];
	const texts: string[] = [];
	for (const name of names) {
		try {
			texts.push(await fetchText(`${ANDROID_REPOSITORY}${name}`));
		} catch { /* репозиторий недоступен — попробуем запасной */ }
	}
	manifestCache = texts;
	return texts;
}

/** URL архива с исходниками платформы для нужного API (имя файла у Google плавает: source-35, sources-34). */
export async function platformSourcesUrl(api: number): Promise<string[]> {
	const candidates: string[] = [];
	for (const text of await repositoryManifest()) {
		const block = new RegExp(`<remotePackage path="sources;android-${api}">([\\s\\S]*?)</remotePackage>`).exec(text)?.[1];
		if (!block) { continue; }
		const urls = [...block.matchAll(/<url>([^<]+\.zip)<\/url>/g)].map(match => ANDROID_REPOSITORY + match[1]);
		if (urls.length) { candidates.push(urls[urls.length - 1]); }
	}
	candidates.push(`${ANDROID_REPOSITORY}sources-${api}_r01.zip`, `${ANDROID_REPOSITORY}source-${api}_r01.zip`);
	return [...new Set(candidates)];
}

/**
 * Что можно подключить прямо сейчас и что нужно скачать. Сетевых вызовов здесь нет:
 * это дешёвая операция, которую можно звать на каждый пересбор shadow-проекта.
 * `cacheDir` — наш собственный каталог скачанных sources-jar: то, что там уже лежит,
 * считается подключённым, иначе после каждой загрузки планировался бы новый круг.
 */
export function planSources(entries: string[], options: { sdkRoot?: string; storageRoot: string }): SourcesPlan {
	const plan: SourcesPlan = { attached: new Map(), platform: [], downloadable: [], unresolved: [] };
	const cacheDir = sourcesCacheDir(options.storageRoot);
	const installed = installedPlatformSources(options.sdkRoot);
	const missingPlatform = new Map<number, MissingPlatform>();
	for (const entry of entries) {
		const api = platformApiOf(entry);
		if (api !== undefined) {
			const root = installed.get(api);
			if (root) { plan.attached.set(entry, root); } else {
				const missing = missingPlatform.get(api) ?? { api, dir: platformSourcesDir(options.sdkRoot, options.storageRoot, api), entries: [] };
				missing.entries.push(entry);
				missingPlatform.set(api, missing);
			}
			continue;
		}
		const cached = cachedSourcesOf(entry);
		if (cached) { plan.attached.set(entry, cached); continue; }
		const coords = coordinatesOf(entry);
		if (!coords) {
			plan.unresolved.push(entry);
			continue;
		}
		const downloaded = cachedTargetFor(cacheDir, coords);
		if (exists(downloaded)) { plan.attached.set(entry, downloaded); continue; }
		plan.downloadable.push({ file: entry, candidates: sourcesUrls(coords), coords });
	}
	// Свежий API первым: чаще всего нужен именно он.
	for (const missing of [...missingPlatform.values()].sort((a, b) => b.api - a.api)) {
		plan.platform.push(missing);
	}
	return plan;
}

/** Наш каталог скачанных исходников (внутри globalStorage расширения). */
export function sourcesCacheDir(storageRoot: string): string {
	return path.join(storageRoot, 'java', 'sources');
}

export interface DownloadOptions {
	token?: { isCancellationRequested: boolean; onCancellationRequested: (listener: () => void) => void };
	onProgress?: (done: number, total: number, subject: string) => void;
	/** Ставить исходники платформы (крупная загрузка). */
	platform?: boolean;
}

export interface DownloadResult {
	/** classpath-запись → исходники. */
	attached: Map<string, string>;
	platformAttached: Map<string, string>;
	downloaded: number;
	failed: string[];
	platformInstalled: string[];
	sizes: { bytes: number };
}

/** Каталог кэша исходников артефакта: `<cache>/<group>/<artifact>/<version>/<artifact>-<version>-sources.jar`. */
function cachedTargetFor(cacheDir: string, coords: Coordinates): string {
	return path.join(cacheDir, coords.group, coords.artifact, coords.version, `${coords.artifact}-${coords.version}${SOURCES_JAR_SUFFIX}`);
}

/**
 * Скачивает недостающие исходники. Исходники платформы (десятки мегабайт) — только при
 * `platform: true`, потому что это заметная загрузка; библиотеки мелкие и идут всегда.
 */
export async function downloadSources(plan: SourcesPlan, cacheDir: string, options: DownloadOptions = {}): Promise<DownloadResult> {
	const result: DownloadResult = { attached: new Map(), platformAttached: new Map(), downloaded: 0, failed: [], platformInstalled: [], sizes: { bytes: 0 } };
	const cancelled = () => options.token?.isCancellationRequested === true;
	const total = plan.downloadable.length + (options.platform ? plan.platform.length : 0);
	let done = 0;

	for (const item of plan.downloadable) {
		if (cancelled()) { break; }
		options.onProgress?.(done, total, path.basename(item.file));
		const target = cachedTargetFor(cacheDir, item.coords);
		if (exists(target)) {
			result.attached.set(item.file, target);
			done++;
			continue;
		}
		let saved = false;
		for (const url of item.candidates) {
			if (await saveSourceJar(url, target)) {
				result.attached.set(item.file, target);
				result.downloaded++;
				saved = true;
				break;
			}
		}
		if (!saved) { result.failed.push(item.coords.artifact); }
		done++;
	}

	if (options.platform) {
		for (const missing of plan.platform) {
			if (cancelled()) { break; }
			options.onProgress?.(done, total, `Android ${missing.api}`);
			try {
				const root = await installPlatformSources(missing.api, missing.dir);
				for (const entry of missing.entries) { result.platformAttached.set(entry, root); }
				result.platformInstalled.push(missing.dir);
				result.sizes.bytes += platformBytes(missing.dir);
			} catch {
				result.failed.push(`Android ${missing.api}`);
			}
			done++;
		}
		options.onProgress?.(done, total, '');
	}
	return result;
}

function platformBytes(dir: string): number {
	let total = 0;
	const pending = [dir];
	while (pending.length) {
		const current = pending.pop()!;
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) { pending.push(full); continue; }
			try { total += fs.statSync(full).size; } catch { /* файл исчез */ }
		}
	}
	return total;
}

/** Скачивает один sources-jar. Временный файл — чтобы обрыв не оставил «полуjar» в кэше. */
async function saveSourceJar(url: string, target: string): Promise<boolean> {
	const temp = `${target}.part`;
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		await downloadFile(url, temp);
		// Многие артефакты sources не публикуют: сервер отвечает HTML-страницей, а не архивом.
		if (!isZip(temp) || fs.statSync(temp).size < 64) {
			fs.rmSync(temp, { force: true });
			return false;
		}
		fs.renameSync(temp, target);
		return true;
	} catch {
		try { fs.rmSync(temp, { force: true }); } catch { /* уже нет */ }
		return false;
	}
}

function isZip(file: string): boolean {
	try {
		const handle = fs.openSync(file, 'r');
		const head = Buffer.alloc(2);
		fs.readSync(handle, head, 0, 2, 0);
		fs.closeSync(handle);
		return head[0] === 0x50 && head[1] === 0x4b;
	} catch {
		return false;
	}
}

/** Ставит пакет исходников платформы: скачивает zip и распаковывает его в каталог пакета. */
export async function installPlatformSources(api: number, destDir: string): Promise<string> {
	const urls = await platformSourcesUrl(api);
	const archive = path.join(os.tmpdir(), `aura-sources-${api}-${Date.now()}.zip`);
	let lastError: Error | undefined;
	for (const url of urls) {
		try {
			await downloadFile(url, archive);
			if (!isZip(archive)) { throw new Error('not a zip'); }
			lastError = undefined;
			break;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}
	if (lastError) {
		try { fs.rmSync(archive, { force: true }); } catch { /* уже нет */ }
		throw new Error(`Android ${api}: ${lastError.message}`);
	}

	// Распаковываем только то, что нужно Eclipse: дерево java-файлов. В архиве их ~15 000,
	// плюс xsd и META-INF — на диске это лишние сотни мегабайт.
	fs.rmSync(destDir, { recursive: true, force: true });
	fs.mkdirSync(destDir, { recursive: true });
	const { files, ok } = extractZipAll(archive, destDir, name => /\.(java|properties)$/i.test(name));
	fs.rmSync(archive, { force: true });
	if (!ok || files === 0) { throw new Error(`Android ${api}: не удалось распаковать исходники`); }
	const root = sourceTreeRoot(destDir);
	if (!root) { throw new Error(`Android ${api}: в архиве нет android/widget/TextView.java`); }
	return root;
}

/** Текстовый GET с поддержкой редиректов (нужен для манифеста репозитория SDK). */
function fetchText(url: string, redirects = 0): Promise<string> {
	return new Promise((resolve, reject) => {
		if (redirects > 5) { reject(new Error('too many redirects')); return; }
		const mod = url.startsWith('https:') ? https : http;
		mod.get(url, response => {
			if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
				response.resume();
				resolve(fetchText(new URL(response.headers.location, url).toString(), redirects + 1));
				return;
			}
			if (response.statusCode !== 200) { reject(new Error(`HTTP ${response.statusCode}`)); return; }
			const chunks: Buffer[] = [];
			response.on('data', chunk => chunks.push(chunk as Buffer));
			response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
			response.on('error', reject);
		}).on('error', reject);
	});
}
