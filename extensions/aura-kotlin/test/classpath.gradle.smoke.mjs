/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — e2e-тест classpath ЧЕРЕЗ КОД РАСШИРЕНИЯ (ClasspathSync), а не ручным запуском
 *  Gradle из теста. Это важно: раньше тест запускал Gradle сам (execFileSync + shell), а в самом
 *  расширении стоял execFile, который на Windows не умеет .bat (spawn EINVAL) — то есть Gradle
 *  внутри расширения не работал, и classpath молча падал в фолбэк-парсер.
 *
 *  Запуск: node test/classpath.gradle.smoke.mjs <путь-к-android-проекту>
 *--------------------------------------------------------------------------------------------*/
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const project = process.argv[2];
if (!project) {
	console.error('usage: node classpath.gradle.smoke.mjs <projectRoot>');
	process.exit(2);
}
if (!fs.existsSync(path.join(project, 'settings.gradle')) && !fs.existsSync(path.join(project, 'settings.gradle.kts'))) {
	console.log(`SKIP: нет gradle-проекта по пути ${project}`);
	process.exit(0);
}

const results = [];
const check = (name, ok, detail = '') => {
	results.push({ name, ok });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const logs = [];
const vscodeStub = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: project, toString: () => `file://${project}` }, name: path.basename(project), index: 0 }],
		getConfiguration: () => ({ get: (key, fallback) => (key === 'androidSdkPath' ? (process.env.ANDROID_HOME ?? fallback) : fallback), update: async () => undefined }),
		createFileSystemWatcher: () => ({ dispose() { }, onDidChange: () => ({ dispose() { } }), onDidCreate: () => ({ dispose() { } }), onDidDelete: () => ({ dispose() { } }) }),
	},
	window: {
		createOutputChannel: () => ({ appendLine: text => logs.push(String(text)), append: text => logs.push(String(text)), show() { }, dispose() { } }),
		createStatusBarItem: () => ({ show() { }, hide() { }, dispose() { } }),
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showInformationMessage: async () => undefined,
	},
	commands: { registerCommand: () => ({ dispose() { } }) },
	l10n: { t: (text, ...args) => String(text).replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? '')) },
	Uri: { file: p => ({ fsPath: p }), joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath ?? base, ...parts) }) },
	RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
	StatusBarAlignment: { Left: 1, Right: 2 },
	Disposable: { from: (...items) => ({ dispose: () => items.forEach(item => item?.dispose?.()) }) },
	EventEmitter: class { constructor() { this.event = () => ({ dispose() { } }); } fire() { } dispose() { } },
};

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') { return vscodeStub; }
	return originalLoad.call(this, request, parent, isMain);
};

const { ClasspathSync } = require('../out/classpath.js');

const sync = new ClasspathSync();
await sync.sync('smoke');

const result = sync.classpath;
const jars = result.jars;
const androidJars = jars.filter(jar => jar.endsWith('android.jar'));
const androidx = jars.filter(jar => /androidx|android[\\/]/i.test(jar));

console.log(`источник: ${result.source}, модулей: ${result.modules.length}, jar: ${jars.length}, нерезолвнутых: ${result.unresolved.length}`);
for (const line of logs.slice(0, 4)) { console.log(`  лог: ${line}`); }

check('classpath взят из Gradle, а не из фолбэк-парсера', result.source === 'gradle', `source=${result.source}`);
check('jar-ов больше 50 (с транзитивными зависимостями)', jars.length > 50, String(jars.length));
check('android.jar из SDK в classpath', androidJars.length > 0, androidJars[0] ?? 'нет');
check('зависимости androidx присутствуют', androidx.length > 0, `${androidx.length} шт.`);
check('applicationId прочитан из Gradle', result.modules.some(module => !!module.applicationId),
	result.modules.map(module => `${path.basename(module.dir)}:${module.applicationId ?? '-'}`).join(', '));

const failed = results.filter(result => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed ? 1 : 0);
