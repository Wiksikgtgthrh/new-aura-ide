/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — смоук-тест TaskProvider: в «Run Task…» должны быть реальные gradle-таски.
 *  Раньше provideTasks() возвращал пустой массив, и в списке задач IDE не было ничего.
 *  Запуск: node test/gradle.tasks.smoke.mjs [путь-к-gradle-проекту]
 *--------------------------------------------------------------------------------------------*/
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const require = createRequire(import.meta.url);
const project = process.argv[2] ?? '/tmp/aura-e2e/AuraTestApp';

const results = [];
const check = (name, ok, detail = '') => {
	results.push({ name, ok });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

if (!fs.existsSync(path.join(project, 'build.gradle')) && !fs.existsSync(path.join(project, 'build.gradle.kts'))) {
	console.log(`SKIP: нет gradle-проекта по пути ${project}`);
	process.exit(0);
}

let captured;
const vscodeStub = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: project, toString: () => `file://${project}` }, name: path.basename(project), index: 0 }],
		getConfiguration: () => ({ get: (_key, fallback) => fallback, update: async () => undefined }),
	},
	window: {
		createStatusBarItem: () => ({ show() { }, hide() { }, dispose() { } }),
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showInformationMessage: async () => undefined,
	},
	tasks: {
		registerTaskProvider: (type, provider) => { captured = { type, provider }; return { dispose() { } }; },
		onDidStartTaskProcess: () => ({ dispose() { } }),
		onDidEndTaskProcess: () => ({ dispose() { } }),
		executeTask: async () => ({ terminate() { } }),
	},
	TaskScope: { Global: 1, Workspace: 2 },
	TaskRevealKind: { Always: 1 },
	TaskPanelKind: { Dedicated: 2 },
	Task: class { constructor(definition, scope, name, source, execution, matchers) { Object.assign(this, { definition, scope, name, source, execution, problemMatchers: matchers }); } },
	ShellExecution: class { constructor(command, args, options) { Object.assign(this, { command, args, options }); } },
	commands: { registerCommand: () => ({ dispose() { } }) },
	l10n: { t: (text, ...args) => String(text).replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? '')) },
	Uri: { file: p => ({ fsPath: p }), joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath ?? base, ...parts) }) },
	StatusBarAlignment: { Left: 1, Right: 2 },
	ProgressLocation: { Notification: 15 },
	ThemeIcon: class { constructor(id) { this.id = id; } },
	Disposable: { from: (...items) => ({ dispose: () => items.forEach(item => item?.dispose?.()) }) },
	EventEmitter: class { constructor() { this.event = () => ({ dispose() { } }); } fire() { } dispose() { } },
};

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') { return vscodeStub; }
	return originalLoad.call(this, request, parent, isMain);
};

const gradle = require('../out/gradle.js');
const context = { subscriptions: { push() { } }, workspaceState: { get: () => undefined, update: async () => undefined } };
gradle.registerGradleIntegration(context);

// Разбор вывода `gradle tasks --all` — на фрагменте реального вывода.
const fixture = [
	'',
	'> Task :tasks',
	'',
	'------------------------------------------------------------',
	"Tasks runnable from root project 'AuraTestApp'",
	'------------------------------------------------------------',
	'',
	'Android tasks',
	'-------------',
	'app:androidDependencies - Displays the Android dependencies of the project.',
	'',
	'Build tasks',
	'-----------',
	'app:assembleDebug - Assembles main output for variant debug',
	'app:assembleDebugAndroidTest - Assembles main output for variant debugAndroidTest',
	'prepareKotlinBuildScriptModel',
	'',
	'BUILD SUCCESSFUL in 2s',
].join('\n');
const parsed = gradle.parseGradleTasks(fixture);
check('разбор тасок: описание отделяется от имени', parsed.includes('app:assembleDebug'), parsed.join(', '));
check('разбор тасок: заголовки групп не попадают в список', !parsed.includes('Build') && !parsed.includes('Android'));
check('разбор тасок: «BUILD SUCCESSFUL» не попадает в список', !parsed.some(name => name.startsWith('BUILD')));
check('разбор тасок: таска без описания попадает', parsed.includes('prepareKotlinBuildScriptModel'));

check('провайдер тасок типа gradle зарегистрирован', captured?.type === 'gradle');

const started = Date.now();
const tasks = await captured.provider.provideTasks();
const names = tasks.map(task => task.name);
check('провайдер вернул таски проекта, а не пустой список', tasks.length > 0, `${tasks.length} тасок за ${Math.round((Date.now() - started) / 1000)} с`);
check('assembleDebug в начале списка', names.slice(0, 20).some(name => name.endsWith('assembleDebug')), names.slice(0, 6).join(', '));
check('у тасок есть исполнение в корне проекта', tasks.every(task => task.execution?.options?.cwd === project));
check('таски подписаны problem matcher-ами', tasks.every(task => (task.problemMatchers ?? []).length === 2));

console.log(`\nпример: ${names.slice(0, 8).join(', ')}`);
console.log(`${results.filter(r => r.ok).length}/${results.length} проверок пройдено`);
process.exit(results.every(r => r.ok) ? 0 : 1);
