/*---------------------------------------------------------------------------------------------
 *  Aura API — провайдер языковых моделей для встроенного чата.
 *  Каждый здоровый ключ (ok, без высокого пинга) появляется в списке моделей
 *  чата как BYOK-модель; запросы уходят на его OpenAI-совместимый эндпоинт.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import {
	ILanguageModelChatProvider, ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatResponse,
	ILanguageModelChatRequestOptions, ILanguageModelChatInfoOptions, ILanguageModelChatMetadata,
} from '../../chat/common/languageModels.js';
import { IChatMessage } from '../../chat/common/languageModels.js';
import { IAuraApiKeysService, IAuraApiKey } from '../common/auraApiKeys.js';
import { agggBoostActive, AGGG_BOOST_PROMPT } from '../../aggg/common/agggBoost.js';

export const AURA_API_VENDOR = 'auraApi';
export const AURA_API_SYSTEM_PROMPT_SETTING = 'auraApi.chat.systemPrompt';

interface IOpenAIMessage { role: string; content: string }

export class AuraApiChatProvider implements ILanguageModelChatProvider {

	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		private readonly keysService: IAuraApiKeysService,
		private readonly configurationService: IConfigurationService,
	) {
		this.keysService.onDidChange(() => this._onDidChange.fire());
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
		const selectedKeyId = modelId.startsWith(`${AURA_API_VENDOR}/`) ? modelId.slice(AURA_API_VENDOR.length + 1) : modelId;
		const routed = this.keysService.resolveKeyForModel(selectedKeyId);
		const preferred = this.keysService.getKeys().find(k => k.id === selectedKeyId) ?? routed;
		if (!preferred) { throw new Error(`Aura API: нет живых ключей (modelId=${modelId})`); }
		const candidates: IAuraApiKey[] = [preferred, ...this.usableKeys().filter(k => k.id !== preferred.id)];

		const systemPrompt = (this.configurationService.getValue<string>(AURA_API_SYSTEM_PROMPT_SETTING) ?? '').trim();
		const oaiMessages: IOpenAIMessage[] = [];
		// AGGG-буст: ядро правил AGGG2.0 первым системным сообщением (глобально или на проект)
		if (agggBoostActive(this.configurationService)) {
			oaiMessages.push({ role: 'system', content: AGGG_BOOST_PROMPT });
		}
		if (systemPrompt) {
			oaiMessages.push({ role: 'system', content: systemPrompt });
		}
		for (const m of messages) {
			const text = m.content
				.map(part => (part as { type?: string; value?: unknown }).type === 'text' ? String((part as { value: unknown }).value) : '')
				.filter(Boolean)
				.join('\n');
			if (!text) { continue; }
			oaiMessages.push({ role: m.role === 1 /* User */ ? 'user' : 'assistant', content: text });
		}


		const controller = new AbortController();
		token.onCancellationRequested(() => controller.abort());

		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const self = this;
		let resolveResult!: (v: string) => void;
		let rejectResult!: (e: unknown) => void;
		const result = new Promise<string>((res, rej) => { resolveResult = res; rejectResult = rej; });

		/** Собрать запрос под провайдера конкретного ключа. */
		const buildRequest = (key: IAuraApiKey, secret: string | undefined): { url: string; headers: Record<string, string>; body: string } => {
			const base = key.baseUrl.replace(/\/+$/, '');
			if (key.provider === 'anthropic') {
				const system = oaiMessages.filter(m => m.role === 'system').map(m => m.content).join('\n');
				return {
					url: `${base}/v1/messages`,
					headers: {
						'Content-Type': 'application/json',
						...(secret ? { 'x-api-key': secret, 'anthropic-version': '2023-06-01' } : {}),
					},
					body: JSON.stringify({ model: key.model, system: system || undefined, messages: oaiMessages.filter(m => m.role !== 'system'), stream: true, max_tokens: 8192 }),
				};
			}
			if (key.provider === 'google') {
				const system = oaiMessages.filter(m => m.role === 'system').map(m => m.content).join('\n');
				return {
					url: `${base}/v1beta/models/${encodeURIComponent(key.model)}:streamGenerateContent?alt=sse${secret ? `&key=${encodeURIComponent(secret)}` : ''}`,
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
						contents: oaiMessages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })),
					}),
				};
			}
			// openai-compatible, openrouter, litellm — единый формат OpenAI
			return {
				url: `${base}/chat/completions`,
				headers: {
					'Content-Type': 'application/json',
					...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
				},
				body: JSON.stringify({ model: key.model, messages: oaiMessages, stream: true }),
			};
		};

		/** Вытащить дельту текста из SSE-события стрима провайдера. */
		const extractDelta = (key: IAuraApiKey, json: Record<string, unknown>): string => {
			if (key.provider === 'anthropic') {
				// События content_block_delta: { delta: { type: 'text_delta', text } }
				const delta = json?.delta as { type?: string; text?: string } | undefined;
				return delta?.type === 'text_delta' && typeof delta.text === 'string' ? delta.text : '';
			}
			if (key.provider === 'google') {
				const parts = (json?.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined)?.[0]?.content?.parts;
				return Array.isArray(parts) ? parts.map(p => typeof p?.text === 'string' ? p.text : '').join('') : '';
			}
			const delta = json?.choices as Array<{ delta?: { content?: string } }> | undefined;
			return typeof delta?.[0]?.delta?.content === 'string' ? delta[0].delta.content : '';
		};

		const stream = (async function* () {
			let lastError: unknown;
			let yielded = false; // стрим начался — фейловер на другой ключ уже невозможен (иначе дубли текста)
			for (const key of candidates) {
				if (controller.signal.aborted) { break; }
				try {
					const secret = await self.keysService.getSecret(key.id);
					const request = buildRequest(key, secret);
					const response = await fetch(request.url, {
						method: 'POST',
						headers: request.headers,
						body: request.body,
						signal: controller.signal,
					});
					if (!response.ok || !response.body) {
						const body = await response.text().catch(() => '');
						throw new Error(`Aura API [${key.name}]: HTTP ${response.status} — ${body.slice(0, 200)}`);
					}
					// SSE: читаем дельты и репортим их по мере поступления
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let buffer = '';
					let fullText = '';
					for (;;) {
						const { done, value } = await reader.read();
						if (done) { break; }
						buffer += decoder.decode(value, { stream: true });
						const lines = buffer.split('\n');
						buffer = lines.pop() ?? '';
						for (const line of lines) {
							const trimmedLine = line.trim();
							if (!trimmedLine.startsWith('data:')) { continue; }
							const payload = trimmedLine.slice(5).trim();
							if (payload === '[DONE]') { continue; }
							try {
								const json = JSON.parse(payload);
								const delta = extractDelta(key, json);
								if (typeof delta === 'string' && delta.length > 0) {
									fullText += delta;
									yielded = true;
									yield { type: 'text' as const, value: delta };
								}
							} catch { /* неполный JSON-чанк — пропускаем */ }
						}
					}
					resolveResult(fullText);
					return;
				} catch (e) {
					if (yielded) { rejectResult(e); throw e; }
					lastError = e; // ошибка до первого байта — пробуем следующий ключ
				}
			}
			const err = lastError instanceof Error ? lastError : new Error('Aura API: все ключи недоступны');
			rejectResult(err);
			throw err;
		})();

		return { stream, result };
	}

	async provideTokenCount(_modelId: string, message: string | IChatMessage, _token: CancellationToken): Promise<number> {
		const text = typeof message === 'string'
			? message
			: message.content.map(p => String((p as { value?: unknown }).value ?? '')).join(' ');
		return Math.ceil(text.length / 4); // приблизительная оценка токенов
	}
}
