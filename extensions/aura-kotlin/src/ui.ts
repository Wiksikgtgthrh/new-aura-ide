/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — UI-панель Android (этап 5 ТЗ).
 *  Контейнер в activity bar с иконкой Android; внутри дерево: устройства с индикаторами,
 *  модули проекта с быстрыми тасками, зависимости с пометкой нерезолвленных.
 *  Статус-бар: состояние LSP (запущен / падал / не установлен), клик — рестарт.
 *  Онбординг: один информативный баннер со списком чего не хватает и кнопками установки.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { tr } from './l10n';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { AndroidPanel, STARTING } from './android';
import { ClasspathSync, ModuleInfo } from './classpath';
import { LspState } from './lsp';
import { javaServerInstalled } from './javaInstall';
import { missingToolchain } from './toolchain';

type Node = DeviceNode | AvdNode | ModuleNode | JarNode | DependencyNode | SectionNode | ActionNode | FileNode;

/** Сколько живёт кэш списка файлов дерева (см. fileNodes). */
const FILE_CACHE_TTL_MS = 5_000;


interface SectionNode { kind: 'section'; id: 'devices' | 'emulators' | 'files' | 'modules' | 'deps'; label: string; }
interface FileNode { kind: 'file'; uri: vscode.Uri; }
interface DeviceNode { kind: 'device'; id: string; emulator: boolean; model: string; selected: boolean; }
interface AvdNode { kind: 'avd'; name: string; runningDevice?: string; }
interface ActionNode { kind: 'action'; label: string; icon: string; command: string; tooltip?: string; }
interface ModuleNode { kind: 'module'; module: ModuleInfo; }
interface JarNode { kind: 'jar'; name: string; file: string; unresolved?: boolean; }
interface DependencyNode { kind: 'dep'; name: string; version: string; }

export class AndroidTreeProvider implements vscode.TreeDataProvider<Node> {

