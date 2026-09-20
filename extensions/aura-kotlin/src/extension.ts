/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerKotlinLsp, KotlinLspClient } from './lsp';
import { registerAndroidPanel } from './android';
import { ClasspathSync } from './classpath';
import { registerKotlinDebugger } from './debugAdapter';
import { registerGradleIntegration } from './gradle';
import { AndroidTreeProvider, registerLspStatusbar, showOnboarding } from './ui';

const execFileAsync = promisify(execFile);

function pathSep(): string { return process.platform === 'win32' ? ';' : ':'; }

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('auraKotlin.checkToolchain', () => checkToolchain()),
		vscode.commands.registerCommand('auraKotlin.compileFile', () => compileFile()),
		vscode.commands.registerCommand('auraKotlin.androidDoctor', () => androidDoctor()),
		vscode.commands.registerCommand('auraKotlin.newProject', (folder?: vscode.Uri) => newProject(folder)),
	);

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

	// Этап 2 ТЗ: Gradle — таски, команды сборки, problem matcher, прогресс в статус-баре.
	registerGradleIntegration(context);

	// Этап 3 ТЗ: Android SDK/эмуляторы, единый селектор устройств, webview-logcat.
	const androidPanel = registerAndroidPanel(context);
	// Этап 4 ТЗ: отладка — Run Android App по F5, PID через pidof+ps, applicationId из Gradle.
	registerKotlinDebugger(context, classpathSync, androidPanel);

	// Этап 5 ТЗ: UI — контейнер в activity bar (устройства/модули/зависимости),
	// статус-бар LSP, один онбординг-баннер вместо трёх нотификаций.
	registerAndroidUi(context, classpathSync, androidPanel, lsp);

	// Шаблонный код при создании нового .kt-файла (как в IntelliJ: пакет + fun main / класс).
	context.subscriptions.push(vscode.workspace.onDidCreateFiles(async event => {
		for (const file of event.files) {
			if (file.fsPath.endsWith('.kt') && (await vscode.workspace.fs.stat(file)).size === 0) {
				await writeKotlinTemplate(file);
			}
		}
	}));
}

