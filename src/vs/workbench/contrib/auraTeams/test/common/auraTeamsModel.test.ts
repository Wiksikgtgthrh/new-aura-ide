/*---------------------------------------------------------------------------------------------
 *  Aura Teams — юнит-тесты модели доски.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	branchNameForTask, createTask, emptyBoard, moveTask, myTasks, parseBoard, removeTask, tasksInColumn, updateTask,
} from '../../common/auraTeamsModel.js';

suite('AuraTeamsModel — доска', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const NOW = 1_000;

	test('createTask: порядок в колонке растёт, значения по умолчанию', () => {
		const board = emptyBoard();
		const a = createTask(board, { title: '  Первая  ' }, 'a', NOW);
		const b = createTask(board, { title: 'Вторая', status: 'backlog', priority: 'high' }, 'b', NOW + 1);
		assert.deepStrictEqual([a.order, b.order, a.title, a.status, a.priority, b.priority], [0, 1, 'Первая', 'backlog', 'medium', 'high']);
	});

	test('moveTask: между колонками с переиндексацией и позицией', () => {
		const board = emptyBoard();
		createTask(board, { title: 'A' }, 'a', NOW);
		createTask(board, { title: 'B' }, 'b', NOW);
		createTask(board, { title: 'C' }, 'c', NOW);
		createTask(board, { title: 'X', status: 'inProgress' }, 'x', NOW);

		moveTask(board, 'b', 'inProgress', 0, NOW + 5);
		assert.deepStrictEqual(tasksInColumn(board, 'inProgress').map(t => [t.id, t.order]), [['b', 0], ['x', 1]]);
		assert.deepStrictEqual(tasksInColumn(board, 'backlog').map(t => [t.id, t.order]), [['a', 0], ['c', 1]]);

		moveTask(board, 'a', 'backlog', undefined, NOW + 6); // в конец своей колонки
		assert.deepStrictEqual(tasksInColumn(board, 'backlog').map(t => t.id), ['c', 'a']);
		assert.strictEqual(moveTask(board, 'nope', 'done', 0, NOW), undefined);
	});

	test('updateTask/removeTask', () => {
		const board = emptyBoard();
		createTask(board, { title: 'A' }, 'a', NOW);
		assert.strictEqual(updateTask(board, 'a', { assignee: 'вася' }, NOW + 1)?.updatedAt, NOW + 1);
		assert.strictEqual(updateTask(board, 'zzz', { title: 'x' }, NOW), undefined);
		assert.strictEqual(removeTask(board, 'a'), true);
		assert.strictEqual(removeTask(board, 'a'), false);
	});

	test('myTasks: только незакрытые задачи участника, порядок статус → приоритет', () => {
		const board = emptyBoard();
		createTask(board, { title: 'done', assignee: 'Вася', status: 'done' }, '1', NOW);
		createTask(board, { title: 'low-backlog', assignee: 'вася', priority: 'low' }, '2', NOW);
		createTask(board, { title: 'high-backlog', assignee: 'Вася ', priority: 'high' }, '3', NOW);
		createTask(board, { title: 'in-progress', assignee: 'вася', status: 'inProgress', priority: 'low' }, '4', NOW);
		createTask(board, { title: 'other', assignee: 'петя', status: 'inProgress' }, '5', NOW);
		assert.deepStrictEqual(myTasks(board, 'вася').map(t => t.title), ['in-progress', 'high-backlog', 'low-backlog']);
		assert.deepStrictEqual(myTasks(board, ''), []);
	});

	test('branchNameForTask: транслит, kebab-case, суффикс id', () => {
		assert.strictEqual(branchNameForTask('Починить логин в чате', 'abcdef123'), 'task/pochinit-login-v-chate-abcdef');
		assert.strictEqual(branchNameForTask('!!!', 'xyz'), 'task/task-xyz');
	});

	test('parseBoard: мусор → пустая доска, битые задачи отбрасываются', () => {
		assert.deepStrictEqual(parseBoard(undefined), emptyBoard());
		assert.deepStrictEqual(parseBoard('{oops'), emptyBoard());
		assert.deepStrictEqual(parseBoard('{"version":2,"tasks":[]}'), emptyBoard());
		const ok = parseBoard(JSON.stringify({ version: 1, tasks: [{ id: 'a', title: 'A', status: 'backlog' }, { id: 'b', title: 'B', status: 'nope' }, null] }));
		assert.deepStrictEqual(ok.tasks.map(t => t.id), ['a']);
	});
});