	private readonly emitter = new vscode.EventEmitter<Node | undefined | void>();
	readonly onDidChangeTreeData = this.emitter.event;
	/** Ссылка для обновления дерева извне (после остановки/запуска AVD). */
	private treeView?: vscode.TreeView<Node>;
	/** Таймер живого опроса AVD, пока виден раздел «Эмуляторы». */
	private liveTimer?: NodeJS.Timeout;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly androidPanel: AndroidPanel,
		private readonly classpathSync: ClasspathSync,
	) {
		this.classpathSync.onDidChange(() => this.refresh());
		// Состояние AVD меняется и без наших команд (эмулятор гасится сам, стартует из другого окна):
		// без подписки дерево держало снимок с момента раскрытия и показывало «запущен» вечно.
		this.disposables.push(this.androidPanel.onDidChangeEmulators(() => this.refresh()));
	}

	/** Подключить дерево к его view: включаем живой опрос состояния эмуляторов. */
	attach(view: vscode.TreeView<Node>): void {
		this.treeView = view;
		// Кэш списка файлов живёт до первого изменения в проекте. Одних onDidCreateFiles мало:
		// они стреляют только на операции через API IDE, а файлы появляются и от git checkout,
		// Gradle и внешних редакторов — поэтому держим ещё и вотчер по тем же маскам.
		const invalidate = (): void => { this.fileCache = undefined; };
		this.disposables.push(
			view.onDidExpandElement(e => this.scheduleLivePoll(e.element)),
			view.onDidCollapseElement(e => { if (this.isEmulatorsSection(e.element)) { this.stopLivePoll(); } }),
			view.onDidChangeVisibility(() => {
				if (!view.visible) { this.stopLivePoll(); return; }
				this.refresh();
				this.scheduleLivePoll({ kind: 'section', id: 'emulators', label: '' });
			}),
			vscode.workspace.onDidCreateFiles(invalidate),
			vscode.workspace.onDidDeleteFiles(invalidate),
			vscode.workspace.onDidRenameFiles(invalidate),
			vscode.workspace.onDidChangeWorkspaceFolders(() => { invalidate(); this.refresh(); }),
		);
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (folder) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*.{kt,kts,java}'));
			const onDiskChange = (): void => { invalidate(); this.refresh(); };
			watcher.onDidCreate(onDiskChange);
			watcher.onDidDelete(onDiskChange);
			this.disposables.push(watcher);
		}
	}

	dispose(): void {
		this.stopLivePoll();
		for (const disposable of this.disposables) { disposable.dispose(); }
		this.disposables.length = 0;
		this.emitter.dispose();
	}

	private isEmulatorsSection(node: Node | undefined): boolean {
		return node?.kind === 'section' && node.id === 'emulators';
	}

	/** Раздел эмуляторов раскрыт — опрашиваем adb, чтобы «запущен/остановлен» был честным. */
	private scheduleLivePoll(node: Node | undefined): void {
		if (!this.isEmulatorsSection(node) || this.liveTimer) { return; }
		this.liveTimer = setInterval(() => { void this.livePoll(); }, AndroidPanel.REFRESH_INTERVAL_MS);
	}

	private stopLivePoll(): void {
		if (this.liveTimer) { clearInterval(this.liveTimer); this.liveTimer = undefined; }
	}

	private async livePoll(): Promise<void> {
		if (this.treeView && !this.treeView.visible) { this.stopLivePoll(); return; }
		// emulatorStates() сам сообщит подписчикам, если состояние изменилось — refresh придёт оттуда.
		try { await this.androidPanel.emulatorStates(); } catch { /* adb недоступен — следующий тик */ }
	}

	refresh(): void {
		this.emitter.fire();
	}

	getTreeItem(node: Node): vscode.TreeItem {
		switch (node.kind) {
			case 'section': {
				const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
				item.contextValue = 'section';
				return item;
			}
			case 'device': {
				const item = new vscode.TreeItem(node.id, vscode.TreeItemCollapsibleState.None);
				item.description = `${node.emulator ? 'emulator' : 'device'} · ${node.model}${node.selected ? ' · ✓' : ''}`;
				item.iconPath = new vscode.ThemeIcon(node.emulator ? 'vm' : 'device-mobile');
				item.contextValue = 'device';
				item.command = { command: 'auraKotlin.android.pickDevice', title: tr('Select device') };
				item.tooltip = tr('Click to select; inline buttons open the screen and logcat.');
				return item;
			}
			case 'avd': {
				const item = new vscode.TreeItem(node.name.replace(/_/g, ' '), vscode.TreeItemCollapsibleState.None);
				// Серийник есть, а sys.boot_completed ещё не пришёл — честнее показать «запускается»:
				// иначе дерево писало «running», когда запуск только начался или уже сломался.
				const starting = node.runningDevice === STARTING;
				const running = Boolean(node.runningDevice) && !starting;
				item.description = running ? `${tr('running')} · ${node.runningDevice}` : starting ? tr('starting…') : tr('stopped');
				item.iconPath = new vscode.ThemeIcon(running ? 'vm-running' : starting ? 'loading~spin' : 'vm');
				item.contextValue = running ? 'avdRunning' : starting ? 'avdBooting' : 'avd';
				item.command = running
					? { command: 'auraKotlin.android.deviceScreen', title: tr('Open device screen'), arguments: [node] }
					: starting
						? undefined
						: { command: 'auraKotlin.android.startAvd', title: tr('Start emulator'), arguments: [node] };
				item.tooltip = running ? tr('Click to open the device screen.')
					: starting ? tr('Booting — stop it from the context menu if it hangs.')
						: tr('Click to start the emulator.');
				return item;
			}
			case 'action': {
				const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon(node.icon);
				item.command = { command: node.command, title: node.label };
				item.tooltip = node.tooltip ?? node.label;
				return item;
			}
			case 'file': {
				const item = new vscode.TreeItem(path.basename(node.uri.fsPath), vscode.TreeItemCollapsibleState.None);
				const dir = vscode.workspace.asRelativePath(path.dirname(node.uri.fsPath), false);
				if (dir && dir !== '.') { item.description = dir; }
				item.iconPath = new vscode.ThemeIcon('file-code');
				item.contextValue = 'file';
				item.command = { command: 'vscode.open', title: tr('Open file'), arguments: [node.uri] };
				item.tooltip = node.uri.fsPath;
				return item;
			}
			case 'module': {
				const item = new vscode.TreeItem(path.basename(node.module.dir) || 'root', vscode.TreeItemCollapsibleState.Collapsed);
				item.description = node.module.gradle
					? (node.module.android ? `android · ${node.module.jars.length} jars` : `${node.module.jars.length} jars`)
					: `maven · ${node.module.jars.length} jars`;
				item.iconPath = new vscode.ThemeIcon(node.module.android ? 'android' : 'file-directory');
				item.contextValue = 'module';
				return item;
			}
			case 'jar': {
				const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
				if (node.unresolved) {
					item.iconPath = new vscode.ThemeIcon('warning');
					item.contextValue = 'unresolvedDep';
					item.tooltip = tr('Not found in local caches — run a Gradle build once.');
				} else {
					item.iconPath = new vscode.ThemeIcon('library');
					item.contextValue = 'jar';
					item.tooltip = node.file;
				}
				return item;
			}
			case 'dep': {
				const item = new vscode.TreeItem(`${node.name}:${node.version}`, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('warning');
				item.contextValue = 'unresolvedDep';
				item.tooltip = tr('Not found in local caches — run a Gradle build once.');
				return item;
			}
		}
	}

	async getChildren(node?: Node): Promise<Node[]> {
		if (!node) {
			return [
				{ kind: 'section', id: 'devices', label: tr('Devices') },
				{ kind: 'section', id: 'emulators', label: tr('Emulators') },
				{ kind: 'section', id: 'files', label: tr('Files') },
				{ kind: 'section', id: 'modules', label: tr('Modules') },
				{ kind: 'section', id: 'deps', label: tr('Dependencies') },
			];
		}
		if (node.kind === 'section') {
			switch (node.id) {
				case 'devices': return this.deviceNodes();
				case 'emulators': return this.emulatorNodes();
				case 'files': return this.fileNodes();
				case 'modules': return this.moduleNodes();
				case 'deps': return this.dependencyNodes();
			}
		}
		if (node.kind === 'module') {
			return node.module.jars.map(jar => ({ kind: 'jar', name: path.basename(jar), file: jar }));
		}
		return [];
	}

	private async deviceNodes(): Promise<Node[]> {
		const devices = await this.androidPanel.devices();
		const selected = this.androidPanel.selectedDevice;
		const nodes: Node[] = devices.map(device => ({ kind: 'device', id: device.id, emulator: device.emulator, model: device.model, selected: device.id === selected }));
		if (!devices.length) {
			nodes.push({ kind: 'action', label: tr('No devices connected'), icon: 'info', command: 'auraKotlin.android.devices' });
		}
		nodes.push({ kind: 'action', label: tr('Device screen…'), icon: 'device-mobile', command: 'auraKotlin.android.deviceScreen' });
		nodes.push({ kind: 'action', label: tr('Open logcat'), icon: 'output', command: 'auraKotlin.android.logcat' });
		return nodes;
	}

	private async emulatorNodes(): Promise<Node[]> {
		const states = await this.androidPanel.emulatorStates().catch(() => []);
		const nodes: Node[] = states.map(state => ({ kind: 'avd', name: state.name, runningDevice: state.runningDevice }));
		nodes.push({ kind: 'action', label: tr('Create emulator (AVD)…'), icon: 'add', command: 'auraKotlin.android.createAvd' });
		if (states.length) {
			nodes.push({ kind: 'action', label: tr('Stop all emulators'), icon: 'debug-stop', command: 'auraKotlin.android.stopEmulator' });
		}
		return nodes;
	}

	/** Список файлов: findFiles — обход всего проекта, а дерево перерисовывается на каждый
	 *  тик опроса AVD (раз в 3 с) и на каждое изменение classpath. Кэш на 5 с убирает
	 *  повторный обход, а вотчер файлов сбрасывает его сразу, как только список изменился. */
	private fileCache?: { at: number; uris: vscode.Uri[] };

	/** Файлы проекта: создание новых + быстрый переход к .kt/.kts/.java (независимо от Gradle). */
	private async fileNodes(): Promise<Node[]> {
		const nodes: Node[] = [
			{ kind: 'action', label: tr('New Kotlin/Java file…'), icon: 'add', command: 'auraKotlin.newFile' },
			{ kind: 'action', label: tr('New project…'), icon: 'project', command: 'auraKotlin.newProject' },
		];
		if (!vscode.workspace.workspaceFolders?.length) { return nodes; }
		let files = this.fileCache && Date.now() - this.fileCache.at < FILE_CACHE_TTL_MS ? this.fileCache.uris : undefined;
		if (!files) {
			files = await vscode.workspace.findFiles('**/*.{kt,kts,java}', '{**/out/**,**/build/**,**/.gradle/**,**/node_modules/**,**/.idea/**}', 80);
			files.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
			// main.kt — первым: это обычно точка входа.
			files.sort((a, b) => Number(/(^|[\\/])main\.kts?$/i.test(b.fsPath)) - Number(/(^|[\\/])main\.kts?$/i.test(a.fsPath)));
			this.fileCache = { at: Date.now(), uris: files };
		}
		for (const uri of files) { nodes.push({ kind: 'file', uri }); }
		return nodes;
	}

	private moduleNodes(): Node[] {
		const modules = this.classpathSync.classpath.modules;
		if (!modules.length) {
			return [{ kind: 'action', label: tr('No Gradle/Maven modules found'), icon: 'info', command: 'auraKotlin.syncDependencies' }];
		}
		return modules.map(module => ({ kind: 'module', module }));
	}

	private dependencyNodes(): Node[] {
		const result = this.classpathSync.classpath;
		const nodes: Node[] = result.modules.flatMap(module => module.jars.map(jar => ({ kind: 'jar', name: path.basename(jar), file: jar }) as Node));
		for (const dep of result.unresolved) {
			nodes.push({ kind: 'dep', name: `${dep.group}:${dep.artifact}`, version: dep.version });
		}
		return nodes.slice(0, 300);
	}
}

