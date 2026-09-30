/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — интеграция с Gradle (этап 2 ТЗ).
 *  Обнаружение gradlew/gradlew.bat с фолбэком на системный gradle, TaskProvider gradle:
 *  (список тасков из `gradle tasks --all`, кэшируется), готовые команды (Sync, Build,
 *  Clean, Tests, Release, произвольная таска), problem matcher для kotlinc/AGP-ошибок
 *  с раскладкой в Problems и переходом по клику, прогресс сборки в статус-баре с отменой.
 *  Вывод — в отдельный терминал (ANSI-цвета Gradle работают).
 *-------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { tr } from './l10n';
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

/** Windows не запускает .bat/.cmd напрямую: spawn/execFile падают с EINVAL. */
export function needsShell(command: string): boolean {
	return process.platform === 'win32' && /\.(bat|cmd)$/i.test(command);
}

/** Аргумент для командной строки cmd.exe: пути и значения с пробелами — в кавычках. */
function quoteArg(value: string): string {
	return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * Запуск внешнего инструмента с учётом Windows: для .bat/.cmd идём через `cmd /c`,
 * иначе `gradlew.bat`, `kotlinc.bat` и `sdkmanager.bat` не запускались вообще (EINVAL),
 * и classpath из Gradle, сборка APK и доктор SDK молча отваливались в фолбэки.
 */
export async function execTool(command: string, args: string[], options: { cwd?: string; timeout?: number; maxBuffer?: number } = {}): Promise<{ stdout: string; stderr: string }> {
	if (needsShell(command)) {
		// Всю строку собираем сами: `cmd /c` с отдельными аргументами ломается на кавычках,
		// а `execFile(cmd, args, { shell: true })` печатает DEP0190 (аргументы не экранируются).
		const line = `"${command}"${args.map(arg => ' ' + quoteArg(arg)).join('')}`;
		const result = await execFileAsync(line, [], { ...options, shell: true });
		return { stdout: result.stdout, stderr: result.stderr };
	}
	const result = await execFileAsync(command, args, options);
	return { stdout: result.stdout, stderr: result.stderr };
}

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
		await execTool('gradle', ['--version'], { timeout: 10_000 });
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
			statusbar.command = { command: 'auraKotlin.gradle.cancelTask', title: tr('Gradle is running — click to cancel'), arguments: [event.execution] };
			statusbar.tooltip = tr('Gradle is running — click to cancel');
			statusbar.show();
		}
	}));
	context.subscriptions.push(vscode.tasks.onDidEndTaskProcess(event => {
		if (event.execution.task.source === 'gradle') {
			statusbar.hide();
			if (event.exitCode !== 0 && event.exitCode !== undefined) {
				void vscode.window.showWarningMessage(tr('Gradle task {0} failed with exit code {1}. Check the Problems panel.', event.execution.task.name, String(event.exitCode)));
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
		void vscode.window.showErrorMessage(tr('gradlew not found in the project and system gradle is not installed.'));
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
	const pick = await vscode.window.showQuickPick(tasks.slice().sort((a, b) => taskRank(a) - taskRank(b) || a.localeCompare(b)), { placeHolder: tr('Gradle task to run') });
	if (pick) { await runGradleTask({ type: TASK_TYPE, gradleTask: pick }); }
}

let tasksCache: { root: string; tasks: string[] } | undefined;

/**
 * Разбор вывода `gradle tasks --all`.
 * Строка таски выглядит как `app:assembleDebug - Assembles main output for variant debug`,
 * то есть имя и описание разделены одним пробелом и дефисом. Прежний разбор резал строку
 * по двум пробелам и поэтому выбрасывал ВСЕ таски с описанием — в списке оставались только
 * те, у кого описания нет, и `assembleDebug` в «Run Task…» не появлялся.
 * Заголовки групп («Build tasks») отбрасываем: под ними идёт линейка из дефисов.
 */
export function parseGradleTasks(stdout: string): string[] {
	const lines = stdout.split(/\r?\n/).map(line => line.trim());
	const tasks: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (!line || /^-+$/.test(line)) { continue; }
		if (/^-+$/.test(lines[index + 1] ?? '')) { continue; }
		const match = /^([A-Za-z][\w:.-]*)(?:\s+-\s+.*)?$/.exec(line);
		if (!match) { continue; }
		const name = match[1];
		if (name.length > 2 && !name.endsWith('.')) { tasks.push(name); }
	}
	return [...new Set(tasks)];
}

/** Список тасков из `gradle tasks --all`, кэшируется до смены build-файлов. */
export async function listGradleTasks(): Promise<string[]> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) { return []; }
	if (tasksCache && tasksCache.root === root) { return tasksCache.tasks; }
	const gradle = await findGradleCommand(root);
	if (!gradle) { return []; }
	try {
		const { stdout } = await execTool(gradle.command, [...gradle.args, 'tasks', '--all', '-q'], { cwd: root, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
		tasksCache = { root, tasks: parseGradleTasks(stdout) };
		return tasksCache.tasks;
	} catch {
		return [];
	}
}

/**
 * Провайдер тасок типа gradle: список берётся из `gradle tasks --all` (кэшируется).
 * Раньше provideTasks возвращал пустой массив — в «Run Task…» не было ни одной
 * задачи, хотя тип провайдера зарегистрирован.
 */
/** Таски, которые нужны при разработке чаще всего — держим их вверху списка. */
const COMMON_GRADLE_TASKS = ['assembleDebug', 'installDebug', 'assembleRelease', 'bundleRelease', 'build', 'clean', 'test', 'connectedAndroidTest', 'lint'];

/**
 * Приоритет таски в списке: сначала нужные каждый день (сборка/установка/тесты), причём
 * таски модулей важнее служебных корневых — раньше `app:assembleDebug` уезжал за сотню
 * строк вида `buildEnvironment` и до него было не добраться.
 */
function taskRank(name: string): number {
	const short = name.split(':').pop() ?? name;
	const common = COMMON_GRADLE_TASKS.indexOf(short);
	const isModule = name.includes(':');
	if (common !== -1) { return isModule ? 10 + common : common; }
	return isModule ? 300 : 100;
}

class GradleTaskProvider implements vscode.TaskProvider {

	async provideTasks(): Promise<vscode.Task[]> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) { return []; }
		const gradle = await findGradleCommand(folder.uri.fsPath);
		if (!gradle) { return []; }
		const names = await listGradleTasks();
		// Без сортировки алфавитный порядок вытеснял нужное: при 200+ тасках assembleDebug
		// не попадал в список вовсе.
		return names.slice().sort((a, b) => taskRank(a) - taskRank(b) || a.localeCompare(b))
			.slice(0, 300)
			.map(name => this.createTask(gradle, folder, name));
	}

	/** Таска из tasks.json: собираем execution по имени таски из определения. */
	async resolveTask(task: vscode.Task): Promise<vscode.Task | undefined> {
		const definition = task.definition as GradleTaskDefinition;
		const folder = typeof task.scope === 'object' ? task.scope as vscode.WorkspaceFolder : vscode.workspace.workspaceFolders?.[0];
		if (!definition.gradleTask || !folder) { return undefined; }
		const gradle = await findGradleCommand(folder.uri.fsPath);
		if (!gradle) { return undefined; }
		return this.createTask(gradle, folder, definition.gradleTask, definition);
	}

	private createTask(gradle: GradleCommand, folder: vscode.WorkspaceFolder, gradleTask: string, definition?: GradleTaskDefinition): vscode.Task {
		const task = new vscode.Task(
			definition ?? { type: TASK_TYPE, gradleTask },
			folder,
			gradleTask,
			TASK_TYPE,
			new vscode.ShellExecution(gradle.command, [...gradle.args, gradleTask], { cwd: folder.uri.fsPath }),
			['$aura-gradle', '$aura-kotlinc'],
		);
		task.presentationOptions = { echo: true, reveal: vscode.TaskRevealKind.Always, focus: false, clear: false, panel: vscode.TaskPanelKind.Dedicated };
		return task;
	}
}
