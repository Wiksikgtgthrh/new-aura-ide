/*---------------------------------------------------------------------------------------------
 *  Aura Market — центральная вкладка: поиск, сегмент-фильтр, карточки с документацией,
 *  установка/отключение/удаление плагинов (живое, без перезагрузки окна).
 *--------------------------------------------------------------------------------------------*/

import './media/auraMarket.css';
import { $, append, addDisposableListener, EventType, Dimension, getWindow } from '../../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { renderMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { AuraMarketEditorInput } from './auraMarketEditorInput.js';
import { AuraMarketFilter, IAuraMarketItem, auraMarketInstalledKey, auraMarketDisabledKey } from '../common/auraMarketCatalog.js';
import { IAuraMarketText, auraMarketItems, auraMarketText } from '../common/auraMarketI18n.js';
import { AURA_LANGUAGES, AURA_LANGUAGE_LABELS, AURA_LANGUAGE_SETTING, IAuraLanguageService, normalizeAuraLanguage } from '../../auraI18n/common/auraLanguage.js';
import { IAuraPluginService } from '../common/auraPluginService.js';
import { AGGG_VERSION_SETTING, normalizeAgggVersion } from '../../aggg/common/agggBoost.js';
import { AgggVersionWidget } from '../../aggg/browser/agggVersionWidget.js';

/** Длительности/изинг — токены auraTokens.css (--dur-2/--dur-3, --ease-out). */
const UNDO_TOAST_MS = 5000;
const LEAVE_ANIMATION_MS = 240;

