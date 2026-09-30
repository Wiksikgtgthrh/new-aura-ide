// Мост доски Team ↔ оркестратор: чистая логика (src/team/sync.ts) без vscode.
// Грузим через esbuild, как tierStore.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { transformSync } = require('esbuild');

function loadTs(relativePath) {
	const file = path.join(root, relativePath);
	const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node20' }).code;
	const module = { exports: {} };
	new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
		module.exports, require, module, file, path.dirname(file)
	);
	return module.exports;
}

const sync = loadTs('src/team/sync.ts');

const task = (id, title, over = {}) => ({ id, title, description: '', status: 'todo', ...over });

// ---------- маппинг taskId → threadId ----------

test('threadIdForTask: стабилен и различает задачи', () => {
	assert.equal(sync.threadIdForTask('abc'), 'team-task-abc');
	assert.equal(sync.threadIdForTask('abc'), sync.threadIdForTask('abc'));
	assert.notEqual(sync.threadIdForTask('abc'), sync.threadIdForTask('def'));
});

test('withThreadMapping: добавляет запись, не теряя прежние', () => {
	const first = sync.withThreadMapping(undefined, 't1', 'team-task-t1');
	const second = sync.withThreadMapping(first, 't2', 'team-task-t2');
	assert.deepEqual(second, { t1: 'team-task-t1', t2: 'team-task-t2' });
});

// ---------- метка [agent] и автозабор ----------

test('isAgentTask: метка нечувствительна к регистру', () => {
	assert.equal(sync.isAgentTask('fix bug [agent]'), true);
	assert.equal(sync.isAgentTask('[AGENT] refactor'), true);
	assert.equal(sync.isAgentTask('fix bug'), false);
});

test('pickAgentTasks: только todo+[agent], в порядке доски, до лимита', () => {
	const tasks = [
		task('a', 'one [agent]'),
		task('b', 'plain'),
		task('c', 'two [agent]', { status: 'doing' }),
		task('d', 'three [agent]'),
		task('e', 'four [agent]'),
	];
	const picked = sync.pickAgentTasks(tasks, 2);
	assert.deepEqual(picked.map(t => t.id), ['a', 'd']);
});

test('pickAgentTasks: занятые и нулевой лимит отсекаются', () => {
	const tasks = [task('a', 'x [agent]'), task('b', 'y [agent]')];
	assert.deepEqual(sync.pickAgentTasks(tasks, 5, ['a']).map(t => t.id), ['b']);
	assert.deepEqual(sync.pickAgentTasks(tasks, 0), []);
});

// ---------- заметки в описании ----------

test('withOrchestratorNote: добавляет заметку и вычищает прежние', () => {
	const first = sync.withOrchestratorNote('Описание задачи', { text: 'взял в работу', at: 1 });
	assert.ok(first.startsWith('Описание задачи'));
	assert.ok(first.includes('🤖 Оркестратор: взял в работу'));

	const second = sync.withOrchestratorNote(first, { text: 'патч готов', at: 2 });
	assert.ok(second.includes('патч готов'));
	assert.ok(!second.includes('взял в работу'), 'старая заметка не должна оставаться');
	assert.equal(second.split('🤖 Оркестратор').length - 1, 1);
});

test('withOrchestratorNote: сохраняет подзадачи и не дублирует маркер', () => {
	const description = 'Кратко\n- [x] шаг\n- [ ] шаг';
	const withNote = sync.withOrchestratorNote(description, { text: 'остановился: тесты', at: 1 });
	assert.ok(withNote.includes('- [ ] шаг'));
	assert.ok(withNote.includes('🤖 Оркестратор: остановился: тесты'));
});

test('taskTextForGraph: без служебных заметок', () => {
	const description = sync.withOrchestratorNote('Суть задачи', { text: 'взял в работу', at: 1 });
	const text = sync.taskTextForGraph(task('a', 'Заголовок', { description }));
	assert.equal(text, 'Заголовок\n\nСуть задачи');
});

// ---------- своя задача из панели ----------

test('normalizeTaskTitle: чистит пробелы и режет по пределу', () => {
	assert.equal(sync.normalizeTaskTitle('  Починить\n тесты  '), 'Починить тесты');
	assert.equal(sync.normalizeTaskTitle(undefined), '', 'пустая строка — создавать нечего');
	assert.equal(sync.normalizeTaskTitle('   '), '');
	assert.equal(sync.normalizeTaskTitle('x'.repeat(500)).length, sync.TASK_TITLE_LIMIT);
});

// ---------- итог → статус ----------

test('statusForOutcome: готово → review, иначе остаётся в работе', () => {
	assert.equal(sync.statusForOutcome('done'), 'review');
	assert.equal(sync.statusForOutcome('error'), 'doing');
	assert.equal(sync.statusForOutcome('cancelled'), 'doing');
});

test('outcomeNote: короткое резюме вместо лога', () => {
	const done = sync.outcomeNote('done', 'Все агенты завершили', 'ветка task/1', 5);
	assert.equal(done.ref, 'ветка task/1');
	assert.ok(done.text.includes('патч готов'));

	const failed = sync.outcomeNote('error', 'verify упал');
	assert.ok(failed.text.startsWith('остановился:'));

	const long = sync.outcomeNote('error', 'x'.repeat(1000));
	assert.ok(long.text.length < 420);
});
