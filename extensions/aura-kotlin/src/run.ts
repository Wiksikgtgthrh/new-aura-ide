/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — запуск текущего .kt-файла одной кнопкой:
 *  команда auraKotlin.runFile (kotlinc -> java -jar в терминале «Kotlin Run»)
 *  и CodeLens «▶ Запустить» над каждым fun main().
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'node:path';
import { tr } from './l10n';
import { execTool } from './gradle';
import { ClasspathSync } from './classpath';
import { resolveJavaBinary, resolveKotlincBinary, reportToolFailure } from './toolchain';

function pathSep(): string { return process.platform === 'win32' ? ';' : ':'; }

/** Регистрация команды запуска и CodeLens-провайдера. */
export function registerKotlinRun(context: vscode.ExtensionContext, classpathSync: ClasspathSync): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('auraKotlin.runFile', () => runFile(classpathSync)),
		vscode.languages.registerCodeLensProvider({ language: 'kotlin' }, new MainCodeLensProvider()),
	);
}

/** Компилирует активный .kt в jar и запускает его в терминале. */
async function runFile(classpathSync: ClasspathSync): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.languageId !== 'kotlin') {
		vscode.window.showWarningMessage(tr('Open a Kotlin file first.'));
		return;
	}
	// Компилируем только сохранённое состояние — иначе запустится старая версия.
	await editor.document.save();
	const file = editor.document.uri.fsPath;
	// Абсолютные пути из тулчейна: терминал не видит process.env extension-хоста.
	const compiler = resolveKotlincBinary();
	const java = resolveJavaBinary();
	// Без workspace кладём jar в out/ рядом с файлом — сценарий одиночного файла (ДЗ, скрипты).
	const workspace = vscode.workspace.getWorkspaceFolder(editor.document.uri);
	const outDir = workspace ? path.join(workspace.uri.fsPath, 'out') : path.join(path.dirname(file), 'out');
	const jar = path.join(outDir, `${path.basename(file, '.kt')}.jar`);
	try {
		// Зависимости из Gradle/Maven идут в classpath компиляции, как и в compileFile.
		const args = [file];
		const classpath = classpathSync.classpath.jars;
		if (classpath.length) {
			args.push('-classpath', classpath.join(pathSep()));
		}
		args.push('-include-runtime', '-d', jar);
		await execTool(compiler, args, { cwd: workspace?.uri.fsPath });
	} catch (error) {
		await reportToolFailure(error, compiler);
		return;
	}
	// Запуск в терминале: вывод программы виден сразу, терминал переиспользуем между запусками.
	const terminal = vscode.window.terminals.find(t => t.name === 'Kotlin Run')
		?? vscode.window.createTerminal('Kotlin Run');
	terminal.show();
	terminal.sendText(`"${java}" -jar "${jar}"`);
}

/** CodeLens «▶ Запустить» над каждым fun main() в открытом .kt-файле. */
class MainCodeLensProvider implements vscode.CodeLensProvider {
	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const lenses: vscode.CodeLens[] = [];
		for (let line = 0; line < document.lineCount; line++) {
			if (/^\s*fun\s+main\s*\(/.test(document.lineAt(line).text)) {
				lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
					title: tr('▶ Run'),
					command: 'auraKotlin.runFile',
				}));
			}
		}
		return lenses;
	}
}
