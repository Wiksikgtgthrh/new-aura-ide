// Стенд для панели: собирает out/panel-preview.html — тот же template.html,
// но с поддельным acquireVsCodeApi и состоянием. Открывается в браузере
// (?lang=en — английский), чтобы верстать доску и колонки ключей без запуска IDE.
// Запуск: node test/panel-preview.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = fs.readFileSync(path.join(root, 'src', 'panel', 'template.html'), 'utf8');

const NOW = Date.now();
const state = {
	running: true,
	paused: false,
	lastTask: 'добавь страницу настроек, покрой тестами и проверь на уязвимости',
	// В браузере navigator.language — en-US, а стенд нужен русский: в бою столько же
	// приходит от хоста, который разрешает настройку по языку IDE (?lang=en — английский).
	uiLanguage: 'ru',
	sidecarAlive: true,
	sidecar: { state: 'ready' },
	run: { status: 'running', round: 2, maxRounds: 4, planned: 5, startedAt: NOW - 90_000, summary: '' },
	nodes: [
		{ id: 'supervisor', role: 'supervisor', status: 'done', tier: 'high', round: 1, keyName: 'kimi-k3', startedAt: NOW - 88_000, finishedAt: NOW - 84_000, note: 'план из 5 задач' },
		{ id: 'coder#1.0', role: 'coder', status: 'done', tier: 'high', round: 1, keyName: 'kimi-k3', startedAt: NOW - 84_000, finishedAt: NOW - 40_000, note: 'готово' },
		{ id: 'tester#1.1', role: 'tester', status: 'error', tier: 'low', round: 1, keyName: 'glm-5', startedAt: NOW - 84_000, finishedAt: NOW - 60_000, error: 'terminal.run: exit code 1 — 3 теста упали' },
		{ id: 'security-auditor#1.2', role: 'security-auditor', status: 'skipped', tier: 'mid', round: 1, finishedAt: NOW - 2_000, note: 'отменён вручную' },
		{ id: 'reviewer#2.0', role: 'reviewer', status: 'waiting-approval', tier: 'mid', round: 2, keyName: 'glm-5', startedAt: NOW - 20_000, note: 'fs.writeFile: ждёт подтверждения' },
		{ id: 'coder#2.1', role: 'coder', status: 'running', tier: 'high', round: 2, keyName: 'kimi-k3', startedAt: NOW - 12_000, note: 'читаю src/vs/workbench/contrib/auraApi/common/auraApiKeys.ts' },
		{ id: 'tester#2.2', role: 'tester', status: 'idle', tier: 'low', round: 2, note: 'покрой очередь подзадач тестами' },
		{ id: 'security-auditor#2.3', role: 'security-auditor', status: 'idle', tier: 'mid', round: 2, note: 'проверь доступ к секретам в командном банке' },
	],
	budget: {
		limits: { runTokens: 4_000_000, runCost: 25, nodeTokens: 0, nodeCost: 0 },
		prices: {
			high: { input: 15, output: 75 },
			mid: { input: 3, output: 15 },
			low: { input: 0.5, output: 1.5 },
		},
		modelPrices: [{ match: 'kimi', input: 2, output: 8 }],
		profiles: [{ name: 'economy', builtin: true }, { name: 'normal', builtin: true }, { name: 'max', builtin: true }, { name: 'моя настройка', builtin: false }],
		activeProfile: 'normal',
		tokens: 1_820_000,
		cost: 12.4123,
		perModel: [
			{ model: 'kimi-k3', tier: 'high', tokens: 1_120_000, cost: 9.8, calls: 34 },
			{ model: 'glm-5', tier: 'mid', tokens: 640_000, cost: 2.4, calls: 51 },
			{ model: 'qwen3', tier: 'low', tokens: 60_000, cost: 0.2123, calls: 12 },
		],
		team: {
			available: true,
			perUser: [
				{ userId: 'u1', name: 'Аня', requests: 412 },
				{ userId: 'u2', name: 'Борис', requests: 188 },
				{ userId: 'u3', name: 'Вера', requests: 97 },
			],
			totalRequests: 697,
		},
	},
	trace: {
		totalSpans: 7,
		spans: [
			{ id: 's1', name: 'supervisor', kind: 'node', node: 'supervisor', tier: 'high', startedAt: NOW - 88_000, durationMs: 4_100, cost: 0.32, tokensIn: 1200, tokensOut: 400, status: 'ok' },
			{ id: 's2', name: 'worker', kind: 'node', node: 'coder#1.0', tier: 'high', startedAt: NOW - 84_000, durationMs: 44_000, cost: 7.4, tokensIn: 90_000, tokensOut: 12_000, retries: 1, status: 'ok' },
			{ id: 's3', name: 'llm', kind: 'llm', node: 'coder#1.0', role: 'coder', tier: 'high', model: 'kimi-k3', startedAt: NOW - 83_000, durationMs: 9_200, cost: 1.9, tokensIn: 20_000, tokensOut: 3_000, status: 'ok' },
			{ id: 's4', name: 'worker', kind: 'node', node: 'tester#1.1', tier: 'low', startedAt: NOW - 84_000, durationMs: 24_000, cost: 0.6, tokensIn: 14_000, tokensOut: 3_400, status: 'error' },
			{ id: 's5', name: 'llm', kind: 'llm', node: 'tester#1.1', role: 'tester', tier: 'low', model: 'qwen3', startedAt: NOW - 80_000, durationMs: 6_000, cost: 0.2, tokensIn: 8_000, tokensOut: 1_400, status: 'ok' },
		],
		summary: {
			byTime: [
				{ node: 'coder#1.0', durationMs: 44_000, cost: 7.4, tokens: 102_000, spans: 1 },
				{ node: 'tester#1.1', durationMs: 24_000, cost: 0.6, tokens: 17_400, spans: 1 },
			],
			byCost: [
				{ node: 'coder#1.0', durationMs: 44_000, cost: 7.4, tokens: 102_000, spans: 1 },
				{ node: 'tester#1.1', durationMs: 24_000, cost: 0.6, tokens: 17_400, spans: 1 },
			],
		},
	},
	approvals: [{ id: 3, toolName: 'fs.writeFile', preview: 'AGENTS.md\n\n# Правила\n…(preview)', nodeId: 'reviewer#2.0' }],
	keys: [
		{ id: 'kimi-k3', source: 'local', name: 'kimi-k3', model: 'kimi-k3', baseUrl: 'https://api.moonshot.ai/v1', tier: 'high', status: 'ok', selectable: true, pingMs: 412, lastCallMs: 5200, activeCalls: 2, health: 'ok', latencyMs: 830, lastChecked: NOW - 30_000 },
		{ id: 'glm-5', source: 'local', name: 'glm-5', model: 'glm-5', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', tier: 'mid', status: 'slow', selectable: true, pingMs: 2150, lastCallMs: 8100, activeCalls: 1, health: 'ok', latencyMs: 7400, excludedReason: 'latency', lastChecked: NOW - 30_000 },
		{ id: 'gpt-5', source: 'local', name: 'gpt-5', model: 'gpt-5', baseUrl: 'https://api.openai.com/v1', tier: 'high', status: 'cooldown', selectable: true, pingMs: 980, activeCalls: 0, health: 'ratelimited', cooldownUntil: NOW + 42_000, lastError: '429 Too Many Requests', lastChecked: NOW - 5_000 },
		{ id: 'dead-key', source: 'local', name: 'старый ключ', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', tier: 'low', status: 'dead', selectable: true, activeCalls: 0, health: 'unauthorized', lastError: 'HTTP 401: ключ отклонён' },
		{ id: 'paused-key', source: 'local', name: 'локальный прокси', model: 'qwen3', baseUrl: 'http://localhost:1234/v1', tier: 'mid', status: 'excluded', selectable: true, activeCalls: 0 },
		{ id: 'team:kt-1', source: 'team', name: 'Team key · Aurora', model: 'openai-compatible', baseUrl: '', tier: 'high', status: 'ok', selectable: false, pingMs: 260, activeCalls: 0, teamPriority: 50, health: 'ok' },
		{ id: 'fresh-key', source: 'local', name: 'только что добавлен', model: 'kimi-k2', baseUrl: 'https://api.moonshot.ai/v1', tier: 'mid', status: 'unknown', selectable: true, checking: true, activeCalls: 0 },
	],
	log: [
		'задача запущена: добавь страницу настроек',
	],
	logs: [
		{ ts: NOW - 90_000, level: 'info', message: 'задача запущена: добавь страницу настроек' },
		{ ts: NOW - 84_000, level: 'info', node: 'supervisor', message: 'раунд 1 — план из 2 задач, ставлю в очередь' },
		{ ts: NOW - 60_000, level: 'warn', node: 'tester#1.1', message: 'проверки упали — правка 1/3' },
		{ ts: NOW - 40_000, level: 'error', node: 'tester#1.1', message: 'проверки не прошли за 3 попыток' },
	],
	runDefaults: { planner: 'auto', plannerTier: 'high', maxParallel: 4 },
	team: {
		available: true,
		tasks: [
			{ id: 't1', title: 'Починить экспорт ключей', description: '', status: 'todo' },
			{ id: 't2', title: 'Написать тесты на оркестратор', description: '', status: 'doing', assigneeName: 'Аня' },
			{ id: 't3', title: 'Ревью патча настроек', description: '', status: 'review' },
			{ id: 't4', title: 'Обновить README', description: '', status: 'done' },
		],
	},
	lastCheckpoint: {
		plan: [
			{ id: 'coder#1.0', goal: 'добавить страницу настроек', deps: [], tier: 'high', agent: 'coder' },
			{ id: 'reviewer#2.0', goal: 'проверить правки', deps: ['coder#1.0'], tier: 'mid', agent: 'reviewer', confirm: true },
		],
		results: {
			'coder#1.0': { status: 'ok', summary: 'страница добавлена', diff_stat: 'src/settings.ts | 42 ++++', tokens: 112_000, branch: 'aura/run-1/nodes/coder#1.0' },
		},
		itemState: { 'coder#1.0': 'done', 'reviewer#2.0': 'needs_human' },
		attempts: { 'coder#1.0': 1 },
	},
};

// CSP шаблона разрешает только скрипты с nonce — стенд получает тот же nonce.
const shim = `
	<script nonce="preview">
		// Подделка моста webview: панель думает, что говорит с расширением.
		window.__previewState = ${JSON.stringify(state)};
		window.acquireVsCodeApi = () => ({
			postMessage: message => console.log('postMessage', message),
		});
	</script>`;

const bootstrap = `
	<script nonce="preview">
		const forced = new URLSearchParams(location.search).get('lang');
		if (forced === 'ru' || forced === 'en') { window.__previewState.uiLanguage = forced; }
		window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', payload: window.__previewState } }));
	</script>`;

const html = template
	.replace(/__NONCE__/g, 'preview')
	.replace('<body>', `<body>${shim}`)
	.replace('</body>', `${bootstrap}</body>`);

const outDir = path.join(root, 'out');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'panel-preview.html');
fs.writeFileSync(outFile, html, 'utf8');
console.log(`panel preview -> ${outFile}`);
