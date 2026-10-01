import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Панель — один IIFE-скрипт в template.html, работающий с DOM через
 * getElementById/createElement. Здесь он прогоняется в Node с минимальной
 * заглушкой DOM: это ловит ошибки рендера (например, в блоке бюджета) без IDE.
 */

function createEl(tag) {
	const el = {
		tagName: String(tag || 'div').toUpperCase(),
		children: [],
		_text: '',
		_html: '',
		hidden: false,
		value: '',
		placeholder: '',
		title: '',
		id: '',
		style: {},
		dataset: {},
		attributes: {},
		// В DOM у <select> есть .options — заглушка обязана вести себя так же, иначе
		// панель с «опции уже созданы» проверялась бы по всегда пустому массиву.
		get options() { return this.tagName === 'SELECT' ? this.children : []; },
		scrollTop: 0,
		scrollHeight: 0,
		className: '',
		setAttribute(name, value) { this.attributes[name] = String(value); },
		getAttribute(name) { return this.attributes[name]; },
		classList: (() => {
			const classes = new Set();
			return {
				add(...names) { names.forEach(name => classes.add(name)); },
				remove(...names) { names.forEach(name => classes.delete(name)); },
				contains(name) { return classes.has(name); },
				toggle(name, force) {
					const on = force === undefined ? !classes.has(name) : Boolean(force);
					if (on) { classes.add(name); } else { classes.delete(name); }
					return on;
				},
			};
		})(),
		handlers: {},
		append(...nodes) { for (const node of nodes) { this.children.push(node); } },
		appendChild(node) { this.children.push(node); return node; },
		removeChild(node) { const i = this.children.indexOf(node); if (i >= 0) { this.children.splice(i, 1); } return node; },
		get firstChild() { return this.children[0] || null; },
		remove() {},
		addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
		click() { for (const fn of (this.handlers.click || [])) { fn({}); } },
		querySelectorAll() { return []; },
	};
	Object.defineProperty(el, 'innerHTML', {
		get() { return el._html; },
		set(value) { el._html = String(value); if (value === '') { el.children = []; } },
	});
	Object.defineProperty(el, 'textContent', {
		get() { return el._text; },
		set(value) { el._text = String(value); },
	});
	return el;
}

function textOf(el) {
	let out = el._text || '';
	for (const child of el.children) {
		out += ' ' + textOf(child);
	}
	return out;
}

/** Прогоняем скрипт панели с заглушками и отдаём реестр, отправленные сообщения и слушатели. */
function renderPanel(state, { navigatorLanguage = 'ru', animationFrames = false } = {}) {
	const html = fs.readFileSync(path.join(root, 'src', 'panel', 'template.html'), 'utf8');
	const script = /<script nonce="__NONCE__">([\s\S]*?)<\/script>/.exec(html);
	assert.ok(script, 'скрипт панели найден в шаблоне');

	const registry = new Map();
	const get = id => {
		if (!registry.has(id)) { registry.set(id, createEl('div')); }
		return registry.get(id);
	};
	const posted = [];
	const document = {
		getElementById: get,
		createElement: createEl,
		querySelectorAll: () => [],
		addEventListener() {},
		body: createEl('body'),
		scripts: [],
		// Панель ставит <html lang> по выбранному словарю — в webview documentElement всегда есть.
		documentElement: createEl('html'),
	};
	const listeners = {};
	const frames = [];
	const window = { addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); } };
	// Панель рисует состояние по кадру: в стенде кадры копим и проигрываем вручную.
	if (animationFrames) { window.requestAnimationFrame = fn => frames.push(fn); }
	const navigator = { language: navigatorLanguage };
	const vscode = { postMessage: message => posted.push(message) };

	const run = new Function('window', 'document', 'navigator', 'acquireVsCodeApi', 'setTimeout', script[1]);
	run(window, document, navigator, () => vscode, () => 0);

	const send = data => { for (const fn of listeners.message || []) { fn({ data }); } };
	// Типизированный протокол: полезная нагрузка в payload.
	send({ type: 'state', payload: state });
	const flushFrames = () => { for (let guard = 0; frames.length && guard < 10; guard++) { frames.shift()(0); } };
	// element() — тот же get, что у панели: создаёт узел, если его ещё не рендерили.
	return { registry, element: get, posted, send, listeners, frames, flushFrames, documentElement: document.documentElement };
}

