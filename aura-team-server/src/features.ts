/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Каталог закрытых возможностей и ранги ролей — один источник правды для
 * сервера, CLI и проверок доступа. Список не выводится из кода клиента:
 * возможность существует только если её знает сервер.
 */

export type Role = 'owner' | 'maintainer' | 'dev' | 'viewer';

/** Ранг роли: сравнение «не ниже, чем» вместо перечисления пар в каждом маршруте. */
export const ROLE_RANK: Record<Role, number> = { viewer: 0, dev: 1, maintainer: 2, owner: 3 };

export const ROLES: Role[] = ['owner', 'maintainer', 'dev', 'viewer'];

export function roleAtLeast(role: string | undefined, minimum: Role): boolean {
	return ROLE_RANK[role as Role] !== undefined && ROLE_RANK[role as Role] >= ROLE_RANK[minimum];
}

export interface GatedFeature {
	/** Идентификатор, которым право выдаётся и проверяется (он же едет в /v1/me). */
	id: string;
	title: string;
	description: string;
	/** Минимальная роль для командной выдачи: ниже неё право не наследуется. */
	defaultMinRole: Role;
}

/**
 * Закрытые возможности. Пока это внешнее ядро AGGG 5.2: оно едет с сервера,
 * а не лежит у каждого в файлах, поэтому лицензия проверяется не клиентом.
 */
export const GATED_FEATURES: readonly GatedFeature[] = [
	{
		id: 'aggg52',
		title: 'AGGG 5.2 — внешний агент',
		description: 'Ядро правил внешнего агента: загружается с сервера команды по праву аккаунта или команды.',
		defaultMinRole: 'dev',
	},
];

export const FEATURE_IDS: readonly string[] = GATED_FEATURES.map(feature => feature.id);

export function featureOf(id: string | undefined): GatedFeature | undefined {
	return GATED_FEATURES.find(feature => feature.id === String(id ?? '').trim());
}
