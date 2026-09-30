/*---------------------------------------------------------------------------------------------
 *  Тесты доски «Канбан и задачи»: плюрализация, пустые колонки без рамок и подсказок,
 *  высота и раскладка, карточки (дедлайн, описание), drag & drop мышью и с клавиатуры,
 *  инлайн-создание, удаление с undo без confirm(), чистый CSS.
 *
 *  Тест читает шаблон напрямую (webview рендерит расширение из src/webview/template.html),
 *  подставляет плейсхолдеры и выполняет скрипт в jsdom — сборка не нужна.
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

const baseState = () => ({
	signedIn: true, demoMode: true, simpleMode: false, serverUrl: 'http://localhost', uiLanguage: 'ru', teamId: 'team1',
	profile: { id: 'me', nickname: 'Wiks', email: 'w@x.y', description: '', avatarColor: '#6366f1' },
	session: { user: { id: 'me', displayName: 'Wiks', email: 'w@x.y' }, teams: [{ id: 'team1', name: 'Aura Studio', role: 'owner' }] },
	board: {
		members: [
			{ id: 'me', displayName: 'Wiks', email: 'w@x.y', role: 'owner', online: true },
			{ id: 'u2', displayName: 'Alex', email: 'a@x.y', role: '', online: true }
		],
		projects: [],
		tasks: [
			{ id: 't1', teamId: 'team1', title: 'Починить импорт ключей', description: 'Починить импорт ключей', status: 'todo', assigneeId: 'me', assigneeName: 'Wiks', position: 0 },
			{ id: 't2', teamId: 'team1', title: 'Второй таск', description: '', status: 'todo', position: 1 },
			{ id: 't3', teamId: 'team1', title: 'Просроченный', description: '', status: 'doing', position: 0, dueAt: new Date(Date.now() - 864e5).toISOString() },
			{ id: 't4', teamId: 'team1', title: 'Готовый с описанием', description: 'Подробности', status: 'done', position: 0 },
			{ id: 't5', teamId: 'team1', title: 'Готовый второй', description: '', status: 'done', position: 1 }
		]
	}
});
const setState = async (mutate) => {
	const s = baseState();
	if (mutate) { mutate(s); }
	window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'state', state: s } }));
	await tick(40);
};

const context = dom.getInternalVMContext();
const scriptText = document.querySelector('script')?.textContent ?? '';
try { vm.runInContext(scriptText, context, { filename: 'template.js' }); } catch (error) { console.error('FAIL: eval:', error.message); process.exit(1); }
const probe = (expr) => vm.runInContext(expr, context);

await setState();

/* ---------- 1. Плюрализация и «висящая w» ---------- */
const plural = (n) => probe(`plural(${n}, ['задача','задачи','задач'])`);
check('plural: 1 → задача', plural(1) === 'задача');
check('plural: 2 → задачи', plural(2) === 'задачи');
check('plural: 5 → задач', plural(5) === 'задач');
check('plural: 11 → задач', plural(11) === 'задач');
check('plural: 21 → задача', plural(21) === 'задача');
check('plural: 101 → задача', plural(101) === 'задача');
check('plural: 22 → задачи', plural(22) === 'задачи');
check('shortText: пусто и один символ отбрасываются', probe("shortText('') === '' && shortText('w') === '' && shortText('Wiks') === 'Wiks'"));
check('Подзаголовок доски: «5 задач · 1 моя · 1 просрочено»',
	document.querySelector('.board-sub')?.textContent.replace(/\s+/g, ' ').trim() === 'Aura Studio · 5 задач · 1 моя · 1 просрочено');

await setState((s) => { s.session.teams[0].name = 'w'; });
check('Односимвольное имя команды не рендерится («висящая w»)',
	!document.querySelector('.board-sub')?.textContent.trim().startsWith('w'));
await setState();

