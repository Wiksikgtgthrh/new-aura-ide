/*---------------------------------------------------------------------------------------------
 *  AGGG — виджет выбора версии ядра (2.0.0 встроенное / 5.2 внешний агент).
 *  Используется в панели AGGG и в карточке AGGG в Aura Market.
 *  Путь к внешнему агенту читается из настройки aggg.externalAgentPath — в коде
 *  никаких хардкод-путей.
 *--------------------------------------------------------------------------------------------*/

import { $, append, addDisposableListener } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { SelectBox } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { defaultSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { AGGG_VERSION_SETTING, AGGG_EXTERNAL_AGENT_PATH_SETTING, normalizeAgggVersion } from '../common/agggBoost.js';
import { AGGG_ROOT_MARKERS } from '../common/agggModel.js';
import { AGGG_EXTERNAL_VERSION, agggVersionAvailable, agggVersionOptionKind, resolveAgggVersion } from '../common/agggEntitlements.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { queryAgggAgentPath, queryAgggFeatures } from './agggVersionGate.js';
import { IAuraLanguageService } from '../../auraI18n/common/auraLanguage.js';

/** Версии ядра: порядок фиксирован, выбор мапится по индексу. */
const AGGG_VERSION_VALUES: readonly string[] = ['2.0.0', AGGG_EXTERNAL_VERSION];

export class AgggVersionWidget extends Disposable {

	private readonly selectBox: SelectBox;
	private readonly warnRow: HTMLElement;
	private readonly pathLabel: HTMLElement;
	/** Возможности аккаунта: до ответа прав нет — 5.2 закрыта, пока сервер не разрешит. */
	private features: readonly string[] = [];
	/** Путь к ядру, доставленному сервером Team (когда aggg.externalAgentPath пуст). */
	private serverRoot: string | undefined;

	constructor(
		container: HTMLElement,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextViewService contextViewService: IContextViewService,
		@IFileService private readonly fileService: IFileService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@IAuraLanguageService private readonly language: IAuraLanguageService,
	) {
		super();

		const row = append(container, $('.aggg-version-row'));
		// Виджет рисуется и в карточке Aura Market, поэтому его текст идёт через тот же
		// переключатель языка, что и сам маркет, а не через хардкод на русском.
		append(row, $('span.aggg-version-label')).textContent = this.language.t('Версия ядра', 'Core version');
		const current = normalizeAgggVersion(this.configurationService.getValue<string>(AGGG_VERSION_SETTING));
		this.selectBox = this._register(new SelectBox(
			this.optionLabels(),
			AGGG_VERSION_VALUES.indexOf(current),
			contextViewService,
			defaultSelectBoxStyles,
		));
		this.selectBox.render(row);
		this._register(this.selectBox.onDidSelect(e => {
			const picked = AGGG_VERSION_VALUES[e.index];
			if (!picked) { return; }
			// Закрытую версию не записываем в настройку: выбор возвращается к текущей.
			if (!agggVersionAvailable(picked, this.features)) {
				this.syncFromConfig();
				this.notificationService.notify({
					severity: Severity.Info,
					message: this.language.t('AGGG 5.2 доступна по лицензии: право выдаётся аккаунту на стороне Team.', 'AGGG 5.2 is available under a licence: the entitlement is granted to the account on the Team side.'),
				});
				return;
			}
			void this.configurationService.updateValue(AGGG_VERSION_SETTING, picked, ConfigurationTarget.USER);
		}));
		void this.refreshEntitlements();

		this.warnRow = append(container, $('.aggg-version-warn'));
		this.warnRow.style.display = 'none';
		this.pathLabel = append(this.warnRow, $('span.aggg-version-warn-text'));
		const pickBtn = append(this.warnRow, $('button.aggg-version-pick')) as HTMLButtonElement;
		pickBtn.textContent = this.language.t('Указать путь…', 'Choose path…');
		this._register(addDisposableListener(pickBtn, 'click', () => { void this.pickPath(); }));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGGG_VERSION_SETTING) || e.affectsConfiguration(AGGG_EXTERNAL_AGENT_PATH_SETTING)) {
				this.syncFromConfig();
			}
		}));
		this.syncFromConfig();
	}

	/** Текущая выбранная версия. */
	get version(): string {
		return normalizeAgggVersion(this.configurationService.getValue<string>(AGGG_VERSION_SETTING));
	}

	/** Подписи версий: закрытая 5.2 помечена, а не спрятана — пользователь видит, что она есть. */
	private optionLabels(): { text: string }[] {
		return AGGG_VERSION_VALUES.map(value => ({
			text: agggVersionOptionKind(value, this.features) === 'external-locked'
				? this.language.t('5.2 — внешний агент (по лицензии)', '5.2 — external agent (licensed)')
				: value === AGGG_EXTERNAL_VERSION
					? this.language.t('5.2 — внешний агент', '5.2 — external agent')
					: this.language.t('2.0.0 — встроенное ядро', '2.0.0 — bundled core'),
		}));
	}

	/** Права аккаунта приходят от расширения Team; без него 5.2 остаётся закрытой. */
	private async refreshEntitlements(): Promise<void> {
		const features = await queryAgggFeatures(this.commandService);
		if (features.length === this.features.length) { return; }
		this.features = features;
		this.syncFromConfig();
	}

	private syncFromConfig(): void {
		const current = this.version;
		this.selectBox.setOptions(this.optionLabels(), AGGG_VERSION_VALUES.indexOf(current));
		void this.refreshWarn();
	}

	/**
	 * Откуда берётся ядро 5.2: путь из настроек или поставка, которую расширение Team
	 * скачало с сервера по праву. Локально хранить ядро не обязательно.
	 */
	private async agentRoot(): Promise<string | undefined> {
		const configured = (this.configurationService.getValue<string>(AGGG_EXTERNAL_AGENT_PATH_SETTING) ?? '').trim();
		if (configured) { this.serverRoot = undefined; return configured; }
		const bundled = await queryAgggAgentPath(this.commandService);
		this.serverRoot = bundled;
		return bundled;
	}

	/** Проверка каталога внешнего агента: существует и содержит манифест AGGG (маркерные файлы). */
	async probeExternalAgent(): Promise<{ ok: boolean; missing: string[] }> {
		const root = await this.agentRoot();
		if (!root) { return { ok: false, missing: [...AGGG_ROOT_MARKERS] }; }
		const missing: string[] = [];
		for (const marker of AGGG_ROOT_MARKERS) {
			try {
				if (!await this.fileService.exists(joinPath(URI.file(root), ...marker.split('/')))) {
					missing.push(marker);
				}
			} catch {
				missing.push(marker);
			}
		}
		return { ok: missing.length === 0, missing };
	}

	private async refreshWarn(): Promise<void> {
		const decision = resolveAgggVersion(this.version, this.features);
		this.warnRow.dataset.blocked = decision.blocked ? 'license' : '';
		if (this.version !== AGGG_EXTERNAL_VERSION) {
			this.warnRow.style.display = 'none';
			return;
		}
		const probe = await this.probeExternalAgent();
		if (probe.ok) {
			// Ядро на месте: если его отдал сервер, говорим об этом прямо — путь
			// в настройках у такого пользователя пуст, и это нормально.
			this.warnRow.style.display = this.serverRoot ? '' : 'none';
			if (this.serverRoot) { this.pathLabel.textContent = this.language.t('Ядро 5.2 получено с сервера Team по праву аккаунта', 'The 5.2 core was delivered by the Team server under the account entitlement'); }
			return;
		}
		this.warnRow.style.display = '';
		this.pathLabel.textContent = this.serverRoot
			? this.language.t('Сервер отдал неполную поставку ядра — проверьте право и AURA_AGGG_CORE_PATH', 'The server delivered an incomplete core bundle — check the entitlement and AURA_AGGG_CORE_PATH')
			: this.language.t('Каталог агента не найден', 'Agent directory not found');
	}

	private async pickPath(): Promise<void> {
		const picked = await this.fileDialogService.showOpenDialog({
			title: this.language.t('Каталог внешнего агента AGGG 5.2', 'AGGG 5.2 external agent directory'),
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
		});
		if (picked?.[0]) {
			await this.configurationService.updateValue(AGGG_EXTERNAL_AGENT_PATH_SETTING, picked[0].fsPath, ConfigurationTarget.USER);
		}
	}
}
