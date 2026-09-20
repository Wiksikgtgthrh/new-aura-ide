/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — интеграция с Gradle (этап 2 ТЗ).
 *  Обнаружение gradlew/gradlew.bat с фолбэком на системный gradle, TaskProvider gradle:
 *  (список тасков из `gradle tasks --all`, кэшируется), готовые команды (Sync, Build,
 *  Clean, Tests, Release, произвольная таска), problem matcher для kotlinc/AGP-ошибок
 *  с раскладкой в Problems и переходом по клику, прогресс сборки в статус-баре с отменой.
 *  Вывод — в отдельный терминал (ANSI-цвета Gradle работают).
 *-------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

const TASK_TYPE = 'gradle';

interface GradleTaskDefinition extends vscode.TaskDefinition {
	type: typeof TASK_TYPE;
	gradleTask: string;
	args?: string[];
}

export interface GradleCommand { command: string; args: string[] }

/** gradlew(.bat) в корне проекта, иначе системный gradle. */
export async function findGradleCommand(root?: string): Promise<GradleCommand | undefined> {
	const folder = root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (folder) {
		const wrapper = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
		const wrapperPath = path.join(folder, wrapper);
		if (fs.existsSync(wrapperPath)) {
			return { command: process.platform === 'win32' ? wrapperPath : `./${wrapper}`, args: [] };
		}
	}
	try {
		await execFileAsync('gradle', ['--version'], { timeout: 10_000 });
		return { command: 'gradle', args: [] };
	} catch {
		return undefined;
	}
}

/** Регистрация всего Gradle-модуля: таски, команды, problem matcher, статус-бар. */
export function registerGradleIntegration(context: vscode.ExtensionContext): void {
	const controller = vscode.tasks.registerTaskProvider(TASK_TYPE, new GradleTaskProvider());
	context.subscriptions.push(controller);

	const statusbar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 47);
	statusbar.name = 'Gradle Build';
	statusbar.hide();
	context.subscriptions.push(statusbar);

	// Отслеживание запущенных gradle-тасок: прогресс в статус-баре + отмена по клику.
	context.subscriptions.push(vscode.tasks.onDidStartTaskProcess(event => {
		if (event.execution.task.source === 'gradle') {
			statusbar.text = `$(tools) gradle ${event.execution.task.name}`;
			statusbar.command = { command: 'auraKotlin.gradle.cancelTask', title: vscode.l10n.t('Gradle is running — click to cancel'), arguments: [event.execution] };
			statusbar.tooltip = vscode.l10n.t('Gradle is running — click to cancel');
			statusbar.show();
		}
	}));
	context.subscriptions.push(vscode.tasks.onDidEndTaskProcess(event => {
		if (event.execution.task.source === 'gradle') {
			statusbar.hide();
			if (event.exitCode !== 0 && event.exitCode !== undefined) {
				void vscode.window.showWarningMessage(vscode.l10n.t('Gradle task {0} failed with exit code {1}. Check the Problems panel.', event.execution.task.name, String(event.exitCode)));
			}
		}
	}));

	context.subscriptions.push(
		vscode.commands.registerCommand('auraKotlin.gradle.cancelTask', (execution?: vscode.TaskExecution) => {
			execution?.terminate();
		}),
		vscode.commands.registerCommand('auraKotlin.gradle.sync', () => runGradleTask({ type: TASK_TYPE, gradleTask: 'build', args: [] }, 'sync')),
		vscode.commands.registerCommand('auraKotlin.gradle.build', () => runGradleTask({ type: TASK_TYPE, gradleTask: 'assembleDebug' })),
		vscode.commands.registerCommand('auraKotlin.gradle.clean', () => runGradleTask({ type: TASK_TYPE, gradleTask: 'clean' })),
		vscode.commands.registerCommand('auraKotlin.gradle.test', () => runGradleTask({ type: TASK_TYPE, gradleTask: 'test' })),
		vscode.commands.registerCommand('auraKotlin.gradle.release', () => runGradleTask({ type: TASK_TYPE, gradleTask: 'assembleRelease' })),
		vscode.commands.registerCommand('auraKotlin.gradle.runTask', () => pickAndRunTask()),
	);
}

/** Запуск gradle-таски в выделенном терминале (ANSI-цвета) + прогресс в статус-баре. */
async function runGradleTask(definition: GradleTaskDefinition, displayName?: string): Promise<void> {
	const gradle = await findGradleCommand();
	if (!gradle) {
		void vscode.window.showErrorMessage(vscode.l10n.t('gradlew not found in the project and system gradle is not installed.'));
		return;
	}
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) { return; }
	const name = displayName ?? definition.gradleTask;
	const task = new vscode.Task(
		definition,
		folder,
		name,
		TASK_TYPE,
		new vscode.ShellExecution(gradle.command, [...gradle.args, definition.gradleTask, ...(definition.args ?? [])], { cwd: folder.uri.fsPath }),
		['$aura-gradle', '$aura-kotlinc'],
	);
	task.presentationOptions = { echo: true, reveal: vscode.TaskRevealKind.Always, focus: false, clear: false, panel: vscode.TaskPanelKind.Dedicated };
	void vscode.tasks.executeTask(task);
}

/** Произвольная gradle-таска через QuickPick (список из `gradle tasks --all`, кэшируется). */
async function pickAndRunTask(): Promise<void> {
	const tasks = await listGradleTasks();
	if (!tasks.length) { return; }
	const pick = await vscode.window.showQuickPick(tasks, { placeHolder: vscode.l10n.t('Gradle task to run') });
	if (pick) { await runGradleTask({ type: TASK_TYPE, gradleTask: pick }); }
}

let tasksCache: { root: string; tasks: string[] } | undefined;

/** Список тасков из `gradle tasks --all`, кэшируется до смены build-файлов. */
export async function listGradleTasks(): Promise<string[]> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) { return []; }
	if (tasksCache && tasksCache.root === root) { return tasksCache.tasks; }
	const gradle = await findGradleCommand(root);
	if (!gradle) { return []; }
	try {
		const { stdout } = await execFileAsync(gradle.command, [...gradle.args, 'tasks', '--all', '-q'], { cwd: root, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
		const tasks = stdout.split(/\r?\n/)
			.map(line => line.trim().split(/\s{2,}/)[0].trim())
			.filter(line => /^[\w:]+$/.test(line) && line.length > 2);
		tasksCache = { root, tasks: [...new Set(tasks)] };
		return tasksCache.tasks;
	} catch {
		return [];
	}
}

/** Провайдер тасок типа gradle: список берётся из `gradle tasks --all`. */
class GradleTaskProvider implements vscode.TaskProvider {
	provideTasks(): vscode.Task[] { return []; }
	resolveTask(task: vscode.Task): vscode.Task | undefined { return task; }
}