function registerAndroidUi(context: vscode.ExtensionContext, classpathSync: ClasspathSync, androidPanel: import('./android').AndroidPanel, lsp: KotlinLspClient): void {
	const provider = new AndroidTreeProvider(androidPanel, classpathSync);
	const tree = vscode.window.createTreeView('auraKotlin.androidView', { treeDataProvider: provider });
	context.subscriptions.push(tree);

	context.subscriptions.push(		vscode.commands.registerCommand('auraKotlin.refreshAndroidView', () => provider.refresh()));

	registerLspStatusbar(context, () => lsp.serverState, lsp.onDidChangeState);

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

/** Создание готового проекта: Gradle-подобная структура (или простой CLI-проект). */
async function newProject(folder?: vscode.Uri): Promise<void> {
	const target = folder ?? (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectMany: false, openLabel: vscode.l10n.t('Create project here') }))?.[0];
	if (!target) { return; }
	const namePick = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Project name'), value: 'MyApp' });
	if (!namePick) { return; }
	const kind = await vscode.window.showQuickPick([
		{ label: '$(rocket) CLI (kotlinc + JVM)', id: 'cli' },
		{ label: '$(device-mobile) Android (Gradle structure)', id: 'android' }
	], { placeHolder: vscode.l10n.t('Project type') });
	if (!kind) { return; }
	const root = vscode.Uri.joinPath(target, namePick);
	const pkg = namePick.toLowerCase().replace(/[^a-z0-9]/g, '');

	if (kind.id === 'cli') {
		// Простой CLI-проект: src/Main.kt, компилируется kotlinc без Gradle.
		const src = vscode.Uri.joinPath(root, 'src');
		await vscode.workspace.fs.createDirectory(src);
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(src, 'Main.kt'), Buffer.from(`fun main() {\n\tprintln("Hello, ${namePick}!")\n}\n`, 'utf8'));
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, 'README.md'), Buffer.from(`# ${namePick}\n\nBuild: kotlinc src/Main.kt -include-runtime -d app.jar && java -jar app.jar\n`, 'utf8'));
	} else {
		// Android-структура как в IntelliJ (минимум для Gradle-сборки).
		const mainDir = vscode.Uri.joinPath(root, 'app', 'src', 'main', 'kotlin', ...pkg.split('').length ? [pkg] : ['app']);
		const resDir = vscode.Uri.joinPath(root, 'app', 'src', 'main', 'res', 'values');
		await vscode.workspace.fs.createDirectory(mainDir);
		await vscode.workspace.fs.createDirectory(resDir);
		const activity = namePick.replace(/[^A-Za-z0-9]/g, '').replace(/^./, c => c.toUpperCase());
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, 'settings.gradle.kts'), Buffer.from(`rootProject.name = "${namePick}"\ninclude(":app")\n`, 'utf8'));
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, 'build.gradle.kts'), Buffer.from(`plugins {\n\tid("org.jetbrains.kotlin.android") version "2.1.0" apply false\n}\n`, 'utf8'));
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, 'app', 'build.gradle.kts'), Buffer.from(`plugins {\n\tid("com.android.application")\n\tid("org.jetbrains.kotlin.android")\n}\n\nandroid {\n\tnamespace = "com.example.${pkg}"\n\tcompileSdk = 35\n\tdefaultConfig {\n\t\tapplicationId = "com.example.${pkg}"\n\t\tminSdk = 24\n\t\ttargetSdk = 35\n\t}\n}\n\ndependencies {\n\timplementation("androidx.core:core-ktx:1.15.0")\n\timplementation("androidx.appcompat:appcompat:1.7.0")\n}\n`, 'utf8'));
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, 'app', 'src', 'main', 'AndroidManifest.xml'), Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n\t<application android:label="${namePick}" android:theme="@style/Theme.AppCompat">\n\t\t<activity android:name=".${activity}" android:exported="true">\n\t\t\t<intent-filter>\n\t\t\t\t<action android:name="android.intent.action.MAIN" />\n\t\t\t\t<category android:name="android.intent.category.LAUNCHER" />\n\t\t\t</intent-filter>\n\t\t</activity>\n\t</application>\n</manifest>\n`, 'utf8'));
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(mainDir, `${activity}.kt`), Buffer.from(`package com.example.${pkg}\n\nimport android.os.Bundle\nimport androidx.appcompat.app.AppCompatActivity\n\nclass ${activity} : AppCompatActivity() {\n\toverride fun onCreate(savedInstanceState: Bundle?) {\n\t\tsuper.onCreate(savedInstanceState)\n\t}\n}\n`, 'utf8'));
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(resDir, 'strings.xml'), Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n<resources>\n\t<string name="app_name">${namePick}</string>\n</resources>\n`, 'utf8'));
	}

	const open = await vscode.window.showInformationMessage(vscode.l10n.t('Project \'{0}\' created.', namePick), vscode.l10n.t('Open folder'));
	if (open) { await vscode.commands.executeCommand('vscode.openFolder', root); }
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
		vscode.window.showWarningMessage(vscode.l10n.t('Open a Kotlin file first.'));
		return;
	}
	const compiler = vscode.workspace.getConfiguration('auraKotlin').get<string>('compilerPath', 'kotlinc');
	const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!workspace) {
		vscode.window.showWarningMessage(vscode.l10n.t('Open a Kotlin workspace first.'));
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
		const result = await execFileAsync(compiler, args, { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath });
		vscode.window.showInformationMessage(result.stderr || 'Kotlin compilation completed.');
	} catch (error) {
		vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
	}
}

async function androidDoctor(): Promise<void> {
	const configured = vscode.workspace.getConfiguration('auraKotlin').get<string>('androidSdkPath', '').trim();
	const sdk = configured || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
	if (!sdk) {
		vscode.window.showWarningMessage(vscode.l10n.t('Set auraKotlin.androidSdkPath or ANDROID_HOME to use Android SDK checks.'));
		return;
	}
	const adb = vscode.Uri.file(vscode.Uri.joinPath(vscode.Uri.file(sdk), 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb').fsPath).fsPath;
	const sdkManager = vscode.Uri.file(vscode.Uri.joinPath(vscode.Uri.file(sdk), 'cmdline-tools', 'latest', 'bin', process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager').fsPath).fsPath;
	const [adbResult, managerResult] = await Promise.all([toolVersion(adb, ['version']), toolVersion(sdkManager, ['--version'])]);
	vscode.window.showInformationMessage(`Android SDK: ${sdk}\nadb: ${adbResult}\nsdkmanager: ${managerResult}`, { modal: true });
}

async function toolVersion(command: string, args: string[]): Promise<string> {
	try {
		const result = await execFileAsync(command, args, { timeout: 10_000 });
		return `${result.stdout}${result.stderr}`.trim().split(/\r?\n/)[0] || 'available';
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export function deactivate(): void { }
