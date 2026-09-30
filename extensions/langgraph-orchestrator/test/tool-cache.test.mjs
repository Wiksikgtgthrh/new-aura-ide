import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function gitAvailable() {
	try {
		cp.execFileSync('git', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}
const HAS_GIT = gitAvailable();
const SKIP = HAS_GIT ? false : 'git is not available in PATH';

function gitSync(dir, args) {
	return cp.execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

const BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-tools-'));

/**
 * Боевые TS-модули расширения импортируют vscode. Собираем их esbuild'ом в CJS
 * (vscode оставляем внешним) и подменяем require('vscode') заглушкой — тест
 * гоняет настоящий код кэша, а не его копию.
 */
function bundleModule(relativeEntry, name) {
	const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
	const outfile = path.join(BUNDLE_DIR, `${name}.cjs`);
	esbuild.buildSync({
		entryPoints: [path.join(root, 'src', relativeEntry)],
		bundle: true,
		external: ['vscode'],
		platform: 'node',
		format: 'cjs',
		target: 'node20',
		outfile,
	});
	return outfile;
}

/** Заглушка vscode: только путь fs.readFile + workspace root. */
function vscodeStub(state) {
	return {
		workspace: {
			get workspaceFolders() {
				return [{ uri: { fsPath: state.root } }];
			},
			fs: {
				readFile: async uri => {
					state.readCount += 1;
					return Buffer.from(fs.readFileSync(uri.fsPath));
				},
			},
		},
		Uri: {
			file: p => ({ fsPath: String(p) }),
		},
	};
}

function withVscodeStub(state, fn) {
	const original = Module._load;
	Module._load = function (request, parent, isMain) {
		if (request === 'vscode') {
			return vscodeStub(state);
		}
		return original.call(this, request, parent, isMain);
	};
	try {
		return fn();
	} finally {
		Module._load = original;
	}
}

test('ToolCache: ключ зависит от аргументов, коммита и грязности, но не от порядка полей', () => {
	const cacheFile = bundleModule(path.join('tools', 'cache.ts'), 'cache-key');
	const { ToolCache } = withVscodeStub({ root: os.tmpdir(), readCount: 0 }, () => require(cacheFile));

	const a = ToolCache.key('grep', { query: 'foo', pattern: '**/*.ts', regex: false }, 'abc123', '');
	const b = ToolCache.key('grep', { regex: false, pattern: '**/*.ts', query: 'foo' }, 'abc123', '');
	assert.equal(a, b, 'порядок полей аргументов не меняет ключ');
	assert.notEqual(a, ToolCache.key('grep', { query: 'bar', regex: false, pattern: '**/*.ts' }, 'abc123', ''), 'другой запрос — другой ключ');
	assert.notEqual(a, ToolCache.key('grep', { query: 'foo', pattern: '**/*.ts', regex: false }, 'def456', ''), 'новый коммит инвалидирует');
	assert.notEqual(a, ToolCache.key('grep', { query: 'foo', pattern: '**/*.ts', regex: false }, 'abc123', ' M src/a.ts'), 'грязное дерево инвалидирует');

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-cache-unit-'));
	const cache = new ToolCache(path.join(dir, 'cache.db'));
	assert.equal(cache.get(a), undefined);
	cache.set(a, 'grep', 'result');
	assert.equal(cache.get(a), 'result');
	cache.set(a, 'grep', 'updated');
	assert.equal(cache.get(a), 'updated', 'повторная запись перезаписывает');
	assert.equal(cache.size(), 1);
	cache.clear();
	assert.equal(cache.get(a), undefined);
	cache.dispose();
	fs.rmSync(dir, { recursive: true, force: true });
});

test('Этап 5.3: повторный readFile в том же коммите не читает файл, а правка инвалидирует кэш', { skip: SKIP }, async () => {
	const execFile = bundleModule(path.join('tools', 'index.ts'), 'tools-index');
	const cacheFile = bundleModule(path.join('tools', 'cache.ts'), 'cache-runtime');
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-cache-'));
	gitSync(repo, ['init']);
	fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
	fs.writeFileSync(path.join(repo, 'src', 'shared.txt'), 'base\n');
	gitSync(repo, ['add', '-A']);
	gitSync(repo, ['-c', 'user.name=Test', '-c', 'user.email=t@e', 'commit', '-m', 'base']);

	const state = { root: repo, readCount: 0 };
	await withVscodeStub(state, async () => {
		const { ToolExecutor } = require(execFile);
		const { ToolCache } = require(cacheFile);
		const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-cachedb-'));
		const config = { approvals: 'auto-readonly', terminalAllowlist: [], gitPath: 'git' };
		const executor = new ToolExecutor(config, async () => true, undefined, new ToolCache(path.join(cacheDir, 'cache.db')));

		const first = await executor.run({ name: 'fs.readFile', input: { path: 'src/shared.txt' } });
		assert.equal(first.ok, true);
		assert.equal(first.output, 'base\n');
		const second = await executor.run({ name: 'fs.readFile', input: { path: 'src/shared.txt' } });
		assert.equal(second.output, 'base\n');
		assert.equal(state.readCount, 1, 'второй вызов взят из кэша — файл не читали');

		// Правка файла делает дерево грязным: ключ меняется, кэш промахивается.
		fs.writeFileSync(path.join(repo, 'src', 'shared.txt'), 'changed\n');
		const third = await executor.run({ name: 'fs.readFile', input: { path: 'src/shared.txt' } });
		assert.equal(third.output, 'changed\n', 'правка не подхватилась из старого кэша');
		assert.equal(state.readCount, 2, 'грязное дерево заставило перечитать файл');

		// Повтор того же состояния — снова кэш.
		const fourth = await executor.run({ name: 'fs.readFile', input: { path: 'src/shared.txt' } });
		assert.equal(fourth.output, 'changed\n');
		assert.equal(state.readCount, 2, 'тот же коммит/грязность — снова кэш');
	});

	fs.rmSync(repo, { recursive: true, force: true });
});
