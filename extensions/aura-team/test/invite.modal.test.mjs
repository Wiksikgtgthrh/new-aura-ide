/*---------------------------------------------------------------------------------------------
 *  Модалка «Пригласить» в панели Aura Team: пересоздание кода одним кликом.
 *
 *  Тест закрывает изменённый путь wireInviteActions (template.html:1677-1694):
 *   • «Пересоздать» — это revoke → createInvite одной цепочкой, а не только отзыв;
 *   • отмена в диалоге расширения ({cancelled: true}) не трогает ни код, ни модалку;
 *   • disabled-гарды: даблклик по revoke/gen не шлёт второй запрос;
 *   • copy-кнопка кладёт код в буфер.
 *  Сайдбар-путь (inviteRevokeBtn) покрыт invite.sidebar.test.mjs — сюда не дублируем.
 *
 *  Читает шаблон напрямую из src/webview/template.html и выполняет в jsdom — сборка не нужна.
 *--------------------------------------------------------------------------------------------*/
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, '..', 'src', 'webview', 'template.html'), 'utf8');
const html = raw
	.split('__NONCE__').join('testnonce')
	.split('__INITIAL_VIEW__').join('board')
	.split('__INITIAL_FILTER__').join('null');

let posted = [];
const clipboardWrites = [];
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
		Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: (t) => { clipboardWrites.push(t); return Promise.resolve(); } }, configurable: true });
	}
});
const { window } = dom;
const { document } = window;

let failures = 0;
const check = (name, ok) => { console.log((ok ? '  ok   ' : '  FAIL ') + name); if (!ok) { failures++; } };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const context = dom.getInternalVMContext();
const scriptText = document.querySelector('script')?.textContent ?? '';
try { vm.runInContext(scriptText, context, { filename: 'template.js' }); } catch (error) { console.error('FAIL: eval:', error.message); process.exit(1); }
const probe = (expr) => vm.runInContext(expr, context);

const send = (data) => window.dispatchEvent(new window.MessageEvent('message', { data }));
const answer = (command, result, ok = true) => {
	const request = [...posted].reverse().find((m) => m.type === 'invoke' && m.command === command && !m.__answered);
	if (!request) { return undefined; }
	request.__answered = true;
	send({ type: 'response', id: request.id, ok, result, error: ok ? undefined : String(result) });
	return request;
};
const invokes = (command) => posted.filter((m) => m.type === 'invoke' && m.command === command);
const overlay = () => document.querySelector('#modalRoot .overlay');
const shownCode = () => overlay()?.querySelector('.invite-code')?.textContent ?? null;

send({ type: 'state', state: {
	signedIn: true, serverUrl: 'http://localhost', uiLanguage: 'ru', teamId: 'team1',
	profile: { id: 'me', nickname: 'Wiks', email: 'w@x.y', description: '', avatarColor: '#6366f1' },
	session: { user: { id: 'me', displayName: 'Wiks', email: 'w@x.y' }, teams: [{ id: 'team1', name: 'Aura Studio', role: 'owner' }] },
	board: { members: [], projects: [], tasks: [] }
} });
await tick(60);

/* Открыть меню с активным кодом. */
let openP = probe('openInviteMenu()');
await tick();
check('открытие меню запрашивает текущий код', invokes('auraTeam.currentInvite').length === 1);
answer('auraTeam.currentInvite', { code: 'AURA-OLD-1' });
await openP;
await tick();
answer('auraTeam.directory', []);
check('модалка показывает активный код', shownCode() === 'AURA-OLD-1');
check('кнопка «Пересоздать» на месте', !!overlay()?.querySelector('[data-revoke-invite]'));

/* ---------- 1. «Пересоздать» = revoke → create одним кликом ---------- */
posted = [];
const revokeBtn = overlay().querySelector('[data-revoke-invite]');
revokeBtn.click();
check('кнопка блокируется сразу (до ответа сервера)', revokeBtn.disabled === true);
revokeBtn.click(); // disabled — клик не диспатчится
await tick();
check('даблклик шлёт ровно один revoke', invokes('auraTeam.revokeInvite').length === 1);
check('create не уходит до ответа revoke', invokes('auraTeam.createInvite').length === 0);
answer('auraTeam.revokeInvite', { ok: true });
await tick();
check('после revoke уходит createInvite (цепочка одним кликом)', invokes('auraTeam.createInvite').length === 1);
answer('auraTeam.createInvite', { code: 'AURA-NEW-2' });
await tick();
check('новый код ушёл в буфер обмена', clipboardWrites.includes('AURA-NEW-2'));
check('тост «скопировано» показан', (document.getElementById('toastRoot')?.textContent ?? '').includes(probe("T('copied')")));
check('модалка перезапросила код после пересоздания', invokes('auraTeam.currentInvite').length === 1);
answer('auraTeam.currentInvite', { code: 'AURA-NEW-2' });
await tick();
check('переоткрытая модалка показывает новый код', shownCode() === 'AURA-NEW-2');
answer('auraTeam.directory', []);

/* ---------- 2. {cancelled}: код, модалка и кнопка не тронуты ---------- */
posted = [];
const overlayBefore = overlay();
const revokeBtn2 = overlayBefore.querySelector('[data-revoke-invite]');
revokeBtn2.click();
await tick();
answer('auraTeam.revokeInvite', { ok: false, cancelled: true });
await tick();
check('при {cancelled} createInvite не уходит', invokes('auraTeam.createInvite').length === 0);
check('при {cancelled} модалка не переоткрывается', overlay() === overlayBefore);
check('при {cancelled} старый код на месте', shownCode() === 'AURA-NEW-2');
check('кнопка разблокирована после отмены', revokeBtn2.disabled === false);

/* ---------- 3. Нет кода: кнопка генерации с тем же гардом ---------- */
overlay().querySelector('[data-close]').click();
await tick();
probe('inviteCache = { code: null }');
posted = [];
openP = probe('openInviteMenu()');
await tick();
answer('auraTeam.currentInvite', {}); // сервер: активного кода нет
await openP;
await tick();
answer('auraTeam.directory', []);
check('без кода показана кнопка генерации', !!overlay()?.querySelector('[data-gen-invite]'));
posted = [];
const genBtn = overlay().querySelector('[data-gen-invite]');
genBtn.click();
check('кнопка генерации блокируется в полёте', genBtn.disabled === true);
genBtn.click(); // disabled
await tick();
check('даблклик по генерации шлёт один createInvite', invokes('auraTeam.createInvite').length === 1);
answer('auraTeam.createInvite', { code: 'AURA-GEN-3' });
await tick();
check('сгенерированный код ушёл в буфер', clipboardWrites.includes('AURA-GEN-3'));
check('после генерации модалка перезапросила код', invokes('auraTeam.currentInvite').length === 1);
answer('auraTeam.currentInvite', { code: 'AURA-GEN-3' });
await tick();
check('модалка показывает свежий код', shownCode() === 'AURA-GEN-3');
answer('auraTeam.directory', []);

/* ---------- 4. copy-кнопка ---------- */
overlay().querySelector('[data-copy-invite]').click();
check('copy-кнопка кладёт код в буфер', clipboardWrites.at(-1) === 'AURA-GEN-3');

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
