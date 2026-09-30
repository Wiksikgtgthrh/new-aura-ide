/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { tr } from './l10n';
import { registerKotlinLsp, KotlinLspClient } from './lsp';
import { registerJavaLsp, JavaLspClient, JAVA_LSP_COMMAND } from './javaLsp';
import { registerLspCommands } from './lspClient';
import { registerAndroidPanel } from './android';
import { ClasspathSync } from './classpath';
import { registerKotlinDebugger } from './debugAdapter';
import { registerGradleIntegration, execTool } from './gradle';
import { AndroidTreeProvider, registerLspStatusbar, showOnboarding } from './ui';
import { registerProjectWizard } from './projectWizard';
import { registerDeviceScreen } from './deviceScreen';

function pathSep(): string { return process.platform === 'win32' ? ';' : ':'; }

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('auraKotlin.checkToolchain', () => checkToolchain()),
		vscode.commands.registerCommand('auraKotlin.compileFile', () => compileFile()),
		vscode.commands.registerCommand('auraKotlin.androidDoctor', () => androidDoctor()),
	);

	// Мастера создания проектов (Kotlin CLI / Java / Android) и файлов (класс, Activity, layout…).
	registerProjectWizard(context);

	// Этап 1 ТЗ: classpath — Gradle через init-скрипт (основной источник), парсер — фолбэк,
	// кэш на диске с ключом по mtime build-файлов.
	classpathSync = new ClasspathSync();
	classpathSync.start(context);

	// Этап 6 ТЗ: LSP — didSave/signatureHelp/symbols/references/rename/codeAction,
	// инкрементальные изменения, перезапуск с новым classpath (с дебаунсом).
	const lsp = registerKotlinLsp(context, classpathSync);
	let restartTimer: NodeJS.Timeout | undefined;
	context.subscriptions.push(classpathSync.onDidChange(() => {
		if (!lsp.available) { return; }
		if (restartTimer) { clearTimeout(restartTimer); }
		restartTimer = setTimeout(() => lsp.restart(), 3000);
	}));

	// Java: Eclipse JDT LS (автодополнение, диагностика, автоимпорт для .java). Classpath
	// передаётся через shadow-проект, сам сервер ставится по кнопке/онбордингу.
	const javaLsp = registerJavaLsp(context, classpathSync);
	// Общая команда применения правок: автоимпорт при принятии подсказки.
	registerLspCommands(context);

	// Этап 2 ТЗ: Gradle — таски, команды сборки, problem matcher, прогресс в статус-баре.
	registerGradleIntegration(context);

	// Этап 3 ТЗ: Android SDK/эмуляторы, единый селектор устройств, webview-logcat.
	const androidPanel = registerAndroidPanel(context);
	// Встроенный экран устройства: screencap-стрим, тапы/свайпы, кнопки управления.
	registerDeviceScreen(context, androidPanel);
	// Этап 4 ТЗ: отладка — Run Android App по F5, PID через pidof+ps, applicationId из Gradle.
	registerKotlinDebugger(context, classpathSync, androidPanel);

	// Этап 5 ТЗ: UI — контейнер в activity bar (устройства/модули/зависимости),
	// статус-бар LSP, один онбординг-баннер вместо трёх нотификаций.
	registerAndroidUi(context, classpathSync, androidPanel, lsp, javaLsp);

	// Шаблонный код при создании нового .kt-файла (как в IntelliJ: пакет + fun main / класс).
	context.subscriptions.push(vscode.workspace.onDidCreateFiles(async event => {
		for (const file of event.files) {
			if (file.fsPath.endsWith('.kt') && (await vscode.workspace.fs.stat(file)).size === 0) {
				await writeKotlinTemplate(file);
			}
		}
	}));
}

function registerAndroidUi(context: vscode.ExtensionContext, classpathSync: ClasspathSync, androidPanel: import('./android').AndroidPanel, lsp: KotlinLspClient, javaLsp: JavaLspClient): void {
	const provider = new AndroidTreeProvider(androidPanel, classpathSync);
	const tree = vscode.window.createTreeView('auraKotlin.androidView', { treeDataProvider: provider });
	context.subscriptions.push(tree);

	context.subscriptions.push(		vscode.commands.registerCommand('auraKotlin.refreshAndroidView', () => provider.refresh()));

	// onDidChangeState — метод (не Event-геттер), передаём обёртку, иначе теряется this
	// и activate() падает до регистрации tree view.
	registerLspStatusbar(context, () => lsp.serverState, listener => lsp.onDidChangeState(listener), {
		label: 'Kotlin', command: 'auraKotlin.restartLsp', priority: 46, server: 'Kotlin Language Server',
	});
	registerLspStatusbar(context, () => javaLsp.serverState, listener => javaLsp.onDidChangeState(listener), {
		label: 'Java', command: JAVA_LSP_COMMAND, priority: 45, server: 'Java Language Server',
	});

	void showOnboarding(context, androidPanel);
}