/** Поиск элемента по предикату среди потомков. */
function findEl(el, predicate) {
	for (const child of el.children) {
		if (predicate(child)) { return child; }
		const found = findEl(child, predicate);
		if (found) { return found; }
	}
	return null;
}

function baseState(budget, trace) {
	return {
		running: true, paused: false, uiLanguage: 'ru', sidecarAlive: true,
		sidecar: { state: 'ready' },
		run: { status: 'running', round: 2, maxRounds: 4, planned: 5 },
		nodes: [], keys: [], models: [], approvals: [], log: [],
		team: { available: false, tasks: [] },
		lastCheckpoint: { plan: [] },
		budget: { profiles: [], activeProfile: '', ...budget },
		trace,
	};
}

test('панель: блок бюджета рисует лимиты, модели и команду', () => {
	const budget = {
		limits: { runTokens: 1000, runCost: 5, nodeTokens: 0, nodeCost: 0 },
		tokens: 500,
		cost: 2.5,
		perModel: [{ model: 'kimi-k3', tier: 'high', tokens: 500, cost: 2.5, calls: 4 }],
		team: { available: true, perUser: [{ userId: 'u1', name: 'Аня', requests: 42 }], totalRequests: 42 },
	};
	const { registry } = renderPanel(baseState(budget, { spans: [], summary: { byTime: [], byCost: [], totalSpans: 0 } }));
	const block = registry.get('budgetBlock');
	assert.ok(block.children.length > 0, 'блок бюджета отрисован');
	const raw = textOf(block);
	// Числа форматируются toLocaleString — пробелы/запятые нормализуем отдельно.
	const numeric = raw.replace(/[\s\u00a0,]/g, '');
	assert.ok(numeric.includes('500/1000'), 'расход и лимит запуска видны');
	assert.ok(raw.includes('Токены запуска'), 'подпись токенов есть');
	assert.ok(raw.includes('kimi-k3'), 'расход по модели виден');
	assert.ok(raw.includes('Аня'), 'траты команды по человеку видны');
	assert.ok(raw.includes('42'), 'итог команды виден');
});

test('панель: без командного usage показывает пояснение, а не пустую таблицу', () => {
	const budget = {
		limits: { runTokens: 0, runCost: 0, nodeTokens: 0, nodeCost: 0 },
		tokens: 0, cost: 0, perModel: [],
		team: { available: false, perUser: [], totalRequests: 0 },
	};
	const { registry } = renderPanel(baseState(budget, { spans: [], summary: { byTime: [], byCost: [], totalSpans: 0 } }));
	const text = textOf(registry.get('budgetBlock'));
	assert.ok(text.includes('Пока нет расхода'), 'пустой расход объяснён');
	assert.ok(text.includes('Aura Team не отдаёт'), 'командная недоступность объяснена');
	assert.ok(text.includes('без лимита'), 'отсутствие лимита подписано');
});

