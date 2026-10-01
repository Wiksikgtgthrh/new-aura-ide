/*---------------------------------------------------------------------------------------------
 *  Orca: хост расширения на поддельном vscode, но с настоящими процессами и git.
 *  Проверяется то, что ломается в жизни: ключ доходит до CLI через env, задача
 *  оркестратора возвращает вывод и код выхода, параллельные агенты получают свои
 *  worktree-ветки, а результат агента сливается в основную ветку.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

if (process.platform === 'win32') { console.log('skip on win32'); process.exit(0); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = mkdtempSync(join(tmpdir(), 'orca-build-'));
for (const file of readdirSync(join(root, 'src')).filter((f) => f.endsWith('.ts'))) {
	const out = ts.transpileModule(readFileSync(join(root, 'src', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
	writeFileSync(join(build, file.replace(/\.ts$/, '.js')), out);
}

/* ---------- Поддельный CLI: печатает задачу и наличие ключа, пишет файл ---------- */
const bin = mkdtempSync(join(tmpdir(), 'orca-bin-'));
const fake = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
console.log('ARGS=' + JSON.stringify(args));
console.log('KEY=' + (process.env.ANTHROPIC_API_KEY || '-') + ' BASE=' + (process.env.ANTHROPIC_BASE_URL || '-'));
const task = args[args.indexOf('-p') + 1] || '';
if (task.includes('write')) { fs.writeFileSync('agent.txt', 'from agent ' + process.pid + ': ' + task + '\\n'); }
process.exit(task.includes('fail') ? 3 : 0);
`;
writeFileSync(join(bin, 'claude'), fake);
chmodSync(join(bin, 'claude'), 0o755);
process.env.PATH = bin + ':' + process.env.PATH;

/* ---------- Репозиторий-песочница ---------- */
const repo = mkdtempSync(join(tmpdir(), 'orca-repo-'));
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
writeFileSync(join(repo, 'README.md'), '# repo\n'); git('add', '.'); git('commit', '-qm', 'init');

/* ---------- Поддельный vscode ---------- */
class EventEmitter { constructor() { this.listeners = []; this.event = (fn) => { this.listeners.push(fn); return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== fn); } }; }; } fire(v) { for (const l of [...this.listeners]) { l(v); } } dispose() { } }
const commands = new Map();
const secrets = new Map();
const globalState = new Map();
const terminals = [];
const ptyOutput = [];
const executed = [];
const errorToasts = [];
const closeTerminal = new EventEmitter();
const vscode = {
	EventEmitter,
	ThemeIcon: class { constructor(id) { this.id = id; } },
	ViewColumn: { One: 1, Active: -1, Beside: -2 },
	TerminalLocation: { Panel: 1, Editor: 2 },
	Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }), joinPath: (u, ...parts) => ({ fsPath: join(u.fsPath, ...parts) }), parse: (s) => ({ toString: () => s }) },
	l10n: { t: (s, ...a) => a.reduce((t, v, i) => t.replace('{' + i + '}', String(v)), s) },
	env: { language: 'ru', shell: '/bin/bash', openExternal: async () => true },
	workspace: { workspaceFolders: [{ uri: { fsPath: repo } }], getConfiguration: () => ({ get: (k, d) => d }) },
	commands: {
		registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() { } }; },
		executeCommand: async (id, ...args) => { executed.push(id); if (id === 'apiKeys.exportKey') { return args[0] === 'k1' ? { value: 'sk-from-plugin', baseUrl: 'https://plugin.proxy', model: 'm' } : undefined; } if (commands.has(id)) { return commands.get(id)(...args); } return undefined; }
	},
	window: {
		createOutputChannel: () => ({ appendLine() { }, append() { }, dispose() { } }),
		showErrorMessage: async (m) => { errorToasts.push(m); },
		showInformationMessage: async () => undefined,
		showQuickPick: async () => undefined,
		onDidChangeTerminalShellIntegration: () => ({ dispose() { } }),
		onDidCloseTerminal: closeTerminal.event,
		onDidEndTerminalShellExecution: () => ({ dispose() { } }),
		createTerminal: (options) => {
			const terminal = { options, creationOptions: options, sent: [], shellIntegration: undefined, show() { }, dispose() { closeTerminal.fire(terminal); }, sendText(t) { this.sent.push(t); } };
			terminals.push(terminal);
			if (options.pty) { options.pty.onDidWrite((t) => ptyOutput.push(t)); setTimeout(() => options.pty.open(), 0); }
			return terminal;
		},
		createWebviewPanel: () => { throw new Error('no panel in test'); }
	}
};
const require = createRequire(import.meta.url);
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain); };
const ext = require(join(build, 'extension.js'));
const context = {
	subscriptions: [], extensionPath: root, extensionUri: { fsPath: root },
	secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); } },
	globalState: { get: (k, d) => globalState.has(k) ? globalState.get(k) : d, update: async (k, v) => { globalState.set(k, v); } }
};
ext.activate(context);
const call = (id, ...args) => commands.get(id)(...args);

let failures = 0;
let checks = 0;
const check = async (name, fn) => { checks++; try { await fn(); console.log('  ok   ' + name); } catch (error) { failures++; console.log('  FAIL ' + name + '\n       ' + (error.stack || error.message).split('\n').slice(0, 3).join('\n       ')); } };

await check('ключ и base URL из настроек доходят до CLI через env', async () => {
	await call('auraOrca.saveCliSettings', 'claude', { apiKey: 'sk-test-123', baseUrl: 'https://proxy.example', keySource: 'manual' });
	assert.equal(secrets.get('auraOrca.key.claude'), 'sk-test-123');
	const result = await call('auraOrca.runHeadless', { agent: 'claude', task: 'say hello' });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.exitCode, 0);
	assert.match(result.output, /KEY=sk-test-123 BASE=https:\/\/proxy\.example/);
	assert.match(result.output, /"-p","say hello","--permission-mode","acceptEdits"/);
	assert.ok(ptyOutput.join('').includes('\r\n'), 'вывод в псевдотерминал идёт с CRLF');
});

await check('неудачная задача возвращает код выхода и ok=false', async () => {
	const result = await call('auraOrca.runHeadless', { agent: 'claude', task: 'please fail' });
	assert.equal(result.ok, false);
	assert.equal(result.exitCode, 3);
});

await check('ключ из плагина API Keys подставляется вместе с base URL', async () => {
	await call('auraOrca.saveCliSettings', 'claude', { keySource: 'api-plugin', apiKeyId: 'k1' });
	const result = await call('auraOrca.runHeadless', { agent: 'claude', task: 'hi' });
	assert.match(result.output, /KEY=sk-from-plugin BASE=https:\/\/plugin\.proxy/);
	assert.ok(executed.includes('apiKeys.exportKey'));
});

await check('отсутствующий CLI даёт понятную ошибку, а не зависание', async () => {
	await call('auraOrca.saveCliSettings', 'claude', { binary: 'definitely-not-installed-orca', keySource: 'none' });
	const result = await call('auraOrca.runHeadless', { agent: 'claude', task: 'hi', timeoutMs: 20000 });
	assert.equal(result.ok, false);
	assert.match(String(result.error), /not installed|not in PATH/);
	await call('auraOrca.saveCliSettings', 'claude', { keySource: 'none' });
});

await check('валидация настроек: base URL и имя переменной', async () => {
	errorToasts.length = 0;
	await call('auraOrca.saveCliSettings', 'claude', { baseUrl: 'ftp://x' });
	await call('auraOrca.saveCliSettings', 'claude', { keyEnv: 'BAD-NAME' });
	assert.equal(errorToasts.length, 2);
	assert.match(errorToasts[0], /Base URL/);
	assert.match(errorToasts[1], /variable/);
	errorToasts.length = 0;
});

await check('интерактивный агент открывает терминал-вкладку и отправляет команду с квотингом', async () => {
	terminals.length = 0;
	const [session] = await call('auraOrca.newAgent', { cli: 'claude', task: "fix it's bug", mode: 'interactive' });
	assert.equal(session.status, 'running');
	await new Promise((r) => setTimeout(r, 3100));
	const terminal = terminals[0];
	assert.equal(terminal.options.cwd, repo);
	assert.deepEqual(terminal.options.location, { viewColumn: -1, preserveFocus: false });
	assert.deepEqual(terminal.sent, [`claude 'fix it'\\''s bug'`]);
	terminal.dispose();
	const state = await call('auraOrca.getState');
	assert.equal(state.sessions.find((s) => s.id === session.id).hasTerminal, false);
});

