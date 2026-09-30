/*---------------------------------------------------------------------------------------------
 *  Тесты админки: код доступа, выдача закрытых возможностей аккаунту и команде.
 *  Раздел в рейле виден только админу, но проверка живёт на сервере — здесь
 *  проверяем ровно интерфейс: что не показываем лишнего и что кнопки шлют верные команды.
 *--------------------------------------------------------------------------------------------*/
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, '..', 'src', 'webview', 'template.html'), 'utf8');
const html = raw
	.split('__NONCE__').join('testnonce')
	.split('__INITIAL_VIEW__').join('profile')
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

const adminPayload = () => ({
	admin: true,
	features: [{ id: 'aggg52', title: 'AGGG 5.2 — внешний агент', description: 'ядро с сервера', defaultMinRole: 'dev' }],
	roles: ['owner', 'maintainer', 'dev', 'viewer'],
	admins: [{ userId: 'me', email: 'w@x.y', displayName: 'Wiks', grantedAt: 'now' }],
	account: [{ userId: 'u2', email: 'dev@x.y', feature: 'aggg52', note: '', grantedAt: 'now' }],
	team: [{ teamId: 'team1', teamName: 'Aura Studio', feature: 'aggg52', minRole: 'maintainer', note: '', grantedAt: 'now' }],
	users: [
		{ id: 'me', email: 'w@x.y', displayName: 'Wiks', features: [] },
		{ id: 'u2', email: 'dev@x.y', displayName: 'Dev', features: ['aggg52'] }
	],
	teams: [{ id: 'team1', name: 'Aura Studio', members: 3, grants: [{ feature: 'aggg52', minRole: 'maintainer' }] }]
});

const baseState = (mutate) => {
	const state = {
		signedIn: true, demoMode: false, simpleMode: false, serverUrl: 'http://localhost', uiLanguage: 'ru', teamId: 'team1',
		profile: { id: 'me', nickname: 'Wiks', email: 'w@x.y' },
		session: { user: { id: 'me', displayName: 'Wiks', email: 'w@x.y' }, teams: [{ id: 'team1', name: 'Aura Studio', role: 'owner' }], entitlements: [], admin: false },
		board: { members: [], projects: [], tasks: [] },
		keys: []
	};
	if (mutate) { mutate(state); }
	return state;
};

const setState = async (mutate) => {
	posted = [];
	window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'state', state: baseState(mutate) } }));
	await tick(40);
};

const answer = (command, result, ok = true) => {
	const request = [...posted].reverse().find((m) => m.type === 'invoke' && m.command === command && m.id !== undefined && !m.__answered);
	if (!request) { return undefined; }
	request.__answered = true;
	window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'response', id: request.id, ok, result, error: ok ? undefined : String(result) } }));
	return request;
};

const scriptText = document.querySelector('script')?.textContent ?? '';
try { window.eval(scriptText); } catch (error) { console.error('FAIL: eval:', error.message); process.exit(1); }
await setState();

/* ---------- 1. Обычный аккаунт ---------- */
check('без админки раздел скрыт в рейле', document.getElementById('navAdmin')?.classList.contains('hidden') === true);
check('обычный аккаунт видит поле кода доступа в профиле', Boolean(document.getElementById('adminCode')));
check('панель выдачи не нарисована', !document.getElementById('adminFeature'));

/* ---------- 1b. Код доступа в профиле: свёрнут, объяснён и не дублирует заголовок ---------- */
check('код свёрнут в раскрывающийся блок', Boolean(document.querySelector('details.code-fold:not([open])')));
check('свёртка подписана вопросом, а не вторым заголовком',
	(document.querySelector('details.code-fold > summary')?.textContent ?? '').includes('Есть код администратора?'));
check('рядом сказано, зачем код в профиле',
	(document.querySelector('details.code-fold')?.textContent ?? '').includes('только админам'));
const codeTitles = [...document.querySelectorAll('label, .section-title')]
	.filter(node => node.textContent.trim() === 'Код администратора');
