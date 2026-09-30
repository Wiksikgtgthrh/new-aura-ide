import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sidecarSrc = path.join(root, 'sidecar', 'src');
const { buildOrchestratorGraph } = require(path.join(sidecarSrc, 'graph.js'));
const { Gate, Orchestrator } = require(path.join(sidecarSrc, 'orchestrator.js'));
const { MemorySaver, Command } = require(path.join(root, 'sidecar', 'node_modules', '@langchain', 'langgraph'));

/** Есть ли git в PATH: без него интеграционный тест бессмыслен, но не должен падать. */
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

/**
 * Настоящий GitClient — это TS расширения. Транспилируем его esbuild'ом в CJS
 * (в нём нет импортов vscode, только child_process), чтобы тест гонял боевой код,
 * а не повторял git-команды руками.
 */
function loadGitClient() {
	const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
	const source = fs.readFileSync(path.join(root, 'src', 'git', 'gitClient.ts'), 'utf8');
	const { code } = esbuild.transformSync(source, { loader: 'ts', format: 'cjs', target: 'node20' });
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-gitclient-'));
	const file = path.join(dir, 'gitClient.cjs');
	fs.writeFileSync(file, code);
	return require(file).GitClient;
}

const GitClient = HAS_GIT ? loadGitClient() : null;

function gitSync(dir, args) {
	return cp.execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/** Временный репозиторий с базовым коммитом (файл src/shared.txt = "base"). */
function initRepo() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-it-'));
	gitSync(dir, ['init']);
	fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'src', 'shared.txt'), 'base\n');
	gitSync(dir, ['add', '-A']);
	gitSync(dir, ['-c', 'user.name=Test', '-c', 'user.email=t@e', 'commit', '-m', 'base']);
	return dir;
}

