import * as http from 'http';
import { timingSafeEqual, randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { ChatMessage, ChatRequest, ChatToolSpec, ChatUsage, RouterProxy } from './routerProxy';
import { isTier, KeyTier } from './tierStore';
import { ModelCatalog } from './modelCatalog';
import { PriceTable, costOf, priceFor } from './pricing';
import { logInfo, logWarn } from '../util/log';

/** Максимум тела запроса: промпты с большим контекстом, но не бесконечность. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface LocalProxyOptions {
	router: RouterProxy;
	catalog: ModelCatalog;
	/** Секрет запуска: только он и адрес уходят сайдкару, API-ключи — никогда. */
	token: string;
	/** Таблица цен (Этап 5.1): по ней считается стоимость ответа. */
	prices: PriceTable;
	/** Колбэк учёта: host копит расход по моделям для панели. */
	onUsage?: (usage: ChatUsage) => void;
}

/**
 * Локальный LLM-прокси: единственная дверь сайдкара к моделям.
 *
 * Сайдкар знает только `AURA_PROXY_URL` и `AURA_RUN_TOKEN`. В теле запроса он
 * называет тир (`{"tier":"low",...}`), а не модель: выбор ключа, фейловер внутри
 * тира и подъём на тир выше остаются здесь, в extension host. Секреты ключей и
 * токены доступа к ним не покидают процесс расширения и не пишутся в лог.
 */
export class LocalLlmProxy implements vscode.Disposable {
	private server?: http.Server;
	private port?: number;

	constructor(private readonly options: LocalProxyOptions) {}

	/** Поднять сервер на случайном порту loopback. Идемпотентно. */
	async start(): Promise<number> {
		if (this.port !== undefined) {
			return this.port;
		}
		const server = http.createServer((req, res) => void this.handle(req, res));
		this.server = server;
		const port = await new Promise<number>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				const address = server.address();
				if (address && typeof address === 'object') {
					resolve(address.port);
				} else {
					reject(new Error('proxy did not report a port'));
				}
			});
		});
		this.port = port;
		const counts = this.options.catalog.counts();
		logInfo(`llm proxy listening on 127.0.0.1:${port} (personal=${counts.personal}, team=${counts.team})`);
		return port;
	}

	get url(): string | undefined {
		return this.port !== undefined ? `http://127.0.0.1:${this.port}` : undefined;
	}

	dispose(): void {
		this.server?.close();
		this.server = undefined;
		this.port = undefined;
	}

	/** Случайный секрет запуска: сайдкар получает его только через окружение. */
	static newToken(): string {
		return randomBytes(32).toString('hex');
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		try {
			if (req.method === 'GET' && req.url === '/health') {
				return this.json(res, 200, { ok: true });
			}
			if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
				return this.json(res, 404, { error: 'not found' });
			}
			if (!this.authorized(req)) {
				// Токен не пишем даже в отказе: лог не должен хранить секреты.
				logWarn('llm proxy rejected request: bad run token');
				return this.json(res, 401, { error: 'unauthorized' });
			}
			const body = await this.readBody(req);
			const request = this.toRequest(body);
			const cancellation = new vscode.CancellationTokenSource();				try {
					const result = await this.options.router.complete(request, {}, cancellation.token);
					const usage = this.priceUsage(result.usage, result.usedTier, result.usedKeyName);
					this.options.onUsage?.(usage);
					logInfo(`proxy role=${request.role} tier=${result.usedTier} key=${result.usedKeyName} tokens=${usage.inputTokens}+${usage.outputTokens} cost=$${usage.costUsd.toFixed(4)}`);
					return this.json(res, 200, { ...result, usage });
				} finally {
				cancellation.dispose();
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logWarn(`llm proxy request failed: ${message}`);
			return this.json(res, 500, { error: message });
		}
	}

	/** Сравнение токена за постоянное время: длина проверяется отдельно. */
	private authorized(req: http.IncomingMessage): boolean {
		const header = req.headers.authorization ?? '';
		const prefix = 'Bearer ';
		if (!header.startsWith(prefix)) {
			return false;
		}
		const provided = Buffer.from(header.slice(prefix.length));
		const expected = Buffer.from(this.options.token);
		return provided.length === expected.length && timingSafeEqual(provided, expected);
	}

	private readBody(req: http.IncomingMessage): Promise<unknown> {
		return new Promise((resolve, reject) => {
			let size = 0;
			const chunks: Buffer[] = [];
			req.on('data', chunk => {
				size += chunk.length;
				if (size > MAX_BODY_BYTES) {
					reject(new Error('request body too large'));
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on('end', () => {
				try {
					resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
				} catch {
					reject(new Error('invalid JSON body'));
				}
			});
			req.on('error', reject);
		});
	}

	/** Цена ответа по таблице тиров/моделей; неизвестная модель — как high-тир. */
	private priceUsage(usage: ChatUsage | undefined, tier: KeyTier, modelName: string): ChatUsage {
		const tokens = {
			inputTokens: Number(usage?.inputTokens) || 0,
			outputTokens: Number(usage?.outputTokens) || 0,
		};
		const model = usage?.model || modelName || '';
		const costUsd = costOf(tokens, priceFor(this.options.prices, model, tier));
		return { ...tokens, costUsd, model, tier };
	}

	/** Тело сайдкара: тир вместо модели; сообщения и инструменты — как в RPC-вызове. */
	private toRequest(body: unknown): ChatRequest {
		const input = (body ?? {}) as Record<string, unknown>;
		const tier = isTier(input.tier) ? (input.tier as KeyTier) : 'mid';
		const messages = Array.isArray(input.messages) ? input.messages as ChatMessage[] : [];
		const tools = Array.isArray(input.tools) ? input.tools as ChatToolSpec[] : undefined;
		return {
			role: typeof input.role === 'string' ? input.role : 'worker',
			tier,
			messages,
			tools,
			maxTokens: typeof input.maxTokens === 'number' ? input.maxTokens : undefined,
		};
	}

	private json(res: http.ServerResponse, status: number, payload: unknown): void {
		const text = JSON.stringify(payload);
		res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
		res.end(text);
	}
}
