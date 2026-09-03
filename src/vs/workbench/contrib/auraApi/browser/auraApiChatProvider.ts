/*---------------------------------------------------------------------------------------------
 *  Aura API — провайдер языковых моделей для встроенного чата.
 *  Каждый здоровый ключ (ok, без высокого пинга) появляется в списке моделей
 *  чата как BYOK-модель; запросы уходят на его OpenAI-совместимый эндпоинт.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { joinPath } from '../../../../base/common/resources.js';
import {
	ILanguageModelChatProvider, ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatResponse,
	ILanguageModelChatRequestOptions, ILanguageModelChatInfoOptions, ILanguageModelChatMetadata,
	IChatMessage, IChatMessagePart, IChatResponsePart, ChatMessageRole,
} from '../../chat/common/languageModels.js';
import { IAuraApiKeysService, IAuraApiKey } from '../common/auraApiKeys.js';
import { AuraSseParser, AuraToolCallAccumulator, IAuraToolCall } from '../common/auraApiModel.js';

export const AURA_API_VENDOR = 'auraApi';
export const AURA_API_SYSTEM_PROMPT_SETTING = 'auraApi.chat.systemPrompt';
export const AURA_API_PROJECT_RULES_SETTING = 'auraApi.chat.useProjectRules';

/** Файлы правил проекта, которые подставляются в системный промпт (первый найденный в порядке списка — на корень). */
const PROJECT_RULE_FILES = ['AGENTS.md', '.github/copilot-instructions.md'];
const PROJECT_RULES_MAX_CHARS = 16_000;

interface IOpenAIToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

interface IOpenAIMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	tool_calls?: IOpenAIToolCall[];
	tool_call_id?: string;
}

interface IOpenAITool {
	type: 'function';
	function: { name: string; description: string; parameters?: object };
}

/** Инструменты в формате vscode.LanguageModelChatTool, как их кладёт в options ядро чата. */
interface IRequestTool {
	name: string;
	description: string;
	inputSchema?: object;
}

/** Событие потока: либо текстовая дельта, либо собранные в конце вызовы инструментов. */
type StreamEvent = { kind: 'text'; value: string } | { kind: 'tools'; calls: IAuraToolCall[] };

function textOf(parts: readonly IChatMessagePart[]): string {
	return parts
		.map(part => part.type === 'text' ? part.value : '')
		.filter(Boolean)
		.join('\n');
}

/** Один ответ инструмента → сообщение role:tool с текстовым содержимым. */
function toolResultText(part: Extract<IChatMessagePart, { type: 'tool_result' }>): string {
	const text = part.value
		.map(v => v.type === 'text' ? v.value : v.type === 'prompt_tsx' ? JSON.stringify(v.value) : '')
		.filter(Boolean)
		.join('\n');
	return text || (part.isError ? 'Инструмент завершился с ошибкой.' : '');
}

/**
 * Перевод истории чата в формат OpenAI. Пользовательские и системные сообщения идут текстом;
 * assistant с tool_use получает tool_calls, а tool_result превращается в отдельное role:tool.
 */
export function toOpenAIMessages(messages: readonly IChatMessage[], systemPrompt: string): IOpenAIMessage[] {
	const out: IOpenAIMessage[] = [];
	if (systemPrompt) {
		out.push({ role: 'system', content: systemPrompt });
	}
	for (const m of messages) {
		if (m.role === ChatMessageRole.System) {
			const text = textOf(m.content);
			if (text) {
				out.push({ role: 'system', content: text });
			}
			continue;
		}
		if (m.role === ChatMessageRole.Assistant) {
			const toolCalls: IOpenAIToolCall[] = [];
			for (const part of m.content) {
				if (part.type === 'tool_use') {
					toolCalls.push({
						id: part.toolCallId,
						type: 'function',
						function: { name: part.name, arguments: JSON.stringify(part.parameters ?? {}) },
					});
				}
			}
			const text = textOf(m.content);
			if (text || toolCalls.length > 0) {
				out.push({ role: 'assistant', content: text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) });
			}
			continue;
		}
		// User: результаты инструментов идут отдельными role:tool, остальное — одним user
		for (const part of m.content) {
			if (part.type === 'tool_result') {
				out.push({ role: 'tool', tool_call_id: part.toolCallId, content: toolResultText(part) });
			}
		}
		const text = textOf(m.content);
		if (text) {
			out.push({ role: 'user', content: text });
		}
	}
	return out;
}

