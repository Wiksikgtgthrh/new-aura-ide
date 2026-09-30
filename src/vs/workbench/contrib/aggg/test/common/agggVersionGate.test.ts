/*---------------------------------------------------------------------------------------------
 *  AGGG — тесты опроса прав и поставки ядра у расширения Team.
 *  Ключевое: отсутствие расширения или права — не ошибка, а штатный ответ «ничего
 *  нет»; после него буст работает на встроенном ядре, а не падает в пустой экран.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { queryAgggAgentPath, queryAgggFeatures, resetAgggFeaturesCache } from '../../browser/agggVersionGate.js';

/** Заглушка службы команд: отвечает тем, что вернёт переданная функция. */
const service = (answer: () => unknown): ICommandService => ({
	executeCommand: async () => answer(),
	getContributedCommandIds: () => [],
} as unknown as ICommandService);

suite('AGGG — права аккаунта и поставка ядра', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	setup(() => resetAgggFeaturesCache());

	test('выданное право даёт возможность, отказ — пустой список', async () => {
		assert.deepStrictEqual(await queryAgggFeatures(service(() => ({ granted: true }))), ['aggg52']);
		resetAgggFeaturesCache();
		assert.deepStrictEqual(await queryAgggFeatures(service(() => ({ granted: false }))), []);
	});

	test('без расширения Team права нет, и исключение не выходит наружу', async () => {
		assert.deepStrictEqual(await queryAgggFeatures(service(() => { throw new Error('command not found'); })), []);
	});

	test('поставка ядра приходит путём, пустой ответ трактуется как «ядра нет»', async () => {
		assert.strictEqual(await queryAgggAgentPath(service(() => ({ path: '/tmp/aggg52' }))), '/tmp/aggg52');
		resetAgggFeaturesCache();
		assert.strictEqual(await queryAgggAgentPath(service(() => ({}))), undefined);
		resetAgggFeaturesCache();
		assert.strictEqual(await queryAgggAgentPath(service(() => undefined)), undefined);
	});

	test('сброс кэша заставляет спросить заново — право могли выдать только что', async () => {
		let granted = false;
		const answers = service(() => ({ granted }));
		assert.deepStrictEqual(await queryAgggFeatures(answers), []);
		granted = true;
		assert.deepStrictEqual(await queryAgggFeatures(answers), [], 'в пределах кэша ответ прежний');
		resetAgggFeaturesCache();
		assert.deepStrictEqual(await queryAgggFeatures(answers), ['aggg52'], 'после сброса видно новое право');
	});
});
