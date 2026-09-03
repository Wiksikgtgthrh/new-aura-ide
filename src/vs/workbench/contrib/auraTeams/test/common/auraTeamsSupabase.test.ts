/*---------------------------------------------------------------------------------------------
 *  Aura Teams — юнит-тесты маппинга Supabase и разбора Realtime.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAuraTask } from '../../common/auraTeamsModel.js';
import {
	mergeTasks, parseRealtimeMessage, realtimeJoinMessage, realtimeUrl, restTasksUrl, rowToTask, taskToRow,
} from '../../common/auraTeamsSupabase.js';

function task(partial: Partial<IAuraTask> & { id: string }): IAuraTask {
	return { title: partial.id, description: '', status: 'backlog', priority: 'medium', createdAt: 1_000, updatedAt: 1_000, order: 0, ...partial };
}

suite('AuraTeamsSupabase — маппинг', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('taskToRow → rowToTask: round-trip', () => {
		const t = task({ id: 'a', title: 'Задача', description: 'опис', status: 'review', priority: 'high', assignee: 'вася', branch: 'task/x', order: 3, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000 });
		assert.deepStrictEqual(rowToTask(taskToRow(t, 'proj')), t);
		assert.strictEqual(taskToRow(t, 'proj').project, 'proj');
	});

	test('rowToTask: нормализация мусора', () => {
		assert.strictEqual(rowToTask(null), undefined);
		assert.strictEqual(rowToTask({ id: 'x' }), undefined);
		const t = rowToTask({ id: 'x', title: 'T', status: 'weird', priority: 'nope', created_at: 'garbage' });
		assert.deepStrictEqual([t?.status, t?.priority, t?.description, t?.order, Number.isFinite(t?.createdAt)], ['backlog', 'medium', '', 0, true]);
	});

	test('mergeTasks: побеждает поздний updatedAt, локальные новые остаются, известные серверу удалённые уходят', () => {
		const local = [task({ id: 'same-newer', updatedAt: 5 }), task({ id: 'same-older', updatedAt: 1 }), task({ id: 'local-new' }), task({ id: 'deleted-remotely' })];
		const remote = [task({ id: 'same-newer', updatedAt: 2, title: 'R' }), task({ id: 'same-older', updatedAt: 9, title: 'R' }), task({ id: 'remote-only' })];
		const merged = mergeTasks(local, remote, new Set(['same-newer', 'same-older', 'deleted-remotely']));
		assert.deepStrictEqual(merged.map(t => [t.id, t.title]).sort(), [
			['local-new', 'local-new'],
			['remote-only', 'remote-only'],
			['same-newer', 'same-newer'],
			['same-older', 'R'],
		]);
	});
});

suite('AuraTeamsSupabase — Realtime и URL', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parseRealtimeMessage: INSERT/UPDATE/DELETE, чужая таблица, мусор', () => {
		const record = { id: 'a', title: 'A', status: 'done', priority: 'low', sort_order: 1, created_at: '2026-09-03T00:00:00Z', updated_at: '2026-09-03T00:00:01Z' };
		const wrap = (data: object) => JSON.stringify({ event: 'postgres_changes', payload: { data } });
		assert.deepStrictEqual(parseRealtimeMessage(wrap({ table: 'aura_tasks', type: 'INSERT', record }))?.type, 'upsert');
		assert.deepStrictEqual(parseRealtimeMessage(wrap({ table: 'aura_tasks', type: 'DELETE', old_record: { id: 'a' } })), { type: 'delete', id: 'a' });
		assert.strictEqual(parseRealtimeMessage(wrap({ table: 'other', type: 'INSERT', record })), undefined);
		assert.strictEqual(parseRealtimeMessage(JSON.stringify({ event: 'phx_reply' })), undefined);
		assert.strictEqual(parseRealtimeMessage('{oops'), undefined);
	});

	test('URL и join-сообщение', () => {
		const cfg = { url: 'https://db.example.com/', anonKey: 'k+1', project: 'my repo' };
		assert.strictEqual(restTasksUrl(cfg), 'https://db.example.com/rest/v1/aura_tasks?project=eq.my%20repo&select=*');
		assert.strictEqual(realtimeUrl(cfg), 'wss://db.example.com/realtime/v1/websocket?apikey=k%2B1&vsn=1.0.0');
		const join = JSON.parse(realtimeJoinMessage('p', 1));
		assert.strictEqual(join.topic, 'realtime:aura:p');
		assert.strictEqual(join.payload.config.postgres_changes[0].filter, 'project=eq.p');
	});
});
