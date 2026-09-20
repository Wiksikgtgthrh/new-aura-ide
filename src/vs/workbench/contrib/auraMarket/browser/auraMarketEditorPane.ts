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
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { AuraMarketEditorInput } from './auraMarketEditorInput.js';
import { AURA_MARKET_ITEMS, AuraMarketFilter, IAuraMarketItem, auraMarketInstalledKey, auraMarketDisabledKey } from '../common/auraMarketCatalog.js';

export class AuraMarketEditorPane extends EditorPane {

	static readonly ID = AuraMarketEditorInput.ID;

	private searchText = '';
	private activeFilter: AuraMarketFilter = 'all';
	private listEl!: HTMLElement;
	private chipsEl!: HTMLElement;
	private readonly expandedDocs = new Set<string>();
	private readonly expandedVersions = new Set<string>();

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly marketStorage: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super(AuraMarketEditorPane.ID, group, telemetryService, themeService, marketStorage);
	}

	protected override createEditor(parent: HTMLElement): void {
		const root = append(parent, $('.aura-market-tab'));

		const header = append(root, $('.aura-market-tab-header'));
		append(header, $('h2.aura-market-tab-title')).textContent = 'Market';
		append(header, $('p.aura-market-tab-subtitle')).textContent = 'Плагины, инструменты и наборы скилов';

		const searchWrap = append(root, $('.aura-market-search'));
		const search = append(searchWrap, $('input.aura-market-search-input')) as HTMLInputElement;
		search.setAttribute('aria-label', 'Search Market');
		search.type = 'text';
		search.placeholder = 'Поиск...';
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

	/** Плагин установлен, но временно отключён (иконка/функции скрыты до включения). */
	private isDisabled(item: IAuraMarketItem): boolean {
		return this.marketStorage.get(auraMarketDisabledKey(item.id), StorageScope.APPLICATION, 'false') === 'true';
	}

	private async install(item: IAuraMarketItem, btn: HTMLButtonElement): Promise<void> {
		// Тяжёлые плагины: предупреждаем, что установится вместе с toolchain.
		if (!this.isInstalled(item) && item.size && /ГБ|GB/i.test(item.size)) {
			const choice = await this.dialogService.confirm({
				type: 'warning',
				title: item.name,
				message: `«${item.name}» требует загрузки инструментов: ${item.size}. Продолжить установку?`,
				primaryButton: 'Установить',
				cancelButton: 'Отмена'
			});
			if (!choice.confirmed) { return; }
		}
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

	/** Временное отключение: флаг остаётся, иконка/функции пропадают до включения. */
	private async disable(item: IAuraMarketItem, btn: HTMLButtonElement): Promise<void> {
		this.marketStorage.store(auraMarketDisabledKey(item.id), 'true', StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.notificationService.prompt(
			Severity.Info,
			`«${item.name}» отключён. Перезагрузите окно — иконка и функции пропадут, пока не включите плагин снова.`,
			[{
				label: 'Перезагрузить окно',
				run: () => { void this.commandService.executeCommand('workbench.action.reloadWindow'); },
			}],
		);
		btn.textContent = 'Включить';
	}

	/** Включение обратно после отключения. */
	private async enable(item: IAuraMarketItem, btn: HTMLButtonElement): Promise<void> {
		this.marketStorage.remove(auraMarketDisabledKey(item.id), StorageScope.APPLICATION);
		this.notificationService.prompt(
			Severity.Info,
			`«${item.name}» включён. Перезагрузите окно, чтобы вернуть иконку и функции.`,
			[{
				label: 'Перезагрузить окно',
				run: () => { void this.commandService.executeCommand('workbench.action.reloadWindow'); },
			}],
		);
		btn.textContent = 'Отключить';
	}

	/** Удаление: сбрасывает флаг установки и предлагает перезагрузить окно. */
	private async uninstall(item: IAuraMarketItem, btn: HTMLButtonElement): Promise<void> {
		const choice = await this.dialogService.confirm({
			type: 'question',
			title: item.name,
			message: `Удалить плагин «${item.name}»? Иконка и функции пропадут после перезагрузки окна. Настройки сохранятся.`,
			primaryButton: 'Удалить',
			cancelButton: 'Отмена'
		});
		if (!choice.confirmed) { return; }
		this.marketStorage.remove(auraMarketInstalledKey(item.id), StorageScope.APPLICATION);
		this.notificationService.prompt(
			Severity.Info,
			`«${item.name}» удалён. Перезагрузите окно, чтобы применить изменения.`,
			[{
				label: 'Перезагрузить окно',
				run: () => { void this.commandService.executeCommand('workbench.action.reloadWindow'); },
			}],
		);
		btn.textContent = 'Установить';
		btn.disabled = false;
		btn.classList.remove('installed');
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
				[item.author, item.version ? `v${item.version}` : undefined, item.size].filter(Boolean).join(' · ');

			const actions = append(card, $('.aura-market-card-actions'));
			const disabled = this.isDisabled(item);
			const installBtn = append(actions, $('button.aura-market-install')) as HTMLButtonElement;
			const installed = this.isInstalled(item);
			installBtn.textContent = !installed ? 'Установить' : disabled ? 'Включить' : 'Установлено ✓';
			installBtn.disabled = installed && !disabled;
			if (installed && !disabled) { installBtn.classList.add('installed'); }
			this._register(addDisposableListener(installBtn, EventType.CLICK, () => {
				if (!installed) { void this.install(item, installBtn); }
				else if (disabled) { void this.enable(item, installBtn); }
			}));

			// «Отключить» у установленного: временно прячет иконку/функции до включения.
			if (installed && !disabled) {
				const disableBtn = append(actions, $('button.aura-api-btn-small')) as HTMLButtonElement;
				disableBtn.textContent = 'Отключить';
				this._register(addDisposableListener(disableBtn, EventType.CLICK, () => { void this.disable(item, disableBtn); }));
				const uninstallBtn = append(actions, $('button.aura-api-btn-small')) as HTMLButtonElement;
				uninstallBtn.textContent = 'Удалить';
				this._register(addDisposableListener(uninstallBtn, EventType.CLICK, () => { void this.uninstall(item, uninstallBtn); }));
			}

			if (item.docs) {
				const docsBtn = append(actions, $('button.aura-api-btn-small')) as HTMLButtonElement;
				docsBtn.textContent = this.expandedDocs.has(item.id) ? 'Скрыть документацию' : 'Документация';
				this._register(addDisposableListener(docsBtn, EventType.CLICK, () => {
					if (this.expandedDocs.has(item.id)) { this.expandedDocs.delete(item.id); } else { this.expandedDocs.add(item.id); }
					this.renderList();
				}));
			}

			// История версий — как в расширениях VS Code: кнопка + разворачиваемый список.
			if (item.versions?.length) {
				const versionsBtn = append(actions, $('button.aura-api-btn-small')) as HTMLButtonElement;
				versionsBtn.textContent = this.expandedVersions.has(item.id) ? 'Скрыть версии' : `Версии (${item.versions.length})`;
				this._register(addDisposableListener(versionsBtn, EventType.CLICK, () => {
					if (this.expandedVersions.has(item.id)) { this.expandedVersions.delete(item.id); } else { this.expandedVersions.add(item.id); }
					this.renderList();
				}));
			}

			if (item.docs && this.expandedDocs.has(item.id)) {
				append(card, $('pre.aura-market-docs')).textContent = item.docs;
			}

			if (item.versions?.length && this.expandedVersions.has(item.id)) {
				const versionsEl = append(card, $('.aura-market-versions'));
				for (const v of item.versions) {
					const row = append(versionsEl, $('.aura-market-version'));
					const head = append(row, $('.aura-market-version-head'));
					append(head, $('span.aura-market-version-num')).textContent = `v${v.version}`;
					if (v.version === item.version) { append(head, $('span.aura-market-version-latest')).textContent = 'последняя'; }
					append(head, $('span.aura-market-version-date')).textContent = v.date;
					const list = append(row, $('ul.aura-market-version-log'));
					for (const line of v.changelog) {
						append(list, $('li')).textContent = line;
					}
				}
			}
		}
	}

	override layout(_dimension: import('../../../../base/browser/dom.js').Dimension): void {
		// Вёрстка резиновая (flex), перерисовка по размеру не требуется.
	}
}
