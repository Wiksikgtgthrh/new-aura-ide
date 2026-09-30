/*---------------------------------------------------------------------------------------------
 *  API Keys — юнит-тесты ядра Этапа 2: bulk-парсер, классификатор HTTP, роутер.
 *  Запуск: ./scripts/test.sh (mocha, suite/test-глобалы).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	applyRequestOutcome, auraSecretStorageKey, classifyHttpStatus, cooldownMsForStatus,
	describeNetworkFailure, describeSlowDecision, describeStreamStall, detectProvider, hasFasterAlternative,
	isKeyEligible, isNetworkFailure, maskSecret, modelAuthenticityPercent, nextLatencyUpdate, parseKeysBulk,
	pickWeightedKey, resolveKey, routerLimits, secretFingerprint, SLOW_STREAK_LIMIT, slowThresholdMs,
	pushLatencySample, medianLatency, bestMedianLatency, LATENCY_WINDOW,
	API_KEYS_FIRST_TOKEN_TIMEOUT_SETTING, API_KEYS_SLOW_FIRST_TOKEN_SETTING, API_KEYS_STREAM_GAP_SETTING,
	API_KEYS_SLOW_KEY_FACTOR_SETTING, API_KEYS_SLOW_FLOOR_SETTING,
	DEFAULT_FIRST_TOKEN_TIMEOUT_MS, DEFAULT_SLOW_FIRST_TOKEN_MS, DEFAULT_STREAM_GAP_MS,
	DEFAULT_SLOW_KEY_FACTOR, DEFAULT_SLOW_FLOOR_MS,
	type IAuraApiGroup, type IAuraApiKey, type IAuraRouterState,
} from '../../common/auraApiModel.js';

function makeKey(partial: Partial<IAuraApiKey> & { id: string; groupId: string }): IAuraApiKey {
	return {
		label: partial.id,
		baseUrl: 'https://api.openai.com/v1',
		provider: 'openai-compatible',
		weight: 1,
		models: [],
		health: { status: 'unknown' },
		secretFingerprint: 'fp',
		...partial,
	};
}

function makeGroup(id: string, priority: number): IAuraApiGroup {
	return { id, name: id, priority };
}

function makeState(groups: IAuraApiGroup[], keys: IAuraApiKey[]): IAuraRouterState {
	return { groups, keys, cursors: new Map() };
}

const SK = 'sk-proj-abcdef1234567890ABCD';
const SK2 = 'sk-proj-zzzzzz9876543210WXYZ';

suite('AuraApiModel — bulk-парсер', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('сырой ключ по строке → openai-compatible с дефолтным baseUrl', () => {
		const r = parseKeysBulk(SK);
		assert.strictEqual(r.errors.length, 0);
		assert.strictEqual(r.keys.length, 1);
		assert.strictEqual(r.keys[0].provider, 'openai-compatible');
		assert.strictEqual(r.keys[0].baseUrl, 'https://api.openai.com/v1');
	});

	test('несколько сырых ключей + комментарии и пустые строки', () => {
		const r = parseKeysBulk(`# мои ключи\n${SK}\n\n${SK2}\n`);
		assert.strictEqual(r.keys.length, 2);
		assert.strictEqual(r.errors.length, 0);
	});

	test('.env-строка с кавычками', () => {
		const r = parseKeysBulk(`OPENAI_API_KEY="${SK}"`);
		assert.strictEqual(r.keys.length, 1);
		assert.strictEqual(r.keys[0].label, 'OPENAI_API_KEY');
		assert.strictEqual(r.keys[0].key, SK);
	});

	test('pipe-формат label | baseUrl | key', () => {
		const r = parseKeysBulk(`Мой прокси | https://proxy.example.com/v1 | ${SK}`);
		assert.strictEqual(r.keys.length, 1);
		assert.strictEqual(r.keys[0].label, 'Мой прокси');
		assert.strictEqual(r.keys[0].baseUrl, 'https://proxy.example.com/v1');
		assert.strictEqual(r.keys[0].provider, 'openai-compatible');
	});

	test('pipe-формат label | key (baseUrl дефолтный)', () => {
		const r = parseKeysBulk(`Рабочий | ${SK}`);
		assert.strictEqual(r.keys.length, 1);
		assert.strictEqual(r.keys[0].baseUrl, 'https://api.openai.com/v1');
	});

	test('CSV с заголовком', () => {
		const r = parseKeysBulk(`label,baseUrl,key\nProd,https://api.openai.com/v1,${SK}\nDev,,${SK2}\n`);
		assert.strictEqual(r.errors.length, 0);
		assert.strictEqual(r.keys.length, 2);
		assert.strictEqual(r.keys[0].label, 'Prod');
		assert.strictEqual(r.keys[1].label, 'Dev');
		assert.strictEqual(r.keys[1].baseUrl, 'https://api.openai.com/v1');
	});

	test('JSON-массив объектов', () => {
		const r = parseKeysBulk(JSON.stringify([{ name: 'A', key: SK, group: 'prod' }, { key: SK2 }]));
		assert.strictEqual(r.errors.length, 0);
		assert.strictEqual(r.keys.length, 2);
		assert.strictEqual(r.keys[0].groupName, 'prod');
	});

	test('невалидный JSON → ошибка, не падение', () => {
		const secret = 'sk-secret-that-must-never-be-rendered';
		const r = parseKeysBulk(`[{"key":"${secret}`);
		assert.strictEqual(r.keys.length, 0);
		assert.strictEqual(r.errors.length, 1);
		assert.ok(!r.errors[0].text.includes(secret));
	});

	test('мусорная строка → ошибка с замаскированным текстом', () => {
		const r = parseKeysBulk('hello world');
		assert.strictEqual(r.keys.length, 0);
		assert.strictEqual(r.errors.length, 1);
		assert.ok(!r.errors[0].text.includes('hello world') || r.errors[0].text.length < 12);
	});

	test('пустой ввод', () => {
		assert.deepStrictEqual(parseKeysBulk('   '), { keys: [], errors: [] });
	});
});

suite('AuraApiModel — провайдеры и секреты', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('detectProvider по префиксам и хостам', () => {
		assert.strictEqual(detectProvider('sk-ant-abc1234567890123'), 'anthropic');
		assert.strictEqual(detectProvider('sk-or-v1-abc1234567890123'), 'openrouter');
		assert.strictEqual(detectProvider('AIzaSyAbc1234567890'), 'google');
		assert.strictEqual(detectProvider('sk-abc1234567890123', 'https://host:4000/v1'), 'litellm');
		assert.strictEqual(detectProvider(SK), 'openai-compatible');
		assert.strictEqual(detectProvider('short'), undefined);
	});

	test('маскирование и fingerprint', () => {
		assert.strictEqual(maskSecret(SK), 'sk-…ABCD');
		assert.strictEqual(secretFingerprint(SK), secretFingerprint(SK));
		assert.notStrictEqual(secretFingerprint(SK), secretFingerprint(SK2));
		assert.strictEqual(auraSecretStorageKey('k1'), 'apiKeys.secret.k1');
		assert.ok(!auraSecretStorageKey('k1').includes(SK));
	});
});

suite('AuraApiModel — классификатор HTTP и cooldown', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('classifyHttpStatus', () => {
		assert.strictEqual(classifyHttpStatus(200), 'ok');
		assert.strictEqual(classifyHttpStatus(401), 'unauthorized');
		assert.strictEqual(classifyHttpStatus(403), 'forbidden');
		assert.strictEqual(classifyHttpStatus(404), 'notfound');
		assert.strictEqual(classifyHttpStatus(429), 'ratelimited');
		assert.strictEqual(classifyHttpStatus(500), 'down');
		assert.strictEqual(classifyHttpStatus(418), 'unknown');
	});

	test('cooldownMsForStatus: 429→60с, 5xx→30с, 401→навсегда', () => {
		assert.strictEqual(cooldownMsForStatus(429), 60_000);
		assert.strictEqual(cooldownMsForStatus(503), 30_000);
		assert.strictEqual(cooldownMsForStatus(401), Number.POSITIVE_INFINITY);
		assert.strictEqual(cooldownMsForStatus(200), 0);
	});

	test('modelAuthenticityPercent: declared vs returned', () => {
		assert.strictEqual(modelAuthenticityPercent('gpt-4o', 'gpt-4o'), 100);
		assert.strictEqual(modelAuthenticityPercent('gpt-4o', 'gpt-4o-mini'), 70);
		assert.strictEqual(modelAuthenticityPercent('gpt-4o', 'llama-3-8b'), 10);
		assert.strictEqual(modelAuthenticityPercent('gpt-4o', undefined, 80), 80);
		assert.strictEqual(modelAuthenticityPercent('gpt-4o', undefined), 50);
	});
});

suite('AuraApiModel — роутер и failover', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const NOW = 1_000_000;

	test('приоритет групп: сначала 0', () => {
		const state = makeState(
			[makeGroup('low', 5), makeGroup('high', 0)],
			[makeKey({ id: 'k-low', groupId: 'low' }), makeKey({ id: 'k-high', groupId: 'high' })]);
		assert.strictEqual(resolveKey(state, NOW)?.id, 'k-high');
	});

	test('ключ в cooldown пропускается, failover на живой', () => {
		const dead = makeKey({ id: 'k-dead', groupId: 'g', cooldownUntil: NOW + 60_000 });
		const alive = makeKey({ id: 'k-alive', groupId: 'g' });
		assert.strictEqual(resolveKey(makeState([makeGroup('g', 0)], [dead, alive]), NOW)?.id, 'k-alive');
	});

	test('все мёртвы → undefined', () => {
		const dead = makeKey({ id: 'k1', groupId: 'g', health: { status: 'unauthorized' } });
		assert.strictEqual(resolveKey(makeState([makeGroup('g', 0)], [dead]), NOW), undefined);
	});

	test('401/403 делают ключ непригодным навсегда', () => {
		assert.strictEqual(isKeyEligible(makeKey({ id: 'k', groupId: 'g', health: { status: 'unauthorized' } }), NOW), false);
		assert.strictEqual(isKeyEligible(makeKey({ id: 'k', groupId: 'g', health: { status: 'forbidden' } }), NOW), false);
	});

	test('фильтр по модели: available=no или выключена для чата → пропуск', () => {
		const k = makeKey({ id: 'k', groupId: 'g', models: [{ id: 'gpt-4o', available: 'no', source: 'discovered', enabledForChat: true }] });
		assert.strictEqual(isKeyEligible(k, NOW, 'gpt-4o'), false);
		assert.strictEqual(isKeyEligible(k, NOW, 'gpt-4o-mini'), true); // модель неизвестна ключу — не блокируем
	});

	test('round-robin внутри группы', () => {
		const state = makeState([makeGroup('g', 0)], [makeKey({ id: 'a', groupId: 'g' }), makeKey({ id: 'b', groupId: 'g' })]);
		const first = resolveKey(state, NOW)?.id;
		const second = resolveKey(state, NOW)?.id;
		assert.notStrictEqual(first, second);
	});

	test('взвешенный round-robin: weight=3 против 1', () => {
		const heavy = makeKey({ id: 'heavy', groupId: 'g', weight: 3 });
		const light = makeKey({ id: 'light', groupId: 'g', weight: 1 });
		const picks = [0, 1, 2, 3].map(c => pickWeightedKey([heavy, light], c)?.key.id);
		assert.deepStrictEqual(picks, ['heavy', 'heavy', 'heavy', 'light']);
	});

	test('applyRequestOutcome: 429 ставит cooldown 60с', () => {
		const k = makeKey({ id: 'k', groupId: 'g' });
		applyRequestOutcome(k, 429, NOW);
		assert.strictEqual(k.health.status, 'ratelimited');
		assert.strictEqual(k.cooldownUntil, NOW + 60_000);
		assert.strictEqual(isKeyEligible(k, NOW), false);
		assert.strictEqual(isKeyEligible(k, NOW + 61_000), true);
	});

	test('applyRequestOutcome: 401 — cooldown навсегда', () => {
		const k = makeKey({ id: 'k', groupId: 'g' });
		applyRequestOutcome(k, 401, NOW);
		assert.strictEqual(k.cooldownUntil, Number.POSITIVE_INFINITY);
		assert.strictEqual(isKeyEligible(k, NOW + 10_000_000_000), false);
	});
});

suite('AuraApiModel — сетевые сбои', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('isNetworkFailure: недоступный хост — да, ответ сервера — нет', () => {
		const undici = Object.assign(new TypeError('fetch failed'), {
			cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
		});
		const chromium = new TypeError('Failed to fetch');
		const aggregate = new AggregateError([Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' })], 'All promises were rejected');
		const cyclic = new Error('соединение оборвалось') as Error & { cause?: unknown };
		cyclic.cause = cyclic;

		assert.deepStrictEqual({
			undici: isNetworkFailure(undici),
			chromium: isNetworkFailure(chromium),
			aggregate: isNetworkFailure(aggregate),
			cyclic: isNetworkFailure(cyclic),
			statusError: isNetworkFailure(new Error('API Keys [kimi]: HTTP 503 — upstream')),
			cancelled: isNetworkFailure(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })),
			parserError: isNetworkFailure(new TypeError("Unexpected token 'x' in JSON")),
		}, {
			undici: true,
			chromium: true,
			aggregate: true,
			cyclic: false,
			statusError: false,
			cancelled: false,
			parserError: false,
		});
	});

	test('describeNetworkFailure: код причины вместо общего текста', () => {
		const wrapped = new Error('fetch failed') as Error & { cause?: unknown };
		wrapped.cause = { code: 'ENOTFOUND' };

		assert.deepStrictEqual({
			code: describeNetworkFailure(wrapped),
			name: describeNetworkFailure(Object.assign(new Error('boom'), { name: 'NetworkError' })),
			message: describeNetworkFailure(new TypeError('Failed to fetch')),
			notAnError: describeNetworkFailure(42),
		}, {
			code: 'ENOTFOUND',
			name: 'NetworkError',
			message: 'Failed to fetch',
			notAnError: '42',
		});
	});
});

suite('AuraApiModel — живые замеры и пороги маршрутизации', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('routerLimits: настройки перекрывают дефолты, мусор не ломает маршрут', () => {
		const values: Record<string, unknown> = {
			[API_KEYS_SLOW_FIRST_TOKEN_SETTING]: 1500,
			[API_KEYS_FIRST_TOKEN_TIMEOUT_SETTING]: '20000',
			[API_KEYS_STREAM_GAP_SETTING]: 'не число',
			[API_KEYS_SLOW_KEY_FACTOR_SETTING]: 4,
			[API_KEYS_SLOW_FLOOR_SETTING]: '600',
		};
		const limits = routerLimits(key => values[key]);

		assert.deepStrictEqual(limits, {
			slowFirstTokenMs: 1500,
			firstTokenTimeoutMs: 20000,
			streamGapMs: DEFAULT_STREAM_GAP_MS,
			slowKeyFactor: 4,
			slowFloorMs: 600,
		});
		assert.deepStrictEqual(routerLimits(() => undefined), {
			slowFirstTokenMs: DEFAULT_SLOW_FIRST_TOKEN_MS,
			firstTokenTimeoutMs: DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
			streamGapMs: DEFAULT_STREAM_GAP_MS,
			slowKeyFactor: DEFAULT_SLOW_KEY_FACTOR,
			slowFloorMs: DEFAULT_SLOW_FLOOR_MS,
		});
	});

	test('pushLatencySample: окно не растёт бесконечно, свежие замеры остаются', () => {
		let samples: number[] = [];
		for (let i = 1; i <= LATENCY_WINDOW + 3; i++) {
			samples = pushLatencySample(samples, i * 100);
		}

		assert.deepStrictEqual({
			length: samples.length,
			first: samples[0],
			last: samples[samples.length - 1],
			withoutPreviousWindow: pushLatencySample(undefined, 320),
		}, {
			length: LATENCY_WINDOW,
			first: 400,
			last: 1300,
			withoutPreviousWindow: [320],
		});
	});

	test('medianLatency: медиана чётного/нечётного окна и пустоты', () => {
		assert.deepStrictEqual({
			odd: medianLatency([900, 120, 300]),
			even: medianLatency([900, 120, 300, 400]),
			single: medianLatency([250]),
			empty: medianLatency([]),
			missing: medianLatency(undefined),
		}, {
			odd: 300,
			even: 350,
			single: 250,
			empty: undefined,
			missing: undefined,
		});
	});

	test('bestMedianLatency: лучший ключ — самая быстрая медиана, чужие выбросы не мешают', () => {
		assert.deepStrictEqual({
			best: bestMedianLatency([[900, 950], [200, 210], undefined]),
			noData: bestMedianLatency([undefined, []]),
		}, {
			best: 205,
			noData: undefined,
		});
	});

	test('slowThresholdMs: порог считается от лучшего ключа, с полом и без данных', () => {
		const limits = { slowFirstTokenMs: 3000, slowKeyFactor: 2.5, slowFloorMs: 800 };
		assert.deepStrictEqual({
			// Лучший ключ 200 мс: 500 мс относительного порога ниже пола — берём пол.
			fastPool: slowThresholdMs(200, limits),
			// Медленный канал: все отвечают за 2 с — медленным считаем только вдвое худшее.
			slowPool: slowThresholdMs(2000, limits),
			// Замеров нет — работает стартовый порог.
			noData: slowThresholdMs(undefined, limits),
			// Наблюдение выключено — порог остаётся нулевым (и switching отключён).
			disabled: slowThresholdMs(200, { ...limits, slowFirstTokenMs: 0 }),
			// Фактор меньше 1 бессмысленен: иначе медленным станет даже лучший ключ.
			factorClamped: slowThresholdMs(2000, { ...limits, slowKeyFactor: 0.5 }),
		}, {
			fastPool: 800,
			slowPool: 5000,
			noData: 3000,
			disabled: 0,
			factorClamped: 2000,
		});
	});

	test('describeSlowDecision: в объяснении есть замер, порог и лучший ключ', () => {
		assert.deepStrictEqual({
			withPeer: describeSlowDecision(2400, 800, 200),
			withoutPeer: describeSlowDecision(2400, 3000, undefined),
		}, {
			withPeer: 'первый токен 2400 мс > 800 мс (лучший ключ — медиана 200 мс)',
			withoutPeer: 'первый токен 2400 мс > 3000 мс (замеров по другим ключам пока нет)',
		});
	});

	test('nextLatencyUpdate: два медленных ответа выводят ключ, быстрый возвращает', () => {
		const firstSlow = nextLatencyUpdate(0, 5000, 3000);
		const secondSlow = nextLatencyUpdate(firstSlow.slowStreak, 4200, 3000);
		const afterFast = nextLatencyUpdate(secondSlow.slowStreak, 300, 3000, 'latency');

		assert.deepStrictEqual({
			firstSlow,
			secondSlow,
			afterFast,
			limit: SLOW_STREAK_LIMIT,
		}, {
			firstSlow: { slowStreak: 1, exclude: false, clearExclusion: false },
			secondSlow: { slowStreak: 2, exclude: true, clearExclusion: false },
			afterFast: { slowStreak: 0, exclude: false, clearExclusion: true },
			limit: 2,
		});
	});

	test('nextLatencyUpdate: исключение по пингу-зонду живым замером не снимается', () => {
		const update = nextLatencyUpdate(0, 120, 3000, 'ping');
		assert.deepStrictEqual(update, { slowStreak: 0, exclude: false, clearExclusion: false });
	});

	test('nextLatencyUpdate: при slowFirstTokenMs = 0 наблюдение выключено', () => {
		const update = nextLatencyUpdate(1, 60_000, 0);
		assert.deepStrictEqual(update, { slowStreak: 1, exclude: false, clearExclusion: false });
	});

	test('hasFasterAlternative: переключаемся только на измеренно более быстрый ключ', () => {
		const slow = { latencyMs: 6000 };
		assert.deepStrictEqual({
			knownFast: hasFasterAlternative(slow, [{ latencyMs: 800 }], 3000),
			knownFastByPing: hasFasterAlternative(slow, [{ pingMs: 1200 }], 3000),
			unknownReplacement: hasFasterAlternative(slow, [{}], 3000),
			slowerReplacement: hasFasterAlternative(slow, [{ latencyMs: 9000 }], 3000),
			noReplacement: hasFasterAlternative(slow, [], 3000),
			disabled: hasFasterAlternative(slow, [{ latencyMs: 800 }], 0),
		}, {
			knownFast: true,
			knownFastByPing: true,
			unknownReplacement: false,
			slowerReplacement: false,
			noReplacement: false,
			disabled: false,
		});
	});

	test('hasFasterAlternative: холодный ключ сам уступает уже измеренному', () => {
		assert.strictEqual(hasFasterAlternative({}, [{ latencyMs: 900 }], 3000), true);
	});

	test('describeStreamStall: причина словами, а не «network error»', () => {
		assert.deepStrictEqual({
			firstToken: describeStreamStall('first-token', 45_000),
			gap: describeStreamStall('gap', 44_000),
			instant: describeStreamStall('gap', 10),
		}, {
			firstToken: 'нет первого токена за 45 с',
			gap: 'поток молчит дольше 44 с',
			instant: 'поток молчит дольше 1 с',
		});
	});
});
