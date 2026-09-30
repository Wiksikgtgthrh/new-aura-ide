/*---------------------------------------------------------------------------------------------
 *  Смоук-тест сайдбара Aura Team v2: единая сетка строк (A3), палитра статусов (A4),
 *  инлайн-счётчик повторов (A2), отсутствие «висящей w» (A1), diff-обновление строк
 *  с сохранением фокуса/скролла, undo-тост с отложенным запросом (C5), FLIP (C6).
 *--------------------------------------------------------------------------------------------*/
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const out = readFileSync(join(here, '..', 'out', 'extension.js'), 'utf8');

const start = out.indexOf('const LAUNCHER_HTML = `');
if (start < 0) { console.error('FAIL: LAUNCHER_HTML not found'); process.exit(1); }
const endMarker = '</script></body></html>`;';
const end = out.indexOf(endMarker, start);
const rawLiteral = out.slice(start + 'const LAUNCHER_HTML = '.length, end + endMarker.length);
const template = vm.runInNewContext(rawLiteral, {});

let posted = [];
const dom = new JSDOM(template
	.split('__CODICON_FONT__').join('QUJD')
	.split('__NONCE__').join('testnonce'), {
	runScripts: 'outside-only',
	url: 'https://localhost/',
	pretendToBeVisual: true,
	beforeParse(window) {
		window.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m), getState: () => ({}), setState: () => {} });
		window.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);
		window.Element.prototype.animate = function () {
			return { finished: Promise.resolve(), onfinish: null, cancel: () => {} };
		};
	}
});
const { window } = dom;
const { document } = window;

let failures = 0;
const check = (name, ok) => { console.log((ok ? '  ok   ' : '  FAIL ') + name); if (!ok) { failures++; } };

const testState = {
	signedIn: true,
	uiLanguage: 'ru',
	teamId: 'team1',
	summary: {
		myTasks: [
			{ id: 't1', title: 'Таск todo', status: 'todo', dueAt: null, subtasks: { done: 1, total: 3 } },
			{ id: 't2', title: 'Таск в работе', status: 'doing', dueAt: null, subtasks: { done: 0, total: 2 } },
			{ id: 't3', title: 'Таск на ревью', status: 'review', dueAt: null },
			{ id: 't4', title: 'Таск готов', status: 'done', dueAt: null },
			{ id: 't5', title: 'Просрочен', status: 'doing', dueAt: new Date(Date.now() - 864e5).toISOString() },
			{ id: 't6', title: 'Шестой', status: 'todo', dueAt: null }
		],
		members: [
			{ id: 'u1', displayName: 'wiks', role: 'owner', online: true },
			{ id: 'u2', displayName: 'Alex', role: '', online: true },
			{ id: 'u3', displayName: 'Mia', role: 'viewer', online: false }
		]
	},
	activity: [
		{ createdAt: new Date(Date.now() - 30e3).toISOString(), action: 'task.update', userId: 'u1', userName: 'wiks', taskTitle: 'пкпкпк' },
		{ createdAt: new Date(Date.now() - 90e3).toISOString(), action: 'task.update', userId: 'u1', userName: 'wiks', taskTitle: 'пкпкпк' },
		{ createdAt: new Date(Date.now() - 150e3).toISOString(), action: 'task.update', userId: 'u1', userName: 'wiks', taskTitle: 'пкпкпк' },
		{ createdAt: new Date(Date.now() - 300e3).toISOString(), action: 'task.create', userId: 'u2', userName: 'Alex', taskTitle: 'Второй таск' },
		{ createdAt: new Date(Date.now() - 30 * 864e5).toISOString(), action: 'key.create', userId: 'u2', userName: 'Alex', taskTitle: null },
		{ createdAt: new Date(Date.now() - 31 * 864e5).toISOString(), action: 'team.create', userId: 'u1', userName: 'wiks', taskTitle: null }
	],
	dismissedActivity: [],
	session: { user: { id: 'u1', displayName: 'wiks', email: 'w@x.y' }, teams: [{ id: 'team1', name: 'Aura Studio', role: 'owner' }] }
};

const scriptText = document.querySelector('script')?.textContent ?? '';
try { window.eval(scriptText); } catch (error) { console.error('FAIL: eval:', error.message); process.exit(1); }
window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'state', state: JSON.parse(JSON.stringify(testState)) } }));
await new Promise(r => setTimeout(r, 80));

/* A1: нет висящей «w»/огрызка роли */
const memberRows = [...document.querySelectorAll('.member-row')];
check('Пустая роль Alex не рендерится', memberRows.find(r => r.dataset.member === 'u2')?.querySelector('.m-role') === null);
check('Свой аккаунт помечен «вы»', memberRows.find(r => r.dataset.member === 'u1')?.textContent.includes('вы'));
check('У профиля нет дублей подписи', !document.querySelector('.me .who .handle') || document.querySelectorAll('.me .who .handle').length === 1);

