import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sidecarSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sidecar', 'src');
const {
	slug, runBranch, nodeBranch, worktreeRelPath, worktreePath, runWorktreePath, needsIsolation,
} = require(path.join(sidecarSrc, 'worktrees.js'));

test('slug: id узла становится безопасным для git-ref', () => {
	assert.equal(slug('coder#1.0'), 'coder-1.0');
	assert.equal(slug('  Team · Run  '), 'team-run');
	assert.equal(slug('', 'fallback'), 'fallback');
	assert.equal(slug('!!!', 'x'), 'x');
});

test('ветки: run и узел — соседи, а не ref-родитель/ребёнок', () => {
	assert.equal(runBranch('run-123'), 'aura/run-123/run');
	assert.equal(nodeBranch('run-123', 'coder#1.0'), 'aura/run-123/nodes/coder-1.0');
	// Ни одна ветка не является префиксом-папкой другой: git это запрещает.
	assert.ok(!nodeBranch('run-123', 'coder#1.0').startsWith(runBranch('run-123') + '/'));
	assert.ok(nodeBranch('run-123', 'coder#1.0').startsWith('aura/run-123/'));
});

test('worktreePath: внутри .aura/worktrees и не выходит из корня', () => {
	const p = worktreePath('/repo', 'run-123', 'coder#1.0');
	assert.equal(p, path.join('/repo', '.aura', 'worktrees', 'run-123', 'coder-1.0'));
	assert.equal(worktreeRelPath('run-123', 'coder#1.0'), path.join('.aura', 'worktrees', 'run-123', 'coder-1.0'));
	assert.ok(p.startsWith(path.join('/repo', '.aura', 'worktrees')));
	assert.equal(runWorktreePath('/repo', 'run-123'), path.join('/repo', '.aura', 'worktrees', 'run-123', '__run'));
});

test('needsIsolation: read-only kinds не изолируются', () => {
	assert.equal(needsIsolation({ kind: 'code' }), true);
	assert.equal(needsIsolation({ kind: 'test' }), true);
	assert.equal(needsIsolation({ kind: 'boilerplate' }), true);
	assert.equal(needsIsolation({ kind: 'search' }), false);
	assert.equal(needsIsolation({ kind: 'review' }), false);
	assert.equal(needsIsolation({ kind: 'security' }), false);
});
