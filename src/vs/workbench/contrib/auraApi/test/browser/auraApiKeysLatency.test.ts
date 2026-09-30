/*---------------------------------------------------------------------------------------------
 *  API Keys — живые замеры ключей: медианы первого токена, адаптивный порог и исключение
 *  медленного ключа из автовыбора. Здесь проверяется именно проводка в реестре ключей
 *  (чистая арифметика порогов покрыта в auraApiModel.test.ts).
 *  Запуск: ./scripts/test.sh (mocha, suite/test-глобалы).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { newWriteableBufferStream, VSBuffer } from '../../../../../base/common/buffer.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { AuraApiKeysService } from '../../common/auraApiKeys.js';

/**
 * Ответ-заглушка в форме IContext: asText читает VS Code-поток (VSBuffer), а не web ReadableStream.
 * Тело уже записано: newWriteableBufferStream буферизует его до первого читателя.
 */
function fakeContext(statusCode: number, body: string) {
	const stream = newWriteableBufferStream();
	stream.write(VSBuffer.fromString(body));
	stream.end();
	return { res: { statusCode, headers: {} }, stream };
}

interface IHarness {
	service: AuraApiKeysService;
	add: (name: string) => Promise<string>;
}

function makeHarness(config: Record<string, unknown> = {}): IHarness {
	const secrets = new Map<string, string>();
	const storage = {
		get: () => undefined,
		store: () => { /* в тесте состояние в памяти */ },
	} as unknown as IStorageService;
	const secretStorage = {
		get: async (key: string) => secrets.get(key),
		set: async (key: string, value: string) => { secrets.set(key, value); },
		delete: async (key: string) => { secrets.delete(key); },
	} as unknown as ISecretStorageService;
	const requestService = {
		request: async (options: { url: string; type: string }) => options.url.endsWith('/models')
			? fakeContext(200, JSON.stringify({ data: [{ id: 'gpt-4o' }] }))
			: fakeContext(200, JSON.stringify({ model: 'gpt-4o', choices: [{ message: { content: 'gpt-4o' } }] })),
	} as unknown as IRequestService;
	const configurationService = {
		getValue: (key: string) => config[key],
	} as unknown as IConfigurationService;

	const service = new AuraApiKeysService(storage, secretStorage, requestService, configurationService, new NullLogService());
	return {
		service,
		add: async (name: string) => {
			const key = await service.addKey({ name, baseUrl: 'https://example.test/v1', model: 'gpt-4o', priority: 'medium' }, `sk-${name}`);
			await service.checkKey(key.id); // ждём проверку: ok=true нужен для правила «есть замена»
			return key.id;
		},
	};
}