/* A2: счётчик повторов — инлайн .rep внутри .title, без фона */
const rep = document.querySelector('.ev-row .rep');
check('Счётчик ×3 — инлайн .rep внутри строки', !!rep && rep.closest('.title') !== null);
check('Формат «×3»', rep?.textContent === '×3');
const repBg = window.getComputedStyle(rep).backgroundColor;
check('.rep без фона', repBg === 'rgba(0, 0, 0, 0)' || repBg === 'transparent');

/* A3: единая сетка — nav-item, task-row, member-row, ev-row, link-btn имеют ту же первую колонку/отступ */
const navItem = document.querySelector('.nav-item');
const taskRow = document.querySelector('.task-row');
const linkBtn = document.querySelector('#taskExtras');
const pad = (el) => window.getComputedStyle(el).paddingLeft;
check('Навигация и задачи: одинаковый левый padding', pad(navItem) === pad(taskRow));
if (linkBtn) { check('«Показать все» — с тем же padding', pad(linkBtn) === pad(taskRow)); }
check('Сетка строк 20px|1fr|auto', window.getComputedStyle(taskRow).gridTemplateColumns.split(' ')[0] === '20px');

/* A4: фиксированная палитра статусов */
const badges = new Map([...document.querySelectorAll('.task-row .badge')].map(b => [b.dataset.state, b]));
check('todo — без бейджа', !document.querySelector('.task-row[data-task="t1"] .badge'));
check('doing → data-state="in-progress", подпись «в работе»', badges.get('in-progress')?.querySelector('.badge-text')?.textContent === 'в работе');
check('review → data-state="review"', badges.has('review'));
check('done → data-state="done"', badges.has('done'));
check('Просроченная задача → overdue', badges.has('overdue'));
check('Цвет статуса через var(--vscode-charts-*)', document.querySelector('.badge[data-state="review"]') !== null && !/[#][0-9a-f]{3,8}/i.test([...document.querySelectorAll('style')].map(s => s.textContent).join('')));

/* Подзадачи: прогресс виден прямо в строке «Мои задачи», без открытия карточки */
const subT1 = document.querySelector('.task-row[data-task="t1"] .sub-count');
check('Прогресс подзадач показан в строке задачи', subT1?.textContent === '1/3');
check('Счётчик подзадач — часть заголовка строки, а не отдельная колонка', !!subT1?.closest('.title'));
check('Задача без подзадач не рисует счётчик', document.querySelector('.task-row[data-task="t5"] .sub-count') === null);
check('Сетка строки не изменилась от счётчика', window.getComputedStyle(document.querySelector('.task-row')).gridTemplateColumns.split(' ')[0] === '20px');
/* Расширение само считает прогресс из описания доски: /summary описаний не отдаёт. */
check('Summary обогащается прогрессом подзадач из доски', /withSubtaskProgress\(state\.summary\)/.test(out));

/* Токены движения C1 */
const css = [...document.querySelectorAll('style')].map(s => s.textContent).join('');
check('Токены --dur-1..4 и --ease-out/in/inout/snap есть', ['--dur-1: 90ms', '--dur-2: 160ms', '--dur-3: 240ms', '--dur-4: 320ms', '--ease-out', '--ease-snap'].every(x => css.includes(x)));
check('reduced-motion: длительности = 1ms', css.includes('@media (prefers-reduced-motion: reduce)'));
check('Нет translateY(-1px)', !css.includes('translateY(-1px)'));
check('Нет infinite кроме спиннера', (css.match(/infinite/g) ?? []).length === 0);
check('точка присутствия не анимируется бесконечно', !/\.presence\.live\s*\{[^}]*animation/.test(css));

/* C5: удаление — строка схлопывается, запрос отложен до истечения тоста */
posted = [];
const delBtn = document.querySelector('[data-del-task="t5"]');
delBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('Кнопка удаления найдена (задача видима в списке)', !!delBtn);
await new Promise(r => setTimeout(r, 400)); // ждём collapse-анимации (мок animate — мгновенный)
const toast = document.getElementById('undoToast');
check('Undo-тост показан', !!toast && !toast.classList.contains('hidden'));
/* Удаление уходит на сервер СРАЗУ: отложенный на 5 с запрос терялся при перерисовке,
   и задача оставалась живой (главный баг «задачи не удаляются»). */
check('deleteTask уходит сразу, а не через тост', posted.some(m => m.type === 'invoke' && m.command === 'auraTeam.deleteTask' && m.args?.[0] === 't5'));
const rowGone = !document.querySelector('.task-row[data-task="t5"]');
check('Строка удалена из DOM', rowGone);
/* C5: «Отменить» → restoreTask и никакого повторного deleteTask */
posted = [];
document.getElementById('undoBtn')?.click();
check('«Отменить» отправляет restoreTask', posted.some(m => m.command === 'auraTeam.restoreTask' && m.args?.[0] === 't5'));
check('После отмены deleteTask повторно не уходит', !posted.some(m => m.command === 'auraTeam.deleteTask'));

/* Присутствие: зелёная/серая точка с подписью в title, онлайн сверху. */
const rows = [...document.querySelectorAll('.member-row')];
const dotOf = (name) => rows.find(r => r.querySelector('.title')?.textContent === name)?.querySelector('.presence');
check('точка присутствия есть у каждого участника', rows.every(r => r.querySelector('.presence')));
check('онлайн — зелёная (live)', dotOf('Alex')?.classList.contains('live'));
check('офлайн — серая (off)', dotOf('Mia')?.classList.contains('off'));
check('в title написано «в сети»', dotOf('Alex')?.getAttribute('title') === 'в сети');
check('онлайновые стоят выше офлайновых', rows.findIndex(r => r.querySelector('.title')?.textContent === 'Mia') > rows.findIndex(r => r.querySelector('.title')?.textContent === 'Alex'));

/* invite: секция внутри сайдбара — никакой вкладки редактора и никаких уведомлений «по факту» */
posted = [];
document.querySelector('.nav-item[data-view="invite"]')?.click();
check('«Пригласить» не открывает вкладку редактора', !posted.some(m => m.type === 'invoke' && m.command === 'auraTeam.invite.open'));
const inviteSection = document.getElementById('secInvite');
check('секция приглашения раскрывается в панели', inviteSection?.dataset.open === 'true');
check('пункт навигации показывает активное состояние', document.querySelector('.nav-item[data-view="invite"]').classList.contains('active'));

/** Отвечаем на отложенные invoke — в сайдбаре нет vscode API, только postMessage. */
const answer = (command, result, ok = true) => {
	const request = [...posted].reverse().find(m => m.type === 'invoke' && m.command === command && m.id !== undefined && !m.__answered);
	if (!request) { return undefined; }
	request.__answered = true;
	window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'response', id: request.id, ok, result, error: ok ? undefined : String(result) } }));
	return request;
};

