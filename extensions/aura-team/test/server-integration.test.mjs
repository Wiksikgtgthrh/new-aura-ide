/*---------------------------------------------------------------------------------------------
 *  Клиент расширения против настоящего сервера.
 *
 *  Почему такой тест вообще нужен. Сервер покрыт собственными тестами (inject по живому
 *  роутеру), клиент — юнитами (api-headers). Зазор между ними не покрыт ничем, и именно
 *  туда упал продовый баг: DELETE задачи уходил с content-type: application/json, Fastify
 *  отвечал 400, из UI это выглядело как «задачи не удаляются». Серверный тест был зелёный
 *  (сервер-то обрабатывает пустое тело), клиентский тоже.
 *
 *  Здесь играет всё настоящее: AuraApiClient из out/ (тот же код, что в extension host),
 *  HTTP по 127.0.0.1 и настоящий aura-team-server из aura-team-server/test/http-harness.ts.
 *  Ничего не мокается, кроме API самого VS Code — его вне IDE не существует.
 *
 *  Требует собранное расширение: `node test/run-all.mjs` собирает out/ перед тестами.
 *--------------------------------------------------------------------------------------------*/
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = join(here, '..');
const serverRoot = join(extensionRoot, '..', '..', 'aura-team-server');
const compiledClient = join(extensionRoot, 'out', 'api', 'client.js');
const harness = join(serverRoot, 'test', 'http-harness.ts');

let failures = 0;
const check = (name, ok, detail) => {
	console.log((ok ? '  ok   ' : '  FAIL ') + name);
	if (!ok) { failures++; if (detail !== undefined) { console.log('       ' + detail); } }
};

if (!existsSync(compiledClient)) {
	console.error('FAIL: нет out/api/client.js — сначала собери расширение (npx tsc -p extensions/aura-team/tsconfig.json).');
	process.exit(1);
}
if (!existsSync(harness) || !existsSync(join(serverRoot, 'node_modules', 'tsx'))) {
	console.error(`FAIL: нет стенда или его зависимостей: ${harness} / ${join(serverRoot, 'node_modules', 'tsx')}`);
	console.error('       Установите зависимости сервера: npm --prefix aura-team-server install');
	process.exit(1);
}

/* ---------- Стенд ---------- */
const child = spawn(process.execPath, ['--import', 'tsx', harness], {
	cwd: serverRoot,
	stdio: ['ignore', 'pipe', 'pipe'],
	env: { ...process.env, NODE_ENV: 'test' }
});
let harnessLog = '';
child.stderr.on('data', chunk => { harnessLog += chunk; });
child.stdout.on('data', chunk => { harnessLog += chunk; });
process.on('exit', () => { try { child.kill(); } catch { /* уже мёртв */ } });

const ready = new Promise((resolve, reject) => {
	let buffer = '';
	child.stdout.on('data', chunk => {
		buffer += chunk.toString();
		let index;
		while ((index = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (line.startsWith('AURA-HARNESS ')) { resolve(JSON.parse(line.slice('AURA-HARNESS '.length))); return; }
		}
	});
	child.on('exit', code => reject(new Error(`стенд завершился (exit ${code})\n${harnessLog.slice(-2000)}`)));
	setTimeout(() => reject(new Error(`стенд не поднялся за 60 секунд\n${harnessLog.slice(-2000)}`)), 60_000).unref();
});

/* ---------- Подмена API VS Code (вне IDE его нет) ---------- */
const configuration = { serverUrl: '' };
const vscodeStub = {
	EventEmitter: class {
		constructor() {
			this.listeners = new Set();
			this.event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
		}
		fire(value) { for (const listener of [...this.listeners]) { listener(value); } }
		dispose() { this.listeners.clear(); }
	},
	workspace: { getConfiguration: () => ({ get: (key, fallback) => (key in configuration ? configuration[key] : fallback) }) },
	env: { language: 'ru' },
	l10n: { t: (message, ...args) => String(message).replace(/\{(\d+)\}/g, (_match, index) => String(args[Number(index)] ?? '')) },
	Uri: { parse: value => ({ toString: () => String(value) }) },
	window: { showErrorMessage: () => undefined }
};

const require = createRequire(import.meta.url);
const realLoad = Module._load;
let AuraApiClient;
try {
	Module._load = function (request, ...rest) {
		return request === 'vscode' ? vscodeStub : realLoad.call(this, request, ...rest);
	};
	({ AuraApiClient } = require(compiledClient));
} finally {
	Module._load = realLoad;
}

/* ---------- Запись реальных запросов ---------- */
const requests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
	requests.push({ url: String(input), method: (init.method ?? 'GET').toUpperCase(), headers: { ...(init.headers ?? {}) } });
	return realFetch(input, init);
};

