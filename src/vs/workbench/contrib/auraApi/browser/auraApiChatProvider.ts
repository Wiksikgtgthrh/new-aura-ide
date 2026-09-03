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
		const routed = this.keysService.resolveKeyForModel ? this.keysService.resolveKeyForModel() : undefined;
		const preferred = this.keysService.getKeys().find(k => k.id === modelId) ?? routed;
		if (!preferred) { throw new Error(`Aura API: нет живых ключей (modelId=${modelId})`); }
		const candidates: IAuraApiKey[] = [preferred, ...this.usableKeys().filter(k => k.id !== preferred.id)];

		const systemPrompt = (this.configurationService.getValue<string>(AURA_API_SYSTEM_PROMPT_SETTING) ?? '').trim();
		const oaiMessages: IOpenAIMessage[] = [];
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

		const stream = (async function* () {
			let lastError: unknown;
			let yielded = false; // стрим начался — фейловер на другой ключ уже невозможен (иначе дубли текста)
			for (const key of candidates) {
				if (controller.signal.aborted) { break; }
				try {
					const secret = await self.keysService.getSecret(key.id);
					const base = key.baseUrl.replace(/\/+$/, '');
					const response = await fetch(`${base}/chat/completions`, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
						},
						body: JSON.stringify({ model: key.model, messages: oaiMessages, stream: true }),
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
								const delta = json?.choices?.[0]?.delta?.content;
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