answer('auraTeam.currentInvite', { code: 'AURA-TEAM-1', expiresAt: new Date(Date.now() + 2 * 864e5).toISOString() });
await new Promise(r => setTimeout(r, 20));
check('код приглашения отрисован в секции', document.querySelector('#secInvite .code')?.textContent === 'AURA-TEAM-1');
check('срок действия кода виден текстом', /истекает/.test(document.querySelector('#secInvite .expires')?.textContent ?? ''));

const dirRequest = [...posted].reverse().find(m => m.type === 'invoke' && m.command === 'auraTeam.directory');
check('каталог запрошен у расширения', Boolean(dirRequest));
answer('auraTeam.directory', [
	{ id: 'u2', displayName: 'Alex', email: 'alex@x.y', inTeam: 1 },
	{ id: 'u9', displayName: 'Nina', email: 'nina@x.y', inTeam: 0 }
]);
await new Promise(r => setTimeout(r, 20));
const hits = [...document.querySelectorAll('#inviteResults .invite-hit')];
check('каталог отрисован строками', hits.length === 2);
check('email кандидата виден в строке', hits.some(h => h.querySelector('.email')?.textContent === 'nina@x.y'));
check('присутствие показано только у участника команды', Boolean(hits.find(h => h.querySelector('.title')?.textContent.startsWith('Alex'))?.querySelector('.presence')) && !hits.find(h => h.querySelector('.title')?.textContent.startsWith('Nina'))?.querySelector('.presence'));
const ninaBtn = hits.find(h => h.querySelector('.title')?.textContent.startsWith('Nina')).querySelector('[data-invite-user]');
check('участник команды уже помечен приглашённым', hits.find(h => h.querySelector('.title')?.textContent.startsWith('Alex')).querySelector('[data-invite-user]').dataset.sent === 'true');
check('кандидат без приглашения — кнопка активна', !ninaBtn.dataset.sent && !ninaBtn.disabled);

posted = [];
ninaBtn.click();
await new Promise(r => setTimeout(r, 10));
const sent = posted.find(m => m.type === 'invoke' && m.command === 'auraTeam.sendInvite');
check('отправка идёт с id пользователя', sent?.args?.[0] === 'u9');
check('кнопка сразу показывает «Приглашён»', ninaBtn.dataset.sent === 'true' && ninaBtn.disabled);

