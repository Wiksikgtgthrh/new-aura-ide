/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — e2e-тест logcat: разметка панели + живой поток с эмулятора.
 *  Проверяет то, что было сломано:
 *   1. В webview уходят ТОЛЬКО новые строки (раньше на каждый чанк пересылались последние
 *      2000 строк целиком — панель тормозила и постоянно прыгала вниз).
 *   2. Разметка без хардкод-цветов (в светлой теме уровни были нечитаемы) и с фильтром
 *      по уровню/тексту и автопрокруткой.
 *   3. Фильтр по приложению: пока выбранный процесс не запущен, в панель не льются логи
 *      всех остальных приложений — ждём появления PID.
 *
 *  Запуск: node test/logcat.smoke.mjs
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

const messages = [];
const statusbars = [];
let lastHtml = '';
let panelRef;

const vscodeStub = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: os.tmpdir(), toString: () => 'file:///tmp' }, name: 'test', index: 0 }],
		getConfiguration: () => ({ get: (key, fallback) => (key === 'androidSdkPath' ? SDK : fallback), update: async () => undefined }),
	},
	window: {
		createOutputChannel: () => ({ append() { }, appendLine() { }, show() { }, dispose() { } }),
		createStatusBarItem: () => { const item = { text: '', show() { }, hide() { }, dispose() { } }; statusbars.push(item); return item; },
		withProgress: (_options, task) => task({ report() { } }),
		showInformationMessage: async text => { messages.push(String(text)); return undefined; },
		showWarningMessage: async text => { messages.push(String(text)); return undefined; },
		showErrorMessage: async text => { messages.push(String(text)); return undefined; },
		showQuickPick: async items => (Array.isArray(items) ? items[0] : undefined),
		showOpenDialog: async () => undefined,
		createWebviewPanel: () => {
			const panel = {
				webview: { html: '', postMessage: async message => { messages.push(message); return true; }, onDidReceiveMessage: () => ({ dispose() { } }) },
				onDidDispose: () => ({ dispose() { } }),
				reveal() { },
				dispose() { },
			};
			panelRef = panel;
			return panel;
		},
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

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') { return vscodeStub; }
	return originalLoad.call(this, request, parent, isMain);
};

const { AndroidPanel } = require('../out/android.js');

const results = [];
const check = (name, ok, detail = '') => {
	results.push({ name, ok });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

if (!fs.existsSync(adbExe)) {
	console.log(`SKIP: adb не найден (${adbExe})`);
	process.exit(0);
}

const stored = new Map();
const panel = new AndroidPanel({
	workspaceState: { get: key => stored.get(key), update: async (key, value) => { stored.set(key, value); } },
	subscriptions: { push() { } },
	storageUri: { fsPath: path.join(os.tmpdir(), 'aura-kotlin-test') },
});

// ---------- 1. Разметка ----------

// logcatHtml() — private по TS, но на рантайме доступен: разметка проверяется без устройства.
panel.logcatDevice = 'emulator-5554';
panel.logcatPidPkg = 'com.example.app';
const html = panel.logcatHtml();
lastHtml = html;
check('панель logcat создана', html.length > 500);
check('нет хардкод-цветов (только var(--vscode-*))', !/#[0-9a-fA-F]{3,8}\b/.test(html) && !/rgb\(/.test(html));
check('нет неразвёрнутых подстановок шаблона', !html.includes('${'));
check('уровни V/D/I/W/E/F и «все» — кнопками', ['A', 'V', 'D', 'I', 'W', 'E', 'F'].every(level => html.includes(`data-level="${level}"`)));
check('кнопки уровней с aria-pressed', /aria-pressed="true"/.test(html));
check('есть фильтр по тексту/тегу', html.includes('id="filter"'));
check('есть автопрокрутка', html.includes('id="follow"'));
check('есть счётчик строк', html.includes('id="count"'));
check('уровни раскрашены темами VS Code', html.includes('--vscode-editorError-foreground') && html.includes('--vscode-editorWarning-foreground'));
check('локальный фильтр уровня со «уровень и выше»', html.includes('RANK'));

// ---------- 2. Живой поток ----------

const avds = await panel.listAvds();
let running = (await panel.devices()).filter(device => device.emulator);
let bootedHere = false;
if (!running.length && avds.length) {
	console.log(`Запускаю эмулятор ${avds[0]} для проверки живого потока…`);
	panel.logcatDevice = undefined;
	panel.logcatPidPkg = undefined;
	await panel.startAvd(avds[0]);
	running = (await panel.devices()).filter(device => device.emulator);
	bootedHere = true;
}
if (!running.length) {
	console.log('SKIP: живой поток не проверен — нет запущенного эмулятора');
	console.log(`\n${results.filter(r => r.ok).length}/${results.length} проверок пройдено`);
	process.exit(results.every(r => r.ok) ? 0 : 1);
}

// Снимаем фильтр, выставленный для проверки разметки: сейчас нужен весь поток.
panel.logcatPidPkg = undefined;
panel.logcatPid = undefined;
messages.length = 0;
await panel.openLogcat();
await new Promise(resolve => setTimeout(resolve, 4000));

const appends = messages.filter(message => message && message.command === 'append');
const appended = appends.reduce((total, message) => total + message.lines.length, 0);
const buffered = panel.logcatBuffer.length;
check('поток logcat идёт', buffered > 0, `${buffered} строк, чанков: ${appends.length}`);
// Старая реализация присылала последние 2000 строк на КАЖДЫЙ чанк: при таком же числе
// чанков это были бы сотни тысяч строк. Дельты — в разы меньше (плюс один догон истории).
const avg = Math.round(appended / Math.max(appends.length, 1));
check('строки уходят дельтой, а не всем буфером каждый раз', avg < 100 && appended < buffered * 2,
	`передано ${appended}, в среднем ${avg} на чанк, в буфере ${buffered}`);
check('нет пустых чанков', appends.every(message => message.lines.length > 0));
check('при открытии отправлен reset', messages.some(message => message && message.command === 'reset'));

// ---------- 3. Фильтр по приложению ждёт PID ----------

// Сначала гасим нефильтрованный поток: его последние строки иначе попадут в замер.
panel.stopLogcat();
await new Promise(resolve => setTimeout(resolve, 500));
messages.length = 0;
await panel.attachLogcatTo(running[0].id, 'com.aura.nonexistent.app');
await new Promise(resolve => setTimeout(resolve, 4000));
const foreign = messages.filter(message => message && message.command === 'append' && message.lines.length);
check('фильтр по несуществующему приложению не льёт чужие логи', !foreign.length, foreign.length ? foreign[0].lines.slice(0, 2).join(' | ') : '');
check('ожидание PID активно (поток подключится, когда приложение запустится)', !!panel.logcatWatch);

panel.stopLogcat();
check('stopLogcat снимает ожидание PID', !panel.logcatWatch);

if (bootedHere) {
	await panel.stopEmulator({ name: avds[0] });
}

const failed = results.filter(result => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed ? 1 : 0);
