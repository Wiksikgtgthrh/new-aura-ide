/*---------------------------------------------------------------------------------------------
 *  Приглашение и команда в сайдбаре Aura Team.
 *
 *  Тест закрывает жалобы с живой панели:
 *   • приглашённые пользователи дублировались (список рос с каждым обновлением состояния);
 *   • свежий 7-дневный код показывался как «истекает через 6 дн.»;
 *   • роли печатались сырыми (owner/dev/viewer) вместо русских подписей;
 *   • отозвать код и убрать участника из команды было нечем.
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
const dom = new JSDOM(template.split('__CODICON_FONT__').join('QUJD').split('__NONCE__').join('testnonce'), {
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
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

const directory = [
	{ id: 'u1', displayName: 'wiks', email: 'wiks@example.com', inTeam: 1 },
	{ id: 'u2', displayName: 'Smoke', email: null, inTeam: 0 },
	{ id: 'u3', displayName: 'Smoke', email: null, inTeam: 0 },
	{ id: 'u4', displayName: 'probe-test-1909', email: null, inTeam: 0 }
];

/** Состояние панели: я — владелец команды, в команде ещё трое с разными ролями. */
const makeState = (myRole = 'owner') => ({
	signedIn: true,
	uiLanguage: 'ru',
	teamId: 'team1',
	summary: {
		myTasks: [],
		members: [
			{ id: 'u1', displayName: 'wiks', role: 'owner', online: true },
			{ id: 'u5', displayName: 'Mia', role: 'maintainer', online: false },
			{ id: 'u6', displayName: 'Nina', role: 'dev', online: false },
			{ id: 'u7', displayName: 'Alex', role: 'viewer', online: false }
		]
	},
	activity: [],
	dismissedActivity: [],
	session: { user: { id: 'u1', displayName: 'wiks', email: 'wiks@example.com' }, teams: [{ id: 'team1', name: 'w', role: myRole }] }
});

const script = document.querySelector('script')?.textContent ?? '';
try { window.eval(script); } catch (error) { console.error('FAIL: eval:', error.message); process.exit(1); }

const send = (data) => window.dispatchEvent(new window.MessageEvent('message', { data }));
const answer = (command, result, ok = true) => {
	const request = [...posted].reverse().find(m => m.type === 'invoke' && m.command === command && m.id !== undefined && !m.__answered);
	if (!request) { return undefined; }
	request.__answered = true;
	send({ type: 'response', id: request.id, ok, result, error: ok ? undefined : String(result) });
	return request;
};
const hits = () => [...document.querySelectorAll('#inviteResults .invite-hit')];
const keys = () => hits().map(h => h.dataset.keyid);
const toasts = () => posted.filter(m => m.type === 'toast').map(m => m.text);

send({ type: 'state', state: makeState() });
await tick(60);

/* ---------- приглашение: никаких дублей строк ---------- */
posted = [];
document.querySelector('.nav-item[data-view="invite"]')?.click();
await tick();
answer('auraTeam.currentInvite', { code: 'AURA-7DAY-CODE', expiresAt: new Date(Date.now() + 7 * 864e5).toISOString() });
answer('auraTeam.directory', directory);
await tick();

check('каталог отрисован по одной строке на пользователя', keys().join(',') === 'u1,u2,u3,u4');
check('подсказка списка убрана после прихода каталога', document.querySelector('#inviteResults .invite-empty') === null);
check('свежий 7-дневный код подписан как «через 7 дн.»', document.querySelector('#secInvite .expires')?.textContent === 'истекает через 7 дн.');

/* Обновление состояния — самая частая операция (websocket broadcast): раньше
   каждая перерисовка добавляла копию всего списка. */
for (let i = 0; i < 5; i++) {
	send({ type: 'state', state: makeState(), inviteCode: 'AURA-7DAY-CODE' });
}
await tick(60);
check('5 обновлений состояния не дублируют строки', keys().join(',') === 'u1,u2,u3,u4');

