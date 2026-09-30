/*---------------------------------------------------------------------------------------------
 *  API Keys — провайдер языковых моделей для встроенного чата.
 *  Каждый здоровый ключ (ok, без высокого пинга) появляется в списке моделей
 *  чата как BYOK-модель; запросы уходят на его OpenAI-совместимый эндпоинт.
 *  Поддерживает tool calling: options.tools уходят в запрос, tool_calls из ответа
 *  возвращаются партами { type: 'tool_use' } для цикла агента.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import {
	ILanguageModelChatProvider, ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatResponse,
	ILanguageModelChatRequestOptions, ILanguageModelChatInfoOptions, ILanguageModelChatMetadata,
	IChatMessage, IChatResponsePart,
} from '../../chat/common/languageModels.js';
import { IAuraApiKeysService, IAuraApiKey } from '../common/auraApiKeys.js';
import {
	describeNetworkFailure, describeSlowDecision, describeStreamStall, hasFasterAlternative,
	isNetworkFailure, routerLimits, slowThresholdMs, bestMedianLatency, medianLatency,
} from '../common/auraApiModel.js';
import { agggBoostActive, agggBoostPrompt } from '../../aggg/common/agggBoost.js';
import { ILogService } from '../../../../platform/log/common/log.js';

export const API_KEYS_VENDOR = 'apiKeys';
export const API_KEYS_SYSTEM_PROMPT_SETTING = 'apiKeys.chat.systemPrompt';
/** Прежний id настройки (брендинг «auraApi»): читаем как fallback, чтобы не потерять промпт пользователя. */
export const LEGACY_SYSTEM_PROMPT_SETTING = 'auraApi.chat.systemPrompt';

/**
 * Молчание эндпоинта: нет первого токена или пауза посреди ответа. Отдельный тип, чтобы
 * не путать это с сетевым сбоем (другая причина, другое поведение) и отменой пользователем.
 */
class AuraStreamStallError extends Error {
	constructor(readonly phase: 'first-token' | 'gap', readonly waitedMs: number) {
		super(describeStreamStall(phase, waitedMs));
	}
}

/** Спецификация инструмента, приходящая в options.tools (формат vscode.lm). */
interface ILMToolSpec {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

/** Нормализованное содержимое сообщения: из него собираются payload'ы всех провайдеров. */
type INormalizedContent =
	| { kind: 'text'; text: string }
	| { kind: 'toolUse'; id: string; name: string; input: unknown }
	| { kind: 'toolResult'; id: string; text: string; isError?: boolean };

interface INormalizedMessage {
	role: 'system' | 'user' | 'assistant';
	content: INormalizedContent[];
}

interface IOpenAIToolCallBuffer {
	id: string;
	name: string;
	args: string;
}

/** Состояние накопления tool_calls, живущее между SSE-чанками одного ответа. */
interface IStreamParseState {
	toolBuffers: Map<number, IOpenAIToolCallBuffer>;
}

export class AuraApiChatProvider implements ILanguageModelChatProvider {

	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		private readonly keysService: IAuraApiKeysService,
		private readonly configurationService: IConfigurationService,
		private readonly logService: ILogService,
	) {
		this.keysService.onDidChange(() => this._onDidChange.fire());
		// Смена активного ключа подхватывается без перезапуска IDE: клиент не кэшируется,
		// выбор ключа происходит на каждый запрос; обновляем список моделей чата.
		this.keysService.onDidChangeActiveKey(() => this._onDidChange.fire());
	}

	/** Здоровые ключи как модели чата: включённые, проверенные, без высокого пинга. */
	private usableKeys(): IAuraApiKey[] {
		return this.keysService.getKeys().filter(k => {
			if (k.enabled === false) { return false; }
			const s = this.keysService.getStatus(k.id);
			return s.ok === true && !s.excludedHighPing;
		});
	}

