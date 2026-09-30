// Инструмент чата «команда агентов»: логика отчёта/прогресса + связка с package.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { transformSync } = require('esbuild');

/** Чистые модули расширения написаны на TypeScript без vscode — грузим их через esbuild. */
function loadTs(relativePath) {
	const file = path.join(root, relativePath);
	const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node20' }).code;
	const module = { exports: {} };
	new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
		module.exports, require, module, file, path.dirname(file)
	);
	return module.exports;
}

const report = loadTs('src/team/report.ts');
const {
	progressLine, nodeSignature, stripLogTimestamp, countNodes, ProgressTracker,
	buildTeamSummary, parseTeamTaskInput, roleTitle, statusTitle,
} = report;

const node = (over = {}) => ({
	id: 'coder#1', role: 'coder', status: 'running', tier: 'high', keyName: 'kimi-k3', ...over,
});

// ---------- строки прогресса ----------

test('progressLine: роль, тир, статус, ключ и заметка', () => {
	assert.equal(
		progressLine(node({ note: 'правлю host.ts' })),
		'Кодер (high) · работает · ключ kimi-k3 · правлю host.ts'
	);
});

test('progressLine: ошибка важнее заметки, тир и ключ необязательны', () => {
	const line = progressLine(node({ role: 'tester', tier: undefined, keyName: undefined, status: 'error', note: 'шум', error: 'не собрались тесты' }));
	assert.equal(line, 'Тестировщик · ошибка · не собрались тесты');
});

test('progressLine: ждёт подтверждения — это отдельное состояние, а не «работает»', () => {
	assert.equal(statusTitle('waiting-approval'), 'ждёт подтверждения');
	assert.match(progressLine(node({ status: 'waiting-approval' })), /ждёт подтверждения/);
});

test('progressLine: мусор вместо узла — undefined, а не «undefined · undefined»', () => {
	assert.equal(progressLine(undefined), undefined);
	assert.equal(progressLine(null), undefined);
	assert.equal(progressLine({}), undefined);
});

test('roleTitle: незнакомая роль остаётся собой', () => {
	assert.equal(roleTitle('supervisor'), 'Супервизор');
	assert.equal(roleTitle('security-auditor'), 'Аудит безопасности');
	assert.equal(roleTitle('archivist'), 'archivist');
});

test('stripLogTimestamp: время вырезается, остальной текст не трогается', () => {
	assert.equal(stripLogTimestamp('[00:12:03] chat.complete role=coder'), 'chat.complete role=coder');
	assert.equal(stripLogTimestamp('chat.complete role=coder'), 'chat.complete role=coder');
});

test('countNodes: работает/ждёт подтверждения считаются занятыми, ошибки — отдельно', () => {
	const counts = countNodes([
		node({ status: 'done' }), node({ status: 'running' }), node({ status: 'waiting-approval' }), node({ status: 'error' }),
	]);
	assert.deepEqual(counts, { total: 4, done: 1, running: 2, failed: 1 });
});

// ---------- отпечаток и трекер прогресса ----------

test('nodeSignature: отличие в статусе/тире/ключе/ошибке/заметке замечается', () => {
	const base = nodeSignature(node());
	assert.notEqual(base, nodeSignature(node({ status: 'done' })));
	assert.notEqual(base, nodeSignature(node({ tier: 'low' })));
	assert.notEqual(base, nodeSignature(node({ keyName: 'gpt-5' })));
	assert.notEqual(base, nodeSignature(node({ error: 'boom' })));
	assert.notEqual(base, nodeSignature(node({ note: 'шаг 2' })));
	assert.equal(base, nodeSignature(node()));
});

test('ProgressTracker: повторный снапшот не повторяет строки', () => {
	const tracker = new ProgressTracker();
	const state = { nodes: [node()], log: [] };
	const first = tracker.update(state);
	assert.deepEqual(first, ['Кодер (high) · работает · ключ kimi-k3', '0 из 1 готово']);
	assert.deepEqual(tracker.update(state), []);
});

test('ProgressTracker: меняется только изменившийся агент', () => {
	const tracker = new ProgressTracker();
	tracker.update({ nodes: [node(), node({ id: 'tester#1', role: 'tester', status: 'running' })], log: [] });
	const lines = tracker.update({
		nodes: [node({ status: 'done' }), node({ id: 'tester#1', role: 'tester', status: 'running' })],
		log: [],
	});
	assert.equal(lines.length, 2, `ожидали строку агента и счётчик, получили: ${JSON.stringify(lines)}`);
	assert.match(lines[0], /^Кодер \(high\) · готово/);
	assert.equal(lines[1], '1 из 2 готово');
});