const main = async () => {
	const { port, token, refreshToken, teamId, userId } = await ready;
	const baseUrl = `http://127.0.0.1:${port}`;
	configuration.serverUrl = baseUrl;

	// Клиент читает extensionPath только чтобы попробовать поднять локальный сервер
	// (wakeLocalServer). Указываем на пустой временный каталог: выше него нет
	// aura-team-server, поэтому побочных запусков не будет.
	const sandbox = mkdtempSync(join(tmpdir(), 'aura-client-'));
	const output = { appendLine: () => undefined, append: () => undefined, dispose: () => undefined };
	const makeClient = (tokens = {}) => {
		const secrets = new Map(Object.entries(tokens));
		const context = {
			extensionPath: sandbox,
			secrets: {
				get: async key => secrets.get(key),
				store: async (key, value) => { secrets.set(key, value); },
				delete: async key => { secrets.delete(key); }
			}
		};
		return { secrets, client: new AuraApiClient(context, output) };
	};

	check('стенд поднялся и отвечает на /health', await fetch(`${baseUrl}/health`).then(r => r.ok).catch(() => false));

	const owner = makeClient({ 'auraTeam.accessToken': token, 'auraTeam.refreshToken': refreshToken });

	/* ---------- 1. Сессия ---------- */
	const session = await owner.client.getSession();
	check('getSession(): серверная сессия с настоящим пользователем', session?.user?.id === userId, JSON.stringify(session?.user));
	check('getSession(): команда стенда в списке', (session?.teams ?? []).some(team => team.id === teamId));

	/* ---------- 2. Доска и задачи ---------- */
	const empty = await owner.client.getBoard(teamId);
	check('getBoard(): свежая доска пуста', Array.isArray(empty?.tasks) && empty.tasks.length === 0, `tasks=${empty?.tasks?.length}`);

	const created = await owner.client.createTask(teamId, 'Задача из интеграционного теста');
	check('createTask(): сервер вернул задачу с id и названием', typeof created?.id === 'string' && created.title === 'Задача из интеграционного теста', JSON.stringify(created));
	check('createTask(): статус по умолчанию — todo', created?.status === 'todo', String(created?.status));

	const afterCreate = await owner.client.getBoard(teamId);
	check('createTask(): задача реально лежит на доске (пережила круг HTTP)', (afterCreate?.tasks ?? []).some(task => task.id === created.id));

	await owner.client.updateTask(teamId, created.id, { status: 'doing', description: 'из интеграционного теста' });
	const afterUpdate = await owner.client.getBoard(teamId);
	const moved = (afterUpdate?.tasks ?? []).find(task => task.id === created.id);
	check('updateTask(): статус и описание доехали до сервера', moved?.status === 'doing' && moved?.description === 'из интеграционного теста', JSON.stringify(moved));

	const second = await owner.client.createTask(teamId, 'Вторая задача', 'doing');
	await owner.client.reorderTasks(teamId, 'doing', [second.id, created.id]);
	const afterReorder = await owner.client.getBoard(teamId);
	const doing = (afterReorder?.tasks ?? []).filter(task => task.status === 'doing').map(task => task.id);
	check('reorderTasks(): порядок в колонке сохранён сервером', doing[0] === second.id && doing[1] === created.id, doing.join(', ') || 'пусто');

	/* ---------- 3. Заголовки: тот самый продовый баг ---------- */
	const json = request => request.headers['content-type'] === 'application/json';
	// Именно создание задачи: POST /…/tasks/reorder тоже содержит «/tasks», но тела не шлёт.
	const posts = requests.filter(request => request.method === 'POST' && new URL(request.url).pathname.endsWith('/tasks'));
	check('POST задачи уходит с content-type: application/json', posts.length === 2 && posts.every(json), JSON.stringify(posts.map(request => request.headers)));
	const patches = requests.filter(request => request.method === 'PATCH');
	check('PATCH задачи уходит с content-type: application/json', patches.length >= 1 && patches.every(json), JSON.stringify(patches.map(request => request.headers)));

	/* ---------- 4. Удаление и корзина (регресс: DELETE без тела) ---------- */
	let deleteError;
	try { await owner.client.deleteTask(teamId, created.id); } catch (error) { deleteError = error; }
	check('deleteTask(): DELETE без тела сервер принимает (иначе 400 как в проде)', deleteError === undefined, deleteError?.message);

	const deletes = requests.filter(request => request.method === 'DELETE' && request.url.endsWith(`/tasks/${created.id}`));
	check('deleteTask(): заголовок content-type не выставлен на пустом теле', deletes.length === 1 && !('content-type' in deletes[0].headers), JSON.stringify(deletes[0]?.headers ?? {}));

	const trash = await owner.client.listDeletedTasks(teamId);
	check('listDeletedTasks(): задача попала в корзину', trash.some(task => task.id === created.id), JSON.stringify(trash.map(task => task.title)));

	let restoreError;
	try { await owner.client.restoreTask(teamId, created.id); } catch (error) { restoreError = error; }
	check('restoreTask(): восстановление без ошибок', restoreError === undefined, restoreError?.message);
	const afterRestore = await owner.client.getBoard(teamId);
	check('restoreTask(): задача вернулась на доску', (afterRestore?.tasks ?? []).some(task => task.id === created.id));

	/* ---------- 5. Лента, лимиты, приглашения ---------- */
	const activity = await owner.client.getActivity(teamId);
	check('getActivity(): лента команды не пуста', Array.isArray(activity) && activity.length > 0, `events=${activity?.length ?? 0}`);

	const limits = await owner.client.fetchLimits(teamId);
	check('fetchLimits(): лимиты пришли с сервера', Number(limits?.archiveMaxBytes) > 0 && Number(limits?.proxyRequestsPerDay) > 0, JSON.stringify(limits));

	const invite = await owner.client.createInvite(teamId);
	check('createInvite(): код приглашения получен', typeof invite?.code === 'string' && invite.code.length > 0, JSON.stringify(invite));
	const current = await owner.client.getCurrentInvite(teamId);
	check('getCurrentInvite(): сервер отдаёт тот же код', current?.code === invite.code, `${current?.code} vs ${invite?.code}`);
	let revokeError;
	try { await owner.client.revokeInvite(teamId); } catch (error) { revokeError = error; }
	check('revokeInvite(): приглашение снято', revokeError === undefined, revokeError?.message);

	/* ---------- 6. Данные для вкладки «Модели» оркестратора ---------- */
	// Мост оркестратора зовёт getUsage у публичного API Team. Сам сервер расход отдаёт —
	// значит, если цифры в панели не появляются, дело в мосте, а не в сервере.
	const usage = await owner.client.fetchUsage(teamId);
	check('fetchUsage(): сервер отдаёт расход по людям', Array.isArray(usage?.perUser) && Number(usage?.limitPerUserPerDay) > 0, JSON.stringify(usage?.perUser));

	/* ---------- 7. Ошибки: текст сервера и обновление сессии ---------- */
	let validation;
	try { await owner.client.createTask(teamId, ''); } catch (error) { validation = error.message; }
	check('ошибка валидации доезжает текстом, а не «HTTP 400»', typeof validation === 'string' && validation.toLowerCase().includes('title'), validation);

	const stale = makeClient({ 'auraTeam.accessToken': 'stale-token', 'auraTeam.refreshToken': refreshToken });
	const refreshed = await stale.client.getSession();
	check('протухший access-токен: сессия обновляется прозрачно', refreshed?.user?.id === userId, JSON.stringify(refreshed?.user));
	check('после обновления новые токены сохранены', stale.secrets.get('auraTeam.accessToken') && stale.secrets.get('auraTeam.accessToken') !== 'stale-token');

	const stranger = makeClient({ 'auraTeam.accessToken': 'not-a-real-token' });
	let unauthorized;
	try { await stranger.client.getSession(); } catch (error) { unauthorized = error.message; }
	check('битый токен без refresh: клиент падает, а не отдаёт пустую сессию', typeof unauthorized === 'string' && unauthorized.length > 0, unauthorized);

	/* ---------- 8. Сервер не поднят ---------- */
	// Свободный порт: слушаем 0, забираем номер, закрываем — по нему никто не ответит.
	const probe = createNetServer();
	const closedPort = await new Promise(resolve => {
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address();
			probe.close(() => resolve(typeof address === 'object' && address ? address.port : 1));
		});
	});
	configuration.serverUrl = `http://127.0.0.1:${closedPort}`;
	let unreachable;
	try { await stranger.client.getSession(); } catch (error) { unreachable = error.message; }
	check('сервер не поднят: понятное сообщение вместо «fetch failed»', typeof unreachable === 'string' && /not reachable/i.test(unreachable), unreachable);
	configuration.serverUrl = baseUrl;

	owner.client.dispose();
	stale.client.dispose();
	stranger.client.dispose();
};

try {
	await main();
} catch (error) {
	check('тест дошёл до конца', false, error instanceof Error ? `${error.message}\n${error.stack}` : String(error));
} finally {
	globalThis.fetch = realFetch;
	child.kill();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
