/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — classpath проекта (этап 1 ТЗ).
 *  Основной источник classpath — сам Gradle через init-скрипт (полный резолв с транзитивными
 *  зависимостями и android.jar). Парсер build-файлов остаётся фолбэком, когда Gradle
 *  недоступен. Результат кэшируется на диск с ключом по mtime build-файлов.
 *-------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findGradleCommand } from './gradle';

const execFileAsync = promisify(execFile);

const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'pom.xml'];
const SETTINGS_FILES = ['settings.gradle', 'settings.gradle.kts'];
const CATALOG_FILE = path.join('gradle', 'libs.versions.toml');
const EXCLUDED_DIRS = new Set(['build', '.gradle', 'node_modules', '.git', '.idea', 'out', '.aura']);

/** Объявленная зависимость (group:artifact:version). */
export interface Dependency { group: string; artifact: string; version: string; scope: string }

/** Модуль проекта, обнаруженный по build-файлу. */
export interface ModuleInfo {
	/** Путь к каталогу модуля. */
	dir: string;
	/** Путь к build-файлу. */
	buildFile: string;
	/** Это Gradle-модуль (иначе Maven). */
	gradle: boolean;
	/** Android-модуль (AGP). */
	android: boolean;
	/** compileSdk из build-файла (для android.jar). */
	compileSdk?: number;
	/** applicationId (Android-модуль, если удалось получить). */
	applicationId?: string;
	/** jar-файлы classpath модуля. */
	jars: string[];
	/** Объявленные, но не найденные в кэшах зависимости (только режим парсера). */
	unresolved: Dependency[];
}

export interface ClasspathResult {
	/** Резолвленные jar-файлы (все модули, отсортированы, без дублей). */
	jars: string[];
	/** Зависимости, не найденные в локальных кэшах (режим парсера). */
	unresolved: Dependency[];
	/** Откуда взято: 'gradle' | 'parser' | имя build-файла | ''. */
	source: string;
	/** Обнаруженные модули. */
	modules: ModuleInfo[];
}

const EMPTY: ClasspathResult = { jars: [], unresolved: [], source: '', modules: [] };

interface CacheShape { fingerprint: string; result: ClasspathResult }

/** Синхронизатор: следит за build-файлами и держит актуальный classpath. */
export class ClasspathSync implements vscode.Disposable {

	private watcher?: vscode.FileSystemWatcher;
	private statusbar: vscode.StatusBarItem | undefined;
	private readonly output = vscode.window.createOutputChannel('Aura Kotlin Classpath');
	private current: ClasspathResult = EMPTY;
	private syncing: Promise<ClasspathResult> | undefined;
	private readonly listeners = new Set<(classpath: ClasspathResult) => void>();
	private storageDir?: string;
	private debounce?: NodeJS.Timeout;

	constructor() { }

	dispose(): void {
		this.watcher?.dispose();
		this.statusbar?.dispose();
		this.output.dispose();
		this.listeners.clear();
		if (this.debounce) { clearTimeout(this.debounce); }
	}

	/** Текущий (последний посчитанный) classpath. */
	get classpath(): ClasspathResult { return this.current; }

