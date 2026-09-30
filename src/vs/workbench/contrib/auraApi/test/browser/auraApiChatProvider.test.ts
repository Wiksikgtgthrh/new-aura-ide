/*---------------------------------------------------------------------------------------------
 *  API Keys — smoke-тесты провайдера чата (пункты 3–6 аудита):
 *  выключенный ключ не выбирается; ключ с ошибкой не в автовыборе, но доступен вручную;
 *  401/429/5xx разведены (пометка / фейловер / retry с бэкоффом); нет ключей — понятная ошибка.
 *  Запуск: ./scripts/test.sh (mocha, suite/test-глобалы).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AuraApiChatProvider, API_KEYS_VENDOR } from '../../browser/auraApiChatProvider.js';
import type { IAuraApiKey, IAuraApiKeyStatus, IAuraApiKeysService } from '../../common/auraApiKeys.js';
import type { IChatMessage, ILanguageModelChatRequestOptions } from '../../../chat/common/languageModels.js';

function makeKey(id: string, overrides?: Partial<IAuraApiKey>): IAuraApiKey {
	return {
		id,
		name: id,
		baseUrl: `https://example.com/${id}`,
		model: 'gpt-4o',
		priority: 'medium',
		createdAt: 0,
		provider: 'openai-compatible',
		...overrides,
	};
}

/** Минимальный мок IAuraApiKeysService: ключи + статусы + запись reportChatRequestResult. */
function makeKeysService(keys: IAuraApiKey[], statuses: Record<string, Partial<IAuraApiKeyStatus>>): IAuraApiKeysService & { reports: Array<[string, number]>; networkReports: Array<[string, string]>; latencyReports: Array<[string, number]> } {
	const reports: Array<[string, number]> = [];
	const networkReports: Array<[string, string]> = [];
	const latencyReports: Array<[string, number]> = [];
	// Event.None не создаёт FunctionDisposable при подписке — иначе ensureNoDisposablesAreLeakedInTestSuite падает.
	const service: Partial<IAuraApiKeysService> & { reports: Array<[string, number]>; networkReports: Array<[string, string]>; latencyReports: Array<[string, number]> } = {
		reports,
		networkReports,
		latencyReports,
		onDidChange: Event.None,
		onDidChangeActiveKey: Event.None,
		getKeys: () => keys,
		getSecret: async () => 'sk-test-secret',
		getStatus: (id: string) => ({ checking: false, ...statuses[id] }) as IAuraApiKeyStatus,
		resolveKeyForModel: () => keys.find(k => {
			if (k.enabled === false) { return false; }
			const s = statuses[k.id];
			return s?.ok === true && !s?.excludedHighPing;
		}),
		getSelectedKeyId: () => undefined,
		maskedSecretLabel: () => 'sk-…test',
		reportChatRequestResult: (keyId: string, status: number) => { reports.push([keyId, status]); },
		reportChatNetworkFailure: (keyId: string, reason: string) => { networkReports.push([keyId, reason]); },
		reportChatLatency: (keyId: string, firstTokenMs: number) => { latencyReports.push([keyId, firstTokenMs]); },
	};
	return service as IAuraApiKeysService & { reports: Array<[string, number]>; networkReports: Array<[string, string]>; latencyReports: Array<[string, number]> };
}

const configStub = { getValue: () => undefined } as unknown as IConfigurationService;

/** Настройки маршрутизации: пороги в миллисекундах вместо дефолтных (чтобы не ждать 45 с в тесте). */
function configWith(values: Record<string, number>): IConfigurationService {
	return { getValue: (key: string) => values[key] } as unknown as IConfigurationService;
}

function sseResponse(text: string): Response {
	const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(payload));
			controller.close();
		}
	});
	return new Response(stream, { status: 200 });
}

function errorResponse(status: number): Response {
	return new Response(`error ${status}`, { status });
}

/** Сбой связи так, как его отдают undici (Node) и Chromium: код лежит в cause. */
function networkErrorResponse(): never {
	throw Object.assign(new TypeError('fetch failed'), {
		cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
	});
}

