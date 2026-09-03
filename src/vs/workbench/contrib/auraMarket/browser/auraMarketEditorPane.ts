/*---------------------------------------------------------------------------------------------
 *  Aura Market — центральная вкладка: поиск, фильтры, карточки с документацией и установкой.
 *--------------------------------------------------------------------------------------------*/

import './media/auraMarket.css';
import { $, append, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { AuraMarketEditorInput } from './auraMarketEditorInput.js';
import { AURA_MARKET_ITEMS, AuraMarketFilter, IAuraMarketItem, auraMarketInstalledKey } from '../common/auraMarketCatalog.js';

export class AuraMarketEditorPane extends EditorPane {

	static readonly ID = AuraMarketEditorInput.ID;

	private searchText = '';
	private activeFilter: AuraMarketFilter = 'all';
	private listEl!: HTMLElement;
	private chipsEl!: HTMLElement;
	private readonly expandedDocs = new Set<string>();

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly marketStorage: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(AuraMarketEditorPane.ID, group, telemetryService, themeService, marketStorage);
	}

	protected override createEditor(parent: HTMLElement): void {
		const root = append(parent, $('.aura-market-tab'));

		const header = append(root, $('.aura-market-tab-header'));
		append(header, $('h2.aura-market-tab-title')).textContent = 'Aura Market';
		append(header, $('p.aura-market-tab-subtitle')).textContent = 'Плагины и наборы скилов Aura IDE';

		const searchWrap = append(root, $('.aura-market-search'));
		const search = append(searchWrap, $('input.aura-market-search-input')) as HTMLInputElement;
		search.type = 'text';
		search.placeholder = 'Поиск в Aura Market...';
		this._register(addDisposableListener(search, EventType.INPUT, () => {
			this.searchText = search.value.trim().toLowerCase();
			this.renderList();
		}));

		this.chipsEl = append(root, $('.aura-market-chips'));
		const chips: Array<{ filter: AuraMarketFilter; label: string }> = [
			{ filter: 'all', label: 'Все' },
			{ filter: 'plugin', label: 'Плагины' },
			{ filter: 'skillset', label: 'Наборы скилов' },
		];
		for (const chip of chips) {
			const el = append(this.chipsEl, $('button.aura-market-chip')) as HTMLButtonElement;
			el.textContent = chip.label;
			el.dataset.filter = chip.filter;
			if (chip.filter === this.activeFilter) { el.classList.add('active'); }
			this._register(addDisposableListener(el, EventType.CLICK, () => {
				this.activeFilter = chip.filter;
				for (const other of Array.from(this.chipsEl.querySelectorAll('.aura-market-chip'))) {
					(other as HTMLElement).classList.toggle('active', (other as HTMLElement).dataset.filter === chip.filter);
				}
				this.renderList();
			}));
		}

		this.listEl = append(root, $('.aura-market-tab-list'));
		this.renderList();
	}

	private isInstalled(item: IAuraMarketItem): boolean {
		return this.marketStorage.get(auraMarketInstalledKey(item.id), StorageScope.APPLICATION, 'false') === 'true';
	}

	private install(item: IAuraMarketItem, btn: HTMLButtonElement): void {
		if (!item.builtinId) {
			this.notificationService.info(`«${item.name}»: загрузка этого плагина будет подключена следующим шагом.`);
			return;
		}
		this.marketStorage.store(auraMarketInstalledKey(item.id), 'true', StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.notificationService.prompt(
			Severity.Info,
			`«${item.name}» установлен. Перезагрузите окно, чтобы активировать плагин.`,
			[{
				label: 'Перезагрузить окно',
				run: () => { void this.commandService.executeCommand('workbench.action.reloadWindow'); },
			}],
		);
		btn.textContent = 'Установлено ✓';
		btn.disabled = true;
		btn.classList.add('installed');
	}

	private renderList(): void {
		if (!this.listEl) { return; }
		this.listEl.textContent = '';

		const items = AURA_MARKET_ITEMS.filter(item => {
			if (this.activeFilter !== 'all' && item.kind !== this.activeFilter) { return false; }
			if (this.searchText) {
				const haystack = `${item.name} ${item.description} ${item.author ?? ''}`.toLowerCase();
				return haystack.includes(this.searchText);
			}
			return true;
		});

		if (items.length === 0) {
			append(this.listEl, $('.aura-market-empty')).textContent = 'Ничего не найдено.';
			return;
		}

		for (const item of items) {
			const card = append(this.listEl, $('.aura-market-card'));

			const headerRow = append(card, $('.aura-market-card-header'));
			append(headerRow, $('span.aura-market-card-name')).textContent = item.name;
			const badge = append(headerRow, $('span.aura-market-item-badge'));
			badge.textContent = item.kind === 'plugin' ? 'Плагин' : 'Наборы скилов';
			badge.classList.add(item.kind === 'plugin' ? 'badge-plugin' : 'badge-skillset');

			append(card, $('.aura-market-card-desc')).textContent = item.description;
			append(card, $('.aura-market-card-meta')).textContent =
				[item.author, item.version ? `v${item.version}` : undefined].filter(Boolean).join(' · ');

			const actions = append(card, $('.aura-market-card-actions'));
			const installBtn = append(actions, $('button.aura-market-install')) as HTMLButtonElement;
			const installed = this.isInstalled(item);
			installBtn.textContent = installed ? 'Установлено ✓' : 'Установить';
			installBtn.disabled = installed;
			if (installed) { installBtn.classList.add('installed'); }
			this._register(addDisposableListener(installBtn, EventType.CLICK, () => this.install(item, installBtn)));

			if (item.docs) {
				const docsBtn = append(actions, $('button.aura-api-btn-small')) as HTMLButtonElement;
				docsBtn.textContent = this.expandedDocs.has(item.id) ? 'Скрыть документацию' : 'Документация';
				this._register(addDisposableListener(docsBtn, EventType.CLICK, () => {
					if (this.expandedDocs.has(item.id)) { this.expandedDocs.delete(item.id); } else { this.expandedDocs.add(item.id); }
					this.renderList();
				}));
			}

			if (item.docs && this.expandedDocs.has(item.id)) {
				append(card, $('pre.aura-market-docs')).textContent = item.docs;
			}
		}
	}

	override layout(_dimension: import('../../../../base/browser/dom.js').Dimension): void {
		// Вёрстка резиновая (flex), перерисовка по размеру не требуется.
	}
}