	/** Подписка на обновления (LSP перезапускается при смене classpath). */
	onDidChange(listener: (classpath: ClasspathResult) => void): vscode.Disposable {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	/** Запуск вотчера build-файлов и первичная синхронизация. */
	start(context: vscode.ExtensionContext): void {
		this.storageDir = context.storageUri?.fsPath;
		this.statusbar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 49);
		this.statusbar.name = 'Kotlin Dependencies';
		this.statusbar.command = 'auraKotlin.showClasspath';
		context.subscriptions.push(this.statusbar);

		const root = rootFolder();
		const base = root ? vscode.Uri.file(root) : vscode.workspace.workspaceFolders![0].uri;
		this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, '**/{build.gradle,build.gradle.kts,settings.gradle,settings.gradle.kts,pom.xml,libs.versions.toml}'));
		this.watcher.onDidChange(() => this.scheduleSync());
		this.watcher.onDidCreate(() => this.scheduleSync());
		this.watcher.onDidDelete(() => this.scheduleSync());
		context.subscriptions.push(this.watcher);

		context.subscriptions.push(vscode.commands.registerCommand('auraKotlin.showClasspath', () => this.show()));
		context.subscriptions.push(vscode.commands.registerCommand('auraKotlin.syncDependencies', () => { this.invalidateCache(); return this.sync(vscode.l10n.t('manual sync')); }));

		void this.sync(vscode.l10n.t('startup'));
	}

	/** Дебаунс пересборки при изменении build-файлов. */
	private scheduleSync(): void {
		if (this.debounce) { clearTimeout(this.debounce); }
		this.debounce = setTimeout(() => void this.sync(vscode.l10n.t('build file changed')), 1000);
	}

	/** Асинхронно пересобрать classpath (дедупликация одновременных запусков). */
	async sync(reason: string): Promise<ClasspathResult> {
		this.syncing ??= this.doSync(reason);
		return this.syncing;
	}

	private async doSync(reason: string): Promise<ClasspathResult> {
		try {
			const root = rootFolder();
			if (!root) { return this.publish(EMPTY, reason); }

			const modules = discoverModules(root);
			if (modules.length === 0) { return this.publish(EMPTY, reason); }

			// Кэш на диске: ключ — mtime всех build-файлов, settings и каталога версий.
			const fingerprint = await this.fingerprint(root, modules);
			const cached = this.loadCache(fingerprint);
			if (cached) {
				this.output.appendLine(`[classpath] ${reason}: cache hit (${cached.jars.length} jars, ${cached.modules.length} modules)`);
				return this.publish(cached, reason);
			}

			let result: ClasspathResult;
			try {
				result = await this.classpathViaGradle(root, modules);
				if (result.jars.length === 0) { throw new Error(vscode.l10n.t('Gradle returned no jars')); }
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.output.appendLine(`[classpath] Gradle unavailable/failed → parser fallback: ${message}`);
				result = this.classpathViaParser(modules);
			}
			this.saveCache(fingerprint, result);
			return this.publish(result, reason);
		} finally {
			this.syncing = undefined;
		}
	}

	private publish(result: ClasspathResult, reason: string): ClasspathResult {
		this.current = result;
		this.output.appendLine(`[classpath] ${reason}: ${result.source} → ${result.jars.length} jars, ${result.modules.length} modules, ${result.unresolved.length} unresolved`);
		this.updateStatus();
		for (const listener of this.listeners) { listener(result); }
		return result;
	}

	// ---------- Кэш на диске ----------

	private cachePath(): string | undefined {
		return this.storageDir ? path.join(this.storageDir, 'aura-classpath-cache.json') : undefined;
	}

	private async fingerprint(root: string, modules: Array<{ dir: string; buildFile: string; gradle: boolean }>): Promise<string> {
		const files = new Set<string>([...SETTINGS_FILES.map(name => path.join(root, name)), path.join(root, CATALOG_FILE)]);
		for (const module of modules) { files.add(module.buildFile); }
		const parts: string[] = [];
		for (const file of [...files].sort()) {
			try { parts.push(`${file}:${Math.round(fs.statSync(file).mtimeMs)}`); } catch { /* файла нет */ }
		}
		return parts.join('|');
	}

	private loadCache(fingerprint: string): ClasspathResult | undefined {
		const file = this.cachePath();
		if (!file || !fs.existsSync(file)) { return undefined; }
		try {
			const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as CacheShape;
			if (parsed.fingerprint !== fingerprint) { return undefined; }
			return parsed.result;
		} catch { return undefined; }
	}

	private saveCache(fingerprint: string, result: ClasspathResult): void {
		const file = this.cachePath();
		if (!file) { return; }
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, JSON.stringify({ fingerprint, result } satisfies CacheShape), 'utf8');
		} catch { /* кэш не критичен */ }
	}

	private invalidateCache(): void {
		const file = this.cachePath();
		if (file && fs.existsSync(file)) { try { fs.rmSync(file); } catch { /* ignore */ } }
	}

	// ---------- Основной путь: Gradle init-скрипт ----------

	private async classpathViaGradle(root: string, modules: Array<{ dir: string; buildFile: string; gradle: boolean }>): Promise<ClasspathResult> {
		const gradle = await findGradleCommand(root);
		if (!gradle) { throw new Error(vscode.l10n.t('gradlew or gradle not found')); }
		const initScript = writeInitScript();
		this.output.appendLine(`[classpath] running ${gradle.command} ${gradle.args.join(' ')} -I ${initScript} auraClasspath …`);

		const statusbar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 48);
		statusbar.text = '$(sync~spin) Gradle classpath';
		statusbar.show();

		try {
			const { stdout } = await execFileAsync(gradle.command, [...gradle.args, '-q', '-I', initScript, 'auraClasspath'], {
				cwd: root,
				timeout: 5 * 60_000,
				maxBuffer: 64 * 1024 * 1024,
			});
			return parseGradleClasspathOutput(stdout, modules, root);
		} finally {
			statusbar.dispose();
			try { fs.rmSync(initScript, { force: true }); } catch { /* ignore */ }
		}
	}

	// ---------- Фолбэк: парсер build-файлов ----------

	private classpathViaParser(modules: Array<{ dir: string; buildFile: string; gradle: boolean }>): ClasspathResult {
		const allJars = new Set<string>();
		const unresolved: Dependency[] = [];
		const resultModules: ModuleInfo[] = [];

		for (const module of modules) {
			const info: ModuleInfo = { ...module, android: false, jars: [], unresolved: [] };
			const text = readText(module.buildFile);
			if (text !== undefined) {
				if (module.gradle) {
					const isRoot = path.dirname(module.buildFile) === rootFolderSafe();
					const catalog = readCatalog(isRoot ? path.join(path.dirname(module.buildFile), CATALOG_FILE) : undefined);
					const dependencies = parseGradle(text, { catalog, localVariables: extractGradleVariables(text) });
					const resolved = resolveJars(dependencies);
					info.jars = resolved.jars;
					unresolved.push(...resolved.unresolved);
				} else {
					const dependencies = parsePom(text);
					const resolved = resolveJars(dependencies);
					info.jars = resolved.jars;
					unresolved.push(...resolved.unresolved);
				}
				// android.jar для Android-модулей обязателен в classpath.
				const sdk = compileSdkOf(text);
				if (sdk) {
					info.compileSdk = sdk;
					info.android = true;
					const platformJar = androidJar(sdk);
					if (platformJar) { info.jars.push(platformJar); }
				}
			}
			resultModules.push(info);
			for (const jar of info.jars) { allJars.add(jar); }
		}
		return { jars: [...allJars].sort(), unresolved, source: 'parser', modules: resultModules };
	}

	// ---------- Статус / показ ----------

	private updateStatus(): void {
		if (!this.statusbar) { return; }
		if (!this.current.source) { this.statusbar.hide(); return; }
		const missing = this.current.unresolved.length;
		this.statusbar.text = missing ? `$(library) ${this.current.jars.length} jars ⚠ ${missing}` : `$(library) ${this.current.jars.length} jars`;
		this.statusbar.tooltip = new vscode.MarkdownString(`${this.current.source}: ${this.current.jars.length} ${vscode.l10n.t('dependencies resolved')}${missing ? `, ${missing} ${vscode.l10n.t('not in local caches')}` : ''}`);
		this.statusbar.show();
	}

	private show(): void {
		if (!this.current.source) {
			void vscode.window.showInformationMessage(vscode.l10n.t('No Gradle or Maven build file in the workspace root.'), { modal: true });
			return;
		}
		const list = this.current.jars.length
			? this.current.jars.map(jar => `• ${path.basename(jar)}`).join('\n')
			: vscode.l10n.t('No jars resolved yet.');
		const missing = this.current.unresolved.length
			? '\n\n' + vscode.l10n.t('Not found in local caches:') + '\n' + this.current.unresolved.map(dep => `• ${dep.group}:${dep.artifact}:${dep.version}`).join('\n')
			: '';
		void vscode.window.showInformationMessage(`${this.current.source}\n\n${list}${missing}`, { modal: true });
	}
}