/* ---------- 2. Пустые колонки: ни рамки, ни текста, подсказка только при перетаскивании ---------- */
const reviewBody = document.querySelector('.column[data-status="review"] .column-body');
check('Пустая колонка: нет узла .col-empty', document.querySelector('.col-empty') === null);
check('Пустая колонка: нет текста-подсказки в покое', !document.body.textContent.includes('Перетащите задачу сюда'));
check('Пустая колонка: подсказка не показана без перетаскивания', document.querySelectorAll('.column.drop-hint').length === 0);
check('Пустая колонка: есть тело колонки', !!reviewBody);

/* ---------- 3. Высота и раскладка (по CSS) ---------- */
const regionStart = raw.indexOf('/* ---------- Доска задач ---------- */');
const regionEnd = raw.indexOf('.keys-shell {');
const css = raw.slice(regionStart, regionEnd);
const rule = (sel) => { const m = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')); return m ? m[1] : ''; };
check('.board-root занимает всю высоту', /height:\s*100%/.test(rule('.board-root')));
check('.board — grid с горизонтальным скроллом', /grid-auto-flow:\s*column/.test(rule('.board')) && /overflow-x:\s*auto/.test(rule('.board')));
check('.column-body скроллится, а не страница', /overflow-y:\s*auto/.test(rule('.column-body')));
check('Колонки — auto minmax(260px, 1fr)', /minmax\(260px,\s*1fr\)/.test(rule('.board')));
// Хост доски — flex-элемент с ростом: блок схлопнул бы сетку по контенту и доска заняла бы треть экрана.
check('#boardHost растёт в колонке flex', /flex:\s*1 1 auto/.test(rule('#boardHost')) && /display:\s*flex/.test(rule('#boardHost')));
check('#boardHost перенимает ограничение высоты', /min-height:\s*0/.test(rule('#boardHost')));
// height 28px с базовым padding 8px обрезал текст нативного селекта («криво сверху»).
check('Контролы тулбара — без вертикального padding', /padding:\s*0 /.test(rule('.board-search, .board-assignee')));
check('Тулбар переносится на узкой ширине', /flex-wrap:\s*wrap/.test(rule('.board-toolbar')));

/* ---------- 4. Двойных рамок нет ---------- */
check('.column без border', !/(^|;|\s)border:/.test(rule('.column')) || !/border:\s*1px/.test(rule('.column')));
check('Дроп-зона — вся колонка: нет .col-empty и вложенного бокса', !css.includes('.col-empty') && !document.querySelector('.col-empty'));

/* ---------- 5. Карточка задачи ---------- */
const t1 = document.querySelector('.task[data-task="t1"]');
check('Карточка — article с aria-label', t1?.tagName === 'ARTICLE' && !!t1.getAttribute('aria-label'));
check('Описание, повторяющее заголовок, не рендерится', document.querySelector('.task[data-task="t1"] .task-desc') === null);
check('Реальное описание рендерится', !!document.querySelector('.task[data-task="t4"] .task-desc'));
check('Описание обрезается line-clamp', /-webkit-line-clamp:\s*2/.test(css));
check('Меню ⋮ скрыто до hover/focus', /\.task-menu \{[^}]*opacity:\s*0/.test(css));
check('Просроченная задача видна на карточке', !!document.querySelector('.task[data-task="t3"] .chip.due.overdue'));
check('Просрочка не только через фильтр: чип содержит текст', (document.querySelector('.task[data-task="t3"] .chip.due.overdue')?.textContent ?? '').trim().length > 0);
check('Карточка плоская: без box-shadow', !/box-shadow/.test(rule('.task')));
check('Hover карточки — только border-color', /\.task:hover \{[^}]*border-color/.test(css));

/* ---------- 6. Тулбар ---------- */
check('Тулбар — одна строка', !!document.querySelector('.board-toolbar'));
check('Поиск в тулбаре', !!document.querySelector('.board-toolbar [data-kanban-search]'));
check('Фильтр исполнителя — выпадашка с подписью', document.querySelector('.board-toolbar [data-kanban-assignee]')?.options?.[0]?.textContent.trim() === 'Исполнитель: все');
check('Тогл «Просроченные» с aria-pressed', document.querySelector('[data-kanban-overdue]')?.getAttribute('aria-pressed') === 'false');
check('Корзина — icon-кнопка в тулбаре', !!document.querySelector('.board-toolbar [data-trash-toggle]'));
check('Не осталось отдельной строки под корзину', document.querySelectorAll('.board-toolbar [data-trash-toggle]').length === 1);
check('Живой регион для объявлений есть', !!document.querySelector('[aria-live="polite"]'));
posted = [];
document.querySelector('[data-kanban-refresh]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('Кнопка обновления просит состояние (ready)', posted.some((m) => m.type === 'ready'));

/* ---------- 7. Клавиатурный drag & drop ---------- */
await setState();
const kbd = document.querySelector('.task[data-task="t2"]');
kbd.focus();
kbd.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
check('Space берёт карточку', kbd.classList.contains('grabbed'));
check('Взятие объявлено', (document.querySelector('#kanbanLive')?.textContent ?? '').includes('Задача взята'));
kbd.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
check('Стрелка переносит карточку в соседнюю колонку (до фиксации)', kbd.closest('.column')?.dataset.status === 'doing');
check('Перемещение объявлено', (document.querySelector('#kanbanLive')?.textContent ?? '').includes('Перемещено'));
kbd.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
await tick(30);
check('Space фиксирует перенос: задача в колонке «В работе»', !!document.querySelector('.column[data-status="doing"] .task[data-task="t2"]'));
check('С клавиатуры задачу можно перенести между колонками', !document.querySelector('.column[data-status="todo"] .task[data-task="t2"]'));

/* ---------- 8. Мышиный drag & drop: плейсхолдер и подсветка колонки ---------- */
await setState();
const dragging = document.querySelector('.task[data-task="t2"]');
dragging.dispatchEvent(new window.Event('dragstart', { bubbles: true }));
check('dragstart помечает карточку .dragging', dragging.classList.contains('dragging'));
const reviewBody2 = document.querySelector('.column[data-status="review"] .column-body');
reviewBody2.dispatchEvent(new window.Event('dragover', { bubbles: true }));
check('При перетаскивании раздвигается плейсхолдер', !!reviewBody2.querySelector('.task-placeholder'));
check('Подсказка/подсветка ровно в одной колонке', document.querySelectorAll('.column.drop-hint').length === 1 && document.querySelectorAll('.column.drag-over').length === 1);
reviewBody2.dispatchEvent(new window.Event('drop', { bubbles: true }));
await tick(30);
check('Бросок переносит задачу', !!document.querySelector('.column[data-status="review"] .task[data-task="t2"]'));
check('После дропа плейсхолдер убран', document.querySelectorAll('.task-placeholder').length === 0);
check('После дропа подсветка снята', document.querySelectorAll('.column.drag-over, .column.drop-hint').length === 0);

/* ---------- 9. Инлайн-создание: серия без модалки ---------- */
await setState();
const before = document.querySelectorAll('.task').length;
// Один клик мышью — дальше серия вводится только с клавиатуры (Enter).
document.querySelector('.column[data-status="todo"] [data-add-task]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
for (const title of ['Первая', 'Вторая', 'Третья']) {
	const ta = document.querySelector('.column[data-status="todo"] .task-form textarea');
	if (!ta) { break; }
	ta.value = title;
	ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	await tick(20);
}
await tick(30);
check('Создание инлайн: три задачи без единого клика мышью после первого', document.querySelectorAll('.task').length === before + 3);
check('Инлайн-форма автофокусится и остаётся открытой', !!document.querySelector('.column[data-status="todo"] .task-form textarea'));
check('Создание задачи не открывает модалку', document.querySelector('.overlay') === null);
check('Кнопка «+ Задача» — ghost, без рамки', /\.add-task-inline \{[^}]*border:\s*none/.test(css) || !/\.add-task-inline \{[^}]*border:/.test(css));
// Оптимистичное создание: в живой режиме ответ сервера приходит позже, а карточка должна появиться сразу.
await setState((s) => { s.demoMode = false; });
posted = [];
// Черновик быстрого ввода остаётся открытым (это его работа), для нового сценария его закрываем.
const leftover = document.querySelector('.task-form textarea');
if (leftover) {
	leftover.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	await tick(20);
}
const liveColumn = document.querySelector('.column[data-status="todo"]');
liveColumn.querySelector('[data-add-task]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const liveTa = liveColumn.querySelector('.task-form textarea');
liveTa.value = 'Живая задача';
liveTa.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await tick(20);
check('Карточка появляется до ответа сервера', !!document.querySelector('.task.pending'));
check('Временная карточка не перетаскивается', document.querySelector('.task.pending')?.getAttribute('draggable') === 'false');
check('Временная карточка не открывает панель деталей', document.querySelector('.task.pending')?.hasAttribute('data-open-task') === false);
check('Создание ушло на сервер', posted.some((m) => m.command === 'auraTeam.createTask'));
check('Поле ввода не пересоздаётся и держит фокус', document.activeElement === document.querySelector('.task-form textarea'));
// Ответ сервера: настоящая задача вытесняет временную карточку без дубля.
await setState((s) => {
	s.demoMode = false;
	s.board.tasks = [...s.board.tasks, { id: 'live1', teamId: 'team1', title: 'Живая задача', description: '', status: 'todo', position: 9 }];
});
check('Ответ сервера снимает временную карточку', document.querySelectorAll('.task.pending').length === 0);
check('Настоящая задача встала на её место', !!document.querySelector('.task[data-task="live1"]'));
check('Поля ввода не задвоились', document.querySelectorAll('.task-form textarea').length === 1);
check('Временная карточка не висит вечно', probe(`(function () { var b = { tasks: [{ id: 'pending-x', title: 'X', status: 'todo', pending: true, createdAt: new Date(Date.now() - 20000).toISOString() }] }; prunePending(b); return b.tasks.length; })()`) === 0);
check('Совпавшее имя снимает временную, а не настоящую', probe(`(function () { var b = { tasks: [{ id: 'real-y', title: 'Y', status: 'todo' }, { id: 'pending-y', title: 'Y', status: 'todo', pending: true, createdAt: new Date().toISOString() }] }; prunePending(b); return b.tasks.map(function (t) { return t.id; }).join(','); })()`) === 'real-y');

/* ---------- 10. Детали — боковая панель, не модалка ---------- */
const card = document.querySelector('.task[data-task="t1"]');
card.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('Клик по карточке открывает боковую панель справа', document.getElementById('taskDetail')?.tagName === 'ASIDE');
check('Это не модалка', document.querySelector('.overlay') === null);
document.querySelector('[data-detail-close]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('Панель закрывается', document.getElementById('taskDetail') === null);

/* ---------- 11. Удаление: undo без confirm(), запрос сразу (мягкое удаление в корзину) ---------- */
await setState();
posted = [];
const delCard = document.querySelector('.task[data-task="t2"]');
delCard.focus();
delCard.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
check('Нет confirm()-модалки при удалении', document.querySelector('.overlay') === null);
check('Undo-тост показан', !!document.querySelector('#toastRoot .toast .toast-undo'));
// Отложенный запрос не работал: пришедший до отправки broadcast состояния возвращал задачу на доску.
check('Запрос удаления уходит сразу', posted.some((m) => m.command === 'auraTeam.deleteTask'));
await tick(240);
check('Карточка уезжает из DOM', !document.querySelector('.task[data-task="t2"]'));
document.querySelector('#toastRoot .toast-undo')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await tick(30);
check('«Отменить» возвращает задачу', !!document.querySelector('.task[data-task="t2"]'));
check('«Отменить» восстанавливает задачу на сервере', posted.some((m) => m.command === 'auraTeam.restoreTask'));
check('Отмена не задваивает карточку', document.querySelectorAll('.task[data-task="t2"]').length === 1);
// Удаление после смены состояния: работаем с текущей доской, а не с захваченной ссылкой.
await setState();
posted = [];
const delCard2 = document.querySelector('.task[data-task="t3"]');
delCard2.focus();
delCard2.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
await tick(240);
await setState((s) => { s.board.tasks = s.board.tasks.filter((t) => t.id !== 't3'); });
check('Удалённая задача не возвращается при broadcast состояния', !document.querySelector('.task[data-task="t3"]'));
// Очистка выполненных удаляет сразу все и отменяется одним restoreTask на задачу.
posted = [];
const doneMenu = document.querySelector('.column[data-status="done"] [data-col-menu]');
doneMenu.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
[...document.querySelectorAll('.board-menu [data-menu-item="clear"]')].pop()?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await tick(20);
check('«Очистить выполненные» удаляет сразу', posted.filter((m) => m.command === 'auraTeam.deleteTask').length === 2);
check('Выполненные ушли с доски', document.querySelectorAll('.column[data-status="done"] .task').length === 0);
// Тост последнего удаления: предыдущий мог ещё не истечь.
[...document.querySelectorAll('#toastRoot .toast .toast-undo')].pop()?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await tick(30);
check('Отмена очистки возвращает обе задачи', document.querySelectorAll('.column[data-status="done"] .task').length === 2);

/* ---------- 12. Пустая доска — одно состояние на всю доску ---------- */
await setState((s) => { s.board.tasks = []; });
check('Пустая доска: одно пустое состояние', document.querySelectorAll('.board-empty').length === 1);
check('Пустая доска: колонок-пустышек нет', document.querySelectorAll('.column').length === 0);
check('Пустая доска: есть кнопка создания', !!document.querySelector('.board-empty [data-add-task]'));

/* ---------- 13. Подзадачи: прогресс на карточке и галочки в панели ---------- */
const descWithFive = 'Собрать шаги\n- [x] Первый\n- [ ] Второй\n- [ ] Третий\n- [ ] Четвёртый\n- [ ] Пятый';
await setState((s) => {
	s.board.tasks = [{ id: 's1', teamId: 'team1', title: 'Задача с подзадачами', description: descWithFive, status: 'todo', position: 0 }];
});
const taskDesc = (id) => probe(`(state.board.tasks.find(function (t) { return t.id === ${JSON.stringify(id)}; }) || {}).description || ''`);
check('Карточка показывает прогресс «1/5»', document.querySelector('.task[data-task="s1"] .chip.progress')?.textContent.trim() === '1/5');
check('На карточке не больше трёх подзадач', document.querySelectorAll('.task[data-task="s1"] .subtask').length === 3);
check('Лишние подзадачи свёрнуты в «+2»', document.querySelector('.task[data-task="s1"] .subtask-more')?.textContent.trim() === '+2');
check('Отмеченная подзадача видна как done', document.querySelector('.task[data-task="s1"] .subtask.done input')?.checked === true);
check('Чекбоксы подзадач не попадают в текст описания карточки', document.querySelector('.task[data-task="s1"] .task-desc')?.textContent.trim() === 'Собрать шаги');
// Галочка прямо на карточке
const card2nd = [...document.querySelectorAll('.task[data-task="s1"] .subtask input')][1];
card2nd.checked = true;
card2nd.dispatchEvent(new window.Event('change', { bubbles: true }));
await tick(20);
check('Отметка на карточке поднимает прогресс до «2/5»', document.querySelector('.task[data-task="s1"] .chip.progress')?.textContent.trim() === '2/5');
check('Отметка сохраняется в описании как markdown-чекбокс', taskDesc('s1').includes('- [x] Второй'));
// Панель деталей
await setState((s) => {
	s.board.tasks = [{ id: 's1', teamId: 'team1', title: 'Задача с подзадачами', description: descWithFive, status: 'todo', position: 0 }];
});
document.querySelector('.task[data-task="s1"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('В панели есть блок подзадач', !!document.getElementById('subtaskBlock'));
check('В панели все пять подзадач', document.querySelectorAll('#subtaskBlock .subtask-row').length === 5);
check('Панель показывает прогресс подзадач', (document.querySelector('#subtaskBlock label')?.textContent ?? '').includes('1/5'));
check('Поле описания в панели содержит только прозу', document.querySelector('[data-detail-desc]')?.value === 'Собрать шаги');
const panel3rd = document.querySelector('#subtaskBlock [data-sub-toggle="2"]');
panel3rd.checked = true;
panel3rd.dispatchEvent(new window.Event('change', { bubbles: true }));
await tick(20);
check('Отметка в панели меняет прогресс на карточке', document.querySelector('.task[data-task="s1"] .chip.progress')?.textContent.trim() === '2/5');
check('Панель и карточка не расходятся', taskDesc('s1').includes('- [x] Третий'));
// Добавление подзадачи из панели
const addInput = document.querySelector('#subtaskBlock [data-sub-add]');
addInput.value = 'Шестой';
addInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await tick(20);
check('Подзадача добавляется из панели', taskDesc('s1').includes('- [ ] Шестой'));
check('Прогресс учитывает новую подзадачу «2/6»', document.querySelector('.task[data-task="s1"] .chip.progress')?.textContent.trim() === '2/6');
check('После добавления фокус остаётся в поле', document.activeElement === document.querySelector('#subtaskBlock [data-sub-add]'));
// Удаление подзадачи
document.querySelector('#subtaskBlock [data-sub-remove="0"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await tick(20);
check('Подзадача удаляется', !taskDesc('s1').includes('Первый'));
check('Прогресс пересчитан «1/5»', document.querySelector('.task[data-task="s1"] .chip.progress')?.textContent.trim() === '1/5');
// Парсер/сборщик — единица логики без DOM
const parsed = probe(`(function () { var r = parseSubtasks(${JSON.stringify(descWithFive)}); return r.prose + '|' + r.items.length + '|' + r.items.filter(function (i) { return i.done; }).length; })()`);
check('parseSubtasks отделяет прозу, считает всего и выполненные', parsed === 'Собрать шаги|5|1');
const roundTrip = probe(`composeDescription('Проза', [{ done: true, text: 'a' }, { done: false, text: 'b' }])`);
check('composeDescription собирает markdown-чекбоксы', roundTrip === 'Проза\n- [x] a\n- [ ] b');
// Доска пишет подзадачи — расширение их же читает для сайдбара: формат должен совпадать.
const extOut = readFileSync(join(here, '..', 'out', 'extension.js'), 'utf8');
const extReSrc = extOut.match(/const m = (\/\^[^\n]*?\/)\.exec\(line\)/);
const extRe = extReSrc ? eval(extReSrc[1]) : null;
const written = probe(`composeDescription('Проза', [{ done: true, text: 'Готово' }, { done: false, text: 'Ещё' }])`);
check('Расширение читает тот же формат подзадач, что пишет доска', !!extRe && written.split('\n').filter((line) => extRe.test(line)).length === 2);
// Описание только из чекбоксов — без пустого блока описания
await setState((s) => {
	s.board.tasks = [{ id: 's2', teamId: 'team1', title: 'Только шаги', description: '- [ ] Один\n- [ ] Два', status: 'todo', position: 0 }];
});
check('Описание из одних чекбоксов не оставляет пустой абзац', document.querySelector('.task[data-task="s2"] .task-desc') === null);
check('Карточка с двумя подзадачами без свёртки', document.querySelectorAll('.task[data-task="s2"] .subtask').length === 2 && document.querySelector('.task[data-task="s2"] .subtask-more') === null);
check('Прогресс «0/2»', document.querySelector('.task[data-task="s2"] .chip.progress')?.textContent.trim() === '0/2');
check('CSS: карточка не получила тень и с подзадачами', !/box-shadow/.test(rule('.task')));

/* ---------- 13b. Движение: FLIP по id, плейсхолдер, дата ---------- */
// Главный дефект «нет плавности»: FLIP вызывался на сетке колонок, а не на теле
// колонки, где едут карточки; после перерисовки анимации не было вообще.
check('FLIP: снимок геометрии по id задачи', /function captureTaskRects\(\)/.test(scriptText) && /el\.dataset\.task/.test(scriptText));
check('FLIP: переезд карточек после перерисовки', /function playTaskMoves\(before/.test(scriptText));
check('FLIP: render() снимает и проигрывает переезд', /const beforeRects = captureTaskRects\(\);/.test(scriptText) && /playTaskMoves\(beforeRects\)/.test(scriptText));
check('Счётчики колонок прокручиваются', /function playCountRolls\(before\)/.test(scriptText) && /playCountRolls\(beforeCounts\)/.test(scriptText));
check('Плейсхолдер раздвигает соседей через FLIP', /function prefersReducedMotion\(\)/.test(scriptText) && /flip\(document\.querySelector\('\.board'\), insert, 120\)/.test(scriptText));
check('Плейсхолдер растёт из нуля', /ph\.animate\(\[\{ height: '0px'/.test(scriptText));
check('Анимации уважают prefers-reduced-motion', /if \(prefersReducedMotion\(\)\) \{ mutate\(\); return; \}/.test(scriptText));

// Дата: системный индикатор календаря в тёмной теме почти чёрный.
const dateCss = css.match(/\.date-field[^}]*}/g) ?? [];
check('CSS: поле даты со своим индикатором', dateCss.length >= 2);
check('CSS: нативный индикатор календаря скрыт', /\.date-field input::-webkit-calendar-picker-indicator \{ opacity: 0/.test(css));
check('CSS: иконка календаря акцентная, а не чёрная', /\.date-field \.date-pick \{[^}]*color: var\(--vscode-focusBorder\)/.test(css));
check('Иконка календаря есть в наборе', /calendar: '<svg/.test(scriptText));
check('Поле даты в панели деталей — с иконкой', /data-detail-due type="datetime-local"[^>]*><span class="date-pick"/.test(scriptText));
check('Быстрые пресеты дедлайна в панели', /data-detail-due-quick="today"/.test(scriptText) && /data-detail-due-quick="clear"/.test(scriptText));
check('Пресеты дат — единый хелпер', /function duePresetValue\(kind\) \{/.test(scriptText) && (scriptText.match(/duePresetValue\(/g) ?? []).length >= 3);

/* ---------- 14. Чистота CSS ---------- */
check('CSS: нет хардкод-цветов (#)', !/#[0-9a-fA-F]{3,8}\b/.test(css));
check('CSS: нет rgb(', !/rgb\(/.test(css));
check('CSS: нет градиентов', !/gradient/.test(css));
check('CSS: нет uppercase', !/uppercase/.test(css));
check('CSS: нет !important', !/!important/.test(css));
check('CSS: нет translateY(-1px)', !/translateY\(-1px\)/.test(css));
check('CSS: нет бесконечных анимаций', !/infinite/.test(css));
const shadowRules = css.split('}').filter((r) => /box-shadow/.test(r));
check('CSS: box-shadow только у drag-превью/меню', shadowRules.length > 0 && shadowRules.every((r) => /\.(drag-ghost|board-menu|qa-pop)\b/.test(r)));
check('CSS: карточки и колонки без тени', !/box-shadow/.test(rule('.task')) && !/box-shadow/.test(rule('.column')));
check('reduced-motion отключает переходы', /prefers-reduced-motion: reduce/.test(css));

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
