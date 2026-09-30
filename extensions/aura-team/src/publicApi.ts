/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import type { BoardSnapshot, Session, TaskStatus, TeamApiKey, TeamTask } from './types';

/**
 * Публичный API Aura Team для других расширений (сейчас — LangGraph Оркестратор).
 * Версия фиксирована: потребитель проверяет `apiVersion === 1` и всё остальное
 * считает несовместимым. Больше ничего из activate() не отдаётся.
 */
export const PUBLIC_API_VERSION = 1;

/** Изменения задачи, которые разрешено применить извне. */
export interface TeamTaskChanges {
	status?: TaskStatus;
	position?: number;
	assigneeId?: string | null;
	title?: string;
	description?: string;
	dueAt?: string | null;
}

export interface AuraTeamPublicApi {
	readonly apiVersion: number;
	getSession(): Session | undefined;
	getBoard(teamId: string): Promise<BoardSnapshot>;
	updateTask(teamId: string, taskId: string, changes: TeamTaskChanges): Promise<unknown>;
	/**
	 * Завести задачу на доске: этим пользуется форма «своя задача» в канбане оркестратора.
	 * Для потребителей метод необязательный (`createTask?` в типе моста): тот, кто его
	 * не знает, просто не показывает форму — поэтому версия API не меняется.
	 */
	createTask(teamId: string, title: string, status?: TaskStatus): Promise<TeamTask>;
	/** Шлётся при любом обновлении доски (после refresh/правки задачи). */
	readonly onDidChangeBoard: vscode.Event<BoardSnapshot | undefined>;
	listApiKeys(teamId: string): Promise<TeamApiKey[]>;
	createProxyToken(teamId: string, provider: string, model: string): Promise<{ id: string; token: string }>;
}
