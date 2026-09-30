/*---------------------------------------------------------------------------------------------
 *  Aura Market — живое управление view-контейнерами плагинов.
 *  Контейнер регистрируется в реестре, когда плагин включён, и ДЕРЕГИСТРИРУЕТСЯ
 *  при отключении/удалении (не прячется CSS — иначе остался бы в меню «Скрытые
 *  элементы» activity bar). Если отключён активный контейнер — сайдбар
 *  переключается на предыдущий видимый (Проводник), пустоты не остаётся.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ILocalizedString } from '../../../../platform/action/common/action.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, IViewDescriptor, ViewContainer, ViewContainerLocation } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IAuraPluginService } from '../common/auraPluginService.js';

/** Куда переключать сайдбар, если закрылся активный контейнер плагина. */
const FALLBACK_VIEW_CONTAINER_ID = 'workbench.view.explorer';

export interface IAuraPluginContainerOptions {
	readonly pluginId: string;
	readonly containerId: string;
	readonly title: ILocalizedString;
	readonly icon: ThemeIcon;
	readonly order: number;
	/** Вьюхи внутри контейнера (обычно одна — лаунчер/панель плагина). */
	readonly views: IViewDescriptor[];
}

/**
 * Управляет регистрацией view-контейнера по состоянию плагина.
 * Возвращает disposable на случай dispose вкладки/контрибуции.
 */
export function managePluginViewContainer(
	options: IAuraPluginContainerOptions,
	pluginService: IAuraPluginService,
	paneCompositePartService: IPaneCompositePartService,
	viewsService: IViewsService,
): IDisposable {
	const containersRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
	const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

	// Context key `auraPlugin.<id>.enabled` доступен when-клаузам меню/вьюх с самого старта.
	pluginService.enabledWhen(options.pluginId);

	let container: ViewContainer | undefined;

	const add = (): void => {
		if (container) { return; }
		container = containersRegistry.registerViewContainer({
			id: options.containerId,
			title: options.title,
			ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [options.containerId, { mergeViewWithContainerWhenSingleView: true }]),
			icon: options.icon,
			hideIfEmpty: false,
			order: options.order,
		}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: true });
		viewsRegistry.registerViews(options.views, container);
	};

	const remove = (): void => {
		if (!container) { return; }
		// Если отключаемый контейнер сейчас активен в сайдбаре — переключаемся
		// на предыдущий видимый, чтобы не оставлять пустую панель.
		const active = paneCompositePartService.getActivePaneComposite(ViewContainerLocation.Sidebar);
		if (active?.getId() === options.containerId) {
			void viewsService.openViewContainer(FALLBACK_VIEW_CONTAINER_ID, false);
		}
		viewsRegistry.deregisterViews(options.views, container);
		containersRegistry.deregisterViewContainer(container);
		container = undefined;
	};

	if (pluginService.isEnabled(options.pluginId)) {
		add();
	}
	const listener = pluginService.onDidChangeEnablement(pluginId => {
		if (pluginId !== options.pluginId) { return; }
		if (pluginService.isEnabled(pluginId)) { add(); } else { remove(); }
	});

	return {
		dispose: () => {
			listener.dispose();
			remove();
		}
	};
}
