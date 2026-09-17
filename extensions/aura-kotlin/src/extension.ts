/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('auraKotlin.checkToolchain', () => checkToolchain()),
		vscode.commands.registerCommand('auraKotlin.compileFile', () => compileFile()),
		vscode.commands.registerCommand('auraKotlin.androidDoctor', () => androidDoctor()),
	);
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
		const result = await execFileAsync(compiler, [editor.document.uri.fsPath, '-include-runtime', '-d', vscode.Uri.joinPath(output, 'app.jar').fsPath], { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath });
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