function prefersReducedMotion(node: HTMLElement): boolean {
	const win = getWindow(node);
	return typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Экранированные переводы строк из JSON-каталога раскрываем перед рендером. */
function normalizeDocsText(text: string): string {
	return text.replace(/\\n/g, '\n');
}

export class AuraMarketEditorPane extends EditorPane {

	static readonly ID = AuraMarketEditorInput.ID;

	private searchText = '';
	private activeFilter: AuraMarketFilter = 'all';
	private rootEl!: HTMLElement;
	private listEl!: HTMLElement;
	private segEl!: HTMLElement;
	private segPillEl!: HTMLElement;
	private toastEl!: HTMLElement;
	private subtitleEl!: HTMLElement;
	private searchEl!: HTMLInputElement;
	private langLabelEl!: HTMLElement;
	private langSelectEl!: HTMLSelectElement;
	private readonly segButtons = new Map<AuraMarketFilter, HTMLButtonElement>();
	private toastTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly expandedVersions = new Set<string>();
	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly toastDisposables = this._register(new DisposableStore());
	private readonly readerDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly marketStorage: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAuraPluginService private readonly pluginService: IAuraPluginService,
		@IAuraLanguageService private readonly languageService: IAuraLanguageService,
	) {
		super(AuraMarketEditorPane.ID, group, telemetryService, themeService, marketStorage);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.rootEl = append(parent, $('.aura-market-tab.aura'));

		// Скроллится только внутренняя обёртка: оверлей-читалка лежит поверх
		// в rootEl и не уезжает вместе с контентом.
		const scroll = append(this.rootEl, $('.aura-market-scroll'));

		const text = this.text;
		const header = append(scroll, $('.aura-market-tab-header'));
		append(header, $('h2.aura-market-tab-title')).textContent = text.title;
		this.subtitleEl = append(header, $('p.aura-market-tab-subtitle'));
		this.subtitleEl.textContent = text.subtitle;
		this.renderLanguageSwitcher(header);

		const searchWrap = append(scroll, $('.aura-market-search'));
		const search = append(searchWrap, $('input.aura-market-search-input')) as HTMLInputElement;
		this.searchEl = search;
		search.setAttribute('aria-label', text.searchAriaLabel);
		search.type = 'text';
		search.placeholder = text.searchPlaceholder;
		this._register(addDisposableListener(search, EventType.INPUT, () => {
			this.searchText = search.value.trim().toLowerCase();
			this.renderList();
		}));

		// Сегмент-контрол: активный сегмент подсвечен подложкой, которая едет FLIP-анимацией.
		this.segEl = append(scroll, $('.aura-market-seg'));
		this.segPillEl = append(this.segEl, $('span.aura-market-seg-pill'));
		const segments: Array<{ filter: AuraMarketFilter; label: string }> = [
			{ filter: 'all', label: text.segmentAll },
			{ filter: 'plugin', label: text.segmentPlugins },
			{ filter: 'skillset', label: text.segmentSkillsets },
		];
		for (const seg of segments) {
			const el = append(this.segEl, $('button.aura-market-seg-btn')) as HTMLButtonElement;
			el.textContent = seg.label;
			el.dataset.filter = seg.filter;
			this.segButtons.set(seg.filter, el);
			if (seg.filter === this.activeFilter) { el.classList.add('active'); }
			this._register(addDisposableListener(el, EventType.CLICK, () => {
				if (this.activeFilter === seg.filter) { return; }
				this.activeFilter = seg.filter;
				for (const other of Array.from(this.segEl.querySelectorAll('.aura-market-seg-btn'))) {
					(other as HTMLElement).classList.toggle('active', (other as HTMLElement).dataset.filter === seg.filter);
				}
				this.moveSegmentPill(el);
				this.renderList();
			}));
		}

		this.listEl = append(scroll, $('.aura-market-tab-list'));

		// Undo-тост удаления: запрос на удаление уходит только после истечения тоста.
		this.toastEl = append(scroll, $('.aura-market-toast'));
		this.toastEl.style.display = 'none';

		this._register(this.pluginService.onDidChangeEnablement(() => this.renderList()));
		// Язык меняется на лету: шапка, фильтры и карточки перерисовываются без перезагрузки окна.
		this._register(this.languageService.onDidChange(() => this.applyLanguage()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGGG_VERSION_SETTING)) { this.renderList(); }
		}));

		this.renderList();
		getWindow(this.rootEl).requestAnimationFrame(() => this.moveSegmentPill(undefined, false));
	}

	/** Строки интерфейса: набор ru/en выбирает сервис, 'auto' он же и разрешает. */
	private get text(): IAuraMarketText {
		return auraMarketText(this.languageService.language);
	}

	/**
	 * Переключатель языка прямо в шапке маркета — тот же выбор, что и индикатор
	 * в статус-баре, только на виду: язык маркета меняется одним кликом, без
	 * похода в настройки. Пишется в user-настройки: язык — свойство пользователя.
	 */
	private renderLanguageSwitcher(header: HTMLElement): void {
		const wrap = append(header, $('.aura-market-lang'));
		this.langLabelEl = append(wrap, $('span.aura-market-lang-label'));
		const select = append(wrap, $('select.aura-market-lang-select')) as HTMLSelectElement;
		this.langSelectEl = select;
		select.setAttribute('aria-label', 'Aura language');
		for (const language of AURA_LANGUAGES) {
			const option = append(select, $('option')) as HTMLOptionElement;
			option.value = language;
		}
		this._register(addDisposableListener(select, EventType.CHANGE, () => {
			const picked = normalizeAuraLanguage(select.value);
			if (picked === this.languageService.setting) { return; }
			void this.configurationService.updateValue(AURA_LANGUAGE_SETTING, picked, ConfigurationTarget.USER);
		}));
		this.syncLanguageSwitcher();
	}

	/** Подписи вариантов — всегда на текущем языке интерфейса, значение — из настройки. */
	private syncLanguageSwitcher(): void {
		this.langLabelEl.textContent = this.text.languageLabel;
		const language = this.languageService.language;
		Array.from(this.langSelectEl.options).forEach((option, index) => {
			option.textContent = AURA_LANGUAGE_LABELS[AURA_LANGUAGES[index]][language];
		});
		this.langSelectEl.value = this.languageService.setting;
	}

	/** Смена языка на лету: шапка, поиск, фильтры и карточки — всё на новом языке. */
	private applyLanguage(): void {
		const text = this.text;
		this.subtitleEl.textContent = text.subtitle;
		this.searchEl.setAttribute('aria-label', text.searchAriaLabel);
		this.searchEl.placeholder = text.searchPlaceholder;
		this.segButtons.forEach((button, filter) => {
			button.textContent = filter === 'all' ? text.segmentAll : filter === 'plugin' ? text.segmentPlugins : text.segmentSkillsets;
		});
		this.syncLanguageSwitcher();
		this.moveSegmentPill(undefined, false);
		this.renderList();
	}

	private isInstalled(item: IAuraMarketItem): boolean {
		return this.marketStorage.get(auraMarketInstalledKey(item.id), StorageScope.APPLICATION, 'false') === 'true'
			|| (!this.marketStorage.get(auraMarketInstalledKey(item.id), StorageScope.APPLICATION) && this.pluginService.isInstalled(item.id));
	}

	/** Плагин установлен, но временно отключён. */
	private isDisabled(item: IAuraMarketItem): boolean {
		return this.marketStorage.get(auraMarketDisabledKey(item.id), StorageScope.APPLICATION, 'false') === 'true';
	}

	private async install(item: IAuraMarketItem, btn: HTMLButtonElement): Promise<void> {
		// Тяжёлый toolchain — предупреждение в диалоге подтверждения, а не в мета-строке.
		if (!this.isInstalled(item) && item.sizeNote) {
			const choice = await this.dialogService.confirm({
				type: 'warning',
				title: item.name,
				message: this.text.confirmInstall(item.name, item.sizeNote),
				primaryButton: this.text.install,
				cancelButton: this.text.cancel
			});
			if (!choice.confirmed) { return; }
		}
		if (!item.builtinId) {
			this.notificationService.info(this.text.notBundled(item.name));
			return;
		}
		this.setBusy(btn, true, this.text.busyInstalling);
		this.pluginService.setInstalled(item.id, true);
		this.notificationService.notify({ severity: Severity.Info, message: this.text.installed(item.name) });
		this.renderList();
	}

	private async disable(item: IAuraMarketItem, btn: HTMLButtonElement): Promise<void> {
		this.setBusy(btn, true);
		this.pluginService.setEnabled(item.id, false);
		this.renderList();
	}

	private async enable(item: IAuraMarketItem, btn: HTMLButtonElement): Promise<void> {
		this.setBusy(btn, true);
		this.pluginService.setEnabled(item.id, true);
		this.renderList();
	}

	/** Удаление: карточка уезжает и схлопывается, запрос уходит после истечения undo-тоста. */
	private async uninstall(item: IAuraMarketItem, card: HTMLElement): Promise<void> {
		const choice = await this.dialogService.confirm({
			type: 'question',
			title: item.name,
			message: this.text.confirmUninstall(item.name),
			primaryButton: this.text.uninstall,
			cancelButton: this.text.cancel
		});
		if (!choice.confirmed) { return; }

		card.classList.add('is-leaving');
		card.style.height = `${card.offsetHeight}px`;
		void card.offsetWidth; // фиксируем высоту до схлопывания
		card.classList.add('is-collapsing');

		setTimeout(() => {
			card.remove();
			this.showUndoToast(item);
		}, prefersReducedMotion(card) ? 1 : LEAVE_ANIMATION_MS);
	}

	private showUndoToast(item: IAuraMarketItem): void {
		if (this.toastTimer) { clearTimeout(this.toastTimer); }
		this.toastDisposables.clear();
		this.toastEl.textContent = '';
		append(this.toastEl, $('span')).textContent = this.text.removed(item.name);
		const undoBtn = append(this.toastEl, $('button.aura-market-toast-undo')) as HTMLButtonElement;
		undoBtn.textContent = this.text.undo;
		this.toastDisposables.add(addDisposableListener(undoBtn, EventType.CLICK, () => {
			if (this.toastTimer) { clearTimeout(this.toastTimer); this.toastTimer = undefined; }
			this.toastEl.style.display = 'none';
			this.renderList(); // флаг не трогали — карточка возвращается
		}));
		this.toastEl.style.display = '';
		this.toastTimer = setTimeout(() => {
			this.toastTimer = undefined;
			this.toastEl.style.display = 'none';
			this.pluginService.uninstall(item.id);
		}, UNDO_TOAST_MS);
	}

	/** Занятое состояние кнопки: disabled + спиннер, ширина зафиксирована CSS (min-width). */
	private setBusy(btn: HTMLButtonElement, busy: boolean, label?: string): void {
		btn.disabled = busy;
		btn.classList.toggle('is-busy', busy);
		if (busy) {
			btn.textContent = '';
			append(btn, $('span.codicon.codicon-loading.codicon-modifier-spin'));
			if (label) { append(btn, $('span')).textContent = label; }
		}
	}

	/** FLIP: подложка сегмент-контрола едет к активной кнопке за 240ms. */
	private moveSegmentPill(target?: HTMLButtonElement, animate = true): void {
		if (!this.segEl) { return; }
		const active = target ?? this.segEl.querySelector<HTMLButtonElement>('.aura-market-seg-btn.active') ?? undefined;
		if (!active) { return; }
		const pill = this.segPillEl;
		const first = pill.getBoundingClientRect();
		pill.style.left = `${active.offsetLeft}px`;
		pill.style.width = `${active.offsetWidth}px`;
		if (!animate || prefersReducedMotion(active) || first.width === 0) { pill.style.transform = ''; return; }
		const last = pill.getBoundingClientRect();
		const dx = first.left - last.left;
		const sx = last.width > 0 ? first.width / last.width : 1;
		if (Math.abs(dx) < 1 && Math.abs(sx - 1) < 0.01) { return; }
		pill.style.transition = 'none';
		pill.style.transformOrigin = 'left center';
		pill.style.transform = `translateX(${dx}px) scaleX(${sx})`;
		void pill.offsetWidth;
		pill.style.transition = 'transform var(--dur-3, 240ms) var(--ease-out, cubic-bezier(.2,0,0,1))';
		pill.style.transform = '';
	}

	private renderList(): void {
		if (!this.listEl) { return; }
		this.renderDisposables.clear();

		// FLIP: запоминаем позиции существующих карточек перед перестроением сетки.
		const firstRects = new Map<string, DOMRect>();
		if (!prefersReducedMotion(this.listEl)) {
			for (const el of Array.from(this.listEl.querySelectorAll<HTMLElement>('.aura-market-card'))) {
				if (el.dataset.itemId) { firstRects.set(el.dataset.itemId, el.getBoundingClientRect()); }
			}
		}

		this.listEl.textContent = '';

		const items = auraMarketItems(this.languageService.language).filter(item => {
			if (this.activeFilter !== 'all' && item.kind !== this.activeFilter) { return false; }
			if (this.searchText) {
				const haystack = `${item.name} ${item.description} ${item.author ?? ''}`.toLowerCase();
				return haystack.includes(this.searchText);
			}
			return true;
		});

		if (items.length === 0) {
			append(this.listEl, $('.aura-market-empty')).textContent = this.text.empty;
			return;
		}

		for (const item of items) {
			this.renderCard(item);
		}

		// FLIP: существующие карточки доезжают до новых позиций, новые появляются без анимации.
		for (const el of Array.from(this.listEl.querySelectorAll<HTMLElement>('.aura-market-card'))) {
			const id = el.dataset.itemId;
			const first = id ? firstRects.get(id) : undefined;
			if (!first) { continue; }
			const last = el.getBoundingClientRect();
			const dx = first.left - last.left;
			const dy = first.top - last.top;
			if (Math.abs(dx) < 1 && Math.abs(dy) < 1) { continue; }
			el.style.transition = 'none';
			el.style.transform = `translate(${dx}px, ${dy}px)`;
			void el.offsetWidth;
			el.style.transition = 'transform var(--dur-3, 240ms) var(--ease-out, cubic-bezier(.2,0,0,1))';
			el.style.transform = '';
			setTimeout(() => { el.style.transition = ''; }, 300);
		}
	}

	private renderCard(item: IAuraMarketItem): void {
		const installed = this.isInstalled(item);
		const disabled = this.isDisabled(item);

		const card = append(this.listEl, $('.aura-market-card'));
		card.dataset.itemId = item.id;
		if (installed && disabled) { card.classList.add('is-disabled'); }

		const headerRow = append(card, $('.aura-market-card-header'));
		if (installed && !disabled) {
			// Факт установки — галочка у имени, а не псевдокнопка.
			append(headerRow, $('span.codicon.codicon-check.aura-market-card-check'));
		}
		append(headerRow, $('span.aura-market-card-name')).textContent = item.name;
		// Бейдж «Плагин» бесполезен (одинаков у всех) — оставляем только у наборов скилов.
		if (item.kind !== 'plugin') {
			const badge = append(headerRow, $('span.aura-market-item-badge'));
			badge.textContent = this.text.skillsetBadge;
			badge.classList.add('badge-skillset');
		}

		append(card, $('.aura-market-card-desc')).textContent = item.description;

		// AGGG: версия в мета-строке следует за выбором селектора.
		const version = item.id === 'aggg'
			? normalizeAgggVersion(this.configurationService.getValue<string>(AGGG_VERSION_SETTING))
			: item.version;
		append(card, $('.aura-market-card-meta')).textContent =
			[item.author, version ? `v${version}` : undefined, item.size].filter(Boolean).join(' · ');

		// AGGG: селектор версии ядра прямо в карточке (установленный плагин).
		if (item.id === 'aggg' && installed) {
			this.renderDisposables.add(this.instantiationService.createInstance(AgggVersionWidget, append(card, $('.aura-market-card-version'))));
		}

		const actions = append(card, $('.aura-market-card-actions'));
		if (!installed) {
			const installBtn = append(actions, $('button.aura-market-install')) as HTMLButtonElement;
			installBtn.textContent = this.text.install;
			this.renderDisposables.add(addDisposableListener(installBtn, EventType.CLICK, () => { void this.install(item, installBtn); }));
		} else if (disabled) {
			const enableBtn = append(actions, $('button.aura-market-install')) as HTMLButtonElement;
			enableBtn.textContent = this.text.enable;
			this.renderDisposables.add(addDisposableListener(enableBtn, EventType.CLICK, () => { void this.enable(item, enableBtn); }));
			const uninstallBtn = append(actions, $('button.aura-market-btn-ghost.aura-market-btn-danger')) as HTMLButtonElement;
			uninstallBtn.textContent = this.text.uninstall;
			this.renderDisposables.add(addDisposableListener(uninstallBtn, EventType.CLICK, () => { void this.uninstall(item, card); }));
		} else {
			const disableBtn = append(actions, $('button.aura-market-btn-ghost')) as HTMLButtonElement;
			disableBtn.textContent = this.text.disable;
			this.renderDisposables.add(addDisposableListener(disableBtn, EventType.CLICK, () => { void this.disable(item, disableBtn); }));
			const uninstallBtn = append(actions, $('button.aura-market-btn-ghost.aura-market-btn-danger')) as HTMLButtonElement;
			uninstallBtn.textContent = this.text.uninstall;
			this.renderDisposables.add(addDisposableListener(uninstallBtn, EventType.CLICK, () => { void this.uninstall(item, card); }));
		}

		if (item.docs) {
			// Документация открывается читалкой-оверлеем поверх вкладки: сетка карточек
			// не перестраивается и новая вкладка редактора не создаётся.
			const docsBtn = append(actions, $('button.aura-market-btn-ghost')) as HTMLButtonElement;
			append(docsBtn, $('span.codicon.codicon-book'));
			append(docsBtn, $('span')).textContent = this.text.docs;
			this.renderDisposables.add(addDisposableListener(docsBtn, EventType.CLICK, () => this.openDocsReader(item)));
		}

		if (item.versions?.length) {
			const versionsBtn = append(actions, $('button.aura-market-btn-ghost')) as HTMLButtonElement;
			versionsBtn.textContent = this.expandedVersions.has(item.id) ? this.text.hideVersions : this.text.versions(item.versions.length);
			this.renderDisposables.add(addDisposableListener(versionsBtn, EventType.CLICK, () => {
				if (this.expandedVersions.has(item.id)) { this.expandedVersions.delete(item.id); } else { this.expandedVersions.add(item.id); }
				this.renderList();
			}));
		}

		if (item.versions?.length && this.expandedVersions.has(item.id)) {
			const versionsEl = append(card, $('.aura-market-versions'));
			for (const v of item.versions) {
				const row = append(versionsEl, $('.aura-market-version'));
				const head = append(row, $('.aura-market-version-head'));
				append(head, $('span.aura-market-version-num')).textContent = `v${v.version}`;
				if (v.version === item.version) { append(head, $('span.aura-market-version-latest')).textContent = this.text.latest; }
				append(head, $('span.aura-market-version-date')).textContent = v.date;
				const list = append(row, $('ul.aura-market-version-log'));
				for (const line of v.changelog) {
					append(list, $('li')).textContent = line;
				}
			}
		}
	}

	/**
	 * Читалка документации: оверлей поверх вкладки Market на всю высоту.
	 * Закрывается кнопкой, Esc или кликом по затемнённому фону.
	 */
	private openDocsReader(item: IAuraMarketItem): void {
		this.closeDocsReader();

		const overlay = append(this.rootEl, $('.aura-market-reader'));
		overlay.tabIndex = -1;
		overlay.setAttribute('role', 'dialog');
		overlay.setAttribute('aria-modal', 'true');
		overlay.setAttribute('aria-label', this.text.docsReaderLabel(item.name));
		const panel = append(overlay, $('.aura-market-reader-panel'));

		// Шапка читалки — идентичность плагина, а не только имя: иконка, версия,
		// автор и размер видны сразу, до прокрутки тела документации.
		const head = append(panel, $('.aura-market-reader-head'));
		append(head, $('span.codicon.codicon-book.aura-market-reader-icon'));
		const heading = append(head, $('.aura-market-reader-heading'));
		append(heading, $('span.aura-market-reader-title')).textContent = item.name;
		const meta = [item.author, item.version ? `v${item.version}` : undefined, item.size].filter(Boolean).join(' · ');
		if (meta) { append(heading, $('span.aura-market-reader-meta')).textContent = meta; }
		const closeBtn = append(head, $('button.aura-market-btn-ghost.aura-market-reader-close')) as HTMLButtonElement;
		append(closeBtn, $('span.codicon.codicon-close'));
		append(closeBtn, $('span')).textContent = this.text.close;

		const body = append(panel, $('.aura-market-reader-body.aura-market-docs-body'));
		const markdown = new MarkdownString(normalizeDocsText(item.docs ?? ''), { isTrusted: false, supportThemeIcons: true });
		this.readerDisposables.add(renderMarkdown(markdown, {}, body));

		this.readerDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => this.closeDocsReader()));
		this.readerDisposables.add(addDisposableListener(overlay, EventType.KEY_DOWN, e => {
			if (new StandardKeyboardEvent(e).keyCode === KeyCode.Escape) { this.closeDocsReader(); }
		}));
		this.readerDisposables.add(addDisposableListener(overlay, EventType.CLICK, e => {
			if (e.target === overlay) { this.closeDocsReader(); }
		}));
		this.readerDisposables.add(toDisposable(() => overlay.remove()));

		overlay.focus();
		// Появление — со следующего кадра (fade фона + подъём панели).
		getWindow(overlay).requestAnimationFrame(() => overlay.classList.add('open'));
	}

	private closeDocsReader(): void {
		this.readerDisposables.clear();
	}

	override layout(dimension: Dimension): void {
		// Сетка резиновая; переставляем только подложку сегмент-контрола без анимации.
		void dimension;
		this.moveSegmentPill(undefined, false);
	}
}