let parallel;
await check('параллельный запуск ×2: у каждого агента своя ветка orca/… и папка', async () => {
	parallel = await call('auraOrca.newAgent', { cli: 'claude', task: 'write file', mode: 'headless', count: 2 });
	assert.equal(parallel.length, 2);
	assert.notEqual(parallel[0].worktree.branch, parallel[1].worktree.branch);
	for (const s of parallel) { assert.ok(existsSync(s.worktree.path)); assert.match(s.worktree.branch, /^orca\/claude-/); }
	assert.match(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\.orca\/$/m);
	await new Promise((r) => setTimeout(r, 1500));
	const state = await call('auraOrca.getState');
	for (const s of parallel) { assert.equal(state.sessions.find((x) => x.id === s.id).status, 'exited'); }
	assert.ok(!existsSync(join(repo, 'agent.txt')), 'агенты не трогают основное дерево');
});

await check('изменения агента видны относительно точки старта', async () => {
	const changes = await call('auraOrca.changes', parallel[0].id);
	assert.deepEqual(changes.files.map((f) => f.path), ['agent.txt']);
});

await check('«Слить» коммитит работу агента и вливает ветку в main', async () => {
	const result = await call('auraOrca.merge', parallel[0].id);
	assert.equal(result.merged, true);
	assert.ok(existsSync(join(repo, 'agent.txt')));
	assert.match(git('log', '--oneline', '-3'), /Merge branch 'orca\/claude-/);
});

await check('второй агент с тем же файлом даёт конфликт, а не молчаливую потерю', async () => {
	const result = await call('auraOrca.merge', parallel[1].id);
	assert.equal(result.conflicts, true);
	assert.ok(executed.includes('workbench.view.scm'));
	git('merge', '--abort');
});

await check('удаление ветки убирает worktree и ветку', async () => {
	await call('auraOrca.removeWorktree', parallel[1].id);
	assert.ok(!existsSync(parallel[1].worktree.path));
	assert.ok(!git('branch', '--list', parallel[1].worktree.branch).trim());
});

await check('список агентов для оркестратора', async () => {
	const list = await call('auraOrca.listAgents');
	const claude = list.find((a) => a.id === 'claude');
	assert.equal(claude.installed, true);
	assert.equal(list.find((a) => a.id === 'codex').installed, false);
});

if (errorToasts.length) { failures++; console.log('  FAIL неожиданные ошибки: ' + errorToasts.join('; ')); }
console.log(failures ? `\n${failures} CHECK(S) FAILED` : `\nALL ${checks} CHECKS PASSED`);
process.exit(failures ? 1 : 0);
