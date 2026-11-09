/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — проверка состояния AVD без живого эмулятора: фейковый adb-скрипт.
 *  Проверяет ровно то, что было сломано:
 *   1. stopEmulator ждёт, пока устройство реально исчезнет из `adb devices`, а не отвечает
 *      «остановлен» сразу (из-за этого дерево показывало «запущен» ещё долго после остановки).
 *   2. Запущенный, но не загруженный эмулятор (нет sys.boot_completed) отдаётся как «запускается».
 *   3. Запущенный AVD, которого нет в `emulator -list-avds`, всё равно попадает в дерево.
 *   4. Смена состояния сообщается подписчикам (дерево перерисовывается без ручного refresh).
 *
 *  Запуск: node test/emulator.state.test.mjs  (нужен только node, SDK не требуется)
 *--------------------------------------------------------------------------------------------*/
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

// ---------- Фейковый SDK ----------

const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-emu-'));
const platformTools = path.join(sdk, 'platform-tools');
const emulatorDir = path.join(sdk, 'emulator');
const store = path.join(sdk, 'store');
fs.mkdirSync(platformTools, { recursive: true });
fs.mkdirSync(emulatorDir, { recursive: true });
fs.mkdirSync(store, { recursive: true });

const stateFile = path.join(store, 'state.json');
const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const writeState = value => fs.writeFileSync(stateFile, JSON.stringify(value));
writeState({ devices: [], booted: false, avds: ['pixel_api_35'], killDelayMs: 1500 });

// adb.exe и emulator.exe — копии самого node: запускаются без оболочки и без .cmd-шимов.
// Скрипт им передаётся через NODE_OPTIONS=--require <файл>, поэтому поведение можно менять на лету.
fs.copyFileSync(process.execPath, path.join(platformTools, 'adb.exe'));
fs.copyFileSync(process.execPath, path.join(emulatorDir, 'emulator.exe'));
const adbPreload = path.join(store, 'adb.js');
const emulatorPreload = path.join(store, 'emulator.js');
const launcher = path.join(store, 'launch.js');
// Точка входа вместо -e: preload по argv[1] отличает настоящий adb/emulator от собственных
// дочерних node-процессов (тот, что «гасит» устройство, не должен исполнять fake-adb).
fs.writeFileSync(launcher, '');

/**
 * Поведение как у живого эмулятора: `emu kill` отвечает OK сразу, а устройство пропадает
 * из `adb devices` через killDelayMs — поэтому останавливать эмулятор нужно с ожиданием.
 */
fs.writeFileSync(adbPreload, `
if (!(process.argv[1] || '').endsWith('launch.js')) { return; }
const fs = require('node:fs');
const stateFile = ${JSON.stringify(stateFile)};
const args = process.argv.slice(2);
const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
if (args[0] === 'devices') {
	console.log('List of devices attached');
	for (const id of state().devices) { console.log(id + '\tdevice'); }
	process.exit(0);
}
const serial = args[0] === '-s' ? args[1] : undefined;
const cmd = args[0] === '-s' ? args.slice(2) : args;
if (cmd[0] === 'emu' && cmd[1] === 'kill') {
	// Гашение «в фоне»: отдельный процесс через killDelayMs убирает устройство из списка.
	const script = 'const fs = require("node:fs"); const f = process.argv[1];'
		+ ' setTimeout(() => { const s = JSON.parse(fs.readFileSync(f, "utf8"));'
		+ ' s.devices = s.devices.filter(id => id !== process.argv[2]);'
		+ ' fs.writeFileSync(f, JSON.stringify(s)); }, ' + state().killDelayMs + ');';
	require('node:child_process').spawn(process.execPath, ['-e', script, stateFile, serial], { detached: true, stdio: 'ignore' }).unref();
	console.log('OK');
	process.exit(0);
}
if (cmd[0] === 'emu' && cmd[1] === 'avd' && cmd[2] === 'name') {
	console.log((state().avds || [])[0] || 'pixel_api_35');
	process.exit(0);
}
if (cmd[0] === 'shell' && cmd[1] === 'getprop' && cmd[2] === 'sys.boot_completed') {
	console.log(state().booted ? '1' : '0');
	process.exit(0);
}
process.exit(0);
`);

/** Набор AVD, который отдаёт emulator -list-avds (меняется по ходу теста). */
const emulatorSources = ['pixel_api_35'];
fs.writeFileSync(emulatorPreload, `
if (!(process.argv[1] || '').endsWith('launch.js')) { return; }
const args = process.argv.slice(2);
if (args[0] === '-list-avds') { for (const name of ${JSON.stringify(emulatorSources)}) { console.log(name); } }
process.exit(0);
`);

// ---------- Стаб vscode ----------