/** Ветки aura/* в репозитории (в норме после cleanup их нет). */
function auraBranches(dir) {
	return gitSync(dir, ['branch', '--list', 'aura/*']).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

/** Пути из `git worktree list` (после cleanup должно остаться только основное дерево). */
function worktreePaths(dir) {
	return gitSync(dir, ['worktree', 'list', '--porcelain'])
		.split(/\r?\n/)
		.filter(line => line.startsWith('worktree '))
		.map(line => line.slice('worktree '.length).trim());
}

function cleanup(dir) {
	fs.rmSync(dir, { recursive: true, force: true });
}

test('интеграция Stage 4: два воркера в worktree, конфликт merge, cleanup без следов', { skip: SKIP }, async () => {
	const repo = initRepo();
	const git = new GitClient();
	try {
		// --- два воркера правят один и тот же файл каждый в своём worktree ---
		const base = await git.head(repo);
		assert.ok(base, 'base-коммит получен');
		const wtA = path.join(repo, '.aura', 'worktrees', 'run', 'a');
		const wtB = path.join(repo, '.aura', 'worktrees', 'run', 'b');
		await git.worktreeAdd(repo, wtA, 'aura/run/nodes/a', base);
		await git.worktreeAdd(repo, wtB, 'aura/run/nodes/b', base);
		fs.writeFileSync(path.join(wtA, 'src', 'shared.txt'), 'A\n');
		fs.writeFileSync(path.join(wtB, 'src', 'shared.txt'), 'B\n');
		const commitA = await git.commitAll(wtA, 'a: change shared');
		const commitB = await git.commitAll(wtB, 'b: change shared');
		assert.ok(commitA.commit && commitB.commit, 'каждый узел закоммитил свою правку');
		// Основное дерево воркеры не тронули.
		assert.equal(fs.readFileSync(path.join(repo, 'src', 'shared.txt'), 'utf8'), 'base\n');

		// --- merge в run-ветку: A вливается, B даёт конфликт ---
		const runWt = path.join(repo, '.aura', 'worktrees', 'run', '__run');
		// run-ветка — сестра веток узлов, иначе git не даст создать ref-родителя.
		await git.worktreeAdd(repo, runWt, 'aura/run/run', base);
		assert.deepEqual(await git.mergeBranch(runWt, 'aura/run/nodes/a', 'merge a'), { ok: true, conflicts: [], stderr: '' });
		const conflict = await git.mergeBranch(runWt, 'aura/run/nodes/b', 'merge b');
		assert.equal(conflict.ok, false, 'второй merge конфликтует');
		assert.ok(conflict.conflicts.includes('src/shared.txt'), 'файл конфликта назван');
		await git.mergeAbort(runWt);

		// --- cleanup: worktree и ветки удаляются, следов не остаётся ---
		await git.worktreeRemove(repo, wtA, 'aura/run/nodes/a');
		await git.worktreeRemove(repo, wtB, 'aura/run/nodes/b');
		await git.worktreeRemove(repo, runWt, 'aura/run/run');
		await git.prune(repo);
		assert.deepEqual(auraBranches(repo), [], 'ветки aura/* удалены');
		assert.equal(worktreePaths(repo).length, 1, 'осталось только основное дерево');
	} finally {
		cleanup(repo);
	}
});

test('интеграция Stage 4: граф -> worktree -> конфликт merge -> interrupt -> Orchestrator.cleanup', { skip: SKIP }, async () => {
	const repo = initRepo();
	const git = new GitClient();
	try {
		const base = await git.head(repo);
		const plan = [
			{ id: 'a#1.0', kind: 'code', goal: 'правка A', deps: [] },
			{ id: 'b#1.1', kind: 'code', goal: 'правка B', deps: [] },
		];
		let supervisorCalls = 0;
		const llm = { complete: async (role, messages) => {
			if (role === 'supervisor') {
				supervisorCalls += 1;
				return supervisorCalls === 1
					? { text: JSON.stringify({ nodes: plan }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' }
					: { text: JSON.stringify({ finish: 'готово' }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' };
			}
			const instruction = String(messages[1] && messages[1].content);
			if (messages.length <= 2) {
				// Оба узла пишут ОДИН файл: изоляция разводит их по worktree.
				const content = instruction.includes('правка A') ? 'A\n' : 'B\n';
				return { text: '', toolCalls: [{ id: 'w1', name: 'fs.writeFile', input: { path: 'src/shared.txt', content } }], usedKeyName: 'k', usedTier: 'low' };
			}
			return { text: 'готово', toolCalls: [], usedKeyName: 'k', usedTier: 'low' };
		}};

		// Настоящий git за RPC-совместимым фасадом tool.invoke.
		const invokeTool = async (name, input) => {
			switch (name) {
				case 'fs.writeFile': {
					const target = path.join(input.cwd, input.path);
					fs.mkdirSync(path.dirname(target), { recursive: true });
					fs.writeFileSync(target, input.content);
					return { ok: true, output: 'written' };
				}
				case 'git.worktreeAdd':
					await git.worktreeAdd(repo, input.worktree, input.branch, input.baseCommit);
					return { isolated: true, worktree: input.worktree, branch: input.branch };
				case 'git.commitWorktree':
					return await git.commitAll(input.cwd, input.message);
				case 'git.diffStat':
					return { diffStat: await git.diffStat(input.cwd, input.from, input.to) };
				case 'git.mergeNode':
					return await git.mergeBranch(input.cwd, input.sourceBranch, input.message);
				case 'git.mergeAbort':
					await git.mergeAbort(input.cwd);
					return { aborted: true };
				case 'git.finalPatch':
					return { stat: await git.diffStat(input.cwd, input.base, input.runBranch), files: await git.filesChanged(input.cwd, input.base, input.runBranch), diff: '' };
				case 'git.worktreeRemove':
					await git.worktreeRemove(input.workspaceRoot || repo, input.worktree, input.branch);
					await git.prune(repo);
					return { removed: true };
				default:
					return { output: 'ok' };
			}
		};

		const emitted = [];
		const graph = buildOrchestratorGraph({
			llm, tools: [], invokeTool, gate: new Gate(), maxParallelWorkers: 2, language: 'ru',
			emit: e => emitted.push(e), runId: 'it-run', workspaceRoot: repo, baseCommit: base,
		}, { checkpointer: new MemorySaver() });
		const cfg = { configurable: { thread_id: 'it-run' } };

		for await (const _ of await graph.stream({ task: 'задача', round: 0, results: {}, summary: '' }, { recursionLimit: 200, streamMode: 'values', ...cfg })) { /* до конфликта */ }

		const state = await graph.getState(cfg);
		assert.ok(state.next.includes('mergeGate'), 'граф остановлен на конфликте merge');
		const banner = emitted.find(e => e.type === 'interrupt.requested' && e.interrupt && e.interrupt.role === 'merge');
		assert.ok(banner, 'конфликт показан человеку');
		assert.ok(banner.interrupt.title.includes('src/shared.txt'), 'файл конфликта виден');
		// Пока cleanup не вызван — изоляция на месте.
		assert.ok(auraBranches(repo).some(b => b.includes('it-run/nodes/a')), 'ветка узла ещё существует');

		// cleanup через настоящий Orchestrator и настоящий git.
		const fakeRpc = {
			notify: () => {},
			request: async (method, params) => (params && params.name ? invokeTool(params.name, params.input) : {}),
		};
		const orch = new Orchestrator(fakeRpc, {});
		orch.workspaceRoot = repo;
		orch.threadId = 'it-run';
		orch.lastSnapshot = { isolations: state.values.isolations };
		const cleaned = await orch.handleCommand('cleanup', {});
		assert.equal(cleaned.cleaned, 3, 'два узла + run-дерево');

		assert.deepEqual(auraBranches(repo), [], 'после cleanup ветки aura/* удалены');
		assert.equal(worktreePaths(repo).length, 1, 'осталось только основное дерево');
		assert.equal(fs.readFileSync(path.join(repo, 'src', 'shared.txt'), 'utf8'), 'base\n', 'основное дерево не изменено');
	} finally {
		cleanup(repo);
	}
});