for (let i = 0; i < 3; i++) {
	document.querySelector('.nav-item[data-view="invite"]')?.click();   // закрыть
	await tick(10);
	document.querySelector('.nav-item[data-view="invite"]')?.click();   // открыть
	await tick(10);
	answer('auraTeam.directory', directory);
	await tick(20);
}
check('переоткрытие секции не дублирует строки', keys().join(',') === 'u1,u2,u3,u4');
check('кнопок «Пригласить» ровно по одной на строку', document.querySelectorAll('#inviteResults [data-invite-user]').length === 4);
check('участник команды помечен «Приглашён»', hits().find(h => h.dataset.keyid === 'u1')?.querySelector('[data-invite-user]')?.dataset.sent === 'true');

/* Повторная отправка (двойной клик) — один запрос, а не очередь. */
posted = [];
const smoke = hits().find(h => h.dataset.keyid === 'u2').querySelector('[data-invite-user]');
smoke.click();
smoke.click();
await tick();
check('двойной клик отправляет одно приглашение', posted.filter(m => m.type === 'invoke' && m.command === 'auraTeam.sendInvite').length === 1);
answer('auraTeam.sendInvite', { ok: true });
await tick();
check('после отправки показан тост', toasts().includes('Приглашение отправлено'));

/* ---------- роли по-русски и кик участника ---------- */
const memberRows = () => new Map([...document.querySelectorAll('.member-row')].map(r => [r.dataset.member, r]));
const roleOf = (id) => memberRows().get(id)?.querySelector('.m-role')?.textContent ?? '';
const kickOf = (id) => memberRows().get(id)?.querySelector('[data-kick-member]') ?? null;

check('роль владельца по-русски', roleOf('u5') === 'Совладелец');
check('роль dev по-русски', roleOf('u6') === 'Разработчик');
check('роль viewer по-русски', roleOf('u7') === 'Зритель');
check('сырых ролей в строках команды нет', ['owner', 'maintainer', 'dev', 'viewer'].every(raw => ![roleOf('u1'), roleOf('u5'), roleOf('u6'), roleOf('u7')].includes(raw)));
check('свой аккаунт помечен «вы»', roleOf('u1') === 'вы');
check('владелец может убрать совладельца', Boolean(kickOf('u5')));
check('владелец может убрать разработчика', Boolean(kickOf('u6')));
check('себя убрать нельзя', !kickOf('u1'));

/* Кик: подтверждение спрашивает расширение, панель ждёт ответа и показывает результат. */
posted = [];
kickOf('u6').click();
await tick();
const kickRequest = posted.find(m => m.type === 'invoke' && m.command === 'auraTeam.removeMember');
check('кик уходит командой расширения', kickRequest?.args?.[0] === 'u6');
answer('auraTeam.removeMember', { ok: true });
await tick();
check('успешный кик подтверждён тостом', toasts().includes('Участник удалён из команды'));

posted = [];
kickOf('u5').click();
await tick();
answer('auraTeam.removeMember', { ok: false, cancelled: true });
await tick();
check('отмена в диалоге расширения не показывает ложный успех', toasts().length === 0);

/* Права: совладелец убирает только dev/viewer, зритель — никого. */
send({ type: 'state', state: makeState('maintainer'), inviteCode: 'AURA-7DAY-CODE' });
await tick(60);
check('совладелец убирает разработчика', Boolean(kickOf('u6')));
check('совладелец убирает зрителя', Boolean(kickOf('u7')));
check('совладелец не убирает совладельца', !kickOf('u5'));
check('совладелец не убирает владельца', !kickOf('u1'));

send({ type: 'state', state: makeState('viewer'), inviteCode: 'AURA-7DAY-CODE' });
await tick(60);
check('зритель не убирает никого', [...memberRows().values()].every(r => !r.querySelector('[data-kick-member]')));

