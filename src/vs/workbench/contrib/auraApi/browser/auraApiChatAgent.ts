/*---------------------------------------------------------------------------------------------
 *  API Keys — дефолтный агент панели чата на BYOK-ключах.
 *  Отвечает через выбранную модель (провайдер auraApi), исполняет вызовы инструментов
 *  через ILanguageModelToolsService и умеет поручать задачу мультиагентной команде:
 *  модель может вызвать инструмент команды сама, а `/team <задача>` запускает её напрямую,
 *  не дожидаясь модели.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { AURA_READ_FILE_TOOL_ID, AURA_WRITE_FILE_TOOL_ID, AURA_LIST_FILES_TOOL_ID } from './auraApiTools.js';
import { API_KEYS_VENDOR } from './auraApiChatProvider.js';
import { toolContentToA11yString } from '../../chat/common/tools/languageModelToolsService.js';
import { TerminalToolId } from '../../chat/common/tools/terminalToolIds.js';
import { InternalFetchWebPageToolId } from '../../chat/common/tools/builtinTools/tools.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { AGENT_TEAM_SLASH_COMMAND, buildChatSystemPrompt, isAgentTeamTool, uniqueWireToolNames } from '../common/auraApiChatTools.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { ILanguageModelsService, IChatMessage, IChatMessagePart, IChatResponseToolUsePart } from '../../chat/common/languageModels.js';
import type { IChatAgentImplementation, IChatAgentRequest, IChatAgentResult, IChatAgentHistoryEntry } from '../../chat/common/participants/chatAgents.js';
import type { IChatProgress } from '../../chat/common/chatService/chatService.js';
import type { ILanguageModelToolsService, IToolData } from '../../chat/common/tools/languageModelToolsService.js';

export const AURA_CHAT_AGENT_ID = 'aura.chat';

/**
 * Дефолтный агент панели чата Aura: отвечает на запросы через выбранную BYOK-модель
 * (провайдер auraApi). Без него дефолтным остаётся core setup-агент, который ждёт
 * расширение GitHub.copilot-chat и падает по таймауту «Chat took too long to get ready».
 *
 * Поддерживает инструменты: модель может читать/создавать файлы, запускать команды
 * в терминале и т.д. — ответы приходят tool_use-партами, агент исполняет их через
 * ILanguageModelToolsService и возвращает результаты следующим запросом.
 */
export class AuraChatAgent implements IChatAgentImplementation {

	/** Сколько раундов «модель → инструменты → модель» разрешено за один запрос. */
	private static readonly MAX_TOOL_ROUNDS = 15;

	/**
	 * Встроенные инструменты, которые безопасно отдавать BYOK-модели.
	 * Остальные internal — служебные (подтверждения, todo, subagent) и модели не нужны.
	 * Инструменты расширений/MCP (source не internal) разрешены все — например, если активен copilot-chat.
	 */
	private static readonly INTERNAL_TOOL_ALLOWLIST = new Set<string>([
		TerminalToolId.RunInTerminal,
		TerminalToolId.GetTerminalOutput,
		TerminalToolId.TerminalLastCommand,
		TerminalToolId.SendToTerminal,
		TerminalToolId.KillTerminal,
		InternalFetchWebPageToolId,
		AURA_READ_FILE_TOOL_ID,
		AURA_WRITE_FILE_TOOL_ID,
		AURA_LIST_FILES_TOOL_ID,
	]);

	constructor(
		private readonly languageModels: ILanguageModelsService,
		private readonly toolsService: ILanguageModelToolsService,
	) { }

