/*---------------------------------------------------------------------------------------------
 *  Aura Teams — юнит-тесты умного коммита, контрольных точек и истории задач.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildSmartCommitPrompt, checkpointTagName, checkpointsFromRefs, cleanCommitMessage, commitSubject, commitsForTask,
	parseCheckpointTag, relativeTime, taskTrailerOf, truncateDiffForPrompt, withTaskTrailer,
} from '../../common/auraTeamsGit.js';

suite('AuraTeamsGit — умный коммит', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('cleanCommitMessage: ограждения, кавычки, префикс, хвостовые пустые строки', () => {
		assert.strictEqual(cleanCommitMessage('```\nfeat: добавить доску\n\n- колонки\n```\n'), 'feat: добавить доску\n\n- колонки');
		assert.strictEqual(cleanCommitMessage('Сообщение коммита: "fix: чинить логин"'), 'fix: чинить логин');
		assert.strictEqual(cleanCommitMessage('«chore: обновить зависимости»\n\n\n'), 'chore: обновить зависимости');
	});

	test('withTaskTrailer/taskTrailerOf: идемпотентно, трейлер в конце', () => {
		const once = withTaskTrailer('feat: x\n\n- пункт\n', 'abc');
		assert.strictEqual(once, 'feat: x\n\n- пункт\n\nAura-Task: abc');
		assert.strictEqual(withTaskTrailer(once, 'abc'), once);
		assert.strictEqual(taskTrailerOf(once), 'abc');
		assert.strictEqual(taskTrailerOf('feat: без задачи'), undefined);
	});

	test('truncateDiffForPrompt: режет по границе файла и перечисляет остаток', () => {
		const file = (name: string) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-${'x'.repeat(200)}\n+${'y'.repeat(200)}\n`;
		const diff = file('a.ts') + file('b.ts') + file('c.ts');
		const out = truncateDiffForPrompt(diff, file('a.ts').length + file('b.ts').length + 20);
		assert.ok(out.includes('diff --git a/a.ts'));
		assert.ok(out.includes('diff --git a/b.ts'));
		assert.ok(!out.includes('+++ b/c.ts'));
		assert.ok(out.endsWith('[diff обрезан; ещё изменены файлы: c.ts]'));
		assert.strictEqual(truncateDiffForPrompt('короткий', 100), 'короткий');
	});

	test('buildSmartCommitPrompt: содержит diff и название задачи', () => {
		const prompt = buildSmartCommitPrompt('diff --git a/x b/x', 'Починить логин');
		assert.ok(prompt.includes('Починить логин'));
		assert.ok(prompt.endsWith('diff --git a/x b/x'));
	});

	test('commitsForTask/commitSubject', () => {
		const log = [
			{ hash: '1', message: 'feat: a\n\nAura-Task: t1', parents: [] },
			{ hash: '2', message: 'fix: b\n\nAura-Task: t2', parents: [] },
			{ hash: '3', message: 'chore: c\n\nAura-Task: t1', parents: [] },
			{ hash: '4', message: 'без трейлера', parents: [] },
		];
		assert.deepStrictEqual(commitsForTask(log, 't1').map(c => c.hash), ['1', '3']);
		assert.strictEqual(commitSubject('feat: a\n\nтело'), 'feat: a');
	});
});

suite('AuraTeamsGit — контрольные точки', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('тег ↔ дата: round-trip с точностью до секунды', () => {
		const now = new Date(2026, 8, 3, 21, 5, 9).getTime();
		const tag = checkpointTagName(now);
		assert.strictEqual(tag, 'aura/checkpoint/20260903-210509');
		assert.strictEqual(parseCheckpointTag(tag), now);
		assert.strictEqual(parseCheckpointTag('v1.0.0'), undefined);
		assert.strictEqual(parseCheckpointTag('aura/checkpoint/garbage'), undefined);
	});

	test('relativeTime', () => {
		const now = 10_000_000_000;
		assert.strictEqual(relativeTime(now - 10_000, now), 'только что');
		assert.strictEqual(relativeTime(now - 5 * 60_000, now), '5 мин назад');
		assert.strictEqual(relativeTime(now - 3 * 3_600_000, now), '3 ч назад');
		assert.strictEqual(relativeTime(now - 24 * 3_600_000, now), 'вчера');
		assert.strictEqual(relativeTime(now - 3 * 24 * 3_600_000, now), '3 дн назад');
	});

	test('checkpointsFromRefs: только наши теги, новые первыми, refs/tags/ срезается', () => {
		const now = new Date(2026, 8, 3, 22, 0, 0).getTime();
		const cps = checkpointsFromRefs([
			{ name: 'refs/tags/aura/checkpoint/20260903-210000', commit: 'aaa' },
			{ name: 'v1.2.3', commit: 'bbb' },
			{ name: 'aura/checkpoint/20260903-215000', commit: 'ccc' },
			{ name: 'aura/checkpoint/20260903-213000' },
		], now);
		assert.deepStrictEqual(cps.map(c => [c.tag, c.commit, c.label]), [
			['aura/checkpoint/20260903-215000', 'ccc', '10 мин назад'],
			['aura/checkpoint/20260903-210000', 'aaa', '1 ч назад'],
		]);
	});
});