test('панель: правка лимита в редакторе сохраняется через budget.update', () => {
	const budget = {
		limits: { runTokens: 0, runCost: 0, nodeTokens: 0, nodeCost: 0 },
		prices: { high: { input: 15, output: 75 }, mid: { input: 3, output: 15 }, low: { input: 0.5, output: 1.5 } },
		modelPrices: [],
		tokens: 0, cost: 0, perModel: [], team: { available: false, perUser: [], totalRequests: 0 },
	};
	const { registry, posted } = renderPanel(baseState(budget, { spans: [], summary: { byTime: [], byCost: [], totalSpans: 0 } }));
	const block = registry.get('budgetBlock');
	const editor = block.children.find(child => child.className === 'bedit');
	assert.ok(editor, 'редактор бюджета отрисован');

	const firstInput = findEl(editor, el => el.tagName === 'INPUT' && el.name === 'runTokens');
	firstInput.value = '12345';
	const save = findEl(editor, el => el.tagName === 'BUTTON' && el.textContent === 'Сохранить');
	assert.ok(save, 'кнопка сохранения есть');
	save.click();

	const invoke = posted.find(message => message.type === 'invoke' && message.payload.command === 'budget.update');
	assert.ok(invoke, 'панель вызвала budget.update');
	assert.equal(invoke.payload.args.limits.runTokens, 12345, 'введённый лимит ушёл в настройки');
	assert.equal(invoke.payload.args.prices.high.input, 15, 'цены тиров уходят вместе с лимитами');
});