export function toOpenAITools(tools: readonly IRequestTool[] | undefined): IOpenAITool[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}
	return tools.map(t => ({
		type: 'function',
		function: { name: t.name, description: t.description, ...(t.inputSchema ? { parameters: t.inputSchema } : {}) },
	}));
}

/** Читает тело SSE-ответа: текстовые дельты сразу, tool_calls — одним событием после сборки. */
async function* readSseEvents(response: Response, signal: AbortSignal): AsyncGenerator<StreamEvent> {
	const body = response.body;
	const tools = new AuraToolCallAccumulator();
	if (!body) {
		// Провайдер проигнорировал stream:true и отдал ответ целиком.
		const data = await response.json().catch(() => undefined) as { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown[] } }> } | undefined;
		const message = data?.choices?.[0]?.message;
		const text = String(message?.content ?? '');
		if (text) {
			yield { kind: 'text', value: text };
		}
		if (Array.isArray(message?.tool_calls)) {
			const parser = new AuraSseParser();
			tools.append(parser.append(`data: ${JSON.stringify(data)}\n`)[0]?.toolCalls);
		}
	} else {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		const parser = new AuraSseParser();
		try {
			while (!signal.aborted) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				for (const delta of parser.append(decoder.decode(value, { stream: true }))) {
					if (delta.text) {
						yield { kind: 'text', value: delta.text };
					}
					tools.append(delta.toolCalls);
				}
			}
			for (const delta of parser.flush()) {
				if (delta.text) {
					yield { kind: 'text', value: delta.text };
				}
				tools.append(delta.toolCalls);
			}
		} finally {
			reader.releaseLock();
		}
	}
	if (!tools.isEmpty) {
		yield { kind: 'tools', calls: tools.finish() };
	}
}

