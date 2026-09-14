/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * AGGG — обвязка-агент: чистые типы и функции (без DOM/DI).
 * Хранение — application storage; ключи настроек — здесь, а не в строках.
 */

export type AgggWrapMode = 'global' | 'per-situation' | 'off';

export const AGGG_STORAGE_ROOT = 'aggg.rootPath';
export const AGGG_STORAGE_MODE = 'aggg.wrapMode';

export function normalizeWrapMode(value: unknown): AgggWrapMode {
	return value === 'global' || value === 'per-situation' ? value : 'off';
}

export interface IAgggProbeResult {
	rootValid: boolean;
	version?: string;
	missing: string[];
}

/** Минимальный набор файлов, по которым корень AGGG2 считается валидным. */
export const AGGG_ROOT_MARKERS: readonly string[] = ['VERSION', 'harness/core.txt', 'CLAUDE.md'];

/** Собирает системный промпт чата из ядра обвязки и режима. */
export function buildChatSystemPrompt(coreText: string, mode: AgggWrapMode): string {
	const core = coreText.trim();
	if (!core || mode === 'off') {
		return '';
	}
	const scope = mode === 'global'
		? 'Режим: глобальный — правила действуют в каждом проекте.'
		: 'Режим: по ситуации — применяй правила, когда они релевантны задаче.';
	return ['Обвязка AGGG [AGENT OS]:', core, '', scope].join('\n');
}