// ---------- Обнаружение модулей ----------

/** Рекурсивный поиск build-файлов по всем модулям workspace (без build/.gradle/node_modules). */
export function discoverModules(root: string): Array<{ dir: string; buildFile: string; gradle: boolean }> {
	const found: Array<{ dir: string; buildFile: string; gradle: boolean }> = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 8) { return; }
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				if (BUILD_FILES.includes(entry.name)) {
					found.push({ dir, buildFile: path.join(dir, entry.name), gradle: !entry.name.endsWith('.xml') });
				}
				continue;
			}
			if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) { continue; }
			walk(path.join(dir, entry.name), depth + 1);
		}
	};
	walk(root, 0);
	// Если есть settings.gradle — оставляем только перечисленные там модули (плюс корень).
	const settings = SETTINGS_FILES.map(name => path.join(root, name)).find(file => fs.existsSync(file));
	if (settings) {
		const includes = parseSettingsIncludes(readText(settings) ?? '');
		if (includes.length) {
			const allowed = new Set([root, ...includes.map(rel => path.resolve(root, rel.replace(/:/g, '/')))]);
			return found.filter(module => allowed.has(path.resolve(module.dir)));
		}
	}
	return found;
}

/** include ':app', include(":feature:login") из settings.gradle(.kts). */
export function parseSettingsIncludes(text: string): string[] {
	const includes: string[] = [];
	// include может перечислять несколько модулей: include ':app', ':core'; include(":a", ":b")
	for (const match of text.matchAll(/(?:^|\n)\s*include\s*\(?([^\n)]*)/g)) {
		for (const quoted of match[1].matchAll(/['"]([^'"]+)['"]/g)) {
			includes.push(quoted[1]);
		}
	}
	return includes;
}