test('панель: профиль бюджета применяется и подставляет значения', async () => {
	const budget = {
		limits: { runTokens: 0, runCost: 10, nodeTokens: 0, nodeCost: 0 },
		prices: { high: { input: 15, output: 75 }, mid: { input: 3, output: 15 }, low: { input: 0.5, output: 1.5 } },
		modelPrices: [],
		profiles: [{ name: 'economy', builtin: true }, { name: 'normal', builtin: true }, { name: 'max', builtin: true }],
		activeProfile: 'normal',
		tokens: 0, cost: 0, perModel: [], team: { available: false, perUser: [], totalRequests: 0 },
	};
	const { registry, posted, send } = renderPanel(baseState(budget, { spans: [], summary: { byTime: [], byCost: [], totalSpans: 0 } }));
	const editor = registry.get('budgetBlock').children.find(child => child.className === 'bedit');
	const select = findEl(editor, el => el.tagName === 'SELECT');
	assert.ok(select, 'список профилей есть');
	assert.deepEqual(select.children.map(option => option.value), ['economy', 'normal', 'max']);
	assert.equal(select.value, 'normal', 'активный профиль выбран');

	select.value = 'economy';
	const apply = findEl(editor, el => el.tagName === 'BUTTON' && el.textContent === 'Применить');
	assert.ok(apply, 'кнопка применения есть');
	apply.click();
	const invoke = posted.find(message => message.payload && message.payload.command === 'budget.profile.apply');
	assert.ok(invoke, 'панель вызвала budget.profile.apply');
	assert.equal(invoke.payload.args.name, 'economy');

	// Ответ host с значениями профиля переносит их в поля редактора.
	send({
		type: 'response',
		payload: {
			id: invoke.payload.id, ok: true,
			result: {
				ok: true, active: 'economy', profiles: budget.profiles,
				profile: { limits: { runTokens: 250_000, runCost: 1.5, nodeTokens: 60_000, nodeCost: 0.25 }, prices: budget.prices, modelPrices: [] },
			},
		},
	});
	// Резолв промиса — микрозадача: даём ей выполниться перед проверкой.
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(findEl(editor, el => el.name === 'runTokens').value, '250000', 'лимит профиля подставлен в поле');
});	test('панель: план рисуется как DAG с тир-бейджами', () => {
		const state = baseState({ limits: {}, tokens: 0, cost: 0, perModel: [], team: {} }, { spans: [], summary: { byTime: [], byCost: [], totalSpans: 0 } });
		state.lastCheckpoint = {
			plan: [
				{ id: 'coder#1', goal: 'сделать', deps: [], tier: 'high', agent: 'coder' },
				{ id: 'tester#2', goal: 'проверить', deps: ['coder#1'], tier: 'low', agent: 'tester' },
			],
			results: { 'coder#1': { status: 'ok', summary: 'готово', tokens: 1200 } },
			itemState: { 'coder#1': 'done' },
			attempts: {},
		};
		const { registry } = renderPanel(state);
		const list = registry.get('planList');
		assert.equal(list.children.length, 2, 'по строке на ноду плана');
		const text = textOf(list);
		assert.ok(text.includes('ВЫС'), 'тир-бейдж high виден по-русски');
		assert.ok(text.includes('НИЗ'), 'тир-бейдж low виден по-русски');
	});

	test('панель: деталь ноды показывает цель и шлёт node.restart', () => {
		const state = baseState({ limits: {}, tokens: 0, cost: 0, perModel: [], team: {} }, { spans: [], summary: { byTime: [], byCost: [], totalSpans: 0 } });
		state.lastCheckpoint = {
			plan: [{ id: 'coder#1', goal: 'починить модуль', deps: [], agent: 'coder' }],
			results: { 'coder#1': { status: 'ok', summary: 'готово', diff_stat: '1 file changed' } },
			itemState: {}, attempts: {},
		};
		const { registry, posted } = renderPanel(state);
		registry.get('planList').children[0].click();
		const detail = registry.get('nodeDetail');
		assert.ok(textOf(detail).includes('починить модуль'), 'цель ноды видна');
		const restart = findEl(detail, node => node.tagName === 'BUTTON' && node.textContent === 'Перезапустить');
		assert.ok(restart, 'кнопка перезапуска есть');
		restart.click();
		const invoke = posted.find(message => message.type === 'invoke' && message.payload && message.payload.command === 'node.restart');
		assert.ok(invoke, 'панель вызвала node.restart');
		assert.equal(invoke.payload.args.nodeId, 'coder#1');
	});

	test('панель: журнал фильтруется по уровню', () => {
		const state = baseState({ limits: {}, tokens: 0, cost: 0, perModel: [], team: {} }, { spans: [], summary: { byTime: [], byCost: [], totalSpans: 0 } });
		state.logs = [
			{ ts: 1, level: 'info', message: 'старт' },
			{ ts: 2, level: 'error', node: 'coder#1', message: 'упал' },
		];
		const { registry } = renderPanel(state);
		assert.ok(textOf(registry.get('logBox')).includes('старт'), 'обе строки видны');
		registry.get('logLevelFilter').handlers.change[0]({ target: { value: 'error' } });
		const text = textOf(registry.get('logBox'));
		assert.ok(text.includes('упал'), 'ошибка осталась');
		assert.ok(!text.includes('старт'), 'info отфильтрован');
	});

	test('панель: сегмент-контрол тира пишет keys.setTier', () => {
		const state = baseState({ limits: {}, tokens: 0, cost: 0, perModel: [], team: {} }, { spans: [], summary: { byTime: [], byCost: [], totalSpans: 0 } });
		state.models = [{ id: 'personal:k1', keyId: 'k1', displayName: 'kimi', model: 'kimi-k3', source: 'personal', tier: 'high', status: 'ok', selectable: true, pingMs: 10, activeCalls: 0 }];
		const { registry, posted } = renderPanel(state);
		const seg = findEl(registry.get('modelsBody'), node => node.className === 'seg');
		assert.ok(seg, 'сегмент-контрол отрисован');
		assert.equal(seg.children.length, 3, 'три кнопки тиров');
		const low = seg.children.find(button => button.textContent === 'НИЗ');
		assert.ok(low, 'кнопка «НИЗ» есть');
		low.click();
		const invoke = posted.find(message => message.payload && message.payload.command === 'keys.setTier');
		assert.ok(invoke, 'панель вызвала keys.setTier');
		assert.equal(invoke.payload.args.keyId, 'k1');
		assert.equal(invoke.payload.args.tier, 'low');
	});

	test('панель: вкладка Trace рисует водопад спанов и топы', () => {
	const trace = {
		totalSpans: 2,
		spans: [
			{ id: 's1', name: 'worker', kind: 'node', node: 'coder#1.0', tier: 'high', startedAt: Date.now() - 100, durationMs: 100, cost: 0.01, tokensIn: 10, tokensOut: 20, status: 'ok' },
			{ id: 's2', name: 'llm', kind: 'llm', node: 'coder#1.0', role: 'coder', tier: 'high', model: 'kimi-k3', startedAt: Date.now(), durationMs: 10, cost: 0.02, status: 'ok' },
		],
		summary: {
			byTime: [{ node: 'coder#1.0', durationMs: 100, cost: 0.01, tokens: 30, spans: 1 }],
			byCost: [{ node: 'coder#1.0', durationMs: 100, cost: 0.01, tokens: 30, spans: 1 }],
		},
	};
	const { registry } = renderPanel(baseState({ limits: {}, tokens: 0, cost: 0, perModel: [], team: {} }, trace));
	const waterfall = registry.get('traceWaterfall');
	assert.equal(waterfall.children.length, 2, 'по строке на спан');
	const tops = textOf(registry.get('traceTops'));
	assert.ok(tops.includes('coder#1.0'), 'топы содержат ноду');
});