// ---------- Статус-бар LSP ----------

export interface LspStatusbarOptions {
	/** Короткая метка языка: «Kotlin», «Java». */
	label: string;
	/** Команда перезапуска по клику. */
	command: string;
	/** Приоритет справа. */
	priority: number;
	/** Полное имя сервера для подсказки. */
	server: string;
}

/** Статус-бар состояния LSP: запущен / падал / не установлен. Клик — рестарт. */
export function registerLspStatusbar(context: vscode.ExtensionContext, getState: () => LspState, onStateChange: vscode.Event<LspState>, options: LspStatusbarOptions): void {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, options.priority);
	item.name = `${options.label} LSP`;
	item.command = options.command;
	const update = (state: LspState) => {
		const map: Record<LspState, { icon: string; text: string }> = {
			running: { icon: 'check', text: tr('LSP running') },
			starting: { icon: 'sync~spin', text: tr('LSP starting') },
			crashed: { icon: 'error', text: tr('LSP crashed') },
			'not-installed': { icon: 'circle-slash', text: tr('LSP not installed') },
			stopped: { icon: 'circle-outline', text: tr('LSP stopped') },
		};
		const entry = map[state];
		item.text = `$(${entry.icon}) ${options.label} ${entry.text}`;
		item.tooltip = tr('{0} state: {1}. Click to restart.', options.server, state);
		item.show();
	};
	update(getState());
	context.subscriptions.push(item, onStateChange(update));
}

