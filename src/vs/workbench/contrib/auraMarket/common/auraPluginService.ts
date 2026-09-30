/*---------------------------------------------------------------------------------------------
 *  Aura Plugin Service — единое состояние установленных/включённых плагинов Aura Market.
 *  Хранилище истины — application storage (флаги auraMarket.installed/disabled);
 *  сервис транслирует изменения в context keys `auraPlugin.<id>.enabled` и событие
 *  onDidChangeEnablement, чтобы иконки activity bar появлялись/исчезали без перезагрузки окна.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { auraMarketInstalledKey, auraMarketDisabledKey } from './auraMarketCatalog.js';

export const IAuraPluginService = createDecorator<IAuraPluginService>('auraPluginService');

/** Context key включённости плагина: `auraPlugin.<id>.enabled`. */
export function auraPluginEnabledContextKey(pluginId: string): string {
	return `auraPlugin.${pluginId}.enabled`;
}

export interface IAuraPluginService {
	readonly _serviceBrand: undefined;

	/** Изменилась включённость плагина (enable/disable/uninstall/install). */
	readonly onDidChangeEnablement: Event<string>;

	/** Плагин установлен через Market (независимо от включённости). */
	isInstalled(pluginId: string): boolean;
	/** Плагин установлен и не отключён. */
	isEnabled(pluginId: string): boolean;

	setEnabled(pluginId: string, enabled: boolean): void;
	setInstalled(pluginId: string, installed: boolean): void;
	/** Удаление: сброс флагов Market + очистка известных ключей стораджа плагина. */
	uninstall(pluginId: string): void;

	/** Выражение `auraPlugin.<id>.enabled == true` для when-клауз. */
	enabledWhen(pluginId: string): ContextKeyExpr;
}

/** Стордж-ключи, которые плагин хочет зачищать при удалении (помимо флагов Market). */
const PLUGIN_STORAGE_CLEANUP: Readonly<Record<string, readonly string[]>> = {
	// Прежние ключи («auraApi») чистим тоже: они остались от версии до переименования id.
	'api-keys': ['apiKeys.chat.selectedKeyId', 'auraApi.chat.selectedKeyId'],
};

/**
 * Плагины, встроенные в сборку и считающиеся установленными по умолчанию
 * (их функции доступны до явной установки через Market — например BYOK-ключи чата).
 * Отключение через Market действует и на них.
 *
 * aura-kotlin включён здесь, потому что его панель Android гейтится контекстным
 * ключом `auraPlugin.aura-kotlin.enabled`: без этого флага у встроенного
 * расширения не было ни иконки в activity bar, ни viewsWelcome, ни онбординга —
 * открыв Android-проект, пользователь видел пустую IDE и не знал о плагине.
 *
 * aura-team и langgraph-orchestrator тоже встроены в сборку и исторически
 * работали всегда: без флага по умолчанию их вьюхи (when: auraPlugin.<id>.enabled)
 * исчезли бы у пользователя после обновления.
 *
 * aggg включён по той же причине: обвязка включается настройкой `aggg.enabled`
 * (и `aggg.projectBoost`), а интерфейса у неё до установки не было вовсе —
 * селектор версии ядра маркет рендерит только у установленного плагина
 * (auraMarketEditorPane), поэтому внешнее ядро нельзя было даже выбрать,
 * а индикатора в статус-баре и команды «Переключить буст» не было тем более.
 * Отключение через Market по-прежнему гасит плагин: индикатор, команду и гейты.
 */
const DEFAULT_INSTALLED_PLUGINS: ReadonlySet<string> = new Set(['api-keys', 'aura-kotlin', 'aura-team', 'langgraph-orchestrator', 'aggg']);

export class AuraPluginService extends Disposable implements IAuraPluginService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeEnablement = this._register(new Emitter<string>());
	readonly onDidChangeEnablement = this._onDidChangeEnablement.event;

	/** Кэш состояния, чтобы стрелять событием только при реальной смене. */
	private readonly enabledCache = new Map<string, boolean>();
	private readonly contextKeys = new Map<string, IContextKey<boolean>>();
	private readonly knownPlugins = new Set<string>();

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super();
		const storageListener = this._register(new DisposableStore());
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, undefined, storageListener)(e => {
			const match = /^auraMarket\.(?:installed|disabled)\.(.+)$/.exec(e.key);
			if (match) {
				this.refresh(match[1]);
			}
		}));
	}

	isInstalled(pluginId: string): boolean {
		const stored = this.storageService.get(auraMarketInstalledKey(pluginId), StorageScope.APPLICATION);
		if (stored === undefined) {
			return DEFAULT_INSTALLED_PLUGINS.has(pluginId);
		}
		return stored === 'true';
	}

	isEnabled(pluginId: string): boolean {
		return this.isInstalled(pluginId)
			&& this.storageService.get(auraMarketDisabledKey(pluginId), StorageScope.APPLICATION, 'false') !== 'true';
	}

	setEnabled(pluginId: string, enabled: boolean): void {
		this.knownPlugins.add(pluginId);
		if (enabled) {
			this.storageService.remove(auraMarketDisabledKey(pluginId), StorageScope.APPLICATION);
		} else {
			this.storageService.store(auraMarketDisabledKey(pluginId), 'true', StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		this.refresh(pluginId);
	}

	setInstalled(pluginId: string, installed: boolean): void {
		this.knownPlugins.add(pluginId);
		if (installed) {
			this.storageService.store(auraMarketInstalledKey(pluginId), 'true', StorageScope.APPLICATION, StorageTarget.MACHINE);
		} else {
			this.uninstall(pluginId);
			return;
		}
		this.refresh(pluginId);
	}

	uninstall(pluginId: string): void {
		this.knownPlugins.add(pluginId);
		this.storageService.remove(auraMarketInstalledKey(pluginId), StorageScope.APPLICATION);
		this.storageService.remove(auraMarketDisabledKey(pluginId), StorageScope.APPLICATION);
		for (const key of PLUGIN_STORAGE_CLEANUP[pluginId] ?? []) {
			this.storageService.remove(key, StorageScope.APPLICATION);
		}
		this.refresh(pluginId);
	}

	enabledWhen(pluginId: string): ContextKeyExpr {
		// Связываем ключ сразу, чтобы when-клауза видела актуальное значение с старта,
		// а не только после первого изменения флагов в сторадже.
		this.knownPlugins.add(pluginId);
		this.refresh(pluginId);
		return ContextKeyExpr.equals(auraPluginEnabledContextKey(pluginId), true);
	}

	/** Перечитать состояние плагина, обновить context key и уведомить подписчиков при смене. */
	private refresh(pluginId: string): void {
		const enabled = this.isEnabled(pluginId);
		if (this.enabledCache.get(pluginId) === enabled && this.contextKeys.has(pluginId)) {
			return;
		}
		this.enabledCache.set(pluginId, enabled);
		let key = this.contextKeys.get(pluginId);
		if (!key) {
			key = new RawContextKey<boolean>(auraPluginEnabledContextKey(pluginId), false).bindTo(this.contextKeyService);
			this.contextKeys.set(pluginId, key);
		}
		key.set(enabled);
		this._onDidChangeEnablement.fire(pluginId);
	}
}

registerSingleton(IAuraPluginService, AuraPluginService, InstantiationType.Delayed);