// ---------- Разбор build.gradle / build.gradle.kts ----------

const GRADLE_CONFIGURATIONS = new Set(['implementation', 'api', 'compileOnly', 'runtimeOnly', 'classpath', 'testImplementation', 'kapt', 'compile', 'testCompile', 'debugImplementation', 'releaseImplementation']);

export interface GradleParseContext {
	/** Координаты из version catalog: 'core-ktx' → { module: 'androidx.core:core-ktx', version: '1.15.0' }. */
	catalog?: Map<string, { module: string; version?: string }>;
	/** Локальные переменные build-файла: имя → значение. */
	localVariables?: Map<string, string>;
}

/**
 * Достаёт координаты group:artifact:version из declarations в Groovy/Kotlin DSL.
 * Понимает строки 'g:a:v', map-аргументы, libs.* из version catalog и переменные версий.
 */
export function parseGradle(text: string, context?: GradleParseContext): Dependency[] {
	const variables = context?.localVariables ?? new Map<string, string>();
	const catalog = context?.catalog ?? new Map<string, { module: string; version?: string }>();
	const dependencies: Dependency[] = [];
	const statement = /(?:^|\n)\s*(\w+)\s*(?:\(|\s)([^\n]*)/g;
	for (const match of text.matchAll(statement)) {
		const configuration = match[1];
		if (!GRADLE_CONFIGURATIONS.has(configuration)) { continue; }
		const args = match[2];
		const stringForm = /['"]([\w.\-]+):([\w.\-]+):([^'"]+)['"]/.exec(args);
		if (stringForm) {
			dependencies.push({ group: stringForm[1], artifact: stringForm[2], version: resolveVariable(stringForm[3].trim(), variables), scope: configuration });
			continue;
		}
		const mapForm = /group\s*:\s*['"]([\w.\-]+)['"][,)]?\s*(?:name\s*:\s*['"]([\w.\-]+)['"])?/.exec(args);
		if (mapForm && mapForm[2]) {
			const versionForm = /version\s*:\s*['"]([\w.\-]+)['"]/.exec(args);
			if (versionForm) {
				dependencies.push({ group: mapForm[1], artifact: mapForm[2], version: resolveVariable(versionForm[1], variables), scope: configuration });
			}
			continue;
		}
		// version catalog: implementation(libs.androidx.core.ktx) или libs.foo.bar
		const catalogForm = /\blibs\.([\w.]+)/.exec(args);
		if (catalogForm) {
			const alias = catalogForm[1];
			const entry = catalog.get(alias) ?? catalog.get(alias.replace(/\./g, '-'));
			if (entry) {
				const [group, artifact, ...rest] = entry.module.split(':');
				const version = resolveVariable(entry.version ?? rest.join(':') ?? '', variables);
				if (group && artifact) { dependencies.push({ group, artifact, version, scope: configuration }); }
			}
		}
	}
	return dependencies;
}

function resolveVariable(value: string, variables: Map<string, string>): string {
	if (/^\$\{?[\w.]+\}?$/.test(value) || /^[$]/.test(value)) {
		const name = value.replace(/[$ {}:]/g, '');
		return variables.get(name) ?? value;
	}
	return value;
}

/** Локальные переменные/версии: ext { foo = "1.2" }, def foo = "1.2", val foo = "1.2", foo = "1.2" в ext-блоке. */
export function extractGradleVariables(text: string): Map<string, string> {
	const variables = new Map<string, string>();
	// ext-блоки (Groovy): внутри блока строки key = "value" / key 'value'.
	for (const block of text.matchAll(/ext\s*\{([^}]*)\}/g)) {
		for (const line of block[1].matchAll(/([\w.]+)\s*=?\s*['"]([^'"]+)['"]/g)) {
			variables.set(line[1], line[2]);
			variables.set(line[1].split('.').pop() ?? line[1], line[2]);
		}
	}
	// def/val/var присваивания строк.
	for (const match of text.matchAll(/(?:def|val|var)\s+([\w.]+)\s*(?::[^=]+)?=\s*['"]([^'"]+)['"]/g)) {
		variables.set(match[1], match[2]);
	}
	// Присваивание ext.foo = "1.2" и project.ext["foo"] = "1.2".
	for (const match of text.matchAll(/ext\.([\w.]+)\s*=\s*['"]([^'"]+)['"]/g)) {
		variables.set(match[1], match[2]);
	}
	return variables;
}

// ---------- Version catalog: gradle/libs.versions.toml ----------

/** Читает gradle/libs.versions.toml: алиас → { module, version } (с учётом version.ref). */
export function readCatalog(catalogPath?: string): Map<string, { module: string; version?: string }> {
	const result = new Map<string, { module: string; version?: string }>();
	const file = catalogPath ?? (rootFolder() ? path.join(rootFolder()!, CATALOG_FILE) : undefined);
	if (!file || !fs.existsSync(file)) { return result; }
	const text = readText(file);
	if (!text) { return result; }

	const versions = new Map<string, string>();
	let section = '';
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) { continue; }
		const sectionMatch = /^\[([\w.\-]+)\]$/.exec(line);
		if (sectionMatch) { section = sectionMatch[1]; continue; }
		const kv = /^([\w.\-]+)\s*=\s*(.+)$/.exec(line);
		if (!kv) { continue; }
		const [, key, rawValue] = kv;
		const value = rawValue.trim().replace(/^['"]|['"]$/g, '');
		if (section === 'versions') {
			versions.set(key, value);
		} else if (section === 'libraries') {
			// Формат: alias = { module = "g:a", version = "1.2" | { strictly = "…" } | version.ref = "ref" }
			const module = /module\s*=\s*["']([^"']+)["']/.exec(rawValue)?.[1];
			if (module) {
				let version: string | undefined = /version\s*=\s*["']([^"']+)["']/.exec(rawValue)?.[1];
				const ref = /version\.ref\s*=\s*["']([^"']+)["']/.exec(rawValue)?.[1];
				if (ref) { version = versions.get(ref) ?? ref; }
				result.set(key, { module, version });
				result.set(key.replace(/-/g, '.'), { module, version });
			} else {
				// Короткая форма: alias = "g:a:v"
				const parts = value.split(':');
				if (parts.length === 3) { result.set(key, { module: `${parts[0]}:${parts[1]}`, version: parts[2] }); result.set(key.replace(/-/g, '.'), { module: `${parts[0]}:${parts[1]}`, version: parts[2] }); }
			}
		}
	}
	return result;
}

// ---------- Разбор pom.xml ----------

/** Достаёт <dependency> (group, artifact, version) из pom.xml; version может быть в dependencyManagement. */
export function parsePom(text: string): Dependency[] {
	const dependencies: Dependency[] = [];
	const managedVersions = new Map<string, string>();
	const blocks = [...text.matchAll(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g)].map(m => m[0]);
	for (const block of blocks) {
		for (const dep of depBlocks(block)) {
			const version = tag(dep, 'version');
			if (version && !version.startsWith('${')) { managedVersions.set(`${tag(dep, 'groupId')}:${tag(dep, 'artifactId')}`, version); }
		}
	}
	const projectProperties = new Map<string, string>();
	for (const prop of text.matchAll(/<([A-Za-z][\w.\-]*)>([^<{}]+)<\/\1>/g)) {
		projectProperties.set(prop[1], prop[2].trim());
	}
	const mainBody = text.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '');
	for (const dep of depBlocks(mainBody)) {
		const group = tag(dep, 'groupId');
		const artifact = tag(dep, 'artifactId');
		if (!group || !artifact) { continue; }
		const scope = tag(dep, 'scope') ?? 'compile';
		let version = tag(dep, 'version') ?? managedVersions.get(`${group}:${artifact}`);
		if (version?.startsWith('${') && version.endsWith('}')) {
			version = projectProperties.get(version.slice(2, -1)) ?? version;
		}
		if (version && !version.startsWith('${')) {
			dependencies.push({ group, artifact, version, scope });
		}
	}
	return dependencies;
}

function depBlocks(text: string): string[] {
	return [...text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)].map(match => match[1]);
}