suite('AuraApiKeysService — живая скорость ключей', () => {

	test('два медленных ответа выводят ключ из автовыбора, быстрый возвращает', async () => {
		const { service, add } = makeHarness();
		const slow = await add('slow');
		await add('fast'); // живая замена есть — исключать можно

		service.reportChatLatency(slow, 5_000);
		service.reportChatLatency(slow, 4_600);
		const excluded = { ...service.getStatus(slow) };

		service.reportChatLatency(slow, 250);
		const returned = { ...service.getStatus(slow) };

		assert.deepStrictEqual({
			excluded: { excludedHighPing: excluded.excludedHighPing, reason: excluded.excludedReason, explains: /лучший ключ/.test(excluded.error ?? '') },
			medians: excluded.latencySamples?.length,
			returned: { excludedHighPing: returned.excludedHighPing === true, reason: returned.excludedReason, streak: returned.slowStreak, median: returned.latencyMs },
		}, {
			excluded: { excludedHighPing: true, reason: 'latency', explains: true },
			medians: 2,
			returned: { excludedHighPing: false, reason: undefined, streak: 0, median: 250 },
		});
	});

	test('порог адаптивный: медленно относительно лучшего ключа, а не в миллисекундах', async () => {
		const { service, add } = makeHarness();
		const first = await add('first');
		const best = await add('best');
		// Лучший ключ отвечает за 110 мс (медиана) — база сравнения.
		service.reportChatLatency(best, 100);
		service.reportChatLatency(best, 120);

		// 900 мс при пороге max(пол=800, 110×2.5=275) — уже медленно.
		service.reportChatLatency(first, 900);
		const slow = service.getStatus(first).slowStreak;

		// 700 мс того же ключа в порог укладывается: серия обнуляется, ключ не мигает.
		service.reportChatLatency(first, 700);
		const after = service.getStatus(first);

		assert.deepStrictEqual({
			bestMedian: service.getStatus(best).latencySamples,
			streakAfterSlow: slow,
			streakAfterWithinThreshold: after.slowStreak,
			excluded: after.excludedHighPing,
		}, {
			bestMedian: [100, 120],
			streakAfterSlow: 1,
			streakAfterWithinThreshold: 0,
			excluded: false,
		});
	});

	test('пока замеров нет, работает стартовый порог из настроек', async () => {
		const { service, add } = makeHarness({ 'apiKeys.router.slowFirstTokenMs': 1_000 });
		const only = await add('only');

		service.reportChatLatency(only, 1_500);
		const slow = service.getStatus(only).slowStreak;
		service.reportChatLatency(only, 400);
		const fast = service.getStatus(only).slowStreak;

		assert.deepStrictEqual({ slow, fast }, { slow: 1, fast: 0 });
	});

	test('единственный рабочий ключ не исключается: переключаться было бы некуда', async () => {
		const { service, add } = makeHarness();
		const only = await add('only');

		service.reportChatLatency(only, 9_000);
		service.reportChatLatency(only, 9_500);
		service.reportChatLatency(only, 9_100);
		const status = service.getStatus(only);

		assert.deepStrictEqual({
			excluded: status.excludedHighPing === true,
			streakStaysOneShortOfLimit: status.slowStreak,
			stillUsable: service.getKeys().filter(k => k.enabled !== false).length,
			inAutoSelection: service.resolveKeyForModel()?.id === only,
		}, {
			excluded: false,
			streakStaysOneShortOfLimit: 1,
			stillUsable: 1,
			inAutoSelection: true,
		});
	});

	test('прежний id настройки (auraApi.*) продолжает работать: настройки не теряются при переименовании', async () => {
		const { service, add } = makeHarness({ 'auraApi.router.slowFirstTokenMs': 1_000 });
		const key = await add('legacy');

		service.reportChatLatency(key, 1_500);
		const slow = service.getStatus(key).slowStreak;
		service.reportChatLatency(key, 400);
		const fast = service.getStatus(key).slowStreak;

		assert.deepStrictEqual({ slow, fast }, { slow: 1, fast: 0 });
	});

	test('новый id настройки важнее прежнего', async () => {
		const { service, add } = makeHarness({ 'apiKeys.router.slowFirstTokenMs': 2_000, 'auraApi.router.slowFirstTokenMs': 100 });
		const key = await add('both');

		service.reportChatLatency(key, 500);
		const status = service.getStatus(key);

		// Порог 2000 мс: 500 мс — быстро, хотя по прежнему id порог был бы 100 мс.
		assert.deepStrictEqual({ streak: status.slowStreak, latencyMs: status.latencyMs }, { streak: 0, latencyMs: 500 });
	});

	test('наблюдение выключено (slowFirstTokenMs = 0) — статус не трогается', async () => {
		const { service, add } = makeHarness({ 'apiKeys.router.slowFirstTokenMs': 0 });
		const key = await add('key');
		await add('other');

		service.reportChatLatency(key, 30_000);
		const status = service.getStatus(key);

		assert.deepStrictEqual({
			latencyMs: status.latencyMs,
			samples: status.latencySamples,
			excluded: status.excludedHighPing === true,
		}, {
			latencyMs: undefined,
			samples: undefined,
			excluded: false,
		});
	});
});