	async provideLanguageModelChatInfo(_options: ILanguageModelChatInfoOptions, _token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		return this.usableKeys().map(key => {
			const identifier = `${API_KEYS_VENDOR}/${key.id}`;
			const metadata: ILanguageModelChatMetadata = {
				extension: new ExtensionIdentifier('aura.aura-api'),
				name: `${key.name} (${key.model})`,
				id: key.id,
				vendor: API_KEYS_VENDOR,
				version: '1.0.0',
				family: key.model,
				maxInputTokens: 128000,
				maxOutputTokens: 16000,
				isDefaultForLocation: {},
				isUserSelectable: true,
				isBYOK: true,
				tooltip: `API Keys: ${key.model} @ ${key.baseUrl}`,
				capabilities: { toolCalling: true, agentMode: true },
			};
			return { identifier, metadata };
		});
	}

	/** IChatMessage[] → нормализованный вид: роли system/user/assistant, текст, вызовы и результаты инструментов. */
	private normalizeMessages(messages: IChatMessage[]): INormalizedMessage[] {
		const out: INormalizedMessage[] = [];
		for (const m of messages) {
			const role: INormalizedMessage['role'] = m.role === 0 /* System */ ? 'system' : m.role === 1 /* User */ ? 'user' : 'assistant';
			const content: INormalizedContent[] = [];
			for (const part of m.content) {
				if (part.type === 'text' && part.value) {
					content.push({ kind: 'text', text: part.value });
				} else if (part.type === 'tool_use') {
					content.push({ kind: 'toolUse', id: part.toolCallId, name: part.name, input: part.parameters ?? {} });
				} else if (part.type === 'tool_result') {
					const text = part.value
						.map(v => (v as { type?: string; value?: unknown }).type === 'text' ? String((v as { value: unknown }).value) : '')
						.filter(Boolean)
						.join('\n');
					content.push({ kind: 'toolResult', id: part.toolCallId, text: text || '(empty result)', isError: part.isError });
				}
			}
			if (content.length) {
				// Одна роль может встречаться подряд (результаты инструментов) — склеиваем с предыдущим.
				const prev = out.at(-1);
				if (prev && prev.role === role) {
					prev.content.push(...content);
				} else {
					out.push({ role, content });
				}
			}
		}
		return out;
	}