function tag(block: string, name: string): string | undefined {
	return new RegExp(`<${name}>([^<]+)</${name}>`).exec(block)?.[1].trim();
}

// ---------- Gradle init-скрипт ----------

const INIT_SCRIPT_MARKER = '===AURA-CP';
const APPID_MARKER = 'AURA-APPID';

/** Генерирует init-скрипт с задачей auraClasspath: полный резолв classpath каждого модуля. */
export function writeInitScript(): string {
	const script = `// Aura IDE classpath init script
allprojects {
    tasks.register('auraClasspath') {
        doLast {
            def names = ['runtimeClasspath', 'compileClasspath', 'runtime', 'compile', 'implementation']
            def cfg = null
            for (n in names) {
                def c = configurations.findByName(n)
                if (c != null && c.isCanBeResolved()) { cfg = c; break }
            }
            println "${INIT_SCRIPT_MARKER} \${project.path}"
            if (cfg != null) {
                try {
                    cfg.resolvedConfiguration.resolvedArtifacts.each { a ->
                        println a.file.absolutePath
                    }
                } catch (Exception e) {
                    println "${APPID_MARKER}-ERROR \${e.message}"
                }
            }
            def android = project.extensions.findByName('android')
            if (android != null) {
                try {
                    def appId = android.defaultConfig.applicationId
                    if (appId != null) { println "${APPID_MARKER} \${project.path} \${appId}" }
                } catch (Exception ignored) { }
            }
        }
    }
}
`;
	const file = path.join(os.tmpdir(), `aura-init-${process.pid}.gradle`);
	fs.writeFileSync(file, script, 'utf8');
	return file;
}