// ---------- Онбординг ----------

/** Один информативный баннер: чего не хватает (SDK / LSP) и кнопки установки. */
export async function showOnboarding(context: vscode.ExtensionContext, androidPanel: AndroidPanel): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) { return; }
	const looksAndroid = fs.existsSync(path.join(root, 'gradlew')) || fs.existsSync(path.join(root, 'gradlew.bat'))
		|| fs.existsSync(path.join(root, 'app', 'src', 'main', 'AndroidManifest.xml'));
	const hasBuildFile = fs.existsSync(path.join(root, 'build.gradle')) || fs.existsSync(path.join(root, 'build.gradle.kts'));
	if (!looksAndroid && !hasBuildFile) { return; }

	const missing: string[] = [];
	const buttons: string[] = [];

	// Тулчейн (JDK / kotlinc / SDK) — главный блокер чистой машины; ставится одной кнопкой.
	const toolchainMissing = await missingToolchain(androidPanel);
	if (toolchainMissing.length) {
		missing.push(tr('Toolchain: {0} (installed automatically into the IDE, ~1 GB download)', toolchainMissing.join(', ')));
		buttons.push(tr('Install everything'));
	}
	// Java-исходники в проекте есть, а Java-сервер не установлен — говорим об этом в том же баннере.
	const hasJavaSources = !!root && ['app/src/main/java', 'src/main/java'].some(relative => fs.existsSync(path.join(root, relative)));
	if (hasJavaSources && !javaServerInstalled(context)) {
		missing.push(tr('Java Language Server (needed for completion, diagnostics and auto-import in .java)'));
		buttons.push(tr('Install Java LSP'));
	}
	if (vscode.workspace.getConfiguration('auraKotlin').get<string>('kotlinLspPath', 'kotlin-language-server') === 'kotlin-language-server') {
		// Не проверяем PATH синхронно; баннер предлагает установить LSP, если он ещё не открывался.
		const dismissed = context.workspaceState.get<boolean>('auraKotlin.lspBannerDismissed');
		if (!dismissed) { missing.push(tr('Kotlin Language Server (needed for completion and diagnostics)')); buttons.push(tr('Install instructions')); }
	}

	if (!missing.length) { return; }
	const message = tr('To work with this project, install:') + '\n' + missing.map(entry => `• ${entry}`).join('\n');
	const pick = await vscode.window.showInformationMessage(message, ...buttons);
	if (pick === tr('Install everything')) {
		await vscode.commands.executeCommand('auraKotlin.installToolchain');
	} else if (pick === tr('Install Java LSP')) {
		await vscode.commands.executeCommand('auraKotlin.java.installLsp');
	} else if (pick === tr('Install instructions')) {
		await vscode.env.openExternal(vscode.Uri.parse('https://github.com/fwcd/kotlin-language-server'));
		await context.workspaceState.update('auraKotlin.lspBannerDismissed', true);
	}
}