	/** Инструменты для модели: allowlist встроенных + все внешние. */
	private availableTools(modelId: string): { spec: Array<{ name: string; description: string; inputSchema: unknown }>; byName: Map<string, IToolData>; teamToolName?: string } {
		const byName = new Map<string, IToolData>();
		const modelMetadata = this.languageModels.lookupLanguageModel(modelId);
		const tools: IToolData[] = [];
		for (const tool of this.toolsService.getTools(modelMetadata)) {
			if (!tool.inputSchema) { continue; }
			const isInternal = tool.source.type === 'internal';
			if (isInternal && !AuraChatAgent.INTERNAL_TOOL_ALLOWLIST.has(tool.id)) { continue; }
			tools.push(tool);
		}
		// Имена инструментов для wire-формата: у инструментов расширений и MCP идентификаторы
		// содержат точки (`auraTeam.runTask`), а OpenAI-совместимые шлюзы такие имена
		// отклоняют — и падал весь запрос, а не один инструмент.
		const wireNames = uniqueWireToolNames(tools.map(tool => tool.toolReferenceName ?? tool.id));
		let teamToolName: string | undefined;
		tools.forEach((tool, index) => {
			byName.set(wireNames[index], tool);
			if (isAgentTeamTool(tool)) { teamToolName = wireNames[index]; }
		});
		return {
			spec: tools.map((tool, index) => ({ name: wireNames[index], description: tool.modelDescription, inputSchema: tool.inputSchema })),
			byName,
			teamToolName,
		};
	}

	/**
	 * `/team <задача>` — прямой запуск мультиагентной команды, без обращения к модели:
	 * команда работает на ключах банка Team, поэтому доступна даже когда сам чат
	 * отвечает ошибкой (например «network error» у выбранного ключа).
	 */
	private async runAgentTeam(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, token: CancellationToken): Promise<IChatAgentResult> {
		const task = request.message.trim();
		if (!task) {
			progress([{ kind: 'markdownContent', content: new MarkdownString(localize('apiKeys.chatAgent.teamNoTask', "Опишите задачу после команды: `/team добавь настройки темы и покрой их тестами`.")) }]);
			return {};
		}
		const tool = [...this.toolsService.getTools(undefined)].find(isAgentTeamTool);
		if (!tool) {
			const message = localize('apiKeys.chatAgent.teamMissing', "Мультиагентная команда недоступна: включите плагин «LangGraph Orchestrator».");
			progress([{ kind: 'markdownContent', content: new MarkdownString(`⚠ ${message}`) }]);
			return { errorDetails: { message } };
		}
		try {
			// Обычный invokeTool: виджет инструмента в чате показывает прогресс агентов
			// и запросы подтверждения сами по себе.
			const result = await this.toolsService.invokeTool({
				callId: generateUuid(),
				toolId: tool.id,
				parameters: { task },
				context: { sessionResource: request.sessionResource },
			}, async () => 0, token);
			const text = toolContentToA11yString(result.content) || '(команда завершила работу без отчёта)';
			progress([{ kind: 'markdownContent', content: new MarkdownString(text) }]);
			return {};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			progress([{ kind: 'markdownContent', content: new MarkdownString(`⚠ ${message}`) }]);
			return { errorDetails: { message } };
		}
	}

