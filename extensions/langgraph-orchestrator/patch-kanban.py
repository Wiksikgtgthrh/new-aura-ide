import io

p = 'C:/new-aura-ide/vscode-main/extensions/langgraph-orchestrator/src/panel/template.html'
s = io.open(p, encoding='utf8').read()

def once(old, new):
    global s
    assert s.count(old) == 1, 'pattern issue: ' + old[:90]
    s = s.replace(old, new)

# ---- fillSelect: rebuild on value change too ----
once("""		let options = selectOptions.get(select);
		if (!options || options.length !== entries.length) {""",
"""		let options = selectOptions.get(select);
		if (!options || options.length !== entries.length || entries.some((entry, index) => options[index].value !== entry.value)) {""")

helpers = r"""
	/** Общий drag&drop канбанов: ghost-призрак, placeholder-позиция, клавиатура, aria-анонсы. */
	let kbDrag = null;
	let kbGrab = null;

	function announce(text) {
		const live = document.getElementById('kanbanLive');
		if (live) { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 30); }
	}

	function startCardDrag(event, board, id, card) {
		kbDrag = { board, id };
		if (event.dataTransfer) {
			event.dataTransfer.setData('text/plain', board + ':' + id);
			event.dataTransfer.effectAllowed = 'move';
		}
		const ghost = card.cloneNode(true);
		ghost.classList.add('drag-ghost');
		ghost.classList.remove('dragging');
		ghost.style.width = card.offsetWidth + 'px';
		document.body.appendChild(ghost);
		if (event.dataTransfer && event.dataTransfer.setDragImage) { event.dataTransfer.setDragImage(ghost, 20, 16); }
		setTimeout(() => ghost.remove(), 0);
		requestAnimationFrame(() => card.classList.add('dragging'));
	}

	function cleanupDrag() {
		kbDrag = null;
		document.querySelectorAll('.card.dragging').forEach(card => card.classList.remove('dragging'));
		document.querySelectorAll('.task-placeholder').forEach(node => node.remove());
		document.querySelectorAll('.column.drag-over').forEach(col => col.classList.remove('drag-over'));
	}

	function insertAfterPoint(body, y, excludeId) {
		const cards = [...body.querySelectorAll('.card')].filter(card => card.dataset.task !== excludeId);
		for (const card of cards) {
			const rect = card.getBoundingClientRect();
			if (y < rect.top + rect.height / 2) { return card; }
		}
		return null;
	}

	function columnDragOver(event, col, board) {
		if (!kbDrag || kbDrag.board !== board) { return; }
		event.preventDefault();
		if (event.dataTransfer) { event.dataTransfer.dropEffect = 'move'; }
		col.classList.add('drag-over');
		const body = col.querySelector('.col-body');
		if (!body) { return; }
		let placeholder = body.querySelector('.task-placeholder');
		if (!placeholder) { placeholder = el('div', { class: 'task-placeholder' }); }
		const before = insertAfterPoint(body, event.clientY, kbDrag.id);
		if (before) { body.insertBefore(placeholder, before); } else { body.appendChild(placeholder); }
	}

	/** Дроп: целевой порядок карточек считается по позиции placeholder-а. */
	function columnDrop(event, board) {
		event.preventDefault();
		const raw = event.dataTransfer ? event.dataTransfer.getData('text/plain') : '';
		const sep = raw.indexOf(':');
		const dragBoard = sep < 0 ? '' : raw.slice(0, sep);
		const id = sep < 0 ? '' : raw.slice(sep + 1);
		const body = event.currentTarget.querySelector('.col-body');
		let orderedIds = [];
		if (body) {
			const kids = [...body.children];
			orderedIds = kids.filter(node => node.classList.contains('card')).map(node => node.dataset.task).filter(taskId => taskId !== id);
			const at = kids.findIndex(node => node.classList.contains('task-placeholder'));
			if (at >= 0) {
				const before = kids.slice(at + 1).find(node => node.classList.contains('card') && node.dataset.task !== id);
				const index = before ? orderedIds.indexOf(before.dataset.task) : orderedIds.length;
				orderedIds.splice(index < 0 ? orderedIds.length : index, 0, id);
			}
		}
		cleanupDrag();
		if (dragBoard !== board || !id) { return null; }
		return { id, orderedIds };
	}

	/** FLIP: карточки перелетают на новые места после перерисовки, а не прыгают. */
	function captureCardRects(host) {
		const rects = new Map();
		host.querySelectorAll('[data-task]').forEach(card => rects.set(card.dataset.task, card.getBoundingClientRect()));
		return rects;
	}

	function playCardMoves(host, rects) {
		host.querySelectorAll('[data-task]').forEach(card => {
			const old = rects.get(card.dataset.task);
			if (!old) { return; }
			const now = card.getBoundingClientRect();
			const dx = old.left - now.left;
			const dy = old.top - now.top;
			if (!dx && !dy) { return; }
			card.style.transition = 'none';
			card.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';
			requestAnimationFrame(() => {
				card.style.transition = 'transform .18s ease';
				card.style.transform = '';
			});
		});
	}

	/** Клавиатурный перенос: Пробел/Enter берёт и кладёт карточку, стрелки двигают, Esc отменяет. */
	function cardKeyboard(event, board, id, moveBy) {
		const t = T();
		const card = event.currentTarget;
		if (event.key === 'Escape' && kbGrab) {
			kbGrab = null;
			document.querySelectorAll('.card.kb-grabbed').forEach(node => node.classList.remove('kb-grabbed'));
			announce(t.kbDragCancel);
			event.preventDefault();
			return;
		}
		if (event.key === ' ' || event.key === 'Enter') {
			event.preventDefault();
			if (kbGrab && kbGrab.id === id) {
				kbGrab = null;
				card.classList.remove('kb-grabbed');
				announce(t.kbPlaced);
			} else {
				kbGrab = { board, id };
				card.classList.add('kb-grabbed');
				announce(t.kbPickedUp);
			}
			return;
		}
		if (kbGrab && kbGrab.id === id && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
			event.preventDefault();
			kbGrab = null;
			card.classList.remove('kb-grabbed');
			moveBy(event.key === 'ArrowLeft' ? -1 : 1);
			announce(t.kbPlaced);
		}
	}

	/** Колонки очереди харнесса: статусы orchestrator.mjs сведены к четырём понятным состояниям. */
	const HARNESS_COLUMNS = [
		{ key: 'queue', label: 'kbQueue', status: 'pending', match: st => st === 'pending' || st === 'awaiting_approval' },
		{ key: 'running', label: 'kbRunning', status: 'running', match: st => st === 'running' },
		{ key: 'done', label: 'kbDone', status: 'done', match: st => st === 'done' },
		{ key: 'failed', label: 'kbFailed', status: 'failed', match: st => st === 'failed' || st === 'cancelled' },
	];

	function riskLabel(t, risk) {
		return { read: t.riskRead, write: t.riskWrite, sensitive: t.riskSensitive, destructive: t.riskDestructive }[risk] || risk;
	}

	/** Очередь харнесса: перетаскивание карточки мапится на команду orchestrator.mjs. */
	function renderHarnessBoard(t, host, harness, query) {
		if (!harness.available) {
			host.append(el('div', { class: 'kb-empty', text: t.harnessUnavailable }));
			return;
		}
		if (!harness.workspace) {
			host.append(el('div', { class: 'kb-empty', text: t.harnessNoWorkspace }));
			return;
		}
		const tasks = (harness.tasks || []).filter(task => matchesQuery(query, task.id, task.title, task.role, task.owner));
		if ((harness.tasks || []).length === 0) {
			host.append(el('div', { class: 'kb-empty', text: t.harnessEmpty }));
			return;
		}
		const board = el('div', { class: 'board' });
		HARNESS_COLUMNS.forEach((column, index) => {
			const items = tasks.filter(task => column.match(task.status));
			const cards = items.map(task => harnessCard(t, task, index));
			const add = el('button', { class: 'col-add', type: 'button', html: KB_ICONS.plus + '<span>' + t.kbAddHere + '</span>', onclick: () => {
				const input = document.getElementById('newTaskTitle');
				if (input && input.focus) { input.focus(); }
			} });
			const col = kbColumn('harness:' + column.key, column.key, t[column.label], items.length, cards, add);
			col.addEventListener('dragover', event => columnDragOver(event, col, 'harness'));
			col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
			col.addEventListener('drop', event => {
				const drop = columnDrop(event, 'harness');
				if (drop) { moveHarnessTask(drop.id, column.key); }
			});
			board.append(col);
		});
		host.append(board);
		if (query && tasks.length === 0) { host.append(el('div', { class: 'kb-empty', text: t.kbNothingFound })); }
	}

	function harnessCard(t, task, columnIndex) {
		const card = el('div', { class: 'card', draggable: 'true', dataset: { task: task.id } });
		card.setAttribute('draggable', 'true');
		card.tabIndex = 0;
		card.title = t.kbPickUpHint;
		card.addEventListener('dragstart', event => startCardDrag(event, 'harness', task.id, card));
		card.addEventListener('dragend', () => cleanupDrag());
		card.addEventListener('keydown', event => cardKeyboard(event, 'harness', task.id, delta => {
			const target = HARNESS_COLUMNS[columnIndex + delta];
			if (target) { moveHarnessTask(task.id, target.key); }
		}));
		const top = el('div', { class: 'card-top' });
		const title = el('div', { class: 'card-title' });
		title.append(el('b', { text: task.title }), el('div', { class: 'muted', style: 'font-family:var(--mono);font-size:10.5px', text: task.id }));
		top.append(title);
		card.append(top);
		if (task.lastError) { card.append(el('div', { class: 'card-desc err-text', text: String(task.lastError.message || '').slice(0, 220) })); }
		const meta = el('div', { class: 'card-meta' });
		meta.append(el('span', { class: 'chip risk risk-' + task.risk, text: riskLabel(t, task.risk) }));
		meta.append(el('span', { class: 'chip', text: task.role }));
		if (task.attempts > 0 || task.maxAttempts > 1) { meta.append(el('span', { class: 'chip', text: task.attempts + '/' + task.maxAttempts + ' ' + plural(task.attempts, t.attemptForms) })); }
		if (task.owner) { meta.append(el('span', { class: 'chip', text: task.owner })); }
		if (task.status === 'awaiting_approval') { meta.append(el('span', { class: 'chip', text: t.kbAwaiting })); }
		if (task.status === 'done') { meta.append(el('span', { class: 'chip' + (task.verified ? ' verified' : ''), text: task.verified ? t.kbVerified : t.kbUnverified })); }
		card.append(meta);
		const acts = el('div', { class: 'card-acts' });
		acts.append(el('span', { class: 'grow' }));
		const prev = HARNESS_COLUMNS[columnIndex - 1];
		const next = HARNESS_COLUMNS[columnIndex + 1];
		acts.append(
			el('button', { class: 'mini', type: 'button', title: t.kbMoveLeft, 'aria-label': t.kbMoveLeft, html: KB_ICONS.left, disabled: !prev, onclick: () => prev && moveHarnessTask(task.id, prev.key) }),
			el('button', { class: 'mini', type: 'button', title: t.kbMoveRight, 'aria-label': t.kbMoveRight, html: KB_ICONS.right, disabled: !next, onclick: () => next && moveHarnessTask(task.id, next.key) }),
		);
		card.append(acts);
		return card;
	}

	/** Перенос карточки харнесса: колонка → команда очереди. Оптимистично, при отказе — откат. */
	function moveHarnessTask(taskId, columnKey) {
		const t = T();
		const s = state();
		const harness = s.harness || { tasks: [] };
		const task = (harness.tasks || []).find(item => item.id === taskId);
		const column = HARNESS_COLUMNS.find(item => item.key === columnKey);
		if (!task || !column || column.match(task.status)) { return; }
		const action = columnKey === 'running' ? 'claim'
			: columnKey === 'done' ? 'finish'
				: columnKey === 'queue' ? 'reopen'
					: task.status === 'running' ? 'fail' : 'cancel';
		const before = task.status;
		task.status = column.status;
		render();
		const note = document.getElementById('addTaskNote');
		invoke('harness.taskAction', { id: taskId, action })
			.then(result => {
				const ok = !result || result.ok !== false;
				if (!ok) { task.status = before; render(); }
				note.className = ok ? 'ok-text' : 'err-text';
				note.textContent = ok ? t.kbMoved : (result && result.error ? result.error : t.kbMoveFailed);
			})
			.catch(() => { task.status = before; render(); note.className = 'err-text'; note.textContent = t.kbMoveFailed; });
	}

	/** «Своя задача» вида «Харнесс»: add в очередь проекта с выбранным риском. */
	function addHarnessTask() {
		const t = T();
		const input = document.getElementById('newTaskTitle');
		const note = document.getElementById('addTaskNote');
		const button = document.getElementById('btnAddTask');
		const title = String(input.value || '').trim();
		if (!title) {
			note.className = 'muted';
			note.textContent = t.taskTitleNeeded;
			return;
		}
		button.disabled = true;
		note.className = 'muted';
		note.textContent = '';
		invoke('harness.addTask', { title, risk: document.getElementById('newTaskStatus').value || 'write' })
			.then(result => {
				const ok = !result || result.ok !== false;
				if (ok) { input.value = ''; }
				note.className = ok ? 'ok-text' : 'err-text';
				note.textContent = ok ? t.taskAdded : t.taskAddFailed;
			})
			.catch(() => { note.className = 'err-text'; note.textContent = t.taskAddFailed; })
			.finally(() => { button.disabled = false; });
	}

	function renderBoardTab() {"""

once("\tfunction renderBoardTab() {", helpers)

io.open(p, 'w', encoding='utf8', newline='\n').write(s)
print('helpers+harness renderers ok')
