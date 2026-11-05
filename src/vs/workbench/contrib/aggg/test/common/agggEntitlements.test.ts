/*---------------------------------------------------------------------------------------------
 *  AGGG — тесты доступности версий ядра: 5.2 открыта всем, файлы идут с сервера.
 *  Запуск: ./scripts/test.sh (mocha, suite/test-глобалы).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { agggVersionAvailable, agggVersionOptionKind, resolveAgggVersion } from '../../common/agggEntitlements.js';

suite('AGGG — доступность версии 5.2', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('встроенное ядро доступно всегда', () => {
		assert.strictEqual(agggVersionAvailable('2.0.0', []), true);
		assert.deepStrictEqual(resolveAgggVersion('2.0.0', []), { version: '2.0.0', blocked: false, reason: undefined });
	});

	test('5.2 открыта всем — права больше не спрашиваем', () => {
		assert.strictEqual(agggVersionAvailable('5.2', []), true);
		assert.deepStrictEqual(resolveAgggVersion('5.2', []), { version: '5.2', blocked: false, reason: undefined });
	});

	test('5.2 с любым списком возможностей работает одинаково', () => {
		for (const features of [[], ['aggg52'], ['beta'], ['aggg50', 'other']]) {
			assert.deepStrictEqual(resolveAgggVersion('5.2', features), { version: '5.2', blocked: false, reason: undefined });
		}
	});

	test('неизвестное значение настройки трактуется как встроенное ядро', () => {
		for (const value of [undefined, '', '   ', '5.2.0', 'v5.2', '6.0']) {
			assert.strictEqual(resolveAgggVersion(value, []).version, '2.0.0', `значение: ${String(value)}`);
		}
	});

	test('внешняя версия в списке всегда выбираема', () => {
		assert.strictEqual(agggVersionOptionKind('5.2', []), 'external');
		assert.strictEqual(agggVersionOptionKind('2.0.0', []), 'builtin');
	});
});