test('панель: сообщение tab переключает вкладку', () => {
	const state = baseState({ limits: {}, tokens: 0, cost: 0, perModel: [], team: {} }, { spans: [], summary: { byTime: [], byCost: [], totalSpans: 0 } });
	const { registry, send } = renderPanel(state);
	assert.ok(registry.get('tab-run').classList.contains('active'), 'Run активна по умолчанию');
	send({ type: 'tab', payload: 'models' });
	assert.ok(registry.get('tab-models').classList.contains('active'), 'Models активна после команды');
	assert.ok(!registry.get('tab-run').classList.contains('active'), 'Run больше не активна');
});

test('панель: F6/F7/F8 шлют pause/resume/cancel', () => {
	const state = baseState({ limits: {}, tokens: 0, cost: 0, perModel: [], team: {} }, { spans: [], summary: { byTime: [], byCost: [], totalSpans: 0 } });
	state.running = true;
	state.paused = false;
	const { posted, listeners } = renderPanel(state);
	const keydown = (listeners.keydown || [])[0];
	assert.ok(keydown, 'обработчик клавиш зарегистрирован');
	const press = key => keydown({ key, preventDefault() {} });
	press('F6');
	press('F7');
	press('F8');
	press('F9');
	const commands = posted.filter(message => message.type === 'invoke').map(message => message.payload.command);
	assert.ok(commands.includes('pause'), 'F6 → pause');
	assert.ok(commands.includes('cancel'), 'F8 → cancel');
	assert.ok(!commands.includes('resume'), 'F7 пропущен, пока запуск не на паузе');
});

// Первый рендер идёт до снапшота (языка ещё нет) и падал в язык браузера. Опции <select>
// создавались один раз — и английская подпись оставалась в списке навсегда.
test('панель: подписи фильтров не застывают на языке первого рендера', () => {
	const budget = { limits: {}, tokens: 0, cost: 0, perModel: [], team: {} };
	const trace = { spans: [], summary: { byTime: [], byCost: [], totalSpans: 0 } };
	const { registry, send } = renderPanel({}, { navigatorLanguage: 'en-US' });
	const filter = registry.get('keySourceFilter');
	assert.deepEqual(filter.children.map(option => option.textContent), ['All sources', 'personal', 'team'],
		'до снапшота язык — язык браузера');

	send({ type: 'state', payload: baseState(budget, trace) });
	assert.deepEqual(filter.children.map(option => option.textContent), ['Все источники', 'личный', 'командный'],
		'после снапшота с uiLanguage=ru подписи обязаны обновиться');
	assert.equal(filter.children.length, 3, 'опции не пересоздаются — иначе слетит выбранный фильтр');
	assert.equal(registry.get('logLevelFilter').children[0].textContent, 'Все', 'фильтр уровня тоже переводится');
});