export class AuraApiChatProvider implements ILanguageModelChatProvider {

	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		private readonly keysService: IAuraApiKeysService,
		private readonly configurationService: IConfigurationService,
		private readonly fileService: IFileService,
		private readonly workspaceContextService: IWorkspaceContextService,
	) {
		this.keysService.onDidChange(() => this._onDidChange.fire());
	}

	/**
	 * Правила проекта (AGENTS.md / copilot-instructions.md) из каждой папки workspace.
	 * Читаются на каждый запрос, чтобы правки файла подхватывались без перезагрузки.
	 */
	private async projectRules(): Promise<string> {
		if (this.configurationService.getValue<boolean>(AURA_API_PROJECT_RULES_SETTING) === false) {
			return '';
		}
		const sections: string[] = [];
		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			for (const relative of PROJECT_RULE_FILES) {
				const uri = joinPath(folder.uri, relative);
				try {
					const content = (await this.fileService.readFile(uri)).value.toString().trim();
					if (content) {
						sections.push(`# Правила проекта (${folder.name}/${relative})\n\n${content}`);
						break; // один файл правил на папку — первый по приоритету
					}
				} catch {
					// файла нет — это норма
				}
			}
		}
		const joined = sections.join('\n\n');
		return joined.length > PROJECT_RULES_MAX_CHARS ? `${joined.slice(0, PROJECT_RULES_MAX_CHARS)}\n\n[правила обрезаны]` : joined;
	}

	/** Здоровые ключи как модели чата. */
	private usableKeys(): IAuraApiKey[] {
		return this.keysService.getKeys().filter(k => {
			const s = this.keysService.getStatus(k.id);
			return s.ok === true && !s.excludedHighPing;
		});
	}

	async provideLanguageModelChatInfo(_options: ILanguageModelChatInfoOptions, _token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		return this.usableKeys().map(key => {
			const identifier = `${AURA_API_VENDOR}/${key.id}`;
			const metadata: ILanguageModelChatMetadata = {
				extension: new ExtensionIdentifier('aura.aura-api'),
				name: `${key.name} (${key.model})`,
				id: key.id,
				vendor: AURA_API_VENDOR,
				version: '1.0.0',
				family: key.model,
				maxInputTokens: 128000,
				maxOutputTokens: 16000,
				isDefaultForLocation: {},
				isUserSelectable: true,
				isBYOK: true,
				tooltip: `Aura API: ${key.model} @ ${key.baseUrl}`,
				capabilities: { toolCalling: true, agentMode: true },
			};
			return { identifier, metadata };
		});
	}

	async sendChatRequest(modelId: string, messages: IChatMessage[], _from: ExtensionIdentifier | undefined, options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		// Выбор ключа через роутер (группы → веса → cooldown), fallback — старый список
		const routed = this.keysService.resolveKeyForModel ? this.keysService.resolveKeyForModel() : undefined;
		const preferred = this.keysService.getKeys().find(k => k.id === modelId) ?? routed;
		if (!preferred) { throw new Error(`Aura API: нет живых ключей (modelId=${modelId})`); }
		const candidates: IAuraApiKey[] = [preferred, ...this.usableKeys().filter(k => k.id !== preferred.id)];

		const userPrompt = (this.configurationService.getValue<string>(AURA_API_SYSTEM_PROMPT_SETTING) ?? '').trim();
		const rules = await this.projectRules();
		const systemPrompt = [userPrompt, rules].filter(Boolean).join('\n\n');
		const oaiMessages = toOpenAIMessages(messages, systemPrompt);
		const tools = toOpenAITools(options.tools as IRequestTool[] | undefined);
		// LanguageModelChatToolMode.Required === 2: модель обязана вызвать инструмент
		const toolChoice = tools ? (options.toolMode === 2 ? 'required' : 'auto') : undefined;

		const controller = new AbortController();
		token.onCancellationRequested(() => controller.abort());

		const openStream = async (key: IAuraApiKey): Promise<Response> => {
			const secret = await this.keysService.getSecret(key.id);
			const base = key.baseUrl.replace(/\/+$/, '');
			const response = await fetch(`${base}/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Accept': 'text/event-stream',
					...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
				},
				body: JSON.stringify({
					model: key.model,
					messages: oaiMessages,
					stream: true,
					...(tools ? { tools, tool_choice: toolChoice } : {}),
				}),
				signal: controller.signal,
			});
			if (!response.ok) {
				const body = await response.text().catch(() => '');
				// Фейловер только на сетевых/лимитных/серверных ошибках: на 401/403 другой ключ может быть жив
				throw new Error(`Aura API [${key.name}]: HTTP ${response.status} — ${body.slice(0, 200)}`);
			}
			return response;
		};

		const result = new DeferredPromise<string>();

		const stream = (async function* (): AsyncGenerator<IChatResponsePart> {
			let lastError: unknown;
			let full = '';
			let started = false;
			for (const key of candidates) {
				if (controller.signal.aborted) {
					break;
				}
				let response: Response;
				try {
					response = await openStream(key);
				} catch (e) {
					lastError = e; // ответ ещё не начался — можно пробовать следующий ключ
					continue;
				}
				try {
					for await (const event of readSseEvents(response, controller.signal)) {
						started = true;
						if (event.kind === 'text') {
							full += event.value;
							yield { type: 'text', value: event.value };
						} else {
							for (const call of event.calls) {
								yield { type: 'tool_use', name: call.name, toolCallId: call.id, parameters: call.parameters };
							}
						}
					}
					result.complete(full);
					return;
				} catch (e) {
					// Поток оборвался после первых частей: повтор на другом ключе продублировал бы
					// уже показанное, поэтому отдаём то, что успели получить.
					if (started) {
						result.complete(full);
						return;
					}
					lastError = e;
				}
			}
			const error = lastError instanceof Error ? lastError : new Error('Aura API: все ключи недоступны');
			result.error(error);
			throw error;
		})();

		return { stream, result: result.p };
	}

	async provideTokenCount(_modelId: string, message: string | IChatMessage, _token: CancellationToken): Promise<number> {
		const text = typeof message === 'string'
			? message
			: message.content.map(p => String((p as { value?: unknown }).value ?? '')).join(' ');
		return Math.ceil(text.length / 4); // приблизительная оценка токенов
	}
}