/** Gradle-путь проекта ':app' / ':feature:login' → относительный путь каталога. */
function projectPathToDir(projectPath: string, root: string): string {
	const rel = projectPath.replace(/^:/, '').replace(/:/g, '/');
	return rel ? path.resolve(root, rel) : path.resolve(root);
}

/** Разбор stdout Gradle: jar-файлы по модулям, applicationId, android.jar. */
export function parseGradleClasspathOutput(stdout: string, modules: Array<{ dir: string; buildFile: string; gradle: boolean }>, root: string): ClasspathResult {
	const jarsByDir = new Map<string, string[]>();
	const applicationIds = new Map<string, string>();
	let currentDir: string | undefined;
	for (const rawLine of stdout.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.startsWith(INIT_SCRIPT_MARKER)) {
			const projectPath = line.slice(INIT_SCRIPT_MARKER.length).trim();
			currentDir = projectPathToDir(projectPath, root);
			if (!jarsByDir.has(currentDir)) { jarsByDir.set(currentDir, []); }
			continue;
		}
		if (line.startsWith(APPID_MARKER) && !line.includes('-ERROR')) {
			const rest = line.slice(APPID_MARKER.length).trim().split(/\s+/);
			if (rest.length >= 2) {
				applicationIds.set(projectPathToDir(rest[0], root), rest[1]);
			}
			continue;
		}
		if (currentDir && /\.jar$/i.test(line) && fs.existsSync(line)) {
			jarsByDir.get(currentDir)!.push(line);
		}
	}

	const resultModules: ModuleInfo[] = [];
	const allJars = new Set<string>();
	for (const module of modules) {
		const jars = [...new Set(jarsByDir.get(path.resolve(module.dir)) ?? [])];
		const info: ModuleInfo = {
			...module,
			android: false,
			jars,
			unresolved: [],
			applicationId: applicationIds.get(path.resolve(module.dir)),
		};
		if (info.applicationId || jars.some(jar => jar.includes('android.jar'))) { info.android = true; }
		// android.jar из SDK по compileSdk (AGP не кладёт его в resolvedArtifacts).
		const text = readText(module.buildFile);
		if (text) {
			const sdk = compileSdkOf(text);
			if (sdk) {
				info.compileSdk = sdk;
				const platformJar = androidJar(sdk);
				if (platformJar && jars.some(jar => /androidx|com\.google\.android/.test(jar) || module.buildFile.replace(/\\/g, '/').includes('/app/'))) {
					info.jars.push(platformJar);
				}
			}
		}
		resultModules.push(info);
		for (const jar of info.jars) { allJars.add(jar); }
	}
	return { jars: [...allJars].sort(), unresolved: [], source: 'gradle', modules: resultModules };
}

