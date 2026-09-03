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
		const key = this.keysService.getKeys().find(k => k.id === modelId);
		if (!key) { throw new Error(`Aura API: ключ ${modelId} не найден`); }
		const secret = await this.keysService.getSecret(key.id);
		const base = key.baseUrl.replace(/\/+$/, '');

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

		const result = (async () => {
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
				throw new Error(`Aura API: HTTP ${response.status} — ${await response.text().catch(() => '')}`);
			}
			const data = await response.json();
			return String(data?.choices?.[0]?.message?.content ?? '');
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
