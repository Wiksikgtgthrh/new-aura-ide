/*---------------------------------------------------------------------------------------------
 *  Тесты панели «Проекты и Git».
 *  Главная задача набора — «кнопки не все работают»: каждая кнопка панели должна иметь
 *  обработчик, а каждая команда, которую webview вызывает, должна быть зарегистрирована
 *  в расширении (именно этот разрыв ломал обновление после коммита: auraTeam.getState
 *  была VS Code-командой, но не была доступна через invoke).
 *--------------------------------------------------------------------------------------------*/
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const templatePath = join(here, '..', 'src', 'webview', 'template.html');
const raw = readFileSync(templatePath, 'utf8');
const html = raw
	.split('__NONCE__').join('testnonce')
	.split('__INITIAL_VIEW__').join('git')
	.split('__INITIAL_FILTER__').join('null');

let posted = [];
const dom = new JSDOM(html, {
	runScripts: 'outside-only',
	url: 'https://localhost/',
	pretendToBeVisual: true,
	beforeParse(window) {
		window.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m), getState: () => ({}), setState: () => { } });
		window.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);
		window.matchMedia ??= () => ({ matches: false, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });
		window.Element.prototype.animate = function () { return { finished: Promise.resolve(), onfinish: null, cancel() { } }; };
		window.Element.prototype.scrollIntoView = function () { };
	}
});
const { window } = dom;
const { document } = window;

let failures = 0;
const check = (name, ok) => { console.log((ok ? '  ok   ' : '  FAIL ') + name); if (!ok) { failures++; } };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const gitSnapshot = (overrides = {}) => ({
	path: 'c:\\DEV\\приложение\\social-services-application (2)',
	branch: 'master',
	remotes: ['origin'],
	changes: [
		{ path: '.gitignore', kind: 'working' },
		{ path: 'README.md', kind: 'untracked' }
	],
	commits: [{ hash: 'a1b2c3d4e5', message: 'первый коммит', author: 'Wiks', date: new Date().toISOString() }],
	branches: [{ name: 'master', current: true }, { name: 'feature/x', current: false }],
	...overrides
});

const baseState = (mutate) => {
	const state = {
		signedIn: true, demoMode: false, simpleMode: false, serverUrl: 'http://localhost', uiLanguage: 'ru', teamId: 'team1',
		profile: { id: 'me', nickname: 'Wiks', email: 'w@x.y' },
		session: { user: { id: 'me', displayName: 'Wiks', email: 'w@x.y' }, teams: [{ id: 'team1', name: 'Aura Studio', role: 'owner' }] },
		board: {
			members: [{ id: 'me', displayName: 'Wiks', role: 'owner', online: true }],
			projects: [],
			tasks: [
				{ id: '29d49eaf-1111-2222-3333-444455556666', title: 'Собрать шаги релиза', status: 'doing', position: 0 },
				{ id: 'bbbbbbbb-1111-2222-3333-444455556666', title: 'Готово', status: 'done', position: 0 }
			]
		},
		githubConnected: false,
		git: gitSnapshot()
	};
	if (mutate) { mutate(state); }
	return state;
};

const setState = async (mutate) => {
	posted = [];
	window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'state', state: baseState(mutate) } }));
	await tick(40);
};

const scriptText = document.querySelector('script')?.textContent ?? '';
try { window.eval(scriptText); } catch (error) { console.error('FAIL: eval:', error.message); process.exit(1); }
await setState();

/* ---------- 1. Каркас панели ---------- */
check('панель Git отрисована', Boolean(document.querySelector('.git-card')));
check('путь репозитория с кириллицей показан целиком', (document.querySelector('.repo-path')?.textContent ?? '').includes('social-services-application (2)'));
check('текущая ветка видна', document.querySelector('.git-head .chip')?.textContent.trim() === 'master');
check('изменённые файлы перечислены', document.querySelectorAll('.change-item').length === 2);
check('у изменённого файла есть чекбокс и клик по диффу', Boolean(document.querySelector('.change-check')) && Boolean(document.querySelector('.change-path[data-diff]')));