/** compileSdk из build.gradle(.kts): compileSdk = 35 / compileSdkVersion 35. */
export function compileSdkOf(buildFileText: string): number | undefined {
	const match = /compileSdk(?:Version)?\s*=?\s*(\d+)/.exec(buildFileText);
	return match ? Number(match[1]) : undefined;
}

/** $ANDROID_HOME/platforms/android-<n>/android.jar. */
export function androidJar(compileSdk: number): string | undefined {
	const sdk = sdkRoot();
	if (!sdk) { return undefined; }
	const candidates = [path.join(sdk, 'platforms', `android-${compileSdk}`, 'android.jar'), path.join(sdk, 'platforms', 'android-35', 'android.jar')];
	return candidates.find(file => fs.existsSync(file));
}

/** Корень Android SDK: настройка → ANDROID_HOME → ANDROID_SDK_ROOT → local.properties → стандартные пути. */
export function sdkRoot(): string | undefined {
	const configured = vscode.workspace.getConfiguration('auraKotlin').get<string>('androidSdkPath', '').trim();
	const fromEnv = configured || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
	if (fromEnv && fs.existsSync(fromEnv)) { return fromEnv; }
	const root = rootFolder();
	if (root) {
		const localProps = path.join(root, 'local.properties');
		if (fs.existsSync(localProps)) {
			const sdkDir = /^\s*sdk\.dir\s*=\s*(.+)$/m.exec(readText(localProps) ?? '')?.[1]?.trim().replace(/\\\\/g, '\\');
			if (sdkDir && fs.existsSync(sdkDir)) { return sdkDir; }
		}
	}
	const home = os.homedir();
	const defaults = process.platform === 'win32'
		? [path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk')]
		: process.platform === 'darwin'
			? [path.join(home, 'Library', 'Android', 'sdk')]
			: [path.join(home, 'Android', 'Sdk')];
	return defaults.find(file => file && fs.existsSync(file));
}

// ---------- Резолв в локальных кэшах ----------

/** Кэши: ~/.gradle/caches/modules-2/files-2.1 и ~/.m2/repository. */
function cacheRoots(): string[] {
	const home = os.homedir();
	return [
		path.join(home, '.gradle', 'caches', 'modules-2', 'files-2.1'),
		path.join(home, '.m2', 'repository'),
	];
}

/**
 * Ищет jar зависимости в локальных кэшах. Gradle-кэш: files-2.1/group/artifact/version/<hash>/jar.
 * Maven: repository/group/artifact/version/artifact-version.jar.
 */
export function resolveJars(dependencies: Dependency[]): { jars: string[]; unresolved: Dependency[] } {
	const jars: string[] = [];
	const unresolved: Dependency[] = [];
	const roots = cacheRoots().filter(root => fs.existsSync(root));
	for (const dep of dependencies) {
		let found = false;
		for (const root of roots) {
			const jar = findJar(root, dep);
			if (jar) {
				jars.push(jar);
				found = true;
				break;
			}
		}
		if (!found) { unresolved.push(dep); }
	}
	return { jars: [...new Set(jars)].sort(), unresolved };
}

function findJar(root: string, dep: Dependency): string | undefined {
	const groupDir = path.join(root, ...dep.group.split('.'));
	const artifactDir = path.join(groupDir, dep.artifact);
	if (!fs.existsSync(artifactDir)) { return undefined; }
	// Version directory: точное совпадение, иначе новейшая доступная.
	const versionDir = path.join(artifactDir, dep.version);
	const versionCandidates = fs.existsSync(versionDir) ? [versionDir] : fs.readdirSync(artifactDir)
		.filter(name => fs.statSync(path.join(artifactDir, name)).isDirectory())
		.map(name => ({ name, stat: path.join(artifactDir, name) }))
		.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
		.slice(0, 1)
		.map(entry => entry.stat);
	for (const dir of versionCandidates) {
		const jar = findFileRecursive(dir, file => file.toLowerCase().endsWith('.jar') && !file.endsWith('.sources.jar'));
		if (jar) { return jar; }
	}
	return undefined;
}

function findFileRecursive(dir: string, predicate: (file: string) => boolean): string | undefined {
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return undefined; }
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isFile() && predicate(entry.name)) { return full; }
		if (entry.isDirectory()) {
			const nested = findFileRecursive(full, predicate);
			if (nested) { return nested; }
		}
	}
	return undefined;
}

// ---------- Утилиты ----------

function readText(file: string): string | undefined {
	try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}

function rootFolder(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function rootFolderSafe(): string { return rootFolder() ?? ''; }