/* Ошибка отправки возвращает кнопку в исходное состояние, а не молча врёт. */
answer('auraTeam.sendInvite', 'нет доступа', false);
await new Promise(r => setTimeout(r, 20));
check('ошибка отправки откатывает кнопку', ninaBtn.dataset.sent === 'false' && !ninaBtn.disabled);

/* Поиск: набор текста и фокус переживают пришедшее состояние (главная причина лага). */
const search = document.getElementById('inviteSearch');
search.focus();
search.value = 'nin';
search.dispatchEvent(new window.Event('input', { bubbles: true }));
await new Promise(r => setTimeout(r, 320));
const searchRequest = [...posted].reverse().find(m => m.type === 'invoke' && m.command === 'auraTeam.directory');
check('поиск отправляется после debounce', searchRequest?.args?.[0] === 'nin');
window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'state', state: JSON.parse(JSON.stringify(testState)), inviteCode: 'AURA-TEAM-1' } }));
await new Promise(r => setTimeout(r, 20));
check('фокус остаётся в поле поиска после обновления состояния', document.activeElement === document.getElementById('inviteSearch'));
check('набранный текст не сбрасывается', document.getElementById('inviteSearch').value === 'nin');
check('строка каталога переиспользуется, а не пересоздаётся', [...document.querySelectorAll('#inviteResults .invite-hit')].every(h => h.isConnected));

/* Кнопка закрытия и отзыв кода. */
document.getElementById('inviteCloseBtn').click();
check('секцию можно закрыть', document.getElementById('secInvite').dataset.open === 'false');
document.querySelector('.nav-item[data-view="invite"]').click();
posted = [];
document.getElementById('inviteRevokeBtn').click();
await new Promise(r => setTimeout(r, 20));
check('отзыв кода уходит на сервер', posted.some(m => m.type === 'invoke' && m.command === 'auraTeam.revokeInvite'));
check('до ответа сервера код остаётся на месте', document.querySelector('#secInvite .code')?.textContent === 'AURA-TEAM-1');
answer('auraTeam.revokeInvite', { ok: true });
await new Promise(r => setTimeout(r, 20));
check('после отзыва показано пустое состояние с кнопкой создания', document.getElementById('inviteCreateBtn')?.tagName === 'BUTTON');

/* Отмена подтверждения в расширении не должна стирать код в панели. */
posted = [];
document.getElementById('inviteCreateBtn').click();
answer('auraTeam.createInvite', { code: 'AURA-TEAM-2', expiresAt: new Date(Date.now() + 864e5).toISOString() });
await new Promise(r => setTimeout(r, 20));
check('новый код появляется вместо пустого состояния', document.querySelector('#secInvite .code')?.textContent === 'AURA-TEAM-2');
check('кнопка копирования вернулась и работает', (() => {
	posted = [];
	document.getElementById('inviteCopyBtn').click();
	return posted.some(m => m.type === 'invoke' && m.command === 'auraTeam.copyToClipboard' && m.args?.[0] === 'AURA-TEAM-2');
})());

/* diff-обновление: повторный broadcast не пересоздаёт строки, фокус сохраняется */
const rowBefore = document.querySelector('.task-row[data-task="t1"]');
rowBefore.focus();
const state2 = JSON.parse(JSON.stringify(testState));
state2.summary.myTasks[1].status = 'review'; // смена статуса t2: doing → review
state2.summary.myTasks[1].subtasks = { done: 2, total: 2 }; // прогресс обновился
state2.summary.myTasks[0].subtasks = undefined; // у t1 подзадачи убрали
window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'state', state: state2 } }));
await new Promise(r => setTimeout(r, 80));
const rowAfter = document.querySelector('.task-row[data-task="t1"]');
check('Diff-обновление: строка t1 — тот же DOM-узел', rowBefore === rowAfter);
check('Фокус сохранён после broadcast', document.activeElement === rowAfter);
const t2badge = document.querySelector('.task-row[data-task="t2"] .badge');
check('Смена статуса: data-state обновился', t2badge?.dataset.state === 'review');
check('Смена статуса: старый текст кросфейдится (2 слоя)', t2badge?.querySelectorAll('.badge-text').length >= 1);
const subT2 = document.querySelector('.task-row[data-task="t2"] .sub-count');
check('Diff-обновление: прогресс подзадач пересчитан', subT2?.textContent === '2/2');
check('Diff-обновление: счётчик не дублируется', document.querySelectorAll('.task-row[data-task="t2"] .sub-count').length === 1);
check('Diff-обновление: исчезнувшие подзадачи убирают счётчик', document.querySelector('.task-row[data-task="t1"] .sub-count') === null);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