/** Ответ, который отдаёт первый токен только через delayMs (живой, но медленный старт). */
function delayedSseResponse(text: string, delayMs: number): Response {
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			await new Promise(r => setTimeout(r, delayMs));
			controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`));
			controller.close();
		}
	});
	return new Response(stream, { status: 200 });
}

/** Ответ, который не отдаёт ничего (эндпоинт принял запрос и молчит). */
function silentResponse(): Response {
	return new Response(new ReadableStream<Uint8Array>({ start() { /* молчим до таймаута */ } }), { status: 200 });
}

/** Ответ, который стримит текст, а затем умолкает, не закрывая соединение. */
function stallingStreamResponse(text: string): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
		}
	});
	return new Response(stream, { status: 200 });
}

/** Ответ, который начинает стримить текст, а затем обрывает соединение. */
function droppingStreamResponse(text: string): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
		},
		pull(controller) {
			controller.error(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
		}
	});
	return new Response(stream, { status: 200 });
}

const USER_MESSAGE: IChatMessage = { role: 1, content: [{ type: 'text', value: 'hi' }] } as unknown as IChatMessage;
const OPTIONS = {} as ILanguageModelChatRequestOptions;

suite('AuraApiChatProvider — smoke', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let originalFetch: typeof globalThis.fetch;
	let fetchCalls: string[];

	setup(() => {
		originalFetch = globalThis.fetch;
		fetchCalls = [];
	});

	teardown(() => {
		globalThis.fetch = originalFetch;
	});

	function stubFetch(handler: (url: string, callIndex: number) => Response): void {
		globalThis.fetch = (async (input: unknown) => {
			const url = String(input);
			fetchCalls.push(url);
			return handler(url, fetchCalls.length - 1);
		}) as typeof fetch;
	}

	async function collect(stream: AsyncIterable<{ type: string; value?: string }>): Promise<string> {
		let text = '';
		for await (const part of stream) {
			if (part.type === 'text' && part.value) { text += part.value; }
		}
		return text;
	}

	/** Собрать то, что успело прийти до сбоя: чат показывает текст, даже если поток оборвался. */
	async function collectUntilFailure(stream: AsyncIterable<{ type: string; value?: string }>): Promise<{ text: string; message?: string }> {
		let text = '';
		try {
			for await (const part of stream) {
				if (part.type === 'text' && part.value) { text += part.value; }
			}
		} catch (error) {
			return { text, message: error instanceof Error ? error.message : String(error) };
		}
		return { text };
	}

	test('п.3: выключенный ключ (enabled: false) не выбирается никогда', async () => {
		const keys = [makeKey('off', { enabled: false }), makeKey('on')];
		const statuses = { off: { ok: true }, on: { ok: true } };
		const keysService = makeKeysService(keys, statuses);
		const provider = new AuraApiChatProvider(keysService, configStub, new NullLogService());

		// В списке моделей чата выключенного ключа нет
		const infos = await provider.provideLanguageModelChatInfo({ silent: true }, CancellationToken.None);
		assert.deepStrictEqual(infos.map(i => i.identifier), [`${API_KEYS_VENDOR}/on`]);

		// Даже явный запрос по id выключенной модели уходит на живой ключ, а не на него
		stubFetch(() => sseResponse('ok'));
		const res = await provider.sendChatRequest('off', [USER_MESSAGE], undefined, OPTIONS, CancellationToken.None);
		await collect(res.stream as AsyncIterable<{ type: string; value?: string }>);
		assert.strictEqual(fetchCalls.length, 1);
		assert.ok(fetchCalls[0].startsWith('https://example.com/on'), `запрос ушёл не на выключенный ключ: ${fetchCalls[0]}`);
	});

	test('п.4: ключ со статусом error исключён из автовыбора, но доступен вручную', async () => {
		const keys = [makeKey('bad'), makeKey('good')];
		const statuses = { bad: { ok: false, error: 'HTTP 500' }, good: { ok: true } };
		const keysService = makeKeysService(keys, statuses);
		const provider = new AuraApiChatProvider(keysService, configStub, new NullLogService());

		const infos = await provider.provideLanguageModelChatInfo({ silent: true }, CancellationToken.None);
		assert.deepStrictEqual(infos.map(i => i.identifier), [`${API_KEYS_VENDOR}/good`]);

		// Вручную (явный modelId) — доступен
		stubFetch(() => sseResponse('manual'));
		const res = await provider.sendChatRequest('bad', [USER_MESSAGE], undefined, OPTIONS, CancellationToken.None);
		const text = await collect(res.stream as AsyncIterable<{ type: string; value?: string }>);
		assert.strictEqual(text, 'manual');
		assert.ok(fetchCalls[0].startsWith('https://example.com/bad'));
	});

	test('п.5: 429 — «Лимит исчерпан» + автопереключение на следующий ключ', async () => {
		const keys = [makeKey('k1'), makeKey('k2')];
		const statuses = { k1: { ok: true }, k2: { ok: true } };
		const keysService = makeKeysService(keys, statuses);
		const provider = new AuraApiChatProvider(keysService, configStub, new NullLogService());

		stubFetch(url => url.includes('/k1') ? errorResponse(429) : sseResponse('from k2'));
		const res = await provider.sendChatRequest('k1', [USER_MESSAGE], undefined, OPTIONS, CancellationToken.None);
		const text = await collect(res.stream as AsyncIterable<{ type: string; value?: string }>);
		assert.strictEqual(text, 'from k2');
		assert.deepStrictEqual(keysService.reports, [['k1', 429]]);
	});

	test('п.5: 5xx — retry с бэкоффом до 3 раз по тому же ключу', async () => {
		const keys = [makeKey('flaky')];
		const keysService = makeKeysService(keys, { flaky: { ok: true } });
		const provider = new AuraApiChatProvider(keysService, configStub, new NullLogService());

		stubFetch((_url, i) => i < 2 ? errorResponse(503) : sseResponse('recovered'));
		const res = await provider.sendChatRequest('flaky', [USER_MESSAGE], undefined, OPTIONS, CancellationToken.None);
		const text = await collect(res.stream as AsyncIterable<{ type: string; value?: string }>);
		assert.strictEqual(text, 'recovered');
		assert.strictEqual(fetchCalls.length, 3, 'должно быть ровно 3 попытки (2 retry с бэкоффом)');
	});

	test('п.5: 401 — «Ключ недействителен», ключ помечается, retry по нему нет', async () => {
		const keys = [makeKey('dead')];
		const keysService = makeKeysService(keys, { dead: { ok: true } });
		const provider = new AuraApiChatProvider(keysService, configStub, new NullLogService());

		stubFetch(() => errorResponse(401));
		const res = await provider.sendChatRequest('dead', [USER_MESSAGE], undefined, OPTIONS, CancellationToken.None);
		await assert.rejects(
			async () => collect(res.stream as AsyncIterable<{ type: string; value?: string }>),
			/недействителен/,
		);
		assert.strictEqual(fetchCalls.length, 1, '401 не должен ретраиться');
		assert.deepStrictEqual(keysService.reports, [['dead', 401]]);
	});

	test('п.6: нет ключей — понятная ошибка с кнопкой «Добавить ключ», а не молчаливый падеж', async () => {
		const keysService = makeKeysService([], {});
		const provider = new AuraApiChatProvider(keysService, configStub, new NullLogService());
		await assert.rejects(
			() => provider.sendChatRequest('any', [USER_MESSAGE], undefined, OPTIONS, CancellationToken.None),
			/Добавить ключ/,
		);
	});

	test('сеть: сбой до первого байта — фейловер на следующий ключ и cooldown пострадавшего', async () => {
		const keys = [makeKey('net1'), makeKey('net2')];
		const keysService = makeKeysService(keys, { net1: { ok: true }, net2: { ok: true } });
		const provider = new AuraApiChatProvider(keysService, configStub, new NullLogService());

		stubFetch(url => url.includes('/net1') ? networkErrorResponse() : sseResponse('from net2'));
		const res = await provider.sendChatRequest('net1', [USER_MESSAGE], undefined, OPTIONS, CancellationToken.None);
		const text = await collect(res.stream as AsyncIterable<{ type: string; value?: string }>);

		assert.deepStrictEqual({
			text,
			fetched: fetchCalls.length,
			networkReports: keysService.networkReports,
			httpReports: keysService.reports,
		}, {
			text: 'from net2',
			fetched: 2,
			networkReports: [['net1', 'UND_ERR_CONNECT_TIMEOUT']],
			httpReports: [],
		});
	});

	test('сеть: все ключи недоступны — в ошибке есть ключ, эндпоинт и причина', async () => {
		const keys = [makeKey('a'), makeKey('b')];
		const keysService = makeKeysService(keys, { a: { ok: true }, b: { ok: true } });
		const provider = new AuraApiChatProvider(keysService, configStub, new NullLogService());

		stubFetch(() => networkErrorResponse());
		const res = await provider.sendChatRequest('a', [USER_MESSAGE], undefined, OPTIONS, CancellationToken.None);

		let message = '';
		try {
			await collect(res.stream as AsyncIterable<{ type: string; value?: string }>);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		assert.deepStrictEqual({
			saysAllKeysFailed: /Все ключи недоступны \(проверено 2\)/.test(message),
			namesKey: message.includes('[b] gpt-4o @ https://example.com/b'),
			hasReason: message.includes('UND_ERR_CONNECT_TIMEOUT'),
			notBareNetworkError: !/^network error$/i.test(message),
			networkReports: keysService.networkReports.map(r => r[0]),
		}, {
			saysAllKeysFailed: true,
			namesKey: true,
			hasReason: true,
			notBareNetworkError: true,
			networkReports: ['a', 'b'],
		});
	});

	test('сеть: обрыв на середине ответа — текст сохраняется, ошибка объясняет разрыв', async () => {
		const keys = [makeKey('drop')];
		const keysService = makeKeysService(keys, { drop: { ok: true } });
		const provider = new AuraApiChatProvider(keysService, configStub, new NullLogService());

		stubFetch(() => droppingStreamResponse('начало ответа '));
		const res = await provider.sendChatRequest('drop', [USER_MESSAGE], undefined, OPTIONS, CancellationToken.None);

		const { text, message } = await collectUntilFailure(res.stream as AsyncIterable<{ type: string; value?: string }>);

		assert.deepStrictEqual({
			streamed: text,
			saysInterrupted: /соединение прервано \(ECONNRESET\)/.test(message ?? ''),
			noFailover: fetchCalls.length,
			networkReports: keysService.networkReports.map(r => r[0]),
		}, {
			streamed: 'начало ответа ',
			saysInterrupted: true,
			noFailover: 1,
			networkReports: ['drop'],
		});
	});

	test('медленный первый токен: есть измеренно быстрый ключ — переключаемся, ничего не потеряно', async () => {
		const keys = [makeKey('slow'), makeKey('fast')];
		const keysService = makeKeysService(keys, { slow: { ok: true }, fast: { ok: true, latencySamples: [20] } });
		const provider = new AuraApiChatProvider(keysService, configWith({
			'apiKeys.router.slowFirstTokenMs': 50,
			'apiKeys.router.slowFloorMs': 20,
			'apiKeys.router.slowKeyFactor': 2,
			'apiKeys.router.firstTokenTimeoutMs': 5000,
			'apiKeys.router.streamGapMs': 5000,
		}), new NullLogService());

		stubFetch(url => url.includes('/slow') ? delayedSseResponse('медленный', 120) : sseResponse('быстрый'));
		const res = await provider.sendChatRequest('slow', [USER_MESSAGE], undefined, OPTIONS, CancellationToken.None);
		const text = await collect(res.stream as AsyncIterable<{ type: string; value?: string }>);

		// Замер снимается с каждого ответа: у slow он медленный, у fast — быстрый (обнуляет серию).
		assert.deepStrictEqual({
			text,
			fetched: fetchCalls.length,
			measured: keysService.latencyReports.map(r => r[0]),
			noErrorReports: keysService.networkReports.length,
		}, {
			text: 'быстрый',
			fetched: 2,
			measured: ['slow', 'fast'],
			noErrorReports: 0,
		});
	});

	test('медленный первый токен без заведомо быстрого запасного — остаёмся на выбранном ключе', async () => {
		const keys = [makeKey('slow'), makeKey('unknown')];
		const keysService = makeKeysService(keys, { slow: { ok: true }, unknown: { ok: true } });
		const provider = new AuraApiChatProvider(keysService, configWith({
			'apiKeys.router.slowFirstTokenMs': 20,
			'apiKeys.router.firstTokenTimeoutMs': 5000,
			'apiKeys.router.streamGapMs': 5000,
		}), new NullLogService());

		stubFetch(url => url.includes('/slow') ? delayedSseResponse('додумался', 60) : sseResponse('запасной'));
		const res = await provider.sendChatRequest('slow', [USER_MESSAGE], undefined, OPTIONS, CancellationToken.None);
		const text = await collect(res.stream as AsyncIterable<{ type: string; value?: string }>);

		// «Долго думающая» модель не бросается вслепую: замена без измерений — не доказательство скорости.
		assert.deepStrictEqual({ text, fetched: fetchCalls.length, reported: keysService.latencyReports.map(r => r[0]) }, {
			text: 'додумался',
			fetched: 1,
			reported: ['slow'],
		});
	});

	test('порог адаптивный: в медленном пуле 400 мс — не повод переключаться', async () => {
		// Оба ключа отвечают сотнями миллисекунд: сравнивать нужно их между собой, а не с настройкой.
		const keys = [makeKey('pool1'), makeKey('pool2')];
		const keysService = makeKeysService(keys, {
			pool1: { ok: true, latencySamples: [300, 320] },
			pool2: { ok: true, latencySamples: [250, 260] },
		});
		const provider = new AuraApiChatProvider(keysService, configWith({
			'apiKeys.router.slowFirstTokenMs': 100, // стартовый порог: замеры есть, он уже не решает
			'apiKeys.router.slowFloorMs': 20,
			'apiKeys.router.slowKeyFactor': 2.5,
			'apiKeys.router.firstTokenTimeoutMs': 5000,
			'apiKeys.router.streamGapMs': 5000,
		}), new NullLogService());

		stubFetch(url => url.includes('/pool1') ? delayedSseResponse('от pool1', 400) : sseResponse('от pool2'));
		const res = await provider.sendChatRequest('pool1', [USER_MESSAGE], undefined, OPTIONS, CancellationToken.None);
		const text = await collect(res.stream as AsyncIterable<{ type: string; value?: string }>);

		// Порог = max(пол 20, лучший ключ 255×2.5=638): 400 мс в него укладывается.
		assert.deepStrictEqual({ text, fetched: fetchCalls.length }, { text: 'от pool1', fetched: 1 });
	});

	test('порог адаптивный: ключ в разы медленнее лучшего — переключаемся, даже если стартовая настройка выше', async () => {
		const keys = [makeKey('laggy'), makeKey('quick')];
		const keysService = makeKeysService(keys, {
			laggy: { ok: true, latencySamples: [900, 950] },
			quick: { ok: true, latencySamples: [200, 210] },
		});
		const provider = new AuraApiChatProvider(keysService, configWith({
			'apiKeys.router.slowFirstTokenMs': 5000, // намеренно выше самого замера: решает только сравнение
			'apiKeys.router.slowFloorMs': 20,
			'apiKeys.router.slowKeyFactor': 2.5,
			'apiKeys.router.firstTokenTimeoutMs': 5000,
			'apiKeys.router.streamGapMs': 5000,
		}), new NullLogService());

		stubFetch(url => url.includes('/laggy') ? delayedSseResponse('медленный', 900) : sseResponse('быстрый'));
		const res = await provider.sendChatRequest('laggy', [USER_MESSAGE], undefined, OPTIONS, CancellationToken.None);
		const text = await collect(res.stream as AsyncIterable<{ type: string; value?: string }>);

		assert.deepStrictEqual({ text, fetched: fetchCalls.length }, { text: 'быстрый', fetched: 2 });
	});

	test('молчание до первого токена: переключаемся на живой ключ и помечаем молчащего', async () => {
		const keys = [makeKey('mute'), makeKey('alive')];
		const keysService = makeKeysService(keys, { mute: { ok: true }, alive: { ok: true } });
		const provider = new AuraApiChatProvider(keysService, configWith({
			'apiKeys.router.firstTokenTimeoutMs': 60,
			'apiKeys.router.streamGapMs': 60,
		}), new NullLogService());

		stubFetch(url => url.includes('/mute') ? silentResponse() : sseResponse('от живого'));
		const res = await provider.sendChatRequest('mute', [USER_MESSAGE], undefined, OPTIONS, CancellationToken.None);
		const text = await collect(res.stream as AsyncIterable<{ type: string; value?: string }>);

		// Молчащий ключ измеряется слишком долгим ожиданием, живой — быстрым ответом.
		assert.deepStrictEqual({
			text,
			fetched: fetchCalls.length,
			saidStall: /нет первого токена/.test(keysService.networkReports[0]?.[1] ?? ''),
			countedAsSlow: keysService.latencyReports.map(r => r[0]),
		}, {
			text: 'от живого',
			fetched: 2,
			saidStall: true,
			countedAsSlow: ['mute', 'alive'],
		});
	});

	test('молчание посреди ответа: текст сохраняется, фейловера нет, ошибка называет причину', async () => {
		const keys = [makeKey('stalled'), makeKey('spare')];
		const keysService = makeKeysService(keys, { stalled: { ok: true }, spare: { ok: true } });
		const provider = new AuraApiChatProvider(keysService, configWith({
			'apiKeys.router.firstTokenTimeoutMs': 5000,
			'apiKeys.router.streamGapMs': 60,
		}), new NullLogService());

		stubFetch(url => url.includes('/stalled') ? stallingStreamResponse('начало ответа ') : sseResponse('дубль'));
		const res = await provider.sendChatRequest('stalled', [USER_MESSAGE], undefined, OPTIONS, CancellationToken.None);
		const { text, message } = await collectUntilFailure(res.stream as AsyncIterable<{ type: string; value?: string }>);

		assert.deepStrictEqual({
			streamed: text,
			saysStall: /поток молчит дольше/.test(message ?? ''),
			saysIncomplete: /Ответ выше не полный/.test(message ?? ''),
			noFailover: fetchCalls.length,
			reportedStall: /поток молчит дольше/.test(keysService.networkReports[0]?.[1] ?? ''),
		}, {
			streamed: 'начало ответа ',
			saysStall: true,
			saysIncomplete: true,
			noFailover: 1,
			reportedStall: true,
		});
	});

	test('отмена пользователем не наказывает ключ', async () => {
		const keys = [makeKey('cancelled')];
		const keysService = makeKeysService(keys, { cancelled: { ok: true } });
		const provider = new AuraApiChatProvider(keysService, configStub, new NullLogService());
		const cts = new CancellationTokenSource();

		stubFetch(() => { cts.cancel(); networkErrorResponse(); });
		const res = await provider.sendChatRequest('cancelled', [USER_MESSAGE], undefined, OPTIONS, cts.token);
		await assert.rejects(async () => collect(res.stream as AsyncIterable<{ type: string; value?: string }>));

		assert.deepStrictEqual(keysService.networkReports, []);
	});
});