	async sendChatRequest(modelId: string, messages: IChatMessage[], _from: ExtensionIdentifier | undefined, options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		// Выбор ключа через роутер (группы → веса → cooldown), fallback — старый список
		const selectedKeyId = modelId.startsWith(`${API_KEYS_VENDOR}/`) ? modelId.slice(API_KEYS_VENDOR.length + 1) : modelId;
		const routed = this.keysService.resolveKeyForModel(selectedKeyId);
		// Явно выбранная модель доступна вручную всегда — даже если ключ сейчас в статусе ошибки.
		// Но выключенный ключ (enabled === false) не выбирается никогда.
		const explicit = this.keysService.getKeys().find(k => k.id === selectedKeyId && k.enabled !== false);
		const preferred = explicit ?? routed;
		if (!preferred) {
			throw new Error(this.keysService.getKeys().length === 0
				? 'API Keys: нет настроенных ключей. Откройте панель «Ключи для чата» и нажмите «Добавить ключ».'
				: `API Keys: нет живых ключей (modelId=${modelId})`);
		}
		const candidates: IAuraApiKey[] = [preferred, ...this.usableKeys().filter(k => k.id !== preferred.id)];

		const systemPrompt = (this.configurationService.getValue<string>(API_KEYS_SYSTEM_PROMPT_SETTING) ?? '').trim();
		const normalized = this.normalizeMessages(messages);
		// AGGG-буст: ядро правил AGGG первым системным сообщением (глобально или на проект).
		// Ядро живое: при выборе внешнего агента 5.2 сюда подставляется его harness/core.txt.
		const systemParts: INormalizedMessage[] = [];
		if (agggBoostActive(this.configurationService)) {
			systemParts.push({ role: 'system', content: [{ kind: 'text', text: agggBoostPrompt.current }] });
		}
		if (systemPrompt) {
			systemParts.push({ role: 'system', content: [{ kind: 'text', text: systemPrompt }] });
		}
		const conversation = [...systemParts, ...normalized];

		// Инструменты для модели (формат vscode.lm: name/description/inputSchema).
		// Google-ветку пока без tools: там другой формат functionDeclarations.
		const tools: ILMToolSpec[] = Array.isArray((options as { tools?: unknown }).tools) ? (options as { tools: ILMToolSpec[] }).tools : [];

		const controller = new AbortController();
		// Подписка живёт ровно столько, сколько запрос: иначе каждая отправка оставляет
		// слушателя на токене и длинная сессия чата копит их без причины.
		const cancellationListener = token.onCancellationRequested(() => controller.abort());

		const self = this;
		let resolveResult!: (v: string) => void;
		let rejectResult!: (e: unknown) => void;
		const result = new Promise<string>((res, rej) => { resolveResult = res; rejectResult = rej; });

		/** Собрать запрос под провайдера конкретного ключа. */
		const buildRequest = (key: IAuraApiKey, secret: string | undefined): { url: string; headers: Record<string, string>; body: string } => {
			const base = key.baseUrl.replace(/\/+$/, '');
			if (key.provider === 'anthropic') {
				const system = conversation.filter(m => m.role === 'system').flatMap(m => m.content.filter(c => c.kind === 'text').map(c => (c as { text: string }).text)).join('\n');
				const anthropicMessages = conversation.filter(m => m.role !== 'system').map(m => ({
					role: m.role,
					content: m.content.map(c => {
						if (c.kind === 'text') { return { type: 'text', text: c.text }; }
						if (c.kind === 'toolUse') { return { type: 'tool_use', id: c.id, name: c.name, input: c.input }; }
						return { type: 'tool_result', tool_use_id: c.id, content: c.text, ...(c.isError ? { is_error: true } : {}) };
					}),
				}));
				const anthropicTools = tools.length ? tools.map(t => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema ?? { type: 'object', properties: {} } })) : undefined;
				return {
					url: `${base}/v1/messages`,
					headers: {
						'Content-Type': 'application/json',
						...(secret ? { 'x-api-key': secret, 'anthropic-version': '2023-06-01' } : {}),
					},
					body: JSON.stringify({ model: key.model, system: system || undefined, messages: anthropicMessages, stream: true, max_tokens: 8192, ...(anthropicTools ? { tools: anthropicTools } : {}) }),
				};
			}
			if (key.provider === 'google') {
				// Инструменты в Google-формат пока не сериализуем: tool_use/tool_result превращаем в текст,
				// чтобы диалог не ломался, и не передаём tools вовсе.
				const system = conversation.filter(m => m.role === 'system').flatMap(m => m.content.filter(c => c.kind === 'text').map(c => (c as { text: string }).text)).join('\n');
				const googleContents = conversation.filter(m => m.role !== 'system').map(m => ({
					role: m.role === 'user' ? 'user' : 'model',
					parts: m.content.map(c => {
						if (c.kind === 'text') { return { text: c.text }; }
						if (c.kind === 'toolUse') { return { text: `[tool call: ${c.name}(${JSON.stringify(c.input)})]` }; }
						return { text: `[tool result${c.isError ? ' (error)' : ''}: ${c.text}]` };
					}),
				}));
				return {
					url: `${base}/v1beta/models/${encodeURIComponent(key.model)}:streamGenerateContent?alt=sse${secret ? `&key=${encodeURIComponent(secret)}` : ''}`,
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
						contents: googleContents,
					}),
				};
			}
			// openai-compatible, openrouter, litellm — единый формат OpenAI
			const openaiMessages: Array<Record<string, unknown>> = [];
			for (const m of conversation) {
				if (m.role === 'system') {
					openaiMessages.push({ role: 'system', content: m.content.filter(c => c.kind === 'text').map(c => (c as { text: string }).text).join('\n') });
					continue;
				}
				if (m.role === 'user') {
					const text = m.content.filter(c => c.kind === 'text').map(c => (c as { text: string }).text).join('\n');
					if (text) { openaiMessages.push({ role: 'user', content: text }); }
					for (const c of m.content) {
						if (c.kind === 'toolResult') {
							openaiMessages.push({ role: 'tool', tool_call_id: c.id, content: c.isError ? `Error: ${c.text}` : c.text });
						}
					}
					continue;
				}
				// assistant: текст + tool_calls
				const text = m.content.filter(c => c.kind === 'text').map(c => (c as { text: string }).text).join('\n');
				const toolCalls = m.content.filter(c => c.kind === 'toolUse');
				const msg: Record<string, unknown> = { role: 'assistant', content: text || null };
				if (toolCalls.length) {
					msg.tool_calls = toolCalls.map(c => ({
						id: (c as { id: string }).id,
						type: 'function',
						function: { name: (c as { name: string }).name, arguments: JSON.stringify((c as { input: unknown }).input ?? {}) },
					}));
				}
				openaiMessages.push(msg);
			}
			const openaiTools = tools.length ? tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema ?? { type: 'object', properties: {} } } })) : undefined;
			return {
				url: `${base}/chat/completions`,
				headers: {
					'Content-Type': 'application/json',
					...(secret ? { 'Authorization': `Bearer ${secret}` } : {}),
				},
				body: JSON.stringify({ model: key.model, messages: openaiMessages, stream: true, ...(openaiTools ? { tools: openaiTools, tool_choice: 'auto' } : {}) }),
			};
		};

		/**
		 * Разобрать одно SSE-событие: вернуть текстовые дельты и завершённые tool_use партии.
		 * Незавершённые tool_calls копятся в state.toolBuffers (OpenAI сбрасывается при flushToolBuffers,
		 * Anthropic — по content_block_stop).
		 */
		const extractStreamParts = (key: IAuraApiKey, json: Record<string, unknown>, state: IStreamParseState): IChatResponsePart[] => {
			const parts: IChatResponsePart[] = [];
			if (key.provider === 'anthropic') {
				const type = json.type as string | undefined;
				if (type === 'content_block_start') {
					const block = json.content_block as { type?: string; id?: string; name?: string } | undefined;
					if (block?.type === 'tool_use') {
						state.toolBuffers.set(json.index as number ?? 0, { id: block.id ?? '', name: block.name ?? '', args: '' });
					}
				} else if (type === 'content_block_delta') {
					const delta = json.delta as { type?: string; text?: string; partial_json?: string } | undefined;
					if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
						parts.push({ type: 'text', value: delta.text });
					} else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
						const buf = state.toolBuffers.get(json.index as number ?? 0);
						if (buf) { buf.args += delta.partial_json; }
					}
				} else if (type === 'content_block_stop') {
					const idx = json.index as number ?? 0;
					const buf = state.toolBuffers.get(idx);
					if (buf) {
						state.toolBuffers.delete(idx);
						parts.push(toToolUsePart(buf));
					}
				}
				return parts;
			}
			if (key.provider === 'google') {
				const textParts = (json?.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined)?.[0]?.content?.parts;
				if (Array.isArray(textParts)) {
					const value = textParts.map(p => typeof p?.text === 'string' ? p.text : '').join('');
					if (value) { parts.push({ type: 'text', value }); }
				}
				return parts;
			}
			// OpenAI-формат
			const choice = (json?.choices as Array<{ delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }> | undefined)?.[0];
			if (typeof choice?.delta?.content === 'string' && choice.delta.content) {
				parts.push({ type: 'text', value: choice.delta.content });
			}
			for (const call of choice?.delta?.tool_calls ?? []) {
				const idx = typeof call.index === 'number' ? call.index : 0;
				const buf = state.toolBuffers.get(idx) ?? { id: '', name: '', args: '' };
				if (call.id) { buf.id = call.id; }
				if (call.function?.name) { buf.name += call.function.name; }
				if (call.function?.arguments) { buf.args += call.function.arguments; }
				state.toolBuffers.set(idx, buf);
			}
			return parts;
		};

		const toToolUsePart = (buf: IOpenAIToolCallBuffer): IChatResponsePart => {
			let parameters: unknown = {};
			try { parameters = JSON.parse(buf.args || '{}'); } catch { /* неполный JSON — модель получит пустые параметры */ }
			return { type: 'tool_use', name: buf.name, toolCallId: buf.id || `call_${Date.now()}`, parameters };
		};

		/** OpenAI tool_calls завершаются только с концом стрима — выдаём накопленное. */
		const flushToolBuffers = (state: IStreamParseState): IChatResponsePart[] => {
			const parts: IChatResponsePart[] = [];
			for (const idx of [...state.toolBuffers.keys()].sort((a, b) => a - b)) {
				const buf = state.toolBuffers.get(idx)!;
				if (buf.name) { parts.push(toToolUsePart(buf)); }
			}
			state.toolBuffers.clear();
			return parts;
		};

		// Пороги «живого» переключения читаются один раз на запрос: они меняются только пользователем.
		const limits = routerLimits(key => self.configurationService.getValue(key));
		/** Скорость ключа для сравнения: медиана живых замеров, иначе последний замер, иначе пинг зонда. */
		const speedHint = (key: IAuraApiKey) => {
			const s = self.keysService.getStatus(key.id);
			return { latencyMs: medianLatency(s.latencySamples) ?? s.latencyMs, pingMs: s.pingMs };
		};
		// Порог адаптивный: лучший ключ среди доступных — база, а не фиксированные миллисекунды.
		// На медленном канале, где все ключи отвечают за 4 с, 4 с — не повод переключаться.
		const bestMedianMs = bestMedianLatency(candidates.map(k => self.keysService.getStatus(k.id).latencySamples));
		const slowMs = slowThresholdMs(bestMedianMs, limits);
		const stream = (async function* () {
			let lastError: unknown;
			let yielded = false; // стрим начался — фейловер на другой ключ уже невозможен (иначе дубли текста)
			for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
				const key = candidates[candidateIndex];
				if (controller.signal.aborted) { break; }
				// 5xx — retry с бэкоффом до 3 раз по тому же ключу, затем фейловер.
				for (let attempt = 0; attempt < 3; attempt++) {
					if (controller.signal.aborted) { break; }
					// Попытка живёт в своём AbortController: медленный старт или молчание гасят только её,
					// а отмена пользователем идёт по мосту от общего контроллера запроса.
					const attemptController = new AbortController();
					const abortAttempt = () => attemptController.abort();
					if (controller.signal.aborted) { abortAttempt(); } else { controller.signal.addEventListener('abort', abortAttempt); }
					let attemptReader: ReadableStreamDefaultReader<Uint8Array> | undefined; // для закрытия потока при молчании
					try {
						const secret = await self.keysService.getSecret(key.id);
						// Google-ветка в buildRequest сама игнорирует tools (другой формат functionDeclarations).
						const request = buildRequest(key, secret);
						// Трассировка без секрета: только маска ключа.
						self.logService.trace(`[AuraAPI] chat request → ${key.name} (${key.baseUrl}), key ${self.keysService.maskedSecretLabel(key.id)}, attempt ${attempt + 1}, tools=${tools.length}`);
						const response = await fetch(request.url, {
							method: 'POST',
							headers: request.headers,
							body: request.body,
							signal: attemptController.signal,
						});
						if (!response.ok || !response.body) {
							const status = response.status ?? 0;
							self.keysService.reportChatRequestResult(key.id, status);
							if (status === 401) {
								throw new Error(`API Keys [${key.name}]: ключ недействителен (HTTP 401)`);
							}
							if (status === 429) {
								throw new Error(`API Keys [${key.name}]: лимит исчерпан (HTTP 429) — переключаюсь на следующий ключ`);
							}
							if (status >= 500) {
								if (attempt < 2) {
									await new Promise(r => setTimeout(r, 250 * 2 ** attempt));
									continue; // retry с бэкоффом
								}
								throw new Error(`API Keys [${key.name}]: сервер недоступен (HTTP ${status}) после 3 попыток`);
							}
							const body = await response.text().catch(() => '');
							throw new Error(`API Keys [${key.name}]: HTTP ${status} — ${body.slice(0, 200)}`);
						}
					// SSE: читаем дельты и репортим их по мере поступления
					const reader = response.body.getReader();
					attemptReader = reader;
					const decoder = new TextDecoder();
					const parseState: IStreamParseState = { toolBuffers: new Map() };
					let buffer = '';
					let fullText = '';
					// Живые замеры: сколько ждали первый токен и не тянет ли эта модель время.
					const attemptStart = Date.now();
					let firstTokenMs: number | undefined;
					let switchToFaster: string | undefined;
					for (;;) {
						const maxSilenceMs = firstTokenMs === undefined
							? Math.max(1, limits.firstTokenTimeoutMs - (Date.now() - attemptStart))
							: limits.streamGapMs;
						const { done, value } = await self.readWithWatchdog(reader, maxSilenceMs, firstTokenMs === undefined ? 'first-token' : 'gap');
						if (done) { break; }
						if (firstTokenMs === undefined) {
							firstTokenMs = Date.now() - attemptStart;
							// Живой, но медленный ключ: измерение уходит в реестр, и следующий запрос
							// (и сортировка в панели) уже учитывают реальную скорость, а не пинг /models.
							self.keysService.reportChatLatency(key.id, firstTokenMs);
							if (firstTokenMs > slowMs && !yielded && hasFasterAlternative(
								{ latencyMs: firstTokenMs, pingMs: self.keysService.getStatus(key.id).pingMs },
								candidates.slice(candidateIndex + 1).map(speedHint),
								slowMs,
							)) {
								// Ничего ещё не ушло в чат — не ждём полного таймаута, а сразу идём на быстрый ключ.
								self.logService.trace(`[AuraAPI] медленный ключ ${key.name}: ${describeSlowDecision(firstTokenMs, slowMs, bestMedianMs)}`);
								switchToFaster = `первый токен за ${firstTokenMs} мс против лучших ${bestMedianMs ?? '?'} мс — переключаюсь на более быстрый ключ`;
							}
						}
						if (switchToFaster !== undefined) { break; }
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
								for (const part of extractStreamParts(key, json, parseState)) {
									if (part.type === 'text') { fullText += part.value; }
									yielded = true;
									yield part;
								}
							} catch { /* неполный JSON-чанк — пропускаем */ }
						}
					}
					if (switchToFaster !== undefined) {
						// В чат ничего не ушло: медленный старт не потерян, уходим на быстрый ключ.
						try { await reader.cancel(); } catch { /* поток больше не нужен */ }
						lastError = new Error(`API Keys [${key.name}] ${key.model}: ${switchToFaster}`);
						break;
					}
					// OpenAI отдаёт tool_calls по кусочкам — дособираем и выдаём в конце стрима.
					for (const part of flushToolBuffers(parseState)) {
						yielded = true;
						yield part;
					}
					resolveResult(fullText);
					cancellationListener.dispose();
					return;					} catch (e) {
						// Отмена пользователем — не повод наказывать ключ.
						const cancelled = controller.signal.aborted;
						const stall = !cancelled && e instanceof AuraStreamStallError;
						const network = !cancelled && !stall && isNetworkFailure(e);
						if (stall) {
							// Эндпоинт жив, но не отвечает: и в реестр скорости (растёт серия), и в cooldown.
							self.keysService.reportChatLatency(key.id, e.waitedMs);
							self.keysService.reportChatNetworkFailure(key.id, describeStreamStall(e.phase, e.waitedMs));
							if (!yielded) { try { await attemptReader?.cancel(); } catch { /* поток уже не нужен */ } }
						} else if (network) {
							// Ключ/эндпоинт не отвечает: короткий cooldown, следующий запрос начнётся с другого ключа.
							self.keysService.reportChatNetworkFailure(key.id, describeNetworkFailure(e));
						}
						if (yielded) {
							// Соединение оборвалось/замолчало на середине ответа: текст уже ушёл в чат, повтор (в том
							// числе другим ключом) продублировал бы его. Сообщаем, что именно случилось.
							// Поток бесполезен дальше: гасим его, иначе соединение будет висеть до таймаута сети.
							attemptController.abort();
							const interrupted = stall
								? new Error(`API Keys [${key.name}] ${key.model}: ${describeStreamStall(e.phase, e.waitedMs)}. Ответ выше не полный — повторите запрос.`)
								: network
									? new Error(`API Keys [${key.name}] ${key.model}: соединение прервано (${describeNetworkFailure(e)}). Ответ выше не полный — повторите запрос.`)
									: e;
							cancellationListener.dispose();
							rejectResult(interrupted);
							throw interrupted;
						}
						// Ошибка до первого байта — пробуем следующий ключ.
						lastError = stall
							? new Error(`API Keys [${key.name}] ${key.model} @ ${key.baseUrl}: ${describeStreamStall(e.phase, e.waitedMs)} — переключаюсь на другой ключ`)
							: network
								? new Error(`API Keys [${key.name}] ${key.model} @ ${key.baseUrl}: сеть недоступна (${describeNetworkFailure(e)})`)
								: e;
						break; // выход из цикла retry: 401/429/сеть/молчание не перезапрашиваем по тому же ключу
					} finally {
						controller.signal.removeEventListener('abort', abortAttempt);
					}
				}
			}
		// Все кандидаты отработаны: сообщаем последнюю причину и сколько ключей перепробовано —
		// иначе чат показывает невнятное «network error» без адреса и причины.
		const err = lastError instanceof Error
			? (candidates.length > 1 && !controller.signal.aborted
				? new Error(`Все ключи недоступны (проверено ${candidates.length}). Последняя ошибка — ${lastError.message}`)
				: lastError)
			: new Error('API Keys: все ключи недоступны');
		rejectResult(err);
		cancellationListener.dispose();
		throw err;
		})();

		return { stream, result };
	}

	/**
	 * Чтение SSE-чанка под надзором: если данных нет дольше лимита, попытка прерывается ошибкой
	 * молчания. Без этого «задумавшийся» эндпоинт подвешивает чат до отмены пользователем.
	 */
	private readWithWatchdog(reader: ReadableStreamDefaultReader<Uint8Array>, maxSilenceMs: number, phase: 'first-token' | 'gap'): Promise<ReadableStreamReadResult<Uint8Array>> {
		if (!(maxSilenceMs > 0)) {
			return reader.read();
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const silence = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new AuraStreamStallError(phase, maxSilenceMs)), maxSilenceMs);
		});
		return Promise.race([reader.read(), silence]).finally(() => {
			if (timer !== undefined) { clearTimeout(timer); }
		});
	}

	async provideTokenCount(_modelId: string, message: string | IChatMessage, _token: CancellationToken): Promise<number> {
		const text = typeof message === 'string'
			? message
			: message.content.map(p => String((p as { value?: unknown }).value ?? '')).join(' ');
		return Math.ceil(text.length / 4); // приблизительная оценка токенов
	}
}
