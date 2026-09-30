import * as vscode from 'vscode';
import { KeyRegistry } from '../keys/registry';
import { API_KEYS_VENDOR_ID, modelForKey } from '../keys/modelId';
import { KeyTier, higherTier } from '../util/config';
import { logInfo, logWarn } from '../util/log';

export interface ChatToolSpec {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export type ChatMessage =
	| { role: 'system' | 'user'; content: string }
	| { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
	| { role: 'tool'; toolCallId: string; content: string };

export interface ToolCall {
	id: string;
	name: string;
	input: unknown;
}

export interface ChatRequest {
	role: string;
	tier: KeyTier;
	messages: ChatMessage[];
	tools?: ChatToolSpec[];
	maxTokens?: number;
}

/** Учёт одного ответа модели (Этап 5.1). costUsd заполняет host по таблице цен. */
export interface ChatUsage {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	/** Имя модели/ключа — по нему выбирается цена (неизвестная → тир). */
	model: string;
	tier: KeyTier;
}

export interface ChatResult {
	text: string;
	toolCalls: ToolCall[];
	usedKeyId: string;
	usedKeyName: string;
	usedTier: KeyTier;
	inputTokens: number;
	outputTokens: number;
	/** Готовый учёт расхода: токены + (для прокси/host) стоимость. */
	usage?: ChatUsage;
}

export interface StreamHandlers {
	onToken?: (token: string) => void;
}

/**
 * Тир-роутер LLM-вызовов. Ходит через vscode.lm в провайдер ядра
 * (AuraApiChatProvider) — секреты, cooldown-учёт и низкоуровневый фейловер
 * остаются в ядре. Поверх — выбор ключа по тиру и перебор кандидатов.
 */
export class RouterProxy {
	constructor(private registry: KeyRegistry) {}

	async complete(request: ChatRequest, handlers: StreamHandlers, token: vscode.CancellationToken): Promise<ChatResult> {
		const tiersToTry = this.tierSequence(request.tier);
		let lastError: unknown;

		for (const tier of tiersToTry) {
			const candidates = this.registry.candidates(tier);
			if (candidates.length === 0) {
				logInfo(`tier ${tier}: no usable keys, falling through`);
				continue;
			}
			for (const key of candidates) {
				try {
					const started = Date.now();
					// Счётчик активных агентов на ключе ведём до конца вызова: он же
					// основа балансировки (KeyRegistry.candidates), а не только индикатор.
					this.registry.beginCall(key.id);
					let result: ChatResult;
					try {
						result = await this.completeWithKey(key.id, request, tier, handlers, token);
					} finally {
						this.registry.endCall(key.id);
					}
					this.registry.reportSuccess(key.id, Date.now() - started);
					return result;
				} catch (err) {
					if (token.isCancellationRequested) {
						throw err;
					}
					lastError = err;
					this.registry.reportOutcome(key.id, err);
					logWarn(`key ${key.id} failed for role ${request.role} (tier ${tier}): ${err instanceof Error ? err.message : err}`);
				}
			}
		}
		throw new Error(`All tiers exhausted for role ${request.role}: ${lastError instanceof Error ? lastError.message : lastError}`);
	}

	/**
	 * Порядок обхода тиров: запрошенный, затем только вверх (low → mid → high).
	 * Вниз не спускаемся: дешёвый тир — это осознанный выбор роли, а не запасной
	 * выход, и подмена «не смогли дешёвой — возьмём ещё дешевле» невозможна.
	 */
	private tierSequence(requested: KeyTier): KeyTier[] {
		const seq: KeyTier[] = [requested];
		let up = higherTier(requested);
		while (up) {
			seq.push(up);
			up = higherTier(up);
		}
		return seq;
	}

	private async completeWithKey(
		keyId: string,
		request: ChatRequest,
		tier: KeyTier,
		handlers: StreamHandlers,
		token: vscode.CancellationToken,
	): Promise<ChatResult> {
		// Модель зарегистрирована ядром как `apiKeys/<id ключа>` — сравнение по id
		// ключа и есть тот промах, из-за которого вызовы падали с «not usable».
		const models = await vscode.lm.selectChatModels({ vendor: API_KEYS_VENDOR_ID });
		const model = modelForKey(models, keyId);
		if (!model) {
			throw new Error(`model not usable (key ${keyId} is not in the vscode.lm list)`);
		}

		const messages = request.messages.map(m => this.toVsMessage(m));
		const tools: vscode.LanguageModelChatTool[] | undefined = request.tools?.map(t => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema,
		}));

		const response = await model.sendRequest(messages, {
			tools,
			toolMode: tools?.length ? vscode.LanguageModelChatToolMode.Auto : undefined,
			modelOptions: request.maxTokens ? { maxTokens: request.maxTokens } : undefined,
		}, token);

		let text = '';
		const toolCalls: ToolCall[] = [];
		for await (const part of response.stream) {
			if (part instanceof vscode.LanguageModelTextPart) {
				text += part.value;
				handlers.onToken?.(part.value);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({ id: part.callId, name: part.name, input: part.input });
			}
		}

		// Учёт токенов: вход считаем по сообщениям, выход — по тексту и аргументам
		// tool-calls. Без этого бюджет узла не увидел бы генерацию вообще.
		let inputTokens = 0;
		let outputTokens = 0;
		try {
			inputTokens = await model.countTokens(messages.map(m => m.content).join('\n'));
		} catch {
			// countTokens не критичен
		}
		try {
			outputTokens = await model.countTokens(this.outputText(text, toolCalls));
		} catch {
			// countTokens не критичен
		}

		return {
			text,
			toolCalls,
			usedKeyId: keyId,
			usedKeyName: model.name,
			usedTier: tier,
			inputTokens,
			outputTokens,
			usage: { inputTokens, outputTokens, costUsd: 0, model: model.name, tier },
		};
	}

	/** Текст, по которому считается выход модели: ответ + сериализованные tool-calls. */
	private outputText(text: string, toolCalls: ToolCall[]): string {
		if (toolCalls.length === 0) {
			return text;
		}
		return `${text}\n${toolCalls.map(call => `${call.name} ${JSON.stringify(call.input ?? {})}`).join('\n')}`;
	}

	private toVsMessage(message: ChatMessage): vscode.LanguageModelChatMessage {
		switch (message.role) {
			case 'assistant': {
				const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
				if (message.content) {
					parts.push(new vscode.LanguageModelTextPart(message.content));
				}
				for (const call of message.toolCalls ?? []) {
					parts.push(new vscode.LanguageModelToolCallPart(call.id, call.name, call.input as object));
				}
				return vscode.LanguageModelChatMessage.Assistant(parts);
			}
			case 'tool':
				return vscode.LanguageModelChatMessage.User([
					new vscode.LanguageModelToolResultPart(message.toolCallId, [new vscode.LanguageModelTextPart(message.content)]),
				]);
			case 'system':
			case 'user':
			default:
				return vscode.LanguageModelChatMessage.User(message.content);
		}
	}
}
