/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — Этап 3: системный classpath из сборщиков Gradle / Maven.
 *  Фоновый разбор build.gradle / build.gradle.kts / pom.xml, резолв объявленных зависимостей
 *  в jar-файлы из локальных кэшей (~/.gradle и ~/.m2) и передача classpath в компиляцию kotlinc
 *  и в Kotlin Language Server. При изменении build-файла classpath пересобирается автоматически.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'pom.xml'];

/** Объявленная зависимость (group:artifact:version). */
export interface Dependency { group: string; artifact: string; version: string; scope: string }

export interface ClasspathResult {
	/** Резолвленные jar-файлы (из кэшей Gradle/Maven, отсортированы). */
	jars: string[];
	/** Резолв из кэшей не удался — добавить исходники в path вручную. */
	unresolved: Dependency[];
	/** Какой build-файл был разобран. */
	source: string;
}

/** Синхронизатор: следит за build-файлами и держит актуальный classpath. */
export class ClasspathSync implements vscode.Disposable {

	private watcher?: vscode.FileSystemWatcher;
	private statusbar: vscode.StatusBarItem | undefined;
	private readonly output = vscode.window.createOutputChannel('Aura Kotlin Classpath');
	private current: ClasspathResult = { jars: [], unresolved: [], source: '' };
	private syncing: Promise<ClasspathResult> | undefined;
	private readonly listeners = new Set<(classpath: ClasspathResult) => void>();

	constructor() { }

	dispose(): void {
		this.watcher?.dispose();
		this.statusbar?.dispose();
		this.output.dispose();
		this.listeners.clear();
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
		this.statusbar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 49);
		this.statusbar.name = 'Kotlin Dependencies';
		this.statusbar.command = 'auraKotlin.showClasspath';
		context.subscriptions.push(this.statusbar);

		const root = rootFolder();
		const pattern = root
			? new vscode.RelativePattern(vscode.Uri.file(root), `{${BUILD_FILES.join(',')}}`)
			: new vscode.RelativePattern(vscode.workspace.workspaceFolders![0], `{${BUILD_FILES.join(',')}}`);
		this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
		this.watcher.onDidChange(() => void this.sync('build file changed'));
		this.watcher.onDidCreate(() => void this.sync('build file created'));
		this.watcher.onDidDelete(() => this.reset());
		context.subscriptions.push(this.watcher);

		context.subscriptions.push(vscode.commands.registerCommand('auraKotlin.showClasspath', () => this.show()));
		context.subscriptions.push(vscode.commands.registerCommand('auraKotlin.syncDependencies', () => this.sync('manual sync')));

		void this.sync('startup');
	}

	/** Асинхронно пересобрать classpath (дедупликация одновременных запусков). */
	async sync(reason: string): Promise<ClasspathResult> {
		this.syncing ??= this.doSync(reason);
		return this.syncing;
	}

	private async doSync(reason: string): Promise<ClasspathResult> {
		try {
			const root = rootFolder();
			if (!root) { this.reset(); return this.current; }
			const buildFile = BUILD_FILES.map(name => path.join(root, name)).find(file => fs.existsSync(file));
			if (!buildFile) { this.reset(); return this.current; }

			const dependencies = path.basename(buildFile).endsWith('.xml') ? parsePom(fs.readFileSync(buildFile, 'utf8')) : parseGradle(fs.readFileSync(buildFile, 'utf8'));
			const { jars, unresolved } = resolveJars(dependencies);
			this.current = { jars, unresolved, source: path.basename(buildFile) };
			this.output.appendLine(`[classpath] ${reason}: ${this.current.source} → ${jars.length} jars, ${unresolved.length} unresolved`);
			this.updateStatus();
			for (const listener of this.listeners) { listener(this.current); }
			return this.current;
		} finally {
			this.syncing = undefined;
		}
	}

	private reset(): void {
		if (this.current.jars.length || this.current.unresolved.length) {
			this.current = { jars: [], unresolved: [], source: '' };
			this.updateStatus();
			for (const listener of this.listeners) { listener(this.current); }
		}
	}

	private updateStatus(): void {
		if (!this.statusbar) { return; }
		if (!this.current.source) { this.statusbar.hide(); return; }
		const missing = this.current.unresolved.length;
		this.statusbar.text = missing ? `$(library) ${this.current.jars.length} jars ⚠ ${missing}` : `$(library) ${this.current.jars.length} jars`;
		this.statusbar.tooltip = `${this.current.source}: ${this.current.jars.length} dependencies resolved${missing ? `, ${missing} not in local caches (run Gradle/Maven build once)` : ''}`;
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

// ---------- Разбор build.gradle / build.gradle.kts ----------

const GRADLE_CONFIGURATIONS = new Set(['implementation', 'api', 'compileOnly', 'runtimeOnly', 'classpath', 'testImplementation', 'kapt', 'compile', 'testCompile', 'debugImplementation', 'releaseImplementation']);

/**
 * Достаёт координаты group:artifact:version из declarations в Groovy/Kotlin DSL.
 * Понимает строки 'g:a:v' и map-аргументы group:…, name:…, version:…
 */
export function parseGradle(text: string): Dependency[] {
	const dependencies: Dependency[] = [];
	const statement = /(?:^|\n)\s*(\w+)\s*(?:\(|\s)([^\n]*)/g;
	for (const match of text.matchAll(statement)) {
		const configuration = match[1];
		if (!GRADLE_CONFIGURATIONS.has(configuration)) { continue; }
		const args = match[2];
		const stringForm = /['"]([\w.\-]+):([\w.\-]+):([\w.\-]+)['"]/.exec(args);
		if (stringForm) {
			dependencies.push({ group: stringForm[1], artifact: stringForm[2], version: stringForm[3], scope: configuration });
			continue;
		}
		const mapForm = /group\s*:\s*['"]([\w.\-]+)['"][,)]?\s*(?:name\s*:\s*['"]([\w.\-]+)['"])?/.exec(args);
		if (mapForm && mapForm[2]) {
			const versionForm = /version\s*:\s*['"]([\w.\-]+)['"]/.exec(args);
			if (versionForm) {
				dependencies.push({ group: mapForm[1], artifact: mapForm[2], version: versionForm[1], scope: configuration });
			}
		}
	}
	return dependencies;
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

function rootFolder(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