check('заголовок кода не дублируется дважды подряд', codeTitles.length === 1);
check('карточки в виде не слипаются — соседним задан зазор',
	/#viewBody > \.card \+ \.card[^{]*\{[^}]*margin-top/.test(raw));

/* ---------- 2. Раздел админки недоступен без прав ---------- */
window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'navigate', view: 'admin' } }));
await tick(40);
check('переход в админку без прав остаётся в профиле', Boolean(document.getElementById('adminCode')) && !document.getElementById('adminFeature'));

/* ---------- 3. Погашение кода ---------- */
document.getElementById('adminCode').value = 'AUR-L2SY6CAL';
document.getElementById('btnAdminRedeem').click();
await tick(20);
const redeemCall = posted.find((m) => m.type === 'invoke' && m.command === 'auraTeam.adminRedeem');
check('код уходит на сервер', redeemCall?.args?.[0] === 'AUR-L2SY6CAL');

answer('auraTeam.adminRedeem', { admin: true, features: ['aggg52'] });
await tick(20);
check('после погашения сессия перезапрашивается', posted.some((m) => m.type === 'invoke' && m.command === 'auraTeam.getState'));
answer('auraTeam.getState', baseState((s) => { s.session.admin = true; s.session.entitlements = [{ feature: 'aggg52', grantedAt: 'now', note: '', source: 'account' }]; }));
await tick(20);
answer('auraTeam.adminState', adminPayload());
await tick(40);

/* ---------- 4. Панель админа ---------- */
check('раздел появился в рейле', document.getElementById('navAdmin')?.classList.contains('hidden') === false);
check('заголовок админки отрисован', document.body.textContent.includes('Админка'));
check('каталог возможностей пришёл с сервера', document.getElementById('adminFeature')?.value === 'aggg52');
check('тип цели переключается между аккаунтом и командой', document.querySelectorAll('#adminKind option').length === 2);
check('есть поле поиска цели', Boolean(document.getElementById('adminSearch')));
check('первый срез каталога показан без поиска', document.querySelectorAll('#adminResults [data-pick]').length === 2);
check('у цели с уже выданным правом есть пометка', (document.querySelector('#adminResults [data-pick="account:u2"]')?.closest('.check-row')?.textContent ?? '').includes('уже выдано'));
check('у цели без права пометки нет', !(document.querySelector('#adminResults [data-pick="account:me"]')?.closest('.check-row')?.textContent ?? '').includes('уже выдано'));
check('порог роли выбирается', document.querySelectorAll('#adminMinRole option').length === 4);
check('права аккаунтов перечислены', document.body.textContent.includes('dev@x.y'));
check('права команд перечислены с порогом роли', document.querySelectorAll('[data-revoke-team]').length === 1);
check('администраторы перечислены', document.body.textContent.includes('w@x.y'));
check('кнопки отзыва есть на каждой выдаче', document.querySelectorAll('[data-revoke-account],[data-revoke-team]').length === 2);

/* ---------- 5. Команда ищется по названию, право идёт с порогом роли ---------- */
const search = document.getElementById('adminSearch');
search.value = 'Licen';
search.dispatchEvent(new window.Event('input'));
await tick(20);
check('поиск не уходит на сервер до окончания набора', !posted.some((m) => m.type === 'invoke' && m.command === 'auraTeam.adminDirectory'));
await tick(300);
const searchCall = posted.find((m) => m.type === 'invoke' && m.command === 'auraTeam.adminDirectory');
check('поиск уходит с запросом', searchCall?.args?.[0]?.q === 'Licen');
answer('auraTeam.adminDirectory', { users: [], teams: [] });
await tick(30);
check('запрос в режиме аккаунтов не показывает команды', document.querySelectorAll('#adminResults [data-pick]').length === 0);

posted = [];
document.getElementById('adminKind').value = 'team';
document.getElementById('adminKind').dispatchEvent(new window.Event('change'));
await tick(30);
const refreshed = posted.find((m) => m.type === 'invoke' && m.command === 'auraTeam.adminDirectory');
check('смена типа цели переспрашивает каталог по тому же запросу', refreshed?.args?.[0]?.q === 'Licen');
answer('auraTeam.adminDirectory', { users: [], teams: [{ id: 'team9', name: 'Licensed Team', members: 4, grants: [] }] });
await tick(30);
const teamRow = document.querySelector('#adminResults [data-pick]');
check('поиск по названию находит команду', teamRow?.dataset.pick === 'team:team9');
check('в строке найденной команды видно имя и состав', (teamRow?.closest('.check-row')?.textContent ?? '').includes('Licensed Team'));