/** Шаблон нового .kt: package по папке + fun main для standalone, класс для остальных. */
async function writeKotlinTemplate(file: vscode.Uri): Promise<void> {
	const workspace = vscode.workspace.getWorkspaceFolder(file);
	const rel = workspace ? vscode.workspace.asRelativePath(file, false).replace(/\\/g, '/') : file.fsPath.split('/').pop() ?? 'Main.kt';
	const dirParts = rel.split('/').slice(0, -1).filter(p => p && !/^(src|main|kotlin)$/.test(p));
	const pkg = dirParts.length > 0 ? `package ${dirParts.map(p => p.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_(.*)$/, '$1')).join('.')}\n\n` : '';
	const isMain = /main\.kt$/i.test(file.fsPath);
	const body = isMain
		? `${pkg}fun main() {\n\tprintln("Hello, Kotlin!")\n}\n`
		: `${pkg}class ${file.fsPath.split(/[\\/]/).pop()?.replace(/\.kt$/, '')?.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())?.replace(/^./, c => c.toUpperCase()) ?? 'MyClass'} {\n\t// TODO: add members\n}\n`;
	try {
		await vscode.workspace.fs.writeFile(file, Buffer.from(body, 'utf8'));
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc);
	} catch { /* не критично */ }
}

async function checkToolchain(): Promise<void> {
	const configuration = vscode.workspace.getConfiguration('auraKotlin');
	const compiler = configuration.get<string>('compilerPath', 'kotlinc');
	const java = configuration.get<string>('javaPath', 'java');
	const results = await Promise.all([
		toolVersion(compiler, ['-version']),
		toolVersion(java, ['-version']),
	]);
	const message = `Kotlin: ${results[0]}\nJava: ${results[1]}`;
	vscode.window.showInformationMessage(message, { modal: true });
}

let classpathSync: ClasspathSync;

async function compileFile(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.languageId !== 'kotlin') {
		vscode.window.showWarningMessage(tr('Open a Kotlin file first.'));
		return;
	}
	const compiler = vscode.workspace.getConfiguration('auraKotlin').get<string>('compilerPath', 'kotlinc');
	const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!workspace) {
		vscode.window.showWarningMessage(tr('Open a Kotlin workspace first.'));
		return;
	}
	const output = vscode.Uri.joinPath(workspace, 'out');
	await vscode.workspace.fs.createDirectory(output);
	try {
		// Зависимости из Gradle/Maven идут в classpath компиляции.
		const args = [editor.document.uri.fsPath];
		const classpath = classpathSync.classpath.jars;
		if (classpath.length) {
			args.push('-classpath', classpath.join(pathSep()));
		}
		args.push('-include-runtime', '-d', vscode.Uri.joinPath(output, 'app.jar').fsPath);
		const result = await execTool(compiler, args, { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath });
		vscode.window.showInformationMessage(result.stderr || 'Kotlin compilation completed.');
	} catch (error) {
		vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
	}
}

async function androidDoctor(): Promise<void> {
	const configured = vscode.workspace.getConfiguration('auraKotlin').get<string>('androidSdkPath', '').trim();
	const sdk = configured || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
	if (!sdk) {
		vscode.window.showWarningMessage(tr('Set auraKotlin.androidSdkPath or ANDROID_HOME to use Android SDK checks.'));
		return;
	}
	const adb = vscode.Uri.file(vscode.Uri.joinPath(vscode.Uri.file(sdk), 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb').fsPath).fsPath;
	const sdkManager = vscode.Uri.file(vscode.Uri.joinPath(vscode.Uri.file(sdk), 'cmdline-tools', 'latest', 'bin', process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager').fsPath).fsPath;
	const [adbResult, managerResult] = await Promise.all([toolVersion(adb, ['version']), toolVersion(sdkManager, ['--version'])]);
	vscode.window.showInformationMessage(`Android SDK: ${sdk}\nadb: ${adbResult}\nsdkmanager: ${managerResult}`, { modal: true });
}

async function toolVersion(command: string, args: string[]): Promise<string> {
	try {
		// execTool: sdkmanager.bat и kotlinc.bat на Windows через execFile не запускаются.
		const result = await execTool(command, args, { timeout: 10_000 });
		return `${result.stdout}${result.stderr}`.trim().split(/\r?\n/)[0] || 'available';
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export function deactivate(): void { }
