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

	async sendChatRequest(modelId: string, messages: IChatMessage[], _from: ExtensionIdentifier | undefined, _options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		// Этап 3: фейловер — предпочтительный ключ (по modelId) первым, дальше остальные
		// здоровые ключи по порядку; чат не падает, пока жив хоть один ключ.
		const preferred = this.keysService.getKeys().find(k => k.id === modelId);
		if (!preferred) { throw new Error(`Aura API: ключ ${modelId} не найден`); }
		const candidates: IAuraApiKey[] = [preferred, ...this.usableKeys().filter(k => k.id !== preferred.id)];

		// Системные правила из настройки auraApi.chat.systemPrompt идут первым сообщением
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

		const doRequest = async (key: IAuraApiKey): Promise<string> => {
			const secret = await this.keysService.getSecret(key.id);
			const base = key.baseUrl.replace(/\/+$/, '');
			const response = await fetch(`${base}/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
				},
				body: JSON.stringify({ model: key.model, messages: oaiMessages, stream: false }),
				signal: controller.signal,
			});
			if (!response.ok) {
				const body = await response.text().catch(() => '');
				// Фейловер только на сетевых/лимитных/серверных ошибках: на 401/403 другой ключ может быть жив
				throw new Error(`Aura API [${key.name}]: HTTP ${response.status} — ${body.slice(0, 200)}`);
			}
			const data = await response.json();
			return String(data?.choices?.[0]?.message?.content ?? '');
		};

		const result = (async () => {
			let lastError: unknown;
			for (const key of candidates) {
				if (controller.signal.aborted) { break; }
				try {
					return await doRequest(key);
				} catch (e) {
					lastError = e; // пробуем следующий ключ
				}
			}
			throw lastError instanceof Error ? lastError : new Error('Aura API: все ключи недоступны');
		})();

		const stream = (async function* () {
			const text = await result;
			yield { type: 'text' as const, value: text };
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
