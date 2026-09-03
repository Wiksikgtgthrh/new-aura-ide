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
import {
	ILanguageModelChatProvider, ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatResponse,
	ILanguageModelChatRequestOptions, ILanguageModelChatInfoOptions, ILanguageModelChatMetadata,
} from '../../chat/common/languageModels.js';
import { IChatMessage } from '../../chat/common/languageModels.js';
import { IAuraApiKeysService, IAuraApiKey } from '../common/auraApiKeys.js';
import { AuraSseParser } from '../common/auraApiModel.js';

export const AURA_API_VENDOR = 'auraApi';
export const AURA_API_SYSTEM_PROMPT_SETTING = 'auraApi.chat.systemPrompt';

interface IOpenAIMessage { role: string; content: string }

/** Читает тело SSE-ответа и отдаёт текстовые дельты по мере поступления. */
async function* readSseText(response: Response, signal: AbortSignal): AsyncGenerator<string> {
	const body = response.body;
	if (!body) {
		// Провайдер проигнорировал stream:true и отдал ответ целиком.
		const data = await response.json().catch(() => undefined) as { choices?: Array<{ message?: { content?: unknown } }> } | undefined;
		const text = String(data?.choices?.[0]?.message?.content ?? '');
		if (text) {
			yield text;
		}
		return;
	}
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
					yield delta.text;
				}
			}
		}
		for (const delta of parser.flush()) {
			if (delta.text) {
				yield delta.text;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

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

	async sendChatRequest(modelId: string, messages: IChatMessage[], _from: ExtensionIdentifier | undefined, _options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
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
				body: JSON.stringify({ model: key.model, messages: oaiMessages, stream: true }),
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

		const stream = (async function* () {
			let lastError: unknown;
			let full = '';
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
					for await (const text of readSseText(response, controller.signal)) {
						full += text;
						yield { type: 'text' as const, value: text };
					}
					result.complete(full);
					return;
				} catch (e) {
					// Поток оборвался после первых дельт: повтор на другом ключе продублировал бы
					// уже показанный текст, поэтому отдаём то, что успели получить.
					if (full) {
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