// Язык приходит от хоста уже разрешённым; настройка 'en' должна переводить всю панель.
test('панель: язык из снапшота переключает словарь и <html lang>', () => {
	const budget = { limits: {}, tokens: 0, cost: 0, perModel: [], team: {} };
	const trace = { spans: [], summary: { byTime: [], byCost: [], totalSpans: 0 } };

	const ru = renderPanel(baseState(budget, trace));
	assert.equal(ru.documentElement.lang, 'ru', '<html lang> следует словарю');
	assert.equal(textOf(ru.registry.get('tabRun')).trim(), 'Запуск', 'вкладки переведены, а не оставлены английскими');
	assert.equal(textOf(ru.registry.get('tabBoard')).trim(), 'Доска');
	assert.equal(textOf(ru.registry.get('tabModels')).trim(), 'Модели');
	assert.equal(textOf(ru.registry.get('tabTrace')).trim(), 'Трасса');
	assert.equal(textOf(ru.registry.get('tabLog')).trim(), 'Журнал');
	assert.ok(textOf(ru.registry.get('title')).includes('Оркестратор'), 'заголовок русский');

	const state = baseState(budget, trace);
	state.uiLanguage = 'en';
	const en = renderPanel(state);
	assert.equal(en.documentElement.lang, 'en');
	assert.equal(textOf(en.registry.get('tabRun')).trim(), 'Run', 'английская панель осталась английской');
	assert.ok(textOf(en.registry.get('title')).includes('Orchestrator'), 'заголовок английский при uiLanguage=en');
});

// Сводка тиров читалась как одна строка: значения сливались. Теперь это отдельные чипы
// с русскими названиями тиров (бейджи LOW/MID/HIGH остаются машинными обозначениями).
test('панель: сводка по тирам — чипы с русскими подписями', () => {
	const budget = { limits: {}, tokens: 0, cost: 0, perModel: [], team: {} };
	const trace = { spans: [], summary: { byTime: [], byCost: [], totalSpans: 0 } };
	const state = baseState(budget, trace);
	state.models = [{ id: 'personal:k1', keyId: 'k1', displayName: 'kimi', model: 'kimi-k3', source: 'personal', tier: 'mid', status: 'ok', selectable: true, pingMs: 10 }];
	const { registry } = renderPanel(state);
	const summary = registry.get('modelsSummary');
	const chips = [];
	// Сравниваем класс точно по границе: 'tier-chips' у контейнера содержит 'tier-chip' подстрокой.
	const isChip = node => String(node.className) === 'tier-chip' || String(node.className).startsWith('tier-chip ');
	const collect = node => { for (const child of node.children) { if (isChip(child)) { chips.push(child); } collect(child); } };
	collect(summary);
	assert.equal(chips.length, 3, 'по чипу на тир');
	assert.equal(chips[0].className, 'tier-chip warn', 'пустой тир подсвечен');
	const text = textOf(summary);
	assert.ok(text.includes('низкий') && text.includes('средний') && text.includes('высокий'), 'тиры названы по-русски');
	assert.ok(text.includes('1 живой'), 'число и форма согласованы');
});

// Канбан — не только просмотр: свою задачу заводят прямо на вкладке Board.
test('панель: своя задача с доски уходит в team.createTask', () => {
	const budget = { limits: {}, tokens: 0, cost: 0, perModel: [], team: {} };
	const trace = { spans: [], summary: { byTime: [], byCost: [], totalSpans: 0 } };
	const state = baseState(budget, trace);
	state.team = { available: true, tasks: [] };
	const { registry, posted } = renderPanel(state);
	assert.equal(registry.get('addTaskRow').hidden, false, 'при доступной доске форма видна');
	assert.equal(registry.get('newTaskStatus').children.length, 4, 'колонки выбираются в форме');

	registry.get('newTaskTitle').value = '  Моя задача  ';
	registry.get('newTaskStatus').value = 'review';
	registry.get('btnAddTask').click();
	const invoke = posted.find(message => message.type === 'invoke' && message.payload.command === 'team.createTask');
	assert.ok(invoke, 'панель вызвала team.createTask');
	assert.equal(invoke.payload.args.title, 'Моя задача', 'заголовок обрезан от пробелов');
	assert.equal(invoke.payload.args.status, 'review', 'колонка из формы');
});