	async invoke(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		// Слеш-команду команды агентов обрабатываем до выбора модели: она работает на ключах
		// банка Team и не должна зависеть от того, жива ли выбранная модель чата.
		if (request.command === AGENT_TEAM_SLASH_COMMAND) {
			return this.runAgentTeam(request, progress, token);
		}
		const modelId = request.userSelectedModelId ?? (await this.languageModels.selectLanguageModels({ vendor: API_KEYS_VENDOR }))[0];
		if (!modelId) {
			const message = localize('apiKeys.chatAgent.noModel', "Нет доступных моделей API Keys. Добавьте ключ в менеджере «Ключи API» и дождитесь зелёного статуса.");
			progress([{ kind: 'markdownContent', content: new MarkdownString(message) }]);
			return { errorDetails: { message } };
		}

		// История диалога: текст запроса + markdown ответа. Остальные партии (tool calls,
		// code edits) BYOK-провайдеру не нужны — он работает с plain text.
		const messages: IChatMessage[] = [];
		for (const entry of history) {
			const requestText = entry.request.message.trim();
			if (requestText) {
				messages.push({ role: 1 /* ChatMessageRole.User */, content: [{ type: 'text', value: requestText }] });
			}
			const responseText = entry.response
				.map(part => part.kind === 'markdownContent' ? part.content.value : '')
				.filter(Boolean)
				.join('\n');
			if (responseText) {
				messages.push({ role: 2 /* ChatMessageRole.Assistant */, content: [{ type: 'text', value: responseText }] });
			}
		}
		messages.push({ role: 1 /* ChatMessageRole.User */, content: [{ type: 'text', value: request.message }] });

		const { spec: toolSpecs, byName: toolsByName, teamToolName } = this.availableTools(modelId);
		// Системная подсказка: без неё модель часто печатает код в чат вместо вызова инструментов.
		// Список инструментов подставляется по факту запроса — иначе модель не знает ни про
		// инструменты расширений (в том числе про команду агентов), ни про их настоящие имена.
		if (toolSpecs.length) {
			messages.unshift({
				role: 0 /* ChatMessageRole.System */,
				content: [{
					type: 'text',
					value: buildChatSystemPrompt({ toolNames: toolSpecs.map(spec => spec.name), teamToolName }),
				}],
			});
		}

		try {
			// Цикл агента: модель отвечает текстом или вызовами инструментов; результаты
			// инструментов уходят следующим запросом, пока модель не завершит ответ текстом.
			for (let round = 0; round <= AuraChatAgent.MAX_TOOL_ROUNDS; round++) {
				const response = await this.languageModels.sendChatRequest(modelId, nullExtensionDescription.identifier, messages, { tools: toolSpecs }, token);
				const toolCalls: IChatResponseToolUsePart[] = [];
				let roundText = '';
				const streaming = (async () => {
					for await (const part of response.stream) {
						const parts = Array.isArray(part) ? part : [part];
						for (const item of parts) {
							if (item.type === 'text') {
								roundText += item.value;
								progress([{ kind: 'markdownContent', content: new MarkdownString(item.value) }]);
							} else if (item.type === 'tool_use') {
								toolCalls.push(item);
							}
						}
					}
				})();
				await Promise.all([response.result, streaming]);

				if (!toolCalls.length) {
					return {}; // чистый текстовый ответ — работа агента завершена
				}

				// Фиксируем ответ ассистента (текст + вызовы) в историю запроса к модели.
				messages.push({
					role: 2 /* ChatMessageRole.Assistant */,
					content: [
						...(roundText ? [{ type: 'text', value: roundText } as const] : []),
						...toolCalls,
					],
				});

				// Исполняем вызовы. context.sessionResource встраивает инструмент в чат:
				// виджет показывает его выполнение и подтверждения (Allow/Deny) как обычно.
				const resultParts: IChatMessagePart[] = [];
				for (const call of toolCalls) {
					const tool = toolsByName.get(call.name);
					if (!tool) {
						resultParts.push({ type: 'tool_result', toolCallId: call.toolCallId, value: [{ type: 'text', value: `Неизвестный инструмент: ${call.name}` }], isError: true });
						continue;
					}
					try {
						const toolResult = await this.toolsService.invokeTool({
							callId: call.toolCallId,
							toolId: tool.id,
							parameters: (call.parameters ?? {}) as Record<string, unknown>,
							context: { sessionResource: request.sessionResource },
							chatStreamToolCallId: call.toolCallId,
						}, async () => 0, token);
						resultParts.push({
							type: 'tool_result',
							toolCallId: call.toolCallId,
							value: [{ type: 'text', value: toolContentToA11yString(toolResult.content) || '(empty)' }],
							...(toolResult.toolResultError ? { isError: true } : {}),
						});
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						resultParts.push({ type: 'tool_result', toolCallId: call.toolCallId, value: [{ type: 'text', value: message }], isError: true });
					}
				}
				messages.push({ role: 1 /* ChatMessageRole.User */, content: resultParts });
			}
			progress([{ kind: 'markdownContent', content: new MarkdownString(localize('apiKeys.chatAgent.toolLimit', "\n\n_Достигнут лимит шагов агента — остановлено, чтобы не крутиться бесконечно._")) }]);
			return {};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			progress([{ kind: 'markdownContent', content: new MarkdownString(`⚠ ${message}`) }]);
			return { errorDetails: { message } };
		}
	}
}