test('ProgressTracker: обрезанный лог не ломает индексацию', () => {
	const tracker = new ProgressTracker();
	tracker.update({ nodes: [], log: ['[00:00:01] первое', '[00:00:02] второе'] });
	// Хост держит только последние N строк: лог стал короче — это не повод падать.
	const lines = tracker.update({ nodes: [], log: ['[00:00:09] третье'] });
	assert.deepEqual(lines, ['третье']);
});

test('ProgressTracker: из пачки новых строк в чат уходит последняя, без времени', () => {
	const tracker = new ProgressTracker();
	const lines = tracker.update({ nodes: [], log: ['[00:00:01] старт', '[00:00:02] chat.complete tier=high', '[00:00:03] финал'] });
	assert.deepEqual(lines, ['финал']);
});

test('ProgressTracker: строки уходят и в колбэк, и в результат', () => {
	const seen = [];
	const tracker = new ProgressTracker(line => seen.push(line));
	const lines = tracker.update({ nodes: [node({ status: 'done' })], log: [] });
	assert.deepEqual(seen, lines);
});

// ---------- сводка запуска ----------

test('buildTeamSummary: статус, задача, агенты, итог и последние события', () => {
	const summary = buildTeamSummary({
		task: 'добавь страницу настроек',
		status: 'done',
		nodes: [
			node({ role: 'coder', status: 'done', note: undefined }),
			node({ id: 'tester#1', role: 'tester', status: 'error', error: 'тесты не собираются', keyName: undefined, tier: undefined }),
		],
		log: ['[00:00:01] старт', ...Array.from({ length: 10 }, (_, i) => `[00:00:${10 + i}] шаг ${i}`)],
	});
	assert.match(summary, /задача выполнена/);
	assert.match(summary, /добавь страницу настроек/);
	assert.match(summary, /- Кодер \(high\) · готово · ключ kimi-k3/);
	assert.match(summary, /- Тестировщик · ошибка · тесты не собираются/);
	assert.match(summary, /Итог: 1 из 2 агентов завершили работу, 1 с ошибкой/);
	assert.match(summary, /Последние события:/);
	// В сводку попадает только хвост лога, иначе отчёт съедает контекст модели.
	assert.match(summary, /шаг 9/);
	assert.doesNotMatch(summary, /\[00:00:01] старт/);
});

test('buildTeamSummary: пустой запуск и отмена говорят об этом прямо', () => {
	const empty = buildTeamSummary({ task: 'x', status: 'error', nodes: [], log: [] });
	assert.match(empty, /Ни один агент не был запущен/);
	assert.doesNotMatch(empty, /Итог:/);

	const cancelled = buildTeamSummary({ task: 'x', status: 'cancelled', nodes: [node({ status: 'running' })], log: [] });
	assert.match(cancelled, /запуск отменён/);
	assert.match(cancelled, /Чекпоинт сохранён/);
});

test('buildTeamSummary: длинные строки обрезаются, переводы строк схлопываются', () => {
	const summary = buildTeamSummary({
		task: `многострочная\nзадача ${'x'.repeat(500)}`,
		status: 'done',
		nodes: [node({ note: 'a'.repeat(400) })],
		log: [],
	});
	assert.doesNotMatch(summary, /многострочная\nзадача/);
	assert.ok(summary.split('\n').every(line => line.length < 300), 'сводка должна оставаться читаемой');
});

// ---------- разбор входа инструмента ----------

test('parseTeamTaskInput: задача берётся из task и обрезается', () => {
	const parsed = parseTeamTaskInput({ task: '  добавь тесты  ' });
	assert.equal(parsed.ok, true);
	assert.equal(parsed.task, 'добавь тесты');
	assert.equal(parsed.maxWorkers, 3);
});

test('parseTeamTaskInput: синонимы prompt/instruction поддерживаются', () => {
	assert.equal(parseTeamTaskInput({ prompt: 'через prompt' }).task, 'через prompt');
	assert.equal(parseTeamTaskInput({ instruction: 'через instruction' }).task, 'через instruction');
});

test('parseTeamTaskInput: пустая и отсутствующая задача — понятная ошибка для модели', () => {
	for (const input of [undefined, {}, { task: '   ' }, { task: 42 }]) {
		const parsed = parseTeamTaskInput(input);
		assert.equal(parsed.ok, false);
		assert.match(parsed.error, /task/);
	}
});

