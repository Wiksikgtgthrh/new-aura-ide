/*---------------------------------------------------------------------------------------------
 *  API Keys — центральная вкладка менеджера ключей (EditorPane + UI).
 *  Компактный layout: 5 видимых колонок, детали по клику, бейджи статуса.
 *--------------------------------------------------------------------------------------------*/

import './media/auraApiEditor.css';
import { $, append, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { AuraApiEditorInput } from './auraApiEditorInput.js';
import { IAuraApiKeysService, IAuraApiKey, AuraApiKeyPriority } from '../common/auraApiKeys.js';
import { medianLatency, bestMedianLatency } from '../common/auraApiModel.js';

export class AuraApiEditorPane extends EditorPane {

	static readonly ID = AuraApiEditorInput.ID;

	private rootEl!: HTMLElement;
	private tableWrap!: HTMLElement;
	private tableBody!: HTMLElement;
	private groupFilter = '';
	private groupSelect?: HTMLSelectElement;
	private expandedRow: string | undefined;
	private detailAnimId: string | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAuraApiKeysService private readonly keysService: IAuraApiKeysService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(AuraApiEditorPane.ID, group, telemetryService, themeService, storageService);
		this._register(this.keysService.onDidChange(() => this.renderTable()));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.rootEl = append(parent, $('.aura-api-editor.aura'));

		// --- Заголовок ---
		const header = append(this.rootEl, $('h2.aura-api-header'));
		append(header, $('span')).textContent = 'Ключи API';
		const count = append(header, $('span.count'));
		count.textContent = String(this.keysService.getKeys().length);

		// --- Тулбар: primary + secondary ---
		const toolbar = append(this.rootEl, $('.aura-api-toolbar'));
		this.mkBtn(toolbar, '+ Добавить ключ', 'primary', () => this.showAddForm());
		this.mkBtn(toolbar, 'Импорт', 'secondary', () => this.showBulkForm());
		this.mkBtn(toolbar, 'Проверить все', 'secondary', () => {
			void this.keysService.checkAllQueued().then(() => this.notificationService.info('Проверка завершена.'));
		});

		// --- Фильтр по группе ---
		const filterWrap = append(toolbar, $('.aura-api-group-filter'));
		append(filterWrap, $('span')).textContent = 'Группа:';
		this.groupSelect = append(filterWrap, $('select.aura-api-select')) as HTMLSelectElement;
		this._register(addDisposableListener(this.groupSelect, EventType.CHANGE, () => {
			this.groupFilter = this.groupSelect!.value;
			this.renderTable();
		}));

		// --- Таблица: 5 видимых колонок + actions ---
		this.tableWrap = append(this.rootEl, $('.aura-api-table-wrap'));
		const table = append(this.tableWrap, $('table.aura-api-table'));
		const head = append(table, $('tr.aura-api-head'));
		for (const [label, cls] of [
			['Название', 'col-name'],
			['Модель', 'col-model'],
			['Статус', 'col-status'],
			['Пинг', 'col-ping'],
			['Группа', 'col-group'],
			['', 'col-actions'],
		] as Array<[string, string]>) {
			const th = append(head, $('th'));
			th.textContent = label;
			th.classList.add(cls);
		}
		this.tableBody = append(table, $('tbody'));
	}

	private mkBtn(parent: HTMLElement, label: string, variant: 'primary' | 'secondary', run: () => void): HTMLButtonElement {
		const b = append(parent, $('button.aura-api-btn')) as HTMLButtonElement;
		b.textContent = label;
		if (variant === 'primary') { b.classList.add('primary'); }
		this._register(addDisposableListener(b, EventType.CLICK, run));
		return b;
	}

	private renderTable(): void {
		if (!this.tableBody) { return; }
		this.tableBody.textContent = '';

		const keys = this.keysService.getKeys();
		const groups = this.keysService.getGroups().map(g => g.name);

		// Обновить селект групп
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

		// Обновить счётчик в заголовке
		const countEl = this.rootEl.querySelector('.aura-api-header .count');
		if (countEl) { countEl.textContent = String(keys.length); }

		const visible = keys.filter(k => !this.groupFilter || k.group === this.groupFilter);
		if (visible.length === 0) {
			const row = append(this.tableBody, $('tr'));
			const cell = append(row, $('td.aura-api-empty')) as HTMLTableCellElement;
			cell.colSpan = 6;
			cell.textContent = 'Ключи не добавлены. Нажмите «+ Добавить ключ» или «Импорт».';
			return;
		}

		for (const key of visible) {
			const s = this.keysService.getStatus(key.id);
			const isSelected = this.keysService.getSelectedKeyId() === key.id;

			// --- Основная строка ---
			const row = append(this.tableBody, $('tr.aura-api-row'));
			if (isSelected) { row.classList.add('selected'); }
			if (this.expandedRow === key.id) { row.classList.add('expanded'); }

			// Название
			const nameCell = append(row, $('td.col-name'));
			const nameText = append(nameCell, $('span'));
			nameText.textContent = key.name;
			nameText.title = key.name;
			if (isSelected) {
				const activeMark = append(nameCell, $('span'));
				activeMark.textContent = ' ✓';
				activeMark.style.color = 'var(--aura-focus)';
			}

			// Модель
			const modelCell = append(row, $('td.col-model.mono'));
			modelCell.textContent = key.model;
			modelCell.title = key.baseUrl;

			// Статус (бейдж)
			const statusCell = append(row, $('td.col-status'));
			this.renderBadge(statusCell, s);

			// Пинг
			const pingCell = append(row, $('td.col-ping'));
			pingCell.textContent = s.pingMs !== undefined ? `${s.pingMs} мс` : (s.checking ? '…' : '—');

			// Группа
			const groupCell = append(row, $('td.col-group'));
			groupCell.textContent = key.group ?? '—';
			groupCell.title = key.group ?? 'По умолчанию';

			// Действия
			const actionsCell = append(row, $('td.aura-api-actions'));
			this.mkSmallBtn(actionsCell, 'Проверить', () => void this.keysService.checkKey(key.id));
			this.mkSmallBtn(actionsCell, 'Детали', () => this.toggleDetail(key.id));
			this.mkSmallBtn(actionsCell, 'В чат', () => this.selectForChat(key));
			this.mkSmallBtn(actionsCell, 'Удалить', 'danger', () => void this.keysService.removeKey(key.id));
			// Шестерёнка настроек — после всех действий, прибита к правому краю ячейки.
			const gear = append(actionsCell, $('button.aura-api-btn.small.gear')) as HTMLButtonElement;
			gear.title = 'Настройки ключа';
			append(gear, $('span.codicon.codicon-gear'));
			this._register(addDisposableListener(gear, EventType.CLICK, () => void this.showSettingsForm(key)));

			// --- Детальная строка (раскрывающаяся) ---
			if (this.expandedRow === key.id) {
				const detailRow = append(this.tableBody, $('tr.aura-api-detail'));
				const detailCell = append(detailRow, $('td')) as HTMLTableCellElement;
				detailCell.colSpan = 6;
				if (this.detailAnimId === key.id) {
					detailCell.classList.add('animate-in');
					this.detailAnimId = undefined;
				}

				const grid = append(detailCell, $('div.aura-api-detail-grid'));

				this.addDetailField(grid, 'Base URL', key.baseUrl);
				this.addDetailField(grid, 'Ожидаемая модель', key.expectedModel ?? '—');
				this.addDetailField(grid, 'Провайдер', key.provider ?? '—');
				this.addDetailField(grid, 'Приоритет', this.priorityLabel(key.priority));
				this.addDetailField(grid, 'Пинг', s.pingMs !== undefined ? `${s.pingMs} мс` : '—');
				// Живой замер первого токена: пинг `/models` не видит ленивую генерацию.
				const medianMs = medianLatency(s.latencySamples);
				this.addDetailField(grid, 'Первый токен', s.latencyMs !== undefined
					? `${medianMs ?? s.latencyMs} мс медиана${s.latencySamples && s.latencySamples.length > 1 ? ` из ${s.latencySamples.length}` : ''}`
						+ (s.latencyMs !== medianMs ? `, последний ${s.latencyMs} мс` : '')
						+ ((s.slowStreak ?? 0) > 0 ? ` · медленных подряд: ${s.slowStreak}` : '')
					: '—');
				this.addDetailField(grid, 'Лучший ключ', this.bestPeerMedianLabel(key.id));
				this.addDetailField(grid, 'Подлинность', s.authenticityPct != null ? `${s.authenticityPct}%` : '—');
				this.addDetailField(grid, 'Безопасность', s.securityPct != null ? `${s.securityPct}%` : '—');

				if (s.securityNotes && s.securityNotes.length > 0) {
					this.addDetailField(grid, 'Замечания', s.securityNotes.join('; '));
				}

				if (s.error) {
					this.addDetailField(grid, 'Ошибка', s.error);
				}

				// Кнопки управления в деталях
				const detailActions = append(detailCell, $('div'));
				detailActions.style.marginTop = '8px';
				detailActions.style.display = 'flex';
				detailActions.style.gap = '8px';

				this.mkSmallBtn(detailActions, 'Проверить модель', () => this.probeKey(key));
				this.mkSmallBtn(detailActions, 'Настройки', () => void this.showSettingsForm(key));

				const prioSelect = append(detailActions, $('select.aura-api-select')) as HTMLSelectElement;
				for (const [value, label] of [['high', 'Высокий'], ['medium', 'Средний'], ['low', 'Низкий']] as Array<[AuraApiKeyPriority, string]>) {
					const opt = append(prioSelect, $('option')) as HTMLOptionElement;
					opt.value = value; opt.textContent = label;
				}
				prioSelect.value = key.priority;
				this._register(addDisposableListener(prioSelect, EventType.CHANGE, () => {
					void this.keysService.updateKey(key.id, { priority: prioSelect.value as AuraApiKeyPriority });
				}));
			}
		}
	}

	private renderBadge(parent: HTMLElement, s: ReturnType<IAuraApiKeysService['getStatus']>): void {
		if (s.checking) {
			const b = append(parent, $('span.aura-badge.info'));
			b.textContent = 'Проверка…';
			return;
		}

		if (s.cooldownUntil !== undefined && s.cooldownUntil > Date.now()) {
			const b = append(parent, $('span.aura-badge.warn'));
			if (s.cooldownUntil === Number.POSITIVE_INFINITY) {
				b.textContent = 'Заблокирован (401)';
			} else {
				b.textContent = 'Cooldown';
				b.title = `до ${new Date(s.cooldownUntil).toLocaleTimeString()}`;
			}
			return;
		}

		if (s.ok === true) {
			if (s.excludedHighPing) {
				const b = append(parent, $('span.aura-badge.warn'));
				// Причина важна: пинг-зонд и живые ответы — разные истории и разные способы вернуть ключ.
				b.textContent = s.excludedReason === 'latency' ? 'Медленные ответы' : 'Высокий пинг';
				b.title = s.excludedReason === 'latency'
					? `первый токен ${s.latencyMs ?? '?'} мс — ключ исключён из автовыбора (быстрый ответ вернёт его)`
					: `${s.pingMs} мс — ключ исключён`;
			} else {
				const b = append(parent, $('span.aura-badge.ok'));
				b.textContent = 'Работает';
			}
			return;
		}

		if (s.ok === false || (s.health && s.health !== 'ok')) {
			const b = append(parent, $('span.aura-badge.error'));
			const label: Record<string, string> = { unauthorized: '401', forbidden: '403', ratelimited: '429', notfound: '404', down: '5xx', unknown: '?' };
			b.textContent = label[s.health ?? ''] ?? 'Ошибка';
			if (s.error) { b.title = s.error; }
			return;
		}

		const b = append(parent, $('span.aura-badge.neutral'));
		b.textContent = 'Не проверен';
	}

	/**
	 * С кем сравнивается этот ключ: самая быстрая медиана среди остальных. Без замеров —
	 * стартовый порог, поэтому порог в интерфейсе видно, а не приходится угадывать.
	 */
	private bestPeerMedianLabel(keyId: string): string {
		const others = this.keysService.getKeys().filter(k => k.id !== keyId);
		const best = bestMedianLatency(others.map(k => this.keysService.getStatus(k.id).latencySamples));
		return best !== undefined ? `${best} мс медиана` : 'замеров пока нет';
	}

	private addDetailField(grid: HTMLElement, label: string, value: string): void {
		const field = append(grid, $('span.field'));
		const lbl = append(field, $('span.label'));
		lbl.textContent = label + ':';
		const val = append(field, $('span.value'));
		val.textContent = value;
		val.title = value;
	}

	private toggleDetail(keyId: string): void {
		const expanding = this.expandedRow !== keyId;
		this.expandedRow = expanding ? keyId : undefined;
		if (expanding) { this.detailAnimId = keyId; }
		this.renderTable();
	}

	private priorityLabel(p: AuraApiKeyPriority): string {
		return p === 'high' ? 'Высокий' : p === 'low' ? 'Низкий' : 'Средний';
	}

	private mkSmallBtn(parent: HTMLElement, label: string, runOrClass: (() => void) | string, maybeRun?: () => void): void {
		const b = append(parent, $('button.aura-api-btn.small')) as HTMLButtonElement;
		b.textContent = label;
		if (typeof runOrClass === 'string') {
			b.classList.add(runOrClass);
			this._register(addDisposableListener(b, EventType.CLICK, maybeRun!));
		} else {
			this._register(addDisposableListener(b, EventType.CLICK, runOrClass));
		}
	}

	private async probeKey(key: IAuraApiKey): Promise<void> {
		const r = await this.keysService.probeModel(key.id);
		const msg = r.available === 'yes'
			? `Модель ${key.model} доступна, подлинность ${r.authenticityPct ?? '—'}%${r.error ? ` (${r.error})` : ''}`
			: `Модель ${key.model}: ${r.available} — ${r.error ?? 'нет данных'}`;
		if (r.available === 'yes') { this.notificationService.info(msg); } else { this.notificationService.warn(msg); }
	}

	private async selectForChat(key: IAuraApiKey): Promise<void> {
		const s = this.keysService.getStatus(key.id);
		if (s.ok !== true) {
			this.notificationService.warn(`«${key.name}» нужно сначала проверить.`);
			await this.keysService.checkKey(key.id);
		}
		const after = this.keysService.getStatus(key.id);
		if (after.ok === true && !after.excludedHighPing) {
			await this.keysService.selectForChat(key.id);
			this.notificationService.info(`«${key.name}» активен для чата (${key.model}).`);
		} else {
			this.notificationService.warn(`«${key.name}» недоступен: ${after.error ?? 'не проверен'}.`);
		}
	}

	// --- Формы ---

	private mountForm(): HTMLElement {
		const form = $('.aura-api-form');
		this.rootEl.insertBefore(form, this.tableWrap);
		return form;
	}

	private showAddForm(): void {
		const existing = this.rootEl.querySelector('.aura-api-form');
		if (existing) { existing.remove(); return; }
		const form = this.mountForm();
		append(form, $('h3')).textContent = 'Новый ключ';
		const name = this.formInput(form, 'Название', 'Мой ключ');
		const baseUrl = this.formInput(form, 'Base URL', 'https://api.openai.com/v1');
		const model = this.formInput(form, 'Модель', 'gpt-4o');
		const expected = this.formInput(form, 'Ожидаемая модель (проверка подлинности)', '');
		const group = this.formInput(form, 'Группа (создаст новую)', '');
		const secret = this.formInput(form, 'API ключ', 'sk-...', true);
		const row = append(form, $('.aura-api-form-buttons'));
		this.mkBtn(row, 'Сохранить и проверить', 'primary', () => {
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
		this.mkBtn(row, 'Отмена', 'secondary', () => form.remove());
	}

	private showBulkForm(): void {
		const existing = this.rootEl.querySelector('.aura-api-form');
		if (existing) { existing.remove(); return; }
		const form = this.mountForm();
		append(form, $('h3')).textContent = 'Массовый импорт';
		const hint = append(form, $('p.aura-api-hint'));
		hint.textContent = 'Вставьте ключи: по одному на строку (sk-…, sk-ant-…), «название | URL | ключ», CSV, .env или JSON-массив. Провайдер определится автоматически.';
		const area = append(form, $('textarea.aura-api-bulk')) as HTMLTextAreaElement;
		area.rows = 8;
		const group = this.formInput(form, 'Группа для всех', '');
		const row = append(form, $('.aura-api-form-buttons'));
		this.mkBtn(row, 'Импортировать', 'primary', () => {
			void this.keysService.bulkImport(area.value, group.value.trim() || undefined).then(r => {
				const errNote = r.errors.length > 0 ? ` Ошибки: ${r.errors.slice(0, 3).join('; ')}${r.errors.length > 3 ? ` (+${r.errors.length - 3})` : ''}` : '';
				this.notificationService.info(`Импортировано: ${r.added}, пропущено: ${r.skipped}.${errNote}`);
				if (r.added > 0) { void this.keysService.checkAllQueued(); }
			});
			form.remove();
		});
		this.mkBtn(row, 'Отмена', 'secondary', () => form.remove());
	}

	private async showSettingsForm(key: IAuraApiKey): Promise<void> {
		const existing = this.rootEl.querySelector('.aura-api-form');
		if (existing) { existing.remove(); return; }
		const s = this.keysService.getStatus(key.id);
		const secret = await this.keysService.getSecret(key.id) ?? '';

		const form = this.mountForm();
		form.classList.add('aura-api-settings');

		// Шапка: имя + живой бейдж статуса
		const head = append(form, $('.aura-api-settings-head'));
		append(head, $('h3')).textContent = `Настройки: ${key.name}`;
		this.renderBadge(head, s);

		// --- Редактируемые поля (сетка 2 колонки) ---
		const grid = append(form, $('.aura-api-settings-grid'));

		const name = this.formInput(grid, 'Название', key.name);
		name.value = key.name;
		const model = this.formInput(grid, 'Модель', key.model);
		model.value = key.model;
		const baseUrl = this.formInput(grid, 'Base URL', 'https://…/v1');
		baseUrl.value = key.baseUrl;
		const expected = this.formInput(grid, 'Ожидаемая модель (проверка подлинности)', key.model);
		expected.value = key.expectedModel ?? '';

		const group = this.formInput(grid, 'Группа', 'Без группы');
		group.value = key.group ?? '';
		group.setAttribute('list', 'aura-api-groups-list');
		const datalist = append(grid, $('datalist')) as HTMLDataListElement;
		datalist.id = 'aura-api-groups-list';
		for (const g of this.keysService.getGroups()) {
			const opt = append(datalist, $('option')) as HTMLOptionElement;
			opt.value = g.name;
		}

		const prioWrap = append(grid, $('.aura-api-field'));
		append(prioWrap, $('label')).textContent = 'Приоритет';
		const prio = append(prioWrap, $('select.aura-api-select')) as HTMLSelectElement;
		for (const [value, label] of [['high', 'Высокий'], ['medium', 'Средний'], ['low', 'Низкий']] as Array<[AuraApiKeyPriority, string]>) {
			const opt = append(prio, $('option')) as HTMLOptionElement;
			opt.value = value; opt.textContent = label;
		}
		prio.value = key.priority;

		const weight = this.formInput(grid, 'Вес (round-robin в группе)', '1');
		weight.type = 'number';
		weight.min = '1';
		weight.max = '100';
		weight.value = String(key.weight ?? 1);

		// Секрет: на всю ширину, с кнопкой «показать»
		const secretWrap = append(grid, $('.aura-api-field.span-2'));
		append(secretWrap, $('label')).textContent = 'API ключ';
		const secretRow = append(secretWrap, $('.aura-api-secret-row'));
		const secretInput = append(secretRow, $('input.aura-api-input')) as HTMLInputElement;
		secretInput.type = 'password';
		secretInput.value = secret;
		secretInput.placeholder = 'sk-...';
		secretInput.autocomplete = 'off';
		const reveal = append(secretRow, $('button.aura-api-btn')) as HTMLButtonElement;
		reveal.type = 'button';
		reveal.textContent = 'Показать';
		reveal.title = 'Показать / скрыть ключ';
		this._register(addDisposableListener(reveal, EventType.CLICK, () => {
			const showing = secretInput.type === 'text';
			secretInput.type = showing ? 'password' : 'text';
			reveal.textContent = showing ? 'Показать' : 'Скрыть';
		}));

		const enabledWrap = append(grid, $('label.aura-api-check.span-2'));
		const enabled = append(enabledWrap, $('input')) as HTMLInputElement;
		enabled.type = 'checkbox';
		enabled.checked = key.enabled !== false;
		append(enabledWrap, $('span')).textContent = 'Ключ включён (участвует в автоматическом выборе)';

		// --- Служебная информация (только чтение) ---
		const meta = append(form, $('.aura-api-settings-meta'));
		this.addDetailField(meta, 'Провайдер', key.provider ?? '—');
		this.addDetailField(meta, 'Ключ (маска)', this.keysService.maskedSecretLabel(key.id));
		this.addDetailField(meta, 'Создан', new Date(key.createdAt).toLocaleString());
		this.addDetailField(meta, 'Последняя проверка', s.lastChecked ? new Date(s.lastChecked).toLocaleString() : '—');
		this.addDetailField(meta, 'Пинг', s.pingMs !== undefined ? `${s.pingMs} мс` : '—');
		this.addDetailField(meta, 'Подлинность', s.authenticityPct != null ? `${s.authenticityPct}%` : '—');
		this.addDetailField(meta, 'Безопасность', s.securityPct != null ? `${s.securityPct}%` : '—');
		if (s.cooldownUntil !== undefined && s.cooldownUntil > Date.now()) {
			this.addDetailField(meta, 'Cooldown', s.cooldownUntil === Number.POSITIVE_INFINITY ? 'до ручной перепроверки' : `до ${new Date(s.cooldownUntil).toLocaleTimeString()}`);
		}
		if (s.error) { this.addDetailField(meta, 'Ошибка', s.error); }

		// --- Кнопки ---
		const row = append(form, $('.aura-api-form-buttons'));
		this.mkBtn(row, 'Сохранить', 'primary', () => {
			if (!baseUrl.value.trim() || !model.value.trim()) {
				this.notificationService.warn('Base URL и модель обязательны.');
				return;
			}
			const patch: Partial<IAuraApiKey> = {
				name: name.value.trim() || key.name,
				baseUrl: baseUrl.value.trim(),
				model: model.value.trim(),
				expectedModel: expected.value.trim() || undefined,
				group: group.value.trim() || undefined,
				priority: prio.value as AuraApiKeyPriority,
				weight: Math.max(1, Number(weight.value) || 1),
				enabled: enabled.checked,
			};
			void (async () => {
				await this.keysService.updateKey(key.id, patch);
				if (secretInput.value !== secret) {
					await this.keysService.setSecret(key.id, secretInput.value.trim());
				}
				this.notificationService.info(`«${patch.name}» сохранён.`);
				form.remove();
			})();
		});
		this.mkBtn(row, 'Сохранить и проверить', 'secondary', () => {
			if (!baseUrl.value.trim() || !model.value.trim()) {
				this.notificationService.warn('Base URL и модель обязательны.');
				return;
			}
			void (async () => {
				await this.keysService.updateKey(key.id, {
					name: name.value.trim() || key.name,
					baseUrl: baseUrl.value.trim(),
					model: model.value.trim(),
					expectedModel: expected.value.trim() || undefined,
					group: group.value.trim() || undefined,
					priority: prio.value as AuraApiKeyPriority,
					weight: Math.max(1, Number(weight.value) || 1),
					enabled: enabled.checked,
				});
				if (secretInput.value !== secret) {
					await this.keysService.setSecret(key.id, secretInput.value.trim());
				}
				form.remove();
				await this.keysService.checkKey(key.id);
			})();
		});
		this.mkBtn(row, 'Отмена', 'secondary', () => form.remove());
	}

	private formInput(parent: HTMLElement, label: string, placeholder: string, password = false): HTMLInputElement {
		const wrap = append(parent, $('.aura-api-field'));
		append(wrap, $('label')).textContent = label;
		const input = append(wrap, $('input.aura-api-input')) as HTMLInputElement;
		input.type = password ? 'password' : 'text';
		input.placeholder = placeholder;
		return input;
	}

	override layout(_dimension: Dimension): void {
		this.renderTable();
	}

}
