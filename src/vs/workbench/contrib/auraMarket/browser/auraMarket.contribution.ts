/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { AuraMarketViewPane, AURA_MARKET_VIEW_ID } from './auraMarketViewPane.js';

const AURA_MARKET_VIEW_CONTAINER_ID = 'workbench.view.auraMarket';

const auraMarketViewIcon = registerIcon('aura-market-view-icon', Codicon.gift, localize('auraMarketViewIcon', 'View icon of the Aura Market view container.'));

// Контейнер (иконка слева в activity bar)
const viewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: AURA_MARKET_VIEW_CONTAINER_ID,
	title: localize2('auraMarket', "Aura Market"),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [AURA_MARKET_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	icon: auraMarketViewIcon,
	hideIfEmpty: false,
	order: 6,
}, ViewContainerLocation.Sidebar);

// Сама панель
Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: AURA_MARKET_VIEW_ID,
	name: localize2('auraMarket.view', "Aura Market"),
	containerIcon: auraMarketViewIcon,
	ctorDescriptor: new SyncDescriptor(AuraMarketViewPane),
	canToggleVisibility: true,
	canMoveView: true,
}], viewContainer);