const messages = [];
const vscodeStub = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: os.tmpdir(), toString: () => 'file:///tmp' }, name: 'test', index: 0 }],
		getConfiguration: () => ({ get: (key, fallback) => (key === 'androidSdkPath' ? sdk : fallback), update: async () => undefined }),
	},
	window: {
		createOutputChannel: () => ({ append() { }, appendLine() { }, show() { }, dispose() { } }),
		createStatusBarItem: () => ({ text: '', show() { }, hide() { }, dispose() { } }),
		withProgress: (_options, task) => task({ report() { } }, { isCancellationRequested: false, onCancellationRequested() { return { dispose() { } }; } }),
		showInformationMessage: async text => { messages.push(String(text)); return undefined; },
		showWarningMessage: async text => { messages.push(String(text)); return undefined; },
		showErrorMessage: async text => { messages.push(String(text)); return undefined; },
		showQuickPick: async items => (Array.isArray(items) ? items[0] : undefined),
	},
	commands: { registerCommand: () => ({ dispose() { } }) },
	l10n: { t: text => String(text) },
	Uri: { file: p => ({ fsPath: p }), joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath ?? base, ...parts) }) },
	StatusBarAlignment: { Left: 1, Right: 2 },
	ProgressLocation: { Notification: 15, Window: 10 },
	ThemeIcon: class { constructor(id) { this.id = id; } },
	Disposable: { from: (...items) => ({ dispose: () => items.forEach(item => item?.dispose?.()) }) },
	EventEmitter: class {
		constructor() { this.listeners = []; this.event = listener => { this.listeners.push(listener); return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } }; }; }
		fire() { for (const listener of this.listeners) { listener(); } }
		dispose() { this.listeners = []; }
	},
};

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') { return vscodeStub; }
	return originalLoad.call(this, request, parent, isMain);
};

const { AndroidPanel, STARTING } = require('../out/android.js');
const ruBundle = JSON.parse(fs.readFileSync(path.join(here, '..', 'l10n', 'bundle.l10n.ru.json'), 'utf8'));
const ru = (key, ...args) => {
	let text = ruBundle[key] ?? key;
	args.forEach((arg, index) => { text = text.split(`{${index}}`).join(String(arg)); });
	return text;
};

const stored = new Map();
const panel = new AndroidPanel({
	workspaceState: { get: key => stored.get(key), update: async (key, value) => { stored.set(key, value); } },
	subscriptions: { push() { } },
	storageUri: { fsPath: sdk },
});

// ---------- Проверки ----------

const results = [];
const check = (name, ok, detail = '') => {
	results.push({ name, ok });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const setState = value => writeState({ avds: ['pixel_api_35'], ...value });

const runFake = (script, args) => new Promise(resolve => {
	const child = execFile(process.execPath, [launcher, ...args], { env: { ...process.env, NODE_OPTIONS: '--require ' + script } },
		(error, stdout, stderr) => { if (error) { console.error('FAKE ERR', error.message, String(stderr)); } resolve(String(stdout ?? '')); });
	child.stdin?.end();
});
const runAdb = args => runFake(adbPreload, args);

// Тот же контракт, что у panel.adb(): вывод adb, только через фейк.
panel.adb = (...args) => runAdb(args);
// listAvds() зовёт emulator.exe напрямую — отдаём список без запуска второго фейка.
panel.listAvds = async () => ['pixel_api_35'];

// 1. Запускается (серийник есть, boot_completed=0) — дерево должно получить STARTING.
setState({ devices: ['emulator-5554'], booted: false, killDelayMs: 1500 });
let changes = 0;
panel.onDidChangeEmulators(() => { changes++; });
let states = await panel.emulatorStates();
check('запускающийся эмулятор отдан как STARTING',
	states.length === 1 && states[0].name === 'pixel_api_35' && states[0].runningDevice === STARTING,
	JSON.stringify(states));
check('первый опрос сообщил об изменении состояния', changes === 1, `changes=${changes}`);
await panel.emulatorStates();
check('без изменений повторный опрос молчит', changes === 1, `changes=${changes}`);

// 2. Загрузился — серийник вместо STARTING.
setState({ devices: ['emulator-5554'], booted: true, killDelayMs: 1500 });
states = await panel.emulatorStates();
check('загруженный эмулятор — с серийником',
	states[0].runningDevice === 'emulator-5554', JSON.stringify(states));
check('переход в «запущен» сообщён подписчикам', changes === 2, `changes=${changes}`);

// 3. Остановка ждёт реального исчезновения устройства.
messages.length = 0;
const startedAt = Date.now();
await panel.stopEmulator({ name: 'pixel_api_35' });
const took = Date.now() - startedAt;
const deviceLeft = JSON.parse(fs.readFileSync(stateFile, 'utf8')).devices.length === 0;
check('stopEmulator дождался исчезновения устройства', deviceLeft, `${took} мс`);
check('stopEmulator не отвечает мгновенно', took >= 1000, `${took} мс`);
check('сообщение об остановке — «остановлен»', messages.some(text => text === ru('Emulator {0} stopped.', 'pixel_api_35')), messages.join(' | '));
states = await panel.emulatorStates();
check('после остановки дерево видит «остановлен»', states[0].runningDevice === undefined, JSON.stringify(states));

// 4. Запущенный AVD, которого нет в emulator -list-avds, всё равно в дереве.
setState({ devices: ['emulator-5554'], booted: true, killDelayMs: 0 });
emulatorSources.length = 0;
states = await panel.emulatorStates();
check('запущенный AVD вне -list-avds попал в дерево',
	states.length === 1 && states[0].name === 'pixel_api_35' && states[0].runningDevice === 'emulator-5554',
	JSON.stringify(states));

panel.dispose();
fs.rmSync(sdk, { recursive: true, force: true });

const failed = results.filter(result => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed ? 1 : 0);