teamRow.click();
await tick(10);
check('выбранная команда попала в список выбранных', document.querySelectorAll('#adminChosen [data-unpick]').length === 1);
document.getElementById('adminMinRole').value = 'maintainer';
posted = [];
document.getElementById('btnAdminGrant').click();
await tick(30);
const grantCall = posted.find((m) => m.type === 'invoke' && m.command === 'auraTeam.adminGrant');
check('выдача команде несёт право, цель и порог', JSON.stringify(grantCall?.args?.[0]) === JSON.stringify({ feature: 'aggg52', kind: 'team', targetId: 'team9', minRole: 'maintainer' }));
answer('auraTeam.adminGrant', adminPayload());
await tick(40);

/* ---------- 6. Несколько участников сразу и отзыв ---------- */
check('после выдачи список выбранных очищен', document.querySelectorAll('#adminChosen [data-unpick]').length === 0);
search.value = '';
search.dispatchEvent(new window.Event('input'));
await tick(300);
document.getElementById('adminKind').value = 'account';
document.getElementById('adminKind').dispatchEvent(new window.Event('change'));
await tick(30);
posted = [];
const boxes = [...document.querySelectorAll('#adminResults [data-pick]')];
check('аккаунты доступны для выбора', boxes.length === 2);
boxes[0].click();
boxes[1].click();
await tick(10);
check('выбранные участники показаны кнопками-чипами', document.querySelectorAll('#adminChosen [data-unpick]').length === 2);
document.getElementById('btnAdminGrant').click();
await tick(30);
// Выдачи идут по очереди: отвечаем на каждую, пока они появляются.
for (let guard = 0; guard < 5; guard++) {
	const next = [...posted].reverse().find((m) => m.type === 'invoke' && m.command === 'auraTeam.adminGrant' && !m.__answered);
	if (!next) { break; }
	answer('auraTeam.adminGrant', adminPayload());
	await tick(20);
}
const grants = posted.filter((m) => m.type === 'invoke' && m.command === 'auraTeam.adminGrant');
check('право выдаётся каждому выбранному', grants.length === 2);
check('аккаунту право выдаётся без порога роли', grants.every((m) => m.args[0].kind === 'account' && m.args[0].minRole === undefined));
check('цели различаются', new Set(grants.map((m) => m.args[0].targetId)).size === 2);
await tick(40);

/* ---------- 6b. Пустой выбор не отправляет запрос ---------- */
posted = [];
document.getElementById('btnAdminGrant').click();
await tick(20);
check('без выбранных целей запрос не уходит', !posted.some((m) => m.type === 'invoke' && m.command === 'auraTeam.adminGrant'));
check('и это сказано тостом', [...document.querySelectorAll('.toast')].length > 0);

posted = [];
document.querySelector('[data-revoke-account]').click();
await tick(20);
const revokeCall = posted.find((m) => m.type === 'invoke' && m.command === 'auraTeam.adminGrant');
check('отзыв идёт той же командой с признаком revoke', revokeCall?.args?.[0]?.revoke === true && revokeCall?.args?.[0]?.targetId === 'u2');
answer('auraTeam.adminGrant', adminPayload());
await tick(40);

/* ---------- 7. Назначение админов ---------- */
posted = [];
document.getElementById('adminNewEmail').value = 'dev@x.y';
document.getElementById('btnAdminAdd').click();
await tick(20);
const addAdmin = posted.find((m) => m.type === 'invoke' && m.command === 'auraTeam.adminSetAdmin');
check('админка выдаётся по email', addAdmin?.args?.[0]?.email === 'dev@x.y');
answer('auraTeam.adminSetAdmin', adminPayload());
await tick(40);
check('ошибка сервера не ломает панель', Boolean(document.getElementById('adminFeature')));

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
if (failures) { process.exit(1); }
