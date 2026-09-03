/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/auraMarket.css';
import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';

export const AURA_MARKET_VIEW_ID = 'auraMarket.browser';

export interface IAuraMarketItem {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly kind: 'plugin' | 'skillset';
	readonly version?: string;
	readonly author?: string;
}

/**
 * Каталог Aura Market.
 *
 * Чтобы добавить свои плагины и наборы скилов — просто допишите элементы
 * в этот массив (kind: 'plugin' для плагина, 'skillset' для набора скилов).
 * Позже его можно заменить загрузкой из JSON-файла или с вашего сервера.
 */
const AURA_MARKET_ITEMS: IAuraMarketItem[] = [
	// Примеры — удалите, когда добавите свои:
	{ id: 'example.hello-world', name: 'Hello World Plugin', description: 'Пример плагина — замените на свой', kind: 'plugin', version: '0.1.0', author: 'Aura' },
	{ id: 'example.starter-skills', name: 'Starter Skills Pack', description: 'Пример набора скилов — замените на свой', kind: 'skillset', author: 'Aura' },
];

type MarketFilter = 'all' | 'plugin' | 'skillset';

export class AuraMarketViewPane extends ViewPane {

	private activeFilter: MarketFilter = 'all';
	private searchText = '';
	private listContainer!: HTMLElement;
	private chipsContainer!: HTMLElement;

	constructor(
		options: IViewletViewOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(options as IViewPaneOptions, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const root = append(container, $('.aura-market-view'));

		// Поиск
		const searchBox = append(root, $('.aura-market-search'));
		const searchInput = append(searchBox, $('input.aura-market-search-input')) as HTMLInputElement;
		searchInput.type = 'text';
		searchInput.placeholder = localize('auraMarket.searchPlaceholder', "Поиск в Aura Market...");
		this._register(addDisposableListener(searchInput, EventType.INPUT, () => {
			this.searchText = searchInput.value.trim().toLowerCase();
			this.renderList();
		}));

		// Фильтры: Все / Плагины / Наборы скилов
		this.chipsContainer = append(root, $('.aura-market-chips'));
		const chips: Array<{ filter: MarketFilter; label: string }> = [
			{ filter: 'all', label: localize('auraMarket.filter.all', "Все") },
			{ filter: 'plugin', label: localize('auraMarket.filter.plugins', "Плагины") },
			{ filter: 'skillset', label: localize('auraMarket.filter.skillsets', "Наборы скилов") },
		];
		for (const chip of chips) {
			const el = append(this.chipsContainer, $('button.aura-market-chip'));
			el.textContent = chip.label;
			el.dataset.filter = chip.filter;
			this._register(addDisposableListener(el, EventType.CLICK, () => {
				this.activeFilter = chip.filter;
				for (const other of Array.from(this.chipsContainer.querySelectorAll('.aura-market-chip'))) {
					other.classList.toggle('active', (other as HTMLElement).dataset.filter === chip.filter);
				}
				this.renderList();
			}));
			if (chip.filter === this.activeFilter) {
				el.classList.add('active');
			}
		}

		// Список
		this.listContainer = append(root, $('.aura-market-list'));
		this.renderList();
	}

	private getFilteredItems(): IAuraMarketItem[] {
		return AURA_MARKET_ITEMS.filter(item => {
			if (this.activeFilter !== 'all' && item.kind !== this.activeFilter) {
				return false;
			}
			if (this.searchText) {
				const haystack = `${item.name} ${item.description} ${item.author ?? ''}`.toLowerCase();
				return haystack.includes(this.searchText);
			}
			return true;
		});
	}

	private renderList(): void {
		if (!this.listContainer) {
			return;
		}
		this.listContainer.textContent = '';

		const items = this.getFilteredItems();
		if (items.length === 0) {
			const empty = append(this.listContainer, $('.aura-market-empty'));
			empty.textContent = localize('auraMarket.empty', "Здесь пока пусто. Добавьте свои плагины в каталог Aura Market.");
			return;
		}

		for (const item of items) {
			const row = append(this.listContainer, $('.aura-market-item'));

			const header = append(row, $('.aura-market-item-header'));
			const name = append(header, $('span.aura-market-item-name'));
			name.textContent = item.name;
			const badge = append(header, $('span.aura-market-item-badge'));
			badge.textContent = item.kind === 'plugin'
				? localize('auraMarket.kind.plugin', "Плагин")
				: localize('auraMarket.kind.skillset', "Наборы скилов");
			badge.classList.add(item.kind === 'plugin' ? 'badge-plugin' : 'badge-skillset');

			const description = append(row, $('.aura-market-item-description'));
			description.textContent = item.description;

			const meta = append(row, $('.aura-market-item-meta'));
			meta.textContent = [item.author, item.version ? `v${item.version}` : undefined].filter(Boolean).join(' · ');

			const installButton = append(row, $('button.aura-market-install'));
			installButton.textContent = localize('auraMarket.install', "Установить");
			this._register(addDisposableListener(installButton, EventType.CLICK, () => {
				this.notificationService.info(localize('auraMarket.comingSoon', "«{0}»: установка из Aura Market будет подключена следующим шагом.", item.name));
			}));
		}
	}
}