test('панель: пустой заголовок не создаёт задачу', () => {
	const budget = { limits: {}, tokens: 0, cost: 0, perModel: [], team: {} };
	const trace = { spans: [], summary: { byTime: [], byCost: [], totalSpans: 0 } };
	const state = baseState(budget, trace);
	state.team = { available: true, tasks: [] };
	const { registry, posted } = renderPanel(state);
	registry.get('newTaskTitle').value = '   ';
	registry.get('btnAddTask').click();
	assert.ok(!posted.some(message => message.type === 'invoke' && message.payload.command === 'team.createTask'), 'запрос не уходит');
	assert.equal(registry.get('addTaskNote').textContent, 'введите название задачи', 'и это сказано');
});

test('панель: без Team формы задачи нет', () => {
	const budget = { limits: {}, tokens: 0, cost: 0, perModel: [], team: {} };
	const trace = { spans: [], summary: { byTime: [], byCost: [], totalSpans: 0 } };
	const { registry } = renderPanel(baseState(budget, trace));
	assert.equal(registry.get('addTaskRow').hidden, true, 'без плагина Team форма скрыта');
});

// Хост шлёт состояние на каждый спан, событие графа и строку лога, а render()
// перерисовывает все семь секций целиком. Пачку состояний нужно схлопывать в один кадр,
// иначе за прогон получаются сотни полных перерисовок.
test('панель: пачка состояний рисуется одним кадром, побеждает последнее', () => {
	const budget = { limits: {}, tokens: 0, cost: 0, perModel: [], team: {} };
	const trace = { spans: [], summary: { byTime: [], byCost: [], totalSpans: 0 } };
	const first = baseState(budget, trace);
	first.logs = [{ ts: 1, level: 'info', message: 'ПЕРВОЕ' }];
	const panel = renderPanel(first, { animationFrames: true });
	assert.equal(panel.frames.length, 1, 'на первое состояние запланирован один кадр');

	const last = baseState(budget, trace);
	last.logs = [{ ts: 2, level: 'info', message: 'ПОСЛЕДНЕЕ' }];
	for (let i = 0; i < 6; i++) { panel.send({ type: 'state', payload: last }); }
	assert.equal(panel.frames.length, 1, 'шесть состояний схлопнулись в тот же кадр');
	assert.ok(!textOf(panel.element('logBox')).includes('ПОСЛЕДНЕЕ'), 'до кадра панель не перерисовывается');

	panel.flushFrames();
	const text = textOf(panel.element('logBox'));
	assert.ok(text.includes('ПОСЛЕДНЕЕ'), 'после кадра видно последнее состояние');
	assert.ok(!text.includes('ПЕРВОЕ'), 'предыдущие состояния перекрыты, а не смешаны с последним');
});

test('панель: действие пользователя рисуется сразу, не дожидаясь кадра', () => {
	const budget = { limits: {}, tokens: 0, cost: 0, perModel: [], team: {} };
	const trace = { spans: [], summary: { byTime: [], byCost: [], totalSpans: 0 } };
	const state = baseState(budget, trace);
	state.logs = [{ ts: 1, level: 'info', message: 'СРОЧНО' }];
	const panel = renderPanel(state, { animationFrames: true });
	assert.equal(panel.frames.length, 1, 'кадр ещё висит');
	assert.ok(!textOf(panel.element('logBox')).includes('СРОЧНО'), 'состояние ещё не отрисовано');

	panel.element('btnLogPin').click();
	assert.ok(textOf(panel.element('logBox')).includes('СРОЧНО'), 'клик рисуется синхронно, без ожидания кадра');
});