/* ---------- 2. Стандарт работы: ветка → коммит со ссылкой → push ---------- */
const flow = [...document.querySelectorAll('.git-flow .step')].map((el) => el.textContent.trim());
check('блок стандартов показывает три шага', flow.length === 3);
check('первый шаг — ветка задачи', /ветка из задачи/.test(flow[0] ?? ''));
check('второй шаг требует ссылку на задачу', /#id/.test(flow[1] ?? ''));
check('третий шаг — push и pull request', /push/.test(flow[2] ?? ''));
check('в master шаг ветки помечен предупреждением', document.querySelector('.git-flow .step.warn')?.textContent.includes('ветка из задачи') === true);
check('есть кнопка «Ветка из задачи»', Boolean(document.getElementById('btnBranchFromTask')));

await setState((s) => { s.git = gitSnapshot({ branch: 'task/29d49eaf-sbor-shagov-reliza' }); });
check('в ветке задачи шаг помечен выполненным', Boolean(document.querySelector('.git-flow .step.ok')));
check('в ветке задачи кнопка создания не нужна', !document.getElementById('btnBranchFromTask'));

/* ---------- 3. GitHub: вход и подпись аккаунта ---------- */
await setState();
check('без подключения показан статус и кнопка входа', document.querySelector('.git-card .chip.off')?.textContent.includes('не подключён') === true && Boolean(document.getElementById('btnGitHub')));
check('кнопки GitHub выключены, пока нет подключения', document.getElementById('btnGhRepos').disabled && document.getElementById('btnGhCreate').disabled);
await setState((s) => { s.githubConnected = true; s.githubAccount = 'wiks'; });
check('подключённый аккаунт подписан логином', document.querySelector('.git-card .chip.ok')?.textContent.includes('GitHub: wiks'));
check('кнопки GitHub включились', !document.getElementById('btnGhRepos').disabled && !document.getElementById('btnGhCreate').disabled);

/* ---------- 4. Все кнопки панели имеют обработчик ---------- */
/* Статическая сверка: id каждой кнопки из разметки Git-карточки должен упоминаться в wireGit. */
const viewSource = raw.slice(raw.indexOf('function wireGit()'), raw.indexOf('function confirmAction'));
const gitMarkup = raw.slice(raw.indexOf('const changeRow ='), raw.indexOf('function wireGit()'));
const ids = [...new Set([...gitMarkup.matchAll(/id="(btn[A-Za-z]+)"/g)].map((m) => m[1]))];
const missing = ids.filter((id) => !viewSource.includes(`'${id}'`));
check(`у каждой кнопки панели есть обработчик (${ids.length} кнопок)`, missing.length === 0);
if (missing.length) { console.log('       без обработчика: ' + missing.join(', ')); }

/* ---------- 5. Каждая вызываемая команда зарегистрирована в расширении ---------- */
const built = readFileSync(join(here, '..', 'out', 'extension.js'), 'utf8');
const called = [...new Set([...raw.matchAll(/(?:svc|demo)\('(auraTeam\.[A-Za-z]+)'/g)].map((m) => m[1]))].sort();
const unregistered = called.filter((command) => !built.includes(`register('${command}'`) && !built.includes(`id === '${command}'`));
check(`все ${called.length} команд из webview зарегистрированы в расширении`, unregistered.length === 0);
if (unregistered.length) { console.log('       неизвестны расширению: ' + unregistered.join(', ')); }

/* ---------- 6. Коммит: ссылка на задачу и обновление состояния ---------- */
const answer = (command, result, ok = true) => {
	const request = [...posted].reverse().find((m) => m.type === 'invoke' && m.command === command && m.id !== undefined && !m.__answered);
	if (!request) { return undefined; }
	request.__answered = true;
	window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'response', id: request.id, ok, result, error: ok ? undefined : String(result) } }));
	return request;
};

document.getElementById('commitMsg').value = 'feat: собрать шаги';
document.getElementById('btnCommit').click();
await tick(20);
const commitCall = posted.find((m) => m.type === 'invoke' && m.command === 'auraTeam.commitAll');
check('коммит уходит с сообщением', commitCall?.args?.[0] === 'feat: собрать шаги');
answer('auraTeam.commitAll', { hash: 'deadbeef', message: 'feat: собрать шаги', pushed: true, linked: false });
await tick(30);
check('коммит без ссылки на задачу предупреждает тостом', [...document.querySelectorAll('.toast')].some((t) => /не связан с задачей/.test(t.textContent)));
check('после коммита панель перезапрашивает состояние', posted.some((m) => m.type === 'invoke' && m.command === 'auraTeam.getState'));
check('поле сообщения очищено', document.getElementById('commitMsg').value === '');

/* ---------- 7. Клик по файлу открывает дифф ---------- */
posted = [];
document.querySelector('.change-path[data-diff]').click();
await tick(10);
check('дифф запрашивается по пути файла', posted.find((m) => m.type === 'invoke' && m.command === 'auraTeam.showDiff')?.args?.[0] === '.gitignore');

/* ---------- 8. Ветка из задачи ---------- */
document.getElementById('btnBranchFromTask').click();
await tick(60);
const rows = [...document.querySelectorAll('[data-branch-task]')];
check('в окне ветки только незакрытые задачи', rows.length === 1 && rows[0].dataset.branchTask.startsWith('29d49eaf'));
posted = [];
rows[0].click();
await tick(20);
check('ветка создаётся из выбранной задачи', posted.find((m) => m.type === 'invoke' && m.command === 'auraTeam.createBranchFromTask')?.args?.[0] === '29d49eaf-1111-2222-3333-444455556666');
answer('auraTeam.createBranchFromTask', { branch: 'task/29d49eaf-sbor-shagov-reliza' });
await tick(30);
check('после создания ветки окно закрыто', !document.querySelector('.overlay'));
check('имя новой ветки показано в тосте', [...document.querySelectorAll('.toast')].some((t) => /task\/29d49eaf/.test(t.textContent)));

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
if (failures) { process.exit(1); }