/* ---------- отзыв кода ---------- */
send({ type: 'state', state: makeState('owner'), inviteCode: 'AURA-7DAY-CODE' });
await tick(40);
posted = [];
document.getElementById('inviteRevokeBtn')?.click();
await tick();
check('отзыв уходит на сервер через расширение', posted.some(m => m.type === 'invoke' && m.command === 'auraTeam.revokeInvite'));
answer('auraTeam.revokeInvite', { ok: true });
await tick();
check('после отзыва показано пустое состояние', Boolean(document.getElementById('inviteCreateBtn')));
check('отозванный код больше не показан', document.querySelector('#secInvite .code') === null);
check('отзыв подтверждён тостом', toasts().includes('Код отозван — старый больше не действует'));

/* Отмена подтверждения в расширении: код остаётся на месте, панель не врёт. */
send({ type: 'state', state: makeState('owner'), inviteCode: 'AURA-7DAY-CODE' });
await tick(40);
posted = [];
document.getElementById('inviteRevokeBtn')?.click();
await tick();
answer('auraTeam.revokeInvite', { ok: false, cancelled: true });
await tick();
check('отмена отзыва сохраняет код в панели', document.querySelector('#secInvite .code')?.textContent === 'AURA-7DAY-CODE');

/* ---------- роль при приглашении ---------- */
const roleOptions = () => [...document.querySelectorAll('#inviteRole option')].map(o => o.value);
const roleRow = () => document.getElementById('inviteRole');

posted = [];
send({ type: 'state', state: makeState('owner'), inviteCode: 'AURA-7DAY-CODE', inviteRole: 'dev' });
await tick(60);
check('владельцу доступны три роли', roleOptions().join(',') === 'maintainer,dev,viewer');
check('роли подписаны по-русски', [...document.querySelectorAll('#inviteRole option')].map(o => o.textContent).join(',') === 'Совладелец,Разработчик,Зритель');
check('по умолчанию выбран разработчик', roleRow()?.value === 'dev');

/* Выбор роли доезжает и до кода приглашения, и до персонального приглашения. */
roleRow().value = 'maintainer';
roleRow().dispatchEvent(new window.Event('change'));
await tick();
posted = [];
document.getElementById('inviteNewBtn')?.click();
await tick();
const codeRequest = posted.find(m => m.type === 'invoke' && m.command === 'auraTeam.createInvite');
check('новый код создаётся на выбранную роль', codeRequest?.args?.[0] === 'maintainer');
answer('auraTeam.createInvite', { code: 'AURA-MAINT-CODE', expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(), role: 'maintainer' });
await tick(40);
check('код подписан своей ролью', /роль: Совладелец/.test(document.querySelector('#secInvite .expires')?.textContent ?? ''));

posted = [];
document.querySelector('[data-invite-user="u4"]')?.click();
await tick();
const inviteRequest = posted.find(m => m.type === 'invoke' && m.command === 'auraTeam.sendInvite');
check('персональное приглашение уходит с выбранной ролью', inviteRequest?.args?.[1] === 'maintainer');
answer('auraTeam.sendInvite', { ok: true });
await tick();

/* Активный код на другую роль: панель говорит об этом, а не молчит. */
send({ type: 'state', state: makeState('owner'), inviteCode: 'AURA-7DAY-CODE', inviteRole: 'viewer' });
await tick(60);
check('видно, что активный код выдан на другую роль', document.querySelector('#secInvite .invite-hint')?.textContent === 'Активный код выдан на роль «Зритель»');

/* Совладелец не может звать совладельцем — в списке только dev/viewer. */
send({ type: 'state', state: makeState('maintainer'), inviteCode: 'AURA-7DAY-CODE', inviteRole: 'dev' });
await tick(60);
check('совладельцу доступны только разработчик и зритель', roleOptions().join(',') === 'dev,viewer');

/* Зритель приглашать не может — остаётся только роль, которую выдаст сервер. */
send({ type: 'state', state: makeState('viewer'), inviteCode: 'AURA-7DAY-CODE', inviteRole: 'dev' });
await tick(60);
check('зрителю доступна только роль разработчик', roleOptions().join(',') === 'dev');

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
