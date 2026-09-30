/*---------------------------------------------------------------------------------------------
 *  API Keys — центральная вкладка менеджера ключей (EditorPane + UI).
 *  Шапка со сводкой, поиск и фильтр групп, таблица ключей с иконками действий,
 *  детали по клику на строку, формы добавления/импорта/настроек над таблицей.
 *--------------------------------------------------------------------------------------------*/

import './media/auraApiEditor.css';
import { $, append, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { AuraApiEditorInput } from './auraApiEditorInput.js';
import { IAuraApiKeysService, IAuraApiKey, IAuraApiKeyStatus, AuraApiKeyPriority } from '../common/auraApiKeys.js';
import { medianLatency, bestMedianLatency } from '../common/auraApiModel.js';

/** Пороги окраски пинга: до 800 мс — быстро, до 2 с — терпимо, дальше — медленно. */
const PING_FAST_MS = 800;
const PING_SLOW_MS = 2000;
/** Сколько держится подтверждение удаления, пока не нажали второй раз. */
const DELETE_CONFIRM_MS = 3000;

type KeyHealth = 'ok' | 'warn' | 'error' | 'checking' | 'unchecked' | 'off';

export class AuraApiEditorPane extends EditorPane {

	static readonly ID = AuraApiEditorInput.ID;

	private rootEl!: HTMLElement;
	private statsEl!: HTMLElement;
	private groupChips!: HTMLElement;
	private searchInput!: HTMLInputElement;
	private formHost!: HTMLElement;
	private tableWrap!: HTMLElement;
	private tableBody!: HTMLElement;
	private groupFilter = '';
	private query = '';
	private expandedRow: string | undefined;
	private detailAnimId: string | undefined;
	private pendingDelete: string | undefined;
	private pendingDeleteTimer: ReturnType<typeof setTimeout> | undefined;
	/** Слушатели строк таблицы: пересоздаются на каждом рендере и не копятся в пане. */
	private readonly renderDisposables = this._register(new DisposableStore());
	/** Слушатели открытой формы: живут, пока форма на экране. */
	private readonly formDisposables = this._register(new DisposableStore());

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
		this._register({ dispose: () => { if (this.pendingDeleteTimer) { clearTimeout(this.pendingDeleteTimer); } } });
	}

	protected override createEditor(parent: HTMLElement): void {
		this.rootEl = append(parent, $('.aura-api-editor.aura'));

		// --- Шапка: заголовок с пояснением слева, главные действия справа ---
		const hero = append(this.rootEl, $('.aura-api-hero'));
		const heroText = append(hero, $('.aura-api-hero-text'));
		const header = append(heroText, $('h2.aura-api-header'));
		append(header, $('span.aura-api-header-icon.codicon.codicon-key'));
		append(header, $('span')).textContent = 'Ключи API';
		const count = append(header, $('span.count'));
		count.textContent = String(this.keysService.getKeys().length);
		append(heroText, $('p.aura-api-sub')).textContent = 'Секреты лежат в защищённом хранилище IDE. Чат и агенты сами берут самый быстрый рабочий ключ — здесь его можно проверить, настроить или закрепить.';
		const heroActions = append(hero, $('.aura-api-hero-actions'));
		this.mkBtn(heroActions, 'Импорт', 'secondary', () => this.showBulkForm(), 'cloud-upload');
		this.mkBtn(heroActions, 'Проверить все', 'secondary', () => {
			void this.keysService.checkAllQueued().then(() => this.notificationService.info('Проверка завершена.'));
		}, 'refresh');
		this.mkBtn(heroActions, 'Добавить ключ', 'primary', () => this.showAddForm(), 'add');

		// --- Сводка: сколько ключей в каком состоянии ---
		this.statsEl = append(this.rootEl, $('.aura-api-stats'));

		// --- Поиск и группы ---
		const toolbar = append(this.rootEl, $('.aura-api-toolbar'));
		const search = append(toolbar, $('.aura-api-search'));
		append(search, $('span.codicon.codicon-search'));
		this.searchInput = append(search, $('input.aura-api-input')) as HTMLInputElement;
		this.searchInput.type = 'search';
		this.searchInput.placeholder = 'Поиск по названию, модели или URL';
		this.searchInput.setAttribute('aria-label', 'Поиск ключей');
		this._register(addDisposableListener(this.searchInput, EventType.INPUT, () => {
			this.query = this.searchInput.value.trim().toLowerCase();
			this.renderTable();
		}));
		this.groupChips = append(toolbar, $('.aura-api-chips'));
		this.groupChips.setAttribute('role', 'tablist');
		this.groupChips.setAttribute('aria-label', 'Группы ключей');

		// --- Место для форм: над таблицей, чтобы не терять контекст ---
		this.formHost = append(this.rootEl, $('.aura-api-form-host'));

		// --- Таблица ---
		this.tableWrap = append(this.rootEl, $('.aura-api-table-wrap'));
		const table = append(this.tableWrap, $('table.aura-api-table'));
		const thead = append(table, $('thead'));
		const head = append(thead, $('tr.aura-api-head'));
		for (const [label, cls] of [
			['Ключ', 'col-name'],
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

	private mkBtn(parent: HTMLElement, label: string, variant: 'primary' | 'secondary', run: () => void, icon?: string, store?: DisposableStore): HTMLButtonElement {
		const b = append(parent, $('button.aura-api-btn')) as HTMLButtonElement;
		b.type = 'button';
		if (icon) { append(b, $(`span.codicon.codicon-${icon}`)); }
		append(b, $('span')).textContent = label;
		if (variant === 'primary') { b.classList.add('primary'); }
		(store ?? this._store).add(addDisposableListener(b, EventType.CLICK, run));
		return b;
	}

	/** Иконка-кнопка действия в строке: подпись уходит в title и aria-label. */
	private mkIconBtn(parent: HTMLElement, icon: string, title: string, run: () => void, extraClass?: string): HTMLButtonElement {
		const b = append(parent, $('button.aura-api-icon-btn')) as HTMLButtonElement;
		b.type = 'button';
		b.title = title;
		b.setAttribute('aria-label', title);
		if (extraClass) { b.classList.add(extraClass); }
		append(b, $(`span.codicon.codicon-${icon}`));
		this.renderDisposables.add(addDisposableListener(b, EventType.CLICK, e => {
			e.stopPropagation();
			run();
		}));
		return b;
	}

	private health(key: IAuraApiKey, s: IAuraApiKeyStatus): KeyHealth {
		if (key.enabled === false) { return 'off'; }
		if (s.checking) { return 'checking'; }
		if (s.cooldownUntil !== undefined && s.cooldownUntil > Date.now()) { return 'warn'; }
		if (s.ok === true) { return s.excludedHighPing ? 'warn' : 'ok'; }
		if (s.ok === false || (s.health && s.health !== 'ok')) { return 'error'; }
		return 'unchecked';
	}

	private renderStats(keys: IAuraApiKey[]): void {
		if (!this.statsEl) { return; }
		this.statsEl.textContent = '';
		const counts = { ok: 0, warn: 0, error: 0, rest: 0 };
		for (const key of keys) {
			const h = this.health(key, this.keysService.getStatus(key.id));
			if (h === 'ok') { counts.ok++; } else if (h === 'warn') { counts.warn++; } else if (h === 'error') { counts.error++; } else { counts.rest++; }
		}
		const selectedId = this.keysService.getSelectedKeyId();
		const selected = keys.find(k => k.id === selectedId);
		const best = bestMedianLatency(keys.map(k => this.keysService.getStatus(k.id).latencySamples));

		const stat = (label: string, value: string, tone: string, hint?: string) => {
			const card = append(this.statsEl, $('.aura-api-stat'));
			card.classList.add(tone);
			append(card, $('span.label')).textContent = label;
			const v = append(card, $('span.value'));
			v.textContent = value;
			if (hint) { card.title = hint; v.title = hint; }
		};
		stat('Работают', `${counts.ok} из ${keys.length}`, 'ok');
		stat('Медленные / пауза', String(counts.warn), counts.warn ? 'warn' : 'neutral');
		stat('С ошибкой', String(counts.error), counts.error ? 'error' : 'neutral');
		stat('Не проверены', String(counts.rest), 'neutral');
		stat('Лучший первый токен', best !== undefined ? `${best} мс` : '—', 'neutral', 'медиана по живым ответам самого быстрого ключа');
		stat('Закреплён для чата', selected ? selected.name : 'автовыбор', selected ? 'info' : 'neutral', selected ? `${selected.name} · ${selected.model}` : 'чат выбирает ключ сам');
	}

	private renderGroupChips(keys: IAuraApiKey[]): void {
		if (!this.groupChips) { return; }
		this.groupChips.textContent = '';
		const groups = this.keysService.getGroups().map(g => g.name);
		if (this.groupFilter && !groups.includes(this.groupFilter)) { this.groupFilter = ''; }
		this.groupChips.style.display = groups.length ? '' : 'none';
		const chip = (value: string, label: string, count: number) => {
			const b = append(this.groupChips, $('button.aura-api-chip')) as HTMLButtonElement;
			b.type = 'button';
			b.setAttribute('role', 'tab');
			const active = this.groupFilter === value;
			b.setAttribute('aria-selected', String(active));
			if (active) { b.classList.add('active'); }
			append(b, $('span')).textContent = label;
			append(b, $('span.n')).textContent = String(count);
			this.renderDisposables.add(addDisposableListener(b, EventType.CLICK, () => {
				this.groupFilter = value;
				this.renderTable();
			}));
		};
		chip('', 'Все', keys.length);
		for (const g of groups) {
			chip(g, g, keys.filter(k => k.group === g).length);
		}
	}

	private matches(key: IAuraApiKey): boolean {
		if (this.groupFilter && key.group !== this.groupFilter) { return false; }
		if (!this.query) { return true; }
		return [key.name, key.model, key.baseUrl, key.group ?? '', key.provider ?? '']
			.some(v => v.toLowerCase().includes(this.query));
	}

	private renderTable(): void {
		if (!this.tableBody) { return; }
		this.renderDisposables.clear();
		this.tableBody.textContent = '';

		const keys = this.keysService.getKeys();

		// Счётчик в заголовке, сводка и группы
		const countEl = this.rootEl.querySelector('.aura-api-header .count');
		if (countEl) { countEl.textContent = String(keys.length); }
		this.renderStats(keys);
		this.renderGroupChips(keys);
		this.statsEl.style.display = keys.length ? '' : 'none';

		if (keys.length === 0) {
			this.renderEmpty('key', 'Пока нет ни одного ключа', 'Добавьте ключ OpenAI-совместимого провайдера или вставьте сразу пачку — из .env, CSV или JSON.', true);
			return;
		}
		const visible = keys.filter(k => this.matches(k));
		if (visible.length === 0) {
			this.renderEmpty('search', 'Ничего не найдено', 'Под фильтр не попал ни один ключ.', false);
			return;
		}

		for (const key of visible) {
			const s = this.keysService.getStatus(key.id);
			const isSelected = this.keysService.getSelectedKeyId() === key.id;
			const expanded = this.expandedRow === key.id;
			const health = this.health(key, s);

			// --- Основная строка: клик раскрывает детали ---
			const row = append(this.tableBody, $('tr.aura-api-row'));
			row.classList.add(`h-${health}`);
			if (isSelected) { row.classList.add('selected'); }
			if (expanded) { row.classList.add('expanded'); }
			row.tabIndex = 0;
			row.setAttribute('aria-expanded', String(expanded));
			this.renderDisposables.add(addDisposableListener(row, EventType.CLICK, () => this.toggleDetail(key.id)));
			this.renderDisposables.add(addDisposableListener(row, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.target === row && (e.key === 'Enter' || e.key === ' ')) {
					e.preventDefault();
					this.toggleDetail(key.id);
				}
			}));

			// Ключ: аватар провайдера + имя + хост
			const nameCell = append(row, $('td.col-name'));
			const ident = append(nameCell, $('.aura-api-ident'));
			append(ident, $('span.aura-api-chevron.codicon')).classList.add(expanded ? 'codicon-chevron-down' : 'codicon-chevron-right');
			const avatar = append(ident, $('span.aura-api-avatar'));
			avatar.textContent = this.initials(key);
			avatar.style.setProperty('--hue', String(this.hue(key.provider ?? this.host(key.baseUrl))));
			const text = append(ident, $('.aura-api-ident-text'));
			const nameLine = append(text, $('.aura-api-name'));
			const nameText = append(nameLine, $('span'));
			nameText.textContent = key.name;
			nameText.title = key.name;
			if (isSelected) {
				const tag = append(nameLine, $('span.aura-api-tag.info'));
				tag.textContent = 'в чате';
				tag.title = 'Ключ закреплён для чата';
			}
			if (key.enabled === false) {
				append(nameLine, $('span.aura-api-tag')).textContent = 'выключен';
			}
			const host = append(text, $('span.aura-api-host'));
			host.textContent = this.host(key.baseUrl);
			host.title = key.baseUrl;

			// Модель
			const modelCell = append(row, $('td.col-model.mono'));
			modelCell.textContent = key.model;
			modelCell.title = key.expectedModel && key.expectedModel !== key.model ? `${key.model} (ожидается ${key.expectedModel})` : key.model;

			// Статус (бейдж)
			const statusCell = append(row, $('td.col-status'));
			this.renderBadge(statusCell, s, key);

			// Пинг: число + цвет по порогам
			const pingCell = append(row, $('td.col-ping'));
			this.renderPing(pingCell, s);

			// Группа
			const groupCell = append(row, $('td.col-group'));
			if (key.group) {
				const g = append(groupCell, $('span.aura-api-group'));
				g.textContent = key.group;
				g.title = key.group;
			} else {
				const g = append(groupCell, $('span.aura-api-muted'));
				g.textContent = '—';
				g.title = 'По умолчанию';
			}

			// Действия: иконки, подписи в подсказках
			const actionsCell = append(row, $('td.aura-api-actions'));
			const actions = append(actionsCell, $('.aura-api-actions-row'));
			const check = this.mkIconBtn(actions, 'refresh', 'Проверить ключ', () => void this.keysService.checkKey(key.id));
			if (s.checking) { check.classList.add('spinning'); check.disabled = true; }
			this.mkIconBtn(actions, 'comment-discussion', isSelected ? 'Уже закреплён для чата' : 'Закрепить для чата', () => void this.selectForChat(key), isSelected ? 'active' : undefined);
			this.mkIconBtn(actions, 'gear', 'Настройки ключа', () => void this.showSettingsForm(key));
			const confirming = this.pendingDelete === key.id;
			const del = this.mkIconBtn(actions, 'trash', confirming ? 'Нажмите ещё раз, чтобы удалить' : 'Удалить ключ', () => this.requestDelete(key), confirming ? 'danger-confirm' : 'danger');
			if (confirming) {
				// На время подтверждения остальные иконки прячутся, чтобы «Удалить?» влезло в колонку.
				actions.classList.add('confirming');
				append(del, $('span.confirm-label')).textContent = 'Удалить?';
			}

			// --- Детальная строка (раскрывающаяся) ---
			if (expanded) {
				this.renderDetail(key, s);
			}
		}
	}

	private renderEmpty(icon: string, title: string, text: string, withActions: boolean): void {
		const row = append(this.tableBody, $('tr'));
		const cell = append(row, $('td.aura-api-empty')) as HTMLTableCellElement;
		cell.colSpan = 6;
		const box = append(cell, $('.aura-api-empty-box'));
		append(box, $(`span.aura-api-empty-icon.codicon.codicon-${icon}`));
		append(box, $('.aura-api-empty-title')).textContent = title;
		append(box, $('.aura-api-empty-text')).textContent = text;
		const acts = append(box, $('.aura-api-empty-actions'));
		if (withActions) {
			this.mkBtn(acts, 'Добавить ключ', 'primary', () => this.showAddForm(), 'add', this.renderDisposables);
			this.mkBtn(acts, 'Импорт', 'secondary', () => this.showBulkForm(), 'cloud-upload', this.renderDisposables);
		} else {
			this.mkBtn(acts, 'Сбросить фильтр', 'secondary', () => {
				this.query = '';
				this.groupFilter = '';
				this.searchInput.value = '';
				this.renderTable();
			}, 'clear-all', this.renderDisposables);
		}
	}

	private renderDetail(key: IAuraApiKey, s: IAuraApiKeyStatus): void {
		const detailRow = append(this.tableBody, $('tr.aura-api-detail'));
		const detailCell = append(detailRow, $('td')) as HTMLTableCellElement;
		detailCell.colSpan = 6;
		if (this.detailAnimId === key.id) {
			detailCell.classList.add('animate-in');
			this.detailAnimId = undefined;
		}

		const sections = append(detailCell, $('.aura-api-detail-sections'));

		const conn = this.detailSection(sections, 'Подключение');
		this.addDetailField(conn, 'Base URL', key.baseUrl, true);
		this.addDetailField(conn, 'Провайдер', key.provider ?? '—');
		this.addDetailField(conn, 'Ожидаемая модель', key.expectedModel ?? '—', true);
		this.addDetailField(conn, 'Приоритет', this.priorityLabel(key.priority));

		const perf = this.detailSection(sections, 'Скорость');
		this.addDetailField(perf, 'Пинг', s.pingMs !== undefined ? `${s.pingMs} мс` : '—');
		// Живой замер первого токена: пинг `/models` не видит ленивую генерацию.
		const medianMs = medianLatency(s.latencySamples);
		this.addDetailField(perf, 'Первый токен', s.latencyMs !== undefined
			? `${medianMs ?? s.latencyMs} мс медиана${s.latencySamples && s.latencySamples.length > 1 ? ` из ${s.latencySamples.length}` : ''}`
				+ (s.latencyMs !== medianMs ? `, последний ${s.latencyMs} мс` : '')
				+ ((s.slowStreak ?? 0) > 0 ? ` · медленных подряд: ${s.slowStreak}` : '')
			: '—');
		this.addDetailField(perf, 'Лучший ключ', this.bestPeerMedianLabel(key.id));
		this.addDetailField(perf, 'Проверен', s.lastChecked ? new Date(s.lastChecked).toLocaleString() : '—');

		const trust = this.detailSection(sections, 'Доверие');
		this.addPercentField(trust, 'Подлинность', s.authenticityPct);
		this.addPercentField(trust, 'Безопасность', s.securityPct);
		if (s.securityNotes && s.securityNotes.length > 0) {
			this.addDetailField(trust, 'Замечания', s.securityNotes.join('; '));
		}

		if (s.error) {
			const err = append(detailCell, $('.aura-api-detail-error'));
			append(err, $('span.codicon.codicon-error'));
			append(err, $('span')).textContent = s.error;
		}

		// Кнопки управления в деталях
		const detailActions = append(detailCell, $('.aura-api-detail-actions'));
		this.mkBtn(detailActions, 'Проверить модель', 'secondary', () => void this.probeKey(key), 'beaker', this.renderDisposables);
		this.mkBtn(detailActions, 'Настройки', 'secondary', () => void this.showSettingsForm(key), 'gear', this.renderDisposables);

		const prioWrap = append(detailActions, $('label.aura-api-inline-field'));
		append(prioWrap, $('span')).textContent = 'Приоритет';
		const prioSelect = append(prioWrap, $('select.aura-api-select')) as HTMLSelectElement;
		for (const [value, label] of [['high', 'Высокий'], ['medium', 'Средний'], ['low', 'Низкий']] as Array<[AuraApiKeyPriority, string]>) {
			const opt = append(prioSelect, $('option')) as HTMLOptionElement;
			opt.value = value; opt.textContent = label;
		}
		prioSelect.value = key.priority;
		this.renderDisposables.add(addDisposableListener(prioSelect, EventType.CHANGE, () => {
			void this.keysService.updateKey(key.id, { priority: prioSelect.value as AuraApiKeyPriority });
		}));
	}

	private detailSection(parent: HTMLElement, title: string): HTMLElement {
		const section = append(parent, $('.aura-api-detail-section'));
		append(section, $('.aura-api-detail-title')).textContent = title;
		return append(section, $('.aura-api-detail-grid'));
	}

	private addPercentField(grid: HTMLElement, label: string, pct: number | null | undefined): void {
		const field = append(grid, $('.field'));
		append(field, $('span.label')).textContent = label;
		const val = append(field, $('span.value.aura-api-pct'));
		if (pct === null || pct === undefined) {
			val.textContent = '—';
			return;
		}
		const meter = append(val, $('span.meter'));
		const fill = append(meter, $('span'));
		fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
		meter.classList.add(pct >= 80 ? 'ok' : pct >= 50 ? 'warn' : 'error');
		append(val, $('span')).textContent = `${pct}%`;
	}

	private renderPing(parent: HTMLElement, s: IAuraApiKeyStatus): void {
		if (s.pingMs === undefined) {
			const empty = append(parent, $('span.aura-api-muted'));
			empty.textContent = s.checking ? '…' : '—';
			return;
		}
		const ping = append(parent, $('span.aura-api-ping'));
		ping.classList.add(s.pingMs <= PING_FAST_MS ? 'fast' : s.pingMs <= PING_SLOW_MS ? 'mid' : 'slow');
		ping.textContent = `${s.pingMs} мс`;
		ping.title = s.latencyMs !== undefined ? `пинг ${s.pingMs} мс · первый токен ${s.latencyMs} мс` : `пинг ${s.pingMs} мс`;
	}

	private renderBadge(parent: HTMLElement, s: IAuraApiKeyStatus, key?: IAuraApiKey): void {
		if (key && key.enabled === false) {
			const b = append(parent, $('span.aura-badge.neutral'));
			b.textContent = 'Выключен';
			b.title = 'Ключ не участвует в автоматическом выборе';
			return;
		}

		if (s.checking) {
			const b = append(parent, $('span.aura-badge.info'));
			b.textContent = 'Проверка…';
			return;
		}

		if (s.cooldownUntil !== undefined && s.cooldownUntil > Date.now()) {
			const b = append(parent, $('span.aura-badge.warn'));
			if (s.cooldownUntil === Number.POSITIVE_INFINITY) {
				b.textContent = 'Заблокирован (401)';
				b.title = 'до ручной перепроверки';
			} else {
				b.textContent = 'Пауза';
				b.title = `лимит запросов — до ${new Date(s.cooldownUntil).toLocaleTimeString()}`;
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
			const label: Record<string, string> = { unauthorized: 'Ключ отклонён (401)', forbidden: 'Нет доступа (403)', ratelimited: 'Лимит (429)', notfound: 'Не найден (404)', down: 'Сервер недоступен', unknown: 'Ошибка' };
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

	private addDetailField(grid: HTMLElement, label: string, value: string, mono = false): void {
		const field = append(grid, $('.field'));
		append(field, $('span.label')).textContent = label;
		const val = append(field, $('span.value'));
		if (mono) { val.classList.add('mono'); }
		val.textContent = value;
		val.title = value;
	}

	private toggleDetail(keyId: string): void {
		const expanding = this.expandedRow !== keyId;
		this.expandedRow = expanding ? keyId : undefined;
		if (expanding) { this.detailAnimId = keyId; }
		this.renderTable();
	}

	/** Удаление в два нажатия: первое превращает корзину в «Удалить?», второе удаляет. */
	private requestDelete(key: IAuraApiKey): void {
		if (this.pendingDeleteTimer) { clearTimeout(this.pendingDeleteTimer); this.pendingDeleteTimer = undefined; }
		if (this.pendingDelete === key.id) {
			this.pendingDelete = undefined;
			if (this.expandedRow === key.id) { this.expandedRow = undefined; }
			void this.keysService.removeKey(key.id).then(() => this.notificationService.info(`«${key.name}» удалён.`));
			return;
		}
		this.pendingDelete = key.id;
		this.pendingDeleteTimer = setTimeout(() => {
			this.pendingDelete = undefined;
			this.pendingDeleteTimer = undefined;
			this.renderTable();
		}, DELETE_CONFIRM_MS);
		this.renderTable();
	}

	private priorityLabel(p: AuraApiKeyPriority): string {
		return p === 'high' ? 'Высокий' : p === 'low' ? 'Низкий' : 'Средний';
	}

	private host(url: string): string {
		const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(url.trim());
		return match ? match[1] : (url || '—');
	}

	private initials(key: IAuraApiKey): string {
		const source = (key.provider ?? key.name ?? key.model ?? '?').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
		const parts = source.split(' ').filter(Boolean);
		const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : source.slice(0, 2);
		return (letters || '?').toUpperCase();
	}

	/** Стабильный оттенок аватара по провайдеру: один провайдер — один цвет. */
	private hue(seed: string): number {
		let h = 0;
		for (let i = 0; i < seed.length; i++) { h = (h * 31 + seed.charCodeAt(i)) % 360; }
		return h;
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

	private closeForm(): void {
		this.formDisposables.clear();
		if (this.formHost) { this.formHost.textContent = ''; }
	}

	/** Открывает форму вида `kind`; повторный клик по той же кнопке её закрывает. */
	private mountForm(kind: string): HTMLElement | undefined {
		const existing = this.formHost.querySelector('.aura-api-form') as HTMLElement | null;
		const sameKind = existing?.dataset.kind === kind;
		this.closeForm();
		if (sameKind) { return undefined; }
		const form = append(this.formHost, $('.aura-api-form'));
		form.dataset.kind = kind;
		return form;
	}

	private formHead(form: HTMLElement, icon: string, title: string, subtitle?: string): HTMLElement {
		const head = append(form, $('.aura-api-form-head'));
		append(head, $(`span.aura-api-form-icon.codicon.codicon-${icon}`));
		const text = append(head, $('.aura-api-form-title'));
		append(text, $('h3')).textContent = title;
		if (subtitle) { append(text, $('p.aura-api-hint')).textContent = subtitle; }
		const close = append(head, $('button.aura-api-icon-btn.close')) as HTMLButtonElement;
		close.type = 'button';
		close.title = 'Закрыть';
		close.setAttribute('aria-label', 'Закрыть');
		append(close, $('span.codicon.codicon-close'));
		this.formDisposables.add(addDisposableListener(close, EventType.CLICK, () => this.closeForm()));
		return head;
	}

	private showAddForm(): void {
		const form = this.mountForm('add');
		if (!form) { return; }
		this.formHead(form, 'add', 'Новый ключ', 'Любой OpenAI-совместимый API. После сохранения ключ сразу проверится.');
		const grid = append(form, $('.aura-api-settings-grid'));
		const name = this.formInput(grid, 'Название', 'Мой ключ');
		const model = this.formInput(grid, 'Модель', 'gpt-4o');
		const baseUrl = this.formInput(grid, 'Base URL', 'https://api.openai.com/v1', false, true);
		const secret = this.formInput(grid, 'API ключ', 'sk-...', true, true);
		const expected = this.formInput(grid, 'Ожидаемая модель (проверка подлинности)', 'необязательно');
		const group = this.formInput(grid, 'Группа (создаст новую)', 'необязательно');
		const row = append(form, $('.aura-api-form-buttons'));
		const submit = () => {
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
			this.closeForm();
		};
		this.mkBtn(row, 'Сохранить и проверить', 'primary', submit, undefined, this.formDisposables);
		this.mkBtn(row, 'Отмена', 'secondary', () => this.closeForm(), undefined, this.formDisposables);
		this.submitOnEnter(form, submit);
		name.focus();
	}

	private showBulkForm(): void {
		const form = this.mountForm('bulk');
		if (!form) { return; }
		this.formHead(form, 'cloud-upload', 'Массовый импорт', 'По одному на строку (sk-…, sk-ant-…), «название | URL | ключ», CSV, .env или JSON-массив. Провайдер определится автоматически.');
		const area = append(form, $('textarea.aura-api-bulk')) as HTMLTextAreaElement;
		area.rows = 8;
		area.placeholder = 'OPENAI_API_KEY=sk-...\nМой прокси | https://llm.example.com/v1 | sk-...';
		area.spellcheck = false;
		const group = this.formInput(form, 'Группа для всех', 'необязательно');
		const row = append(form, $('.aura-api-form-buttons'));
		this.mkBtn(row, 'Импортировать', 'primary', () => {
			void this.keysService.bulkImport(area.value, group.value.trim() || undefined).then(r => {
				const errNote = r.errors.length > 0 ? ` Ошибки: ${r.errors.slice(0, 3).join('; ')}${r.errors.length > 3 ? ` (+${r.errors.length - 3})` : ''}` : '';
				this.notificationService.info(`Импортировано: ${r.added}, пропущено: ${r.skipped}.${errNote}`);
				if (r.added > 0) { void this.keysService.checkAllQueued(); }
			});
			this.closeForm();
		}, 'cloud-upload', this.formDisposables);
		this.mkBtn(row, 'Отмена', 'secondary', () => this.closeForm(), undefined, this.formDisposables);
		area.focus();
	}

	private async showSettingsForm(key: IAuraApiKey): Promise<void> {
		const form = this.mountForm(`settings:${key.id}`);
		if (!form) { return; }
		const s = this.keysService.getStatus(key.id);
		const secret = await this.keysService.getSecret(key.id) ?? '';
		// Пока секрет читался, форму могли закрыть или сменить на другую.
		if (!form.isConnected) { return; }
		form.classList.add('aura-api-settings');

		// Шапка: имя + живой бейдж статуса
		const head = this.formHead(form, 'gear', `Настройки: ${key.name}`, this.host(key.baseUrl));
		const badgeHost = $('.aura-api-form-badge');
		head.insertBefore(badgeHost, head.querySelector('.close'));
		this.renderBadge(badgeHost, s, key);

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
		const revealIcon = append(reveal, $('span.codicon.codicon-eye'));
		const revealText = append(reveal, $('span'));
		revealText.textContent = 'Показать';
		reveal.title = 'Показать / скрыть ключ';
		this.formDisposables.add(addDisposableListener(reveal, EventType.CLICK, () => {
			const showing = secretInput.type === 'text';
			secretInput.type = showing ? 'password' : 'text';
			revealText.textContent = showing ? 'Показать' : 'Скрыть';
			revealIcon.classList.toggle('codicon-eye', showing);
			revealIcon.classList.toggle('codicon-eye-closed', !showing);
		}));

		const enabledWrap = append(grid, $('label.aura-api-check.span-2'));
		const enabled = append(enabledWrap, $('input')) as HTMLInputElement;
		enabled.type = 'checkbox';
		enabled.checked = key.enabled !== false;
		append(enabledWrap, $('span')).textContent = 'Ключ включён (участвует в автоматическом выборе)';

		// --- Служебная информация (только чтение) ---
		const meta = append(form, $('.aura-api-settings-meta'));
		this.addDetailField(meta, 'Провайдер', key.provider ?? '—');
		this.addDetailField(meta, 'Ключ (маска)', this.keysService.maskedSecretLabel(key.id), true);
		this.addDetailField(meta, 'Создан', new Date(key.createdAt).toLocaleString());
		this.addDetailField(meta, 'Последняя проверка', s.lastChecked ? new Date(s.lastChecked).toLocaleString() : '—');
		this.addDetailField(meta, 'Пинг', s.pingMs !== undefined ? `${s.pingMs} мс` : '—');
		this.addDetailField(meta, 'Подлинность', s.authenticityPct != null ? `${s.authenticityPct}%` : '—');
		this.addDetailField(meta, 'Безопасность', s.securityPct != null ? `${s.securityPct}%` : '—');
		if (s.cooldownUntil !== undefined && s.cooldownUntil > Date.now()) {
			this.addDetailField(meta, 'Пауза', s.cooldownUntil === Number.POSITIVE_INFINITY ? 'до ручной перепроверки' : `до ${new Date(s.cooldownUntil).toLocaleTimeString()}`);
		}
		if (s.error) { this.addDetailField(meta, 'Ошибка', s.error); }

		// --- Кнопки ---
		const collect = (): Partial<IAuraApiKey> | undefined => {
			if (!baseUrl.value.trim() || !model.value.trim()) {
				this.notificationService.warn('Base URL и модель обязательны.');
				return undefined;
			}
			return {
				name: name.value.trim() || key.name,
				baseUrl: baseUrl.value.trim(),
				model: model.value.trim(),
				expectedModel: expected.value.trim() || undefined,
				group: group.value.trim() || undefined,
				priority: prio.value as AuraApiKeyPriority,
				weight: Math.max(1, Number(weight.value) || 1),
				enabled: enabled.checked,
			};
		};
		const save = async (patch: Partial<IAuraApiKey>) => {
			await this.keysService.updateKey(key.id, patch);
			if (secretInput.value !== secret) {
				await this.keysService.setSecret(key.id, secretInput.value.trim());
			}
		};
		const row = append(form, $('.aura-api-form-buttons'));
		const saveOnly = () => {
			const patch = collect();
			if (!patch) { return; }
			void (async () => {
				await save(patch);
				this.notificationService.info(`«${patch.name}» сохранён.`);
				this.closeForm();
			})();
		};
		this.mkBtn(row, 'Сохранить', 'primary', saveOnly, undefined, this.formDisposables);
		this.mkBtn(row, 'Сохранить и проверить', 'secondary', () => {
			const patch = collect();
			if (!patch) { return; }
			void (async () => {
				await save(patch);
				this.closeForm();
				await this.keysService.checkKey(key.id);
			})();
		}, 'refresh', this.formDisposables);
		this.mkBtn(row, 'Отмена', 'secondary', () => this.closeForm(), undefined, this.formDisposables);
		this.submitOnEnter(form, saveOnly);
	}

	/** Enter в однострочном поле формы — основное действие, Escape — закрыть форму. */
	private submitOnEnter(form: HTMLElement, submit: () => void): void {
		this.formDisposables.add(addDisposableListener(form, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const target = e.target as HTMLElement | null;
			if (e.key === 'Escape') {
				e.preventDefault();
				this.closeForm();
			} else if (e.key === 'Enter' && target?.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'checkbox') {
				e.preventDefault();
				submit();
			}
		}));
	}

	private formInput(parent: HTMLElement, label: string, placeholder: string, password = false, wide = false): HTMLInputElement {
		const wrap = append(parent, $('.aura-api-field'));
		if (wide) { wrap.classList.add('span-2'); }
		append(wrap, $('label')).textContent = label;
		const input = append(wrap, $('input.aura-api-input')) as HTMLInputElement;
		input.type = password ? 'password' : 'text';
		input.placeholder = placeholder;
		if (password) { input.autocomplete = 'off'; }
		return input;
	}

	override layout(_dimension: Dimension): void {
		this.renderTable();
	}

}
