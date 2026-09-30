/*---------------------------------------------------------------------------------------------
 *  Инструмент чата: поручить задачу мультиагентной команде оркестратора.
 *  Модель вызывает его из диалога, прогресс по агентам уходит в виджете инструмента,
 *  а результатом возвращается markdown-сводка запуска.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { OrchestratorHost } from '../host';
import { buildTeamSummary, parseTeamTaskInput } from './report';

/** Идентификатор должен совпадать с contributes.languageModelTools[].name. */
export const TEAM_TOOL_ID = 'auraOrchestrator_runTeam';

export interface ITeamToolInput {
	task: string;
	max_workers?: number;
}

function shorten(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * Регистрация инструмента. Требуется proposed API `toolProgress` — без него
 * `progress.report` не доходит до чата и виджет инструмента молчит до самого конца.
 */
export function registerTeamTool(context: vscode.ExtensionContext, host: OrchestratorHost): vscode.Disposable {
	const tool: vscode.LanguageModelTool<ITeamToolInput> = {
		prepareInvocation: async options => {
			const parsed = parseTeamTaskInput(options.input);
			return {
				invocationMessage: parsed.ok
					? `Поручаю команде агентов: ${shorten(parsed.task, 140)}`
					: 'Команда агентов: уточняю задачу',
			};
		},
		// progress необязателен: интерфейс объявлен двумя перегрузками (с proposed API
		// toolProgress и без него), и обязательный третий параметр не подошёл бы второй.
		async invoke(options, token, progress?: vscode.Progress<vscode.ToolProgressStep>) {
			const parsed = parseTeamTaskInput(options.input);
			if (!parsed.ok) {
				return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(parsed.error)]);
			}
			progress?.report({ message: 'Ставлю задачу команде агентов…' });
			if (token.isCancellationRequested) {
				return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Запуск отменён до старта.')]);
			}
			const result = await host.runTeamTask(parsed.task, {
				maxWorkers: parsed.maxWorkers,
				onProgress: line => {
					if (!token.isCancellationRequested) {
						progress?.report({ message: line });
					}
				},
			}, token);
			progress?.report({ message: 'Команда агентов завершила работу' });
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(buildTeamSummary(result))]);
		},
	};
	const registration = vscode.lm.registerTool(TEAM_TOOL_ID, tool);
	context.subscriptions.push(registration);
	return registration;
}
