/*
 * Минимальный стаб модуля `vscode` для node-тестов вне хоста расширений.
 * Раньше тесты искали его в test/node_modules/vscode — каталога нет в репозитории
 * (node_modules игнорируется), поэтому classpath-тесты падали с MODULE_NOT_FOUND
 * ещё до первой проверки. Здесь только то, что нужно модулям на загрузке.
 */

const noopDisposable = { dispose() { } };

function createStatusBarItem() {
	return {
		text: '', name: '', tooltip: '', command: undefined,
		show() { }, hide() { }, dispose() { },
	};
}

function createOutputChannel() {
	return { name: '', append() { }, appendLine() { }, replace() { }, clear() { }, show() { }, hide() { }, dispose() { } };
}

module.exports = {
	StatusBarAlignment: { Left: 1, Right: 2 },
	ProgressLocation: { Notification: 15, Window: 10, SourceControl: 1 },
	Uri: {
		file: fsPath => ({ fsPath, scheme: 'file', toString: () => `file://${fsPath}` }),
		parse: value => ({ fsPath: value, scheme: 'file', toString: () => value }),
		joinPath: (base, ...segments) => module.exports.Uri.file([base.fsPath, ...segments].join('/')),
	},
	RelativePattern: class RelativePattern {
		constructor(base, pattern) { this.baseUri = base; this.pattern = pattern; }
	},
	MarkdownString: class MarkdownString {
		constructor(value = '') { this.value = value; }
		appendMarkdown(value) { this.value += value; return this; }
	},
	EventEmitter: class EventEmitter {
		constructor() { this.listeners = []; this.event = listener => { this.listeners.push(listener); return noopDisposable; }; }
		fire(value) { for (const listener of this.listeners) { listener(value); } }
		dispose() { this.listeners.length = 0; }
	},
	Disposable: { from: () => noopDisposable },
	workspace: {
		workspaceFolders: undefined,
		getConfiguration: () => ({ get: (_key, fallback) => fallback, update: async () => undefined }),
		createFileSystemWatcher: () => ({ onDidChange: () => noopDisposable, onDidCreate: () => noopDisposable, onDidDelete: () => noopDisposable, dispose() { } }),
		onDidCreateFiles: () => noopDisposable,
		fs: { stat: async () => ({ size: 0 }) },
	},
	window: {
		createStatusBarItem,
		createOutputChannel,
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		withProgress: (_options, task) => task({ report() { } }),
	},
	commands: {
		registerCommand: () => noopDisposable,
		executeCommand: async () => undefined,
	},
	l10n: { t: (message, ...args) => args.reduce((text, arg, index) => text.split(`{${index}}`).join(String(arg)), message) },
};
