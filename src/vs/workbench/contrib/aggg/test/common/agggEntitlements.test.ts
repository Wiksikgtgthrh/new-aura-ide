/*---------------------------------------------------------------------------------------------
 *  AGGG — тесты гейта версии ядра 5.2: право выдаётся аккаунту, а не едет с плагином.
 *  Запуск: ./scripts/test.sh (mocha, suite/test-глобалы).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AGGG_52_FEATURE, agggVersionAvailable, agggVersionOptionKind, resolveAgggVersion } from '../../common/agggEntitlements.js';

suite('AGGG — доступность версии 5.2', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('встроенное ядро доступно без прав', () => {
		assert.strictEqual(agggVersionAvailable('2.0.0', []), true);
		assert.deepStrictEqual(resolveAgggVersion('2.0.0', []), { version: '2.0.0', blocked: false, reason: undefined });
	});

	test('5.2 без права откатывается на встроенное ядро с причиной «лицензия»', () => {
		assert.deepStrictEqual(resolveAgggVersion('5.2', []), { version: '2.0.0', blocked: true, reason: 'license' });
	});

	test('5.2 с выданным правом работает', () => {
		const decision = resolveAgggVersion('5.2', [AGGG_52_FEATURE]);
		assert.deepStrictEqual(decision, { version: '5.2', blocked: false, reason: undefined });
	});

	test('чужие возможности не открывают 5.2', () => {
		assert.strictEqual(agggVersionAvailable('5.2', ['aggg50', 'beta']), false);
	});

	test('неизвестное значение настройки трактуется как встроенное ядро', () => {
		for (const value of [undefined, '', '   ', '5.2.0', 'v5.2', '6.0']) {
			assert.strictEqual(resolveAgggVersion(value, [AGGG_52_FEATURE]).version, '2.0.0', `значение: ${String(value)}`);
		}
	});

	test('закрытая версия помечена в списке, а не спрятана', () => {
		assert.strictEqual(agggVersionOptionKind('5.2', []), 'external-locked');
		assert.strictEqual(agggVersionOptionKind('5.2', [AGGG_52_FEATURE]), 'external');
		assert.strictEqual(agggVersionOptionKind('2.0.0', []), 'builtin');
	});
});
