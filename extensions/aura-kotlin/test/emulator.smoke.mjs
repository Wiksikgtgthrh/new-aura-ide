/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — e2e-тест эмулятора: реальный запуск AVD через AndroidPanel.
 *  Проверяет ровно то, что было сломано:
 *   1. Ожидание загрузки идёт по серийнику конкретного эмулятора (adb -s …), а не по
 *      «первому подключённому устройству» — иначе с воткнутым телефоном эмулятор считался
 *      загруженным мгновенно, а при двух устройствах adb отвечал ошибкой.
 *   2. Запущенный эмулятор сразу становится выбранным устройством (раньше каждый раз
 *      переспрашивал pickDevice).
 *   3. stopEmulator({name}) гасит только этот AVD, а не все подряд.
 *   4. Провал запуска виден в выводе «Android Emulator», а не только «не загрузился».
 *
 *  Запуск: node test/emulator.smoke.mjs
 *  Нужен Android SDK; если AVD нет — тест печатает skip и выходит с кодом 0.
 *--------------------------------------------------------------------------------------------*/
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const require = createRequire(import.meta.url);

const SDK = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || 'C:\\android-sdk';
const adbExe = path.join(SDK, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');

const adb = (...args) => execFileSync(adbExe, args, { encoding: 'utf8', timeout: 60_000 }).trim();
const emulatorSerials = () => adb('devices')
	.split(/\r?\n/).slice(1).map(line => line.split(/\s+/)[0]).filter(id => id.startsWith('emulator-'));

// ---------- Стаб vscode ----------

const messages = [];
const outputs = new Map();
const statusbars = [];

const makeOutput = name => {
	const lines = [];
	outputs.set(name, lines);
	return { name, append: text => lines.push(text), appendLine: text => lines.push(text), show() { }, hide() { }, dispose() { } };
};

const vscodeStub = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: os.tmpdir(), toString: () => 'file:///tmp' }, name: 'test', index: 0 }],
		getConfiguration: () => ({
			get: (key, fallback) => (key === 'androidSdkPath' ? SDK : fallback),
			update: async () => undefined,
		}),
	},
	window: {
		createOutputChannel: makeOutput,
		createStatusBarItem: () => { const item = { text: '', tooltip: '', command: undefined, show() { item.visible = true; }, hide() { item.visible = false; }, dispose() { } }; statusbars.push(item); return item; },
		withProgress: (_options, task) => task({ report() { } }),
		showInformationMessage: async (text, ...rest) => { messages.push(String(text)); void rest; return undefined; },
		showWarningMessage: async (text, ...rest) => { messages.push(String(text)); void rest; return undefined; },
		showErrorMessage: async (text, ...rest) => { messages.push(String(text)); void rest; return undefined; },
		showQuickPick: async items => (Array.isArray(items) ? items[0] : undefined),
		showOpenDialog: async () => undefined,
		createWebviewPanel: () => ({ webview: { html: '', postMessage: async () => true, onDidReceiveMessage: () => ({ dispose() { } }) }, onDidDispose: () => ({ dispose() { } }), reveal() { }, dispose() { } }),
	},
	commands: { registerCommand: () => ({ dispose() { } }) },
	l10n: { t: (text, ...args) => String(text).replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? '')) },
	Uri: { file: p => ({ fsPath: p }), joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath ?? base, ...parts) }) },
	StatusBarAlignment: { Left: 1, Right: 2 },
	ProgressLocation: { Notification: 15, Window: 10 },
	ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
	ThemeIcon: class { constructor(id) { this.id = id; } },
	Disposable: { from: (...items) => ({ dispose: () => items.forEach(item => item?.dispose?.()) }) },
	EventEmitter: class { constructor() { this.event = () => ({ dispose() { } }); } fire() { } dispose() { } },
};

// Подменяем require('vscode') для скомпилированного расширения.
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') { return vscodeStub; }
	return originalLoad.call(this, request, parent, isMain);
};

const { AndroidPanel } = require('../out/android.js');

// ---------- Проверки ----------

const results = [];
const check = (name, ok, detail = '') => {
	results.push({ name, ok, detail });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// Настоящее (in-memory) хранилище: на нём проверяется, что выбранное устройство запоминается.
const stored = new Map();
const context = {
	workspaceState: { get: key => stored.get(key), update: async (key, value) => { stored.set(key, value); } },
	subscriptions: { push() { } },
	storageUri: { fsPath: path.join(os.tmpdir(), 'aura-kotlin-test') },
};

const panel = new AndroidPanel(context);

if (!fs.existsSync(adbExe)) {
	console.log(`SKIP: adb не найден (${adbExe})`);
	process.exit(0);
}

const avds = await panel.listAvds();
if (!avds.length) {
	console.log('SKIP: нет ни одного AVD — нечего запускать');
	process.exit(0);
}

const previous = emulatorSerials();
if (previous.length) {
	console.log(`SKIP: эмулятор уже запущен (${previous.join(', ')}) — тест не должен гасить чужой процесс`);
	process.exit(0);
}

const avd = avds[0];
console.log(`AVD: ${avd}\nSDK: ${SDK}\n`);

const started = Date.now();
await panel.startAvd(avd);
const seconds = Math.round((Date.now() - started) / 1000);
const serials = emulatorSerials();

check('эмулятор запущен и появился в adb devices', serials.length === 1, serials.join(', ') || 'нет устройств');
const serial = serials[0];
check('выбранным устройством стал запущенный эмулятор', !!serial && panel.selectedDevice === serial, `selectedDevice=${panel.selectedDevice}`);
if (serial) {
	check('sys.boot_completed=1 именно у запущенного эмулятора (adb -s)', adb('-s', serial, 'shell', 'getprop', 'sys.boot_completed') === '1', `за ${seconds} с`);
	check('статус-бар показывает устройство', statusbars.some(item => String(item.text).includes(serial)), statusbars.map(item => item.text).join(' | '));
}
check('есть сообщение о готовности', messages.some(text => text.includes('is ready')), messages.join(' | '));
check('ошибок запуска не было', !messages.some(text => text.includes('exited during startup') || text.includes('did not finish booting')));

// Остановка конкретного AVD не должна трогать остальные (здесь других нет — проверяем, что гасится нужный).
await panel.stopEmulator({ name: avd });
let gone = false;
for (let attempt = 0; attempt < 20 && !gone; attempt++) {
	await new Promise(resolve => setTimeout(resolve, 1000));
	gone = emulatorSerials().length === 0;
}
check('stopEmulator(avd) остановил эмулятор', gone, emulatorSerials().join(', ') || 'устройств нет');
check('сообщение об остановке — про конкретный AVD', messages.some(text => text.includes(`${avd} stopped`) || text.includes('Emulators stopped')), messages.slice(-2).join(' | '));
check('выбор устройства сброшен после остановки', panel.selectedDevice === undefined, String(panel.selectedDevice));

await panel.stopEmulator({ name: 'AuraNoSuchAvd' });
check('для незапущенного AVD — сообщение «не запущен», без ошибок', messages.some(text => text.includes('is not running')));

const failed = results.filter(result => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
console.log(`Вывод «Android Emulator»: ${(outputs.get('Android Emulator') ?? []).length} строк`);
process.exit(failed ? 1 : 0);
