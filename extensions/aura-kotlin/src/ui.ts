/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — UI-панель Android (этап 5 ТЗ).
 *  Контейнер в activity bar с иконкой Android; внутри дерево: устройства с индикаторами,
 *  модули проекта с быстрыми тасками, зависимости с пометкой нерезолвленных.
 *  Статус-бар: состояние LSP (запущен / падал / не установлен), клик — рестарт.
 *  Онбординг: один информативный баннер со списком чего не хватает и кнопками установки.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { AndroidPanel } from './android';
import { ClasspathSync, ModuleInfo } from './classpath';
import { LspState } from './lsp';

type Node = DeviceNode | ModuleNode | JarNode | DependencyNode | SectionNode | ActionNode;


interface SectionNode { kind: 'section'; label: string; }
interface DeviceNode { kind: 'device'; id: string; emulator: boolean; model: string; selected: boolean; }
interface ActionNode { kind: 'action'; label: string; icon: string; command: string; tooltip?: string; }
interface ModuleNode { kind: 'module'; module: ModuleInfo; }
interface JarNode { kind: 'jar'; name: string; file: string; unresolved?: boolean; }
interface DependencyNode { kind: 'dep'; name: string; version: string; }

export class AndroidTreeProvider implements vscode.TreeDataProvider<Node> {

	private readonly emitter = new vscode.EventEmitter<Node | undefined | void>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(
		private readonly androidPanel: AndroidPanel,
		private readonly classpathSync: ClasspathSync,
	) {
		this.classpathSync.onDidChange(() => this.refresh());
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
				item.contextValue = node.selected ? 'deviceSelected' : 'device';
				item.command = { command: 'auraKotlin.android.pickDevice', title: vscode.l10n.t('Select device') };
				return item;
			}
			case 'action': {
				const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon(node.icon);
				item.command = { command: node.command, title: node.label };
				item.tooltip = node.tooltip ?? node.label;
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
					item.tooltip = vscode.l10n.t('Not found in local caches — run a Gradle build once.');
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
				item.tooltip = vscode.l10n.t('Not found in local caches — run a Gradle build once.');
				return item;
			}
		}
	}

	getChildren(node?: Node): Node[] {
		if (!node) {
			return [
				{ kind: 'section', label: vscode.l10n.t('Devices') },
				{ kind: 'section', label: vscode.l10n.t('Modules') },
				{ kind: 'section', label: vscode.l10n.t('Dependencies') },
			];
		}
		if (node.kind === 'section') {
			if (node.label === vscode.l10n.t('Devices')) { return this.deviceNodes(); }
			if (node.label === vscode.l10n.t('Modules')) { return this.moduleNodes(); }
			return this.dependencyNodes();
		}
		if (node.kind === 'module') {
			return node.module.jars.map(jar => ({ kind: 'jar', name: path.basename(jar), file: jar }));
		}
		return [];
	}

	private deviceNodes(): Node[] {
		const nodes: Node[] = [];
		void this.androidPanel.devices().then(devices => {
			// Асинхронное обновление не блокирует дерево; обновим при готовности.
			if (devices.length !== this.lastDeviceCount) {
				this.lastDeviceCount = devices.length;
				this.refresh();
			}
		});
		nodes.push({ kind: 'action', label: vscode.l10n.t('Start emulator…'), icon: 'play', command: 'auraKotlin.android.startEmulator' });
		nodes.push({ kind: 'action', label: vscode.l10n.t('Stop emulator'), icon: 'debug-stop', command: 'auraKotlin.android.stopEmulator' });
		return nodes;
	}

	private lastDeviceCount = -1;

	private moduleNodes(): Node[] {
		const modules = this.classpathSync.classpath.modules;
		if (!modules.length) {
			return [{ kind: 'action', label: vscode.l10n.t('No Gradle/Maven modules found'), icon: 'info', command: 'auraKotlin.syncDependencies' }];
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

/** Статус-бар состояния LSP: запущен / падал / не установлен. Клик — рестарт. */
export function registerLspStatusbar(context: vscode.ExtensionContext, getState: () => LspState, onStateChange: vscode.Event<LspState>): void {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 46);
	item.name = 'Kotlin LSP';
	item.command = 'auraKotlin.restartLsp';
	const update = (state: LspState) => {
		const map: Record<LspState, { icon: string; text: string }> = {
			running: { icon: 'check', text: vscode.l10n.t('LSP running') },
			starting: { icon: 'sync~spin', text: vscode.l10n.t('LSP starting') },
			crashed: { icon: 'error', text: vscode.l10n.t('LSP crashed') },
			'not-installed': { icon: 'circle-slash', text: vscode.l10n.t('LSP not installed') },
			stopped: { icon: 'circle-outline', text: vscode.l10n.t('LSP stopped') },
		};
		const entry = map[state];
		item.text = `$(${entry.icon}) ${entry.text}`;
		item.tooltip = vscode.l10n.t('Kotlin Language Server state: {0}. Click to restart.', state);
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

	if (looksAndroid && !androidPanel.sdk()) { missing.push(vscode.l10n.t('Android SDK (needed for build, devices and emulator)')); buttons.push(vscode.l10n.t('Set SDK path')); }
	if (vscode.workspace.getConfiguration('auraKotlin').get<string>('kotlinLspPath', 'kotlin-language-server') === 'kotlin-language-server') {
		// Не проверяем PATH синхронно; баннер предлагает установить LSP, если он ещё не открывался.
		const dismissed = context.workspaceState.get<boolean>('auraKotlin.lspBannerDismissed');
		if (!dismissed) { missing.push(vscode.l10n.t('Kotlin Language Server (needed for completion and diagnostics)')); buttons.push(vscode.l10n.t('Install instructions')); }
	}

	if (!missing.length) { return; }
	const message = vscode.l10n.t('To work with this project, install:') + '\n' + missing.map(entry => `• ${entry}`).join('\n');
	const pick = await vscode.window.showInformationMessage(message, ...buttons);
	if (pick === vscode.l10n.t('Set SDK path')) {
		await vscode.commands.executeCommand('auraKotlin.androidDoctor');
	} else if (pick === vscode.l10n.t('Install instructions')) {
		await vscode.env.openExternal(vscode.Uri.parse('https://github.com/fwcd/kotlin-language-server'));
		await context.workspaceState.update('auraKotlin.lspBannerDismissed', true);
	}
}