test('parseTeamTaskInput: слишком длинная задача отклоняется с числом символов', () => {
	const parsed = parseTeamTaskInput({ task: 'я'.repeat(9000) });
	assert.equal(parsed.ok, false);
	assert.match(parsed.error, /9000/);
});

test('parseTeamTaskInput: max_workers ограничивается сверху и игнорируется мусором', () => {
	assert.equal(parseTeamTaskInput({ task: 'x', max_workers: 12 }).maxWorkers, 8);
	assert.equal(parseTeamTaskInput({ task: 'x', max_workers: 2.7 }).maxWorkers, 2);
	assert.equal(parseTeamTaskInput({ task: 'x', max_workers: -1 }).maxWorkers, 3);
	assert.equal(parseTeamTaskInput({ task: 'x', max_workers: 'много' }).maxWorkers, 3);
});

// ---------- связка с package.json и хостом ----------

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const toolSrc = fs.readFileSync(path.join(root, 'src/team/tool.ts'), 'utf8');
const hostSrc = fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8');
const extensionSrc = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));

test('package.json: вклад инструмента объявлен и совпадает с registerTool', () => {
	const tools = pkg.contributes.languageModelTools;
	assert.equal(tools.length, 1);
	assert.equal(tools[0].name, 'auraOrchestrator_runTeam');
	assert.match(toolSrc, new RegExp(`TEAM_TOOL_ID = '${tools[0].name}'`));
	assert.match(toolSrc, /vscode\.lm\.registerTool\(TEAM_TOOL_ID/);
	assert.equal(tools[0].toolReferenceName, 'agent_team');
	// Инструмент живёт, пока плагин включён в Aura Market: иначе он остался бы в списке
	// инструментов модели после отключения оркестратора.
	assert.equal(tools[0].when, 'auraPlugin.langgraph-orchestrator.enabled == true');
	assert.equal(tools[0].canBeReferencedInPrompt, true);
	assert.ok(tools[0].inputSchema.required.includes('task'));
	assert.match(extensionSrc, /registerTeamTool\(context, host\)/, 'расширение должно регистрировать инструмент при активации');
});

test('toolProgress включён: без него виджет инструмента в чате молчит до конца', () => {
	assert.ok(pkg.enabledApiProposals.includes('toolProgress'));
	assert.ok(tsconfig.include.some(entry => entry.includes('vscode.proposed.toolProgress.d.ts')));
	assert.match(toolSrc, /progress\?\.report\(/, 'прогресс должен уходить в чат (progress опционален из-за двух перегрузок API)');
	assert.ok((toolSrc.match(/progress\?\.report\(/g) ?? []).length >= 2, 'нужны и стартовая строка, и строки по агентам');
});

// Строки манифеста впечатаны в package.json: через package.nls они зависели бы от локали IDE.
// Файлы локализации при этом остаются словарём перевода — тест ловит, если они разъехались.
test('строки манифеста русские и совпадают со словарём перевода', () => {
	const ru = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.ru.json'), 'utf8'));
	const en = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
	assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort(), 'наборы ключей ru/en обязаны совпадать');

	const manifest = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
	assert.ok(!/%[A-Za-z0-9_.]+%/.test(manifest), "в манифесте не должно остаться %ключей% — они зависят от локали IDE");

	// Каждый перевод словаря обязан быть реально использован в манифесте.
	for (const [key, text] of Object.entries(ru)) {
		assert.ok(manifest.includes(JSON.stringify(text).slice(1, -1)), `${key}: перевод не найден в package.json`);
	}
});

test('хост: запуск из чата ждёт завершения графа и отменяется токеном', () => {
	assert.match(hostSrc, /async runTeamTask\(/);
	assert.match(hostSrc, /graph\.finished' \|\| event\.type === 'graph\.error' \|\| event\.type === 'graph\.cancelled'/, 'финал графа обязан резолвить ожидание');
	assert.match(hostSrc, /resolve\?\.\(\)/, 'без резолва промис инструмента зависнет');
	assert.match(hostSrc, /token\.onCancellationRequested\(\(\) => \{ void this\.cancel\(\); \}\)/, 'отмена из чата должна останавливать граф');
	assert.match(hostSrc, /if \(this\.running\)/, 'два запуска одновременно недопустимы');
});
