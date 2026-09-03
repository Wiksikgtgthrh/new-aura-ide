/*---------------------------------------------------------------------------------------------
 *  Aura API — центральная вкладка менеджера ключей (EditorPane + UI).
 *--------------------------------------------------------------------------------------------*/

import './media/auraApiEditor.css';
import { $, append, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { AuraApiEditorInput } from './auraApiEditorInput.js';
import { IAuraApiKeysService, IAuraApiKey, IAuraApiKeyStatus, AuraApiKeyPriority } from '../common/auraApiKeys.js';

type AuraStatusFilter = '' | 'ok' | 'error' | 'cooldown' | 'unchecked';

/** Строк за одну порцию рендера; дальше подгрузка по прокрутке. */
const ROW_CHUNK = 100;

export class AuraApiEditorPane extends EditorPane {

	static readonly ID = AuraApiEditorInput.ID;

	private rootEl!: HTMLElement;
	private tableBody!: HTMLElement;
	private groupFilter = '';
	private searchText = '';
	private statusFilter: AuraStatusFilter = '';
	private groupSelect?: HTMLSelectElement;
	private inputId = 0;
	private readonly selected = new Set<string>();
	private selectAll?: HTMLInputElement;
	private bulkBar!: HTMLElement;
	private bulkCount!: HTMLElement;
	/** Слушатели строк таблицы живут до следующей перерисовки, а не до dispose панели. */
	private readonly rowDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAuraApiKeysService private readonly keysService: IAuraApiKeysService,
		@INotificationService private readonly notificationService: INotificationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super(AuraApiEditorPane.ID, group, telemetryService, themeService, storageService);
		this._register(this.keysService.onDidChange(() => this.renderTable()));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.rootEl = append(parent, $('.aura-api-editor'));

		// --- Панель действий ---
		const toolbar = append(this.rootEl, $('.aura-api-toolbar'));
		this.mkButton(toolbar, '+ Добавить ключ', () => this.showAddForm());
		this.mkButton(toolbar, 'Массовый импорт', () => this.showBulkForm());
		this.mkButton(toolbar, 'Проверить все (очередь)', () => {
			void this.keysService.checkAllQueued().then(() => this.notificationService.info('Проверка всех ключей завершена.'));
		});
		this.mkButton(toolbar, 'Проверить группу', () => this.checkGroup());
		this.mkButton(toolbar, 'Обновить', () => this.renderTable());

		// --- Поиск и фильтры ---
		const filterWrap = append(toolbar, $('.aura-api-group-filter'));

		const searchLabel = append(filterWrap, $('label')) as HTMLLabelElement;
		searchLabel.htmlFor = 'aura-api-search';
		searchLabel.textContent = 'Поиск:';
		const search = append(filterWrap, $('input.aura-api-input.aura-api-search')) as HTMLInputElement;
		search.id = searchLabel.htmlFor;
		search.type = 'search';
		search.placeholder = 'название, модель или URL';
		this._register(addDisposableListener(search, EventType.INPUT, () => {
			this.searchText = search.value.trim().toLowerCase();
			this.renderTable();
		}));

		const statusLabel = append(filterWrap, $('label')) as HTMLLabelElement;
		statusLabel.htmlFor = 'aura-api-status-filter';
		statusLabel.textContent = 'Статус:';
		const statusSelect = append(filterWrap, $('select.aura-api-select')) as HTMLSelectElement;
		statusSelect.id = statusLabel.htmlFor;
		for (const [value, label] of [['', 'Любой'], ['ok', 'Работают'], ['error', 'С ошибкой'], ['cooldown', 'В cooldown'], ['unchecked', 'Не проверены']] as Array<[AuraStatusFilter, string]>) {
			const opt = append(statusSelect, $('option')) as HTMLOptionElement;
			opt.value = value; opt.textContent = label;
		}
		this._register(addDisposableListener(statusSelect, EventType.CHANGE, () => {
			this.statusFilter = statusSelect.value as AuraStatusFilter;
			this.renderTable();
		}));

		const groupLabel = append(filterWrap, $('label')) as HTMLLabelElement;
		groupLabel.htmlFor = 'aura-api-group-filter';
		groupLabel.textContent = 'Группа:';
		this.groupSelect = append(filterWrap, $('select.aura-api-select')) as HTMLSelectElement;
		this.groupSelect.id = groupLabel.htmlFor;
		this._register(addDisposableListener(this.groupSelect, EventType.CHANGE, () => {
			this.groupFilter = this.groupSelect!.value;
			this.renderTable();
		}));

		// --- Групповые операции над выбранными ключами ---
		this.bulkBar = append(this.rootEl, $('.aura-api-bulk-bar'));
		this.bulkCount = append(this.bulkBar, $('span.aura-api-bulk-count'));
		this.mkButton(this.bulkBar, 'Проверить', () => {
			for (const id of this.selected) { void this.keysService.checkKey(id); }
		});
		this.mkButton(this.bulkBar, 'В группу…', () => this.moveSelectedToGroup());
		this.mkButton(this.bulkBar, 'Приоритет…', () => this.setSelectedPriority());
		this.mkButton(this.bulkBar, 'Удалить', () => this.removeSelected());
		this.mkButton(this.bulkBar, 'Снять выбор', () => {
			this.selected.clear();
			this.renderTable();
		});

		// --- Таблица ключей ---
		const tableWrap = append(this.rootEl, $('.aura-api-table-wrap'));
		const table = append(tableWrap, $('table.aura-api-table'));
		const head = append(table, $('tr.aura-api-head'));
		const selectAllCell = append(head, $('th.aura-api-check'));
		this.selectAll = append(selectAllCell, $('input')) as HTMLInputElement;
		this.selectAll.type = 'checkbox';
		this.selectAll.setAttribute('aria-label', 'Выбрать все видимые ключи');
		this._register(addDisposableListener(this.selectAll, EventType.CHANGE, () => {
			const visibleIds = this.visibleKeys().map(k => k.id);
			if (this.selectAll!.checked) {
				for (const id of visibleIds) { this.selected.add(id); }
			} else {
				for (const id of visibleIds) { this.selected.delete(id); }
			}
			this.renderTable();
		}));
		for (const col of ['Название', 'Base URL', 'Модель', 'Группа', 'Приоритет', 'Пинг', 'Статус', 'Модель %', 'Защита %', 'Действия']) {
			append(head, $('th')).textContent = col;
		}
		this.tableBody = append(table, $('tbody'));
	}

	private visibleKeys(): IAuraApiKey[] {
		return this.keysService.getKeys().filter(k => {
			if (this.groupFilter && k.group !== this.groupFilter) {
				return false;
			}
			if (this.searchText && !`${k.name} ${k.model} ${k.baseUrl}`.toLowerCase().includes(this.searchText)) {
				return false;
			}
			return this.matchesStatusFilter(this.keysService.getStatus(k.id));
		});
	}

	private selectedKeys(): IAuraApiKey[] {
		return this.keysService.getKeys().filter(k => this.selected.has(k.id));
	}

	private async moveSelectedToGroup(): Promise<void> {
		const groups = this.keysService.getGroups().map(g => g.name);
		const picked = await this.quickInputService.pick(
			[{ label: '$(close) Без группы', id: '' }, ...groups.map(g => ({ label: g, id: g })), { label: '$(add) Новая группа…', id: '__new__' }],
			{ placeHolder: `Перенести ${this.selected.size} ключей в группу` },
		);
		if (!picked) { return; }
		let target = picked.id ?? '';
		if (target === '__new__') {
			const name = await this.quickInputService.input({ prompt: 'Название новой группы', placeHolder: 'например, prod' });
			if (!name?.trim()) { return; }
			target = name.trim();
			this.keysService.createGroup(target);
		}
		for (const key of this.selectedKeys()) {
			await this.keysService.updateKey(key.id, { group: target || undefined });
		}
		this.notificationService.info(target ? `Перенесено в «${target}»: ${this.selected.size} ключей.` : `Убрано из групп: ${this.selected.size} ключей.`);
	}

	private async setSelectedPriority(): Promise<void> {
		const picked = await this.quickInputService.pick(
			[{ label: 'Высокий', id: 'high' }, { label: 'Средний', id: 'medium' }, { label: 'Низкий', id: 'low' }],
			{ placeHolder: `Приоритет для ${this.selected.size} ключей` },
		);
		if (!picked) { return; }
		for (const key of this.selectedKeys()) {
			await this.keysService.updateKey(key.id, { priority: picked.id as AuraApiKeyPriority });
		}
	}

	private async removeSelected(): Promise<void> {
		const count = this.selected.size;
		const { confirmed } = await this.dialogService.confirm({
			message: `Удалить ${count} ключей?`,
			detail: 'Секреты будут удалены из системного хранилища. Действие нельзя отменить.',
			primaryButton: 'Удалить',
			type: 'warning',
		});
		if (!confirmed) { return; }
		for (const key of this.selectedKeys()) {
			await this.keysService.removeKey(key.id);
		}
		this.selected.clear();
		this.notificationService.info(`Удалено ключей: ${count}.`);
	}

	private matchesStatusFilter(status: IAuraApiKeyStatus): boolean {
		const inCooldown = status.cooldownUntil !== undefined && status.cooldownUntil > Date.now();
		switch (this.statusFilter) {
			case 'ok': return status.ok === true && !inCooldown && !status.excludedHighPing;
			case 'error': return status.ok === false || (status.health !== undefined && status.health !== 'ok');
			case 'cooldown': return inCooldown;
			case 'unchecked': return status.ok === undefined && !status.checking;
			default: return true;
		}
	}

	private mkButton(parent: HTMLElement, label: string, run: () => void): HTMLButtonElement {
		const b = append(parent, $('button.aura-api-btn')) as HTMLButtonElement;
		b.textContent = label;
		this._register(addDisposableListener(b, EventType.CLICK, run));
		return b;
	}

	private renderTable(): void {
		if (!this.tableBody) { return; }
		this.rowDisposables.clear();
		this.tableBody.textContent = '';

		// обновить список групп (из сервиса — включая пустые созданные)
		const keys = this.keysService.getKeys();
		const groups = this.keysService.getGroups().map(g => g.name);
		if (this.groupSelect) {
			const prev = this.groupSelect.value;
			this.groupSelect.textContent = '';
			const all = append(this.groupSelect, $('option')) as HTMLOptionElement;
			all.value = ''; all.textContent = 'Все';
			for (const g of groups) {
				const opt = append(this.groupSelect, $('option')) as HTMLOptionElement;
				opt.value = g; opt.textContent = g;
			}
			this.groupSelect.value = groups.includes(prev) ? prev : '';
			this.groupFilter = this.groupSelect.value;
		}

		// выбор переживает удаления и фильтры, но мёртвые id чистим
		const liveIds = new Set(keys.map(k => k.id));
		for (const id of this.selected) {
			if (!liveIds.has(id)) { this.selected.delete(id); }
		}
		this.bulkBar.classList.toggle('hidden', this.selected.size === 0);
		this.bulkCount.textContent = `Выбрано: ${this.selected.size}`;

		const visible = this.visibleKeys();
		if (this.selectAll) {
			const visibleSelected = visible.filter(k => this.selected.has(k.id)).length;
			this.selectAll.checked = visible.length > 0 && visibleSelected === visible.length;
			this.selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;
			this.selectAll.disabled = visible.length === 0;
		}
		if (visible.length === 0) {
			const row = append(this.tableBody, $('tr'));
			const cell = append(row, $('td.aura-api-empty')) as HTMLTableCellElement;
			cell.colSpan = 11;
			cell.textContent = keys.length === 0
				? 'Ключи не добавлены. Нажмите «+ Добавить ключ» или «Массовый импорт».'
				: 'Ничего не найдено. Смягчите поиск или сбросьте фильтры группы и статуса.';
			return;
		}

		// Рендер порциями: первые ROW_CHUNK строк сразу, остальные — по мере прокрутки.
		// При сотнях ключей это держит перерисовку (на каждый onDidChange) в пределах кадра.
		const renderRows = (from: number, to: number) => {
			for (const key of visible.slice(from, to)) {
				this.renderRow(key);
			}
		};
		renderRows(0, ROW_CHUNK);
		if (visible.length > ROW_CHUNK) {
			const sentinel = append(this.tableBody, $('tr.aura-api-more'));
			const cell = append(sentinel, $('td.aura-api-empty')) as HTMLTableCellElement;
			cell.colSpan = 11;
			let rendered = ROW_CHUNK;
			const update = () => { cell.textContent = `Показано ${rendered} из ${visible.length}. Прокрутите вниз, чтобы загрузить ещё.`; };
			update();
			const observer = new IntersectionObserver(entries => {
				if (!entries.some(e => e.isIntersecting) || rendered >= visible.length) {
					return;
				}
				const next = Math.min(rendered + ROW_CHUNK, visible.length);
				const anchor = sentinel;
				for (const key of visible.slice(rendered, next)) {
					this.tableBody.insertBefore(this.renderRow(key, false), anchor);
				}
				rendered = next;
				if (rendered >= visible.length) {
					observer.disconnect();
					sentinel.remove();
				} else {
					update();
				}
			}, { root: this.tableBody.closest('.aura-api-table-wrap') });
			observer.observe(sentinel);
			this.rowDisposables.add(toDisposable(() => observer.disconnect()));
		}
	}

	private renderRow(key: IAuraApiKey, attach = true): HTMLElement {
		const s = this.keysService.getStatus(key.id);
		const row = $('tr.aura-api-row');
		if (attach) {
			this.tableBody.appendChild(row);
		}
		row.classList.toggle('selected', this.selected.has(key.id));

		const checkCell = append(row, $('td.aura-api-check'));
		const check = append(checkCell, $('input')) as HTMLInputElement;
		check.type = 'checkbox';
		check.checked = this.selected.has(key.id);
		check.setAttribute('aria-label', `Выбрать ${key.name}`);
		this.rowDisposables.add(addDisposableListener(check, EventType.CHANGE, () => {
			if (check.checked) { this.selected.add(key.id); } else { this.selected.delete(key.id); }
			this.renderTable();
		}));

		append(row, $('td')).textContent = key.name;
		append(row, $('td.aura-api-url')).textContent = key.baseUrl;
		append(row, $('td')).textContent = key.model;
		append(row, $('td')).textContent = key.group ?? '—';

		// Приоритет (селектор)
		const prioCell = append(row, $('td'));
		const prio = append(prioCell, $('select.aura-api-select')) as HTMLSelectElement;
		for (const [value, label] of [['high', 'Высокий'], ['medium', 'Средний'], ['low', 'Низкий']] as Array<[AuraApiKeyPriority, string]>) {
			const opt = append(prio, $('option')) as HTMLOptionElement;
			opt.value = value; opt.textContent = label;
		}
		prio.value = key.priority;
		this.rowDisposables.add(addDisposableListener(prio, EventType.CHANGE, () => {
			void this.keysService.updateKey(key.id, { priority: prio.value as AuraApiKeyPriority });
		}));

		// Пинг
		append(row, $('td')).textContent = s.pingMs !== undefined ? `${s.pingMs} мс` : (s.checking ? '…' : '—');

		// Статус / ошибка (health из ядра + cooldown)
		const statusCell = append(row, $('td'));
		const healthLabel: Record<string, string> = { ok: 'OK', unauthorized: '401', forbidden: '403', ratelimited: '429', notfound: '404', down: '5xx', unknown: '?' };
		if (s.cooldownUntil !== undefined && s.cooldownUntil > Date.now()) {
			statusCell.textContent = s.cooldownUntil === Number.POSITIVE_INFINITY ? 'Cooldown: до ручной перепроверки (401)' : `Cooldown до ${new Date(s.cooldownUntil).toLocaleTimeString()}`;
			statusCell.classList.add('aura-api-warn');
		} else if (s.checking) {
			statusCell.textContent = 'Проверка…';
		} else if (s.health && s.health !== 'ok') {
			const hb = append(statusCell, $('span.aura-api-err'));
			hb.textContent = `${healthLabel[s.health] ?? s.health}: ${s.error ?? ''}`;
			hb.title = s.error ?? '';
		} else if (s.ok === true) {
			const ok = append(statusCell, $('span.aura-api-ok'));
			ok.textContent = s.excludedHighPing ? 'Работает, но исключён (высокий пинг)' : 'Работает';
		} else if (s.ok === false) {
			const err = append(statusCell, $('span.aura-api-err'));
			err.textContent = `Ошибка: ${s.error ?? 'неизвестная'}`;
			err.title = s.error ?? '';
		} else {
			statusCell.textContent = 'Не проверен';
		}

		// Подлинность модели %
		append(row, $('td')).textContent = s.authenticityPct !== undefined && s.authenticityPct !== null ? `${s.authenticityPct}%` : '—';

		// Безопасность %
		const secCell = append(row, $('td'));
		if (s.securityPct !== undefined && s.securityPct !== null) {
			secCell.textContent = `${s.securityPct}%`;
			if (s.securityNotes && s.securityNotes.length > 0) {
				secCell.title = 'Замечания: ' + s.securityNotes.join('; ');
				secCell.classList.add('aura-api-warn');
			}
		} else {
			secCell.textContent = '—';
		}

		// Действия
		const actions = append(row, $('td.aura-api-actions'));
		this.mkRowButton(actions, 'Проверить', () => void this.keysService.checkKey(key.id));
		this.mkRowButton(actions, 'Probe', () => this.probeKey(key));
		this.mkRowButton(actions, 'В чат', () => this.selectForChat(key));
		this.mkRowButton(actions, 'Удалить', () => void this.keysService.removeKey(key.id));
		return row;
	}

	private mkRowButton(parent: HTMLElement, label: string, run: () => void): void {
		const b = append(parent, $('button.aura-api-btn-small')) as HTMLButtonElement;
		b.textContent = label;
		this.rowDisposables.add(addDisposableListener(b, EventType.CLICK, run));
	}

	private async probeKey(key: IAuraApiKey): Promise<void> {
		const r = await this.keysService.probeModel(key.id);
		const msg = r.available === 'yes'
			? `Модель ${key.model} доступна, подлинность ${r.authenticityPct ?? '—'}%${r.error ? ` (${r.error})` : ''}`
			: `Модель ${key.model}: ${r.available} — ${r.error ?? 'нет данных'}`;
		if (r.available === 'yes') { this.notificationService.info(msg); } else { this.notificationService.warn(msg); }
	}

	private checkGroup(): void {
		if (!this.groupFilter) {
			this.notificationService.warn('Сначала выберите группу в фильтре.');
			return;
		}
		const groupKeys = this.keysService.getKeys().filter(k => k.group === this.groupFilter);
		for (const k of groupKeys) { void this.keysService.checkKey(k.id); }
		this.notificationService.info(`Запущена проверка группы «${this.groupFilter}» (${groupKeys.length} ключей).`);
	}

	private async selectForChat(key: IAuraApiKey): Promise<void> {
		const s = this.keysService.getStatus(key.id);
		if (s.ok !== true) {
			this.notificationService.warn(`«${key.name}» сначала нужно проверить — запускаю проверку.`);
			await this.keysService.checkKey(key.id);
		}
		const after = this.keysService.getStatus(key.id);
		if (after.ok === true && !after.excludedHighPing) {
			await this.keysService.selectForChat(key.id);
			this.notificationService.info(`«${key.name}» выбран как активный эндпоинт для чата (${key.model} @ ${key.baseUrl}).`);
		} else {
			this.notificationService.warn(`«${key.name}» нельзя использовать: ${after.error ?? 'не прошёл проверку'}.`);
		}
	}

	// --- Формы добавления ---

	private showAddForm(): void {
		const existing = this.rootEl.querySelector('.aura-api-form');
		if (existing) { existing.remove(); return; }
		const form = append(this.rootEl, $('.aura-api-form'));
		append(form, $('h3')).textContent = 'Новый ключ';
		const name = this.formInput(form, 'Название', 'Мой ключ');
		const baseUrl = this.formInput(form, 'Base URL', 'https://api.openai.com/v1');
		const model = this.formInput(form, 'Модель', 'gpt-4o');
		const expected = this.formInput(form, 'Ожидаемая модель (для проверки подлинности, опц.)', '');
		const group = this.formInput(form, 'Группа (опц., новое имя = создать)', '');
		const secret = this.formInput(form, 'API ключ', 'sk-...', true);
		const row = append(form, $('.aura-api-form-buttons'));
		this.mkButton(row, 'Сохранить и проверить', () => {
			if (!baseUrl.value || !model.value || !secret.value) {
				this.notificationService.warn('Заполните Base URL, модель и ключ.');
				return;
			}
			void this.keysService.addKey({
				name: name.value || model.value,
				baseUrl: baseUrl.value.trim(),
				model: model.value.trim(),
				expectedModel: expected.value.trim() || undefined,
				group: group.value.trim() || undefined,
				priority: 'medium',
			}, secret.value.trim());
			form.remove();
		});
		this.mkButton(row, 'Отмена', () => form.remove());
	}

	private showBulkForm(): void {
		const existing = this.rootEl.querySelector('.aura-api-form');
		if (existing) { existing.remove(); return; }
		const form = append(this.rootEl, $('.aura-api-form'));
		append(form, $('h3')).textContent = 'Массовый импорт';
		const hint = append(form, $('p.aura-api-hint'));
		hint.textContent = 'Вставьте что угодно: сырые ключи по строкам (sk-…, sk-ant-…, AIza…), «название | baseUrl | ключ», CSV с заголовком, .env-строки (OPENAI_API_KEY=…) или JSON-массив. Провайдер и baseUrl определятся автоматически; повторная вставка того же ключа будет пропущена.';
		const area = append(form, $('textarea.aura-api-bulk')) as HTMLTextAreaElement;
		area.setAttribute('aria-label', 'Ключи для массового импорта');
		area.rows = 10;
		const group = this.formInput(form, 'Группа для всех (опц., новое имя = создать)', '');
		const row = append(form, $('.aura-api-form-buttons'));
		this.mkButton(row, 'Импортировать и проверить', () => {
			void this.keysService.bulkImport(area.value, group.value.trim() || undefined).then(r => {
				const errNote = r.errors.length > 0 ? ` Ошибки: ${r.errors.slice(0, 3).join('; ')}${r.errors.length > 3 ? ` (+${r.errors.length - 3})` : ''}` : '';
				this.notificationService.info(`Импортировано: ${r.added}, пропущено: ${r.skipped}.${errNote}`);
				if (r.added > 0) { void this.keysService.checkAllQueued(); }
			});
			form.remove();
		});
		this.mkButton(row, 'Отмена', () => form.remove());
	}

	private formInput(parent: HTMLElement, label: string, placeholder: string, password = false): HTMLInputElement {
		const wrap = append(parent, $('.aura-api-field'));
		const inputId = `aura-api-input-${++this.inputId}`;
		const inputLabel = append(wrap, $('label')) as HTMLLabelElement;
		inputLabel.htmlFor = inputId;
		inputLabel.textContent = label;
		const input = append(wrap, $('input.aura-api-input')) as HTMLInputElement;
		input.id = inputId;
		input.type = password ? 'password' : 'text';
		input.placeholder = placeholder;
		return input;
	}

	override layout(_dimension: Dimension): void {
		this.renderTable();
	}

}
