import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { logError, logWarn } from '../util/log';

export interface RpcRequest {
	kind: 'req';
	id: number;
	method: 'chat.complete' | 'tool.invoke';
	params: unknown;
}

export interface RpcCommand {
	kind: 'cmd';
	id: number;
	/** cancelNode — отмена одной подзадачи графа, не всего запуска; interrupt.resolve —
	 *  решение пользователя по рискованной подзадаче; history/rewind/patchState — машина времени. */
	method:
		| 'start'
		| 'pause'
		| 'resume'
		| 'cancel'
		| 'cancelNode'
		| 'status'
		| 'interrupt.resolve'
		| 'history'
		| 'rewind'
		| 'patchState';
	params?: unknown;
}

interface RpcMessage {
	kind: 'req' | 'res' | 'ntf' | 'evt' | 'cmd';
	id?: number;
	method?: string;
	event?: string;
	ok?: boolean;
	params?: unknown;
	result?: unknown;
	error?: string;
	data?: unknown;
}

/**
 * JSON-RPC поверх stdio сайдкара: строки-JSON в обе стороны.
 * Расширение шлёт команды (start/pause/resume/cancel/cancelNode), сайдкар шлёт
 * запросы (chat.complete/tool.invoke), события стрима (evt) и нотификации (ntf).
 */
export class RpcClient {
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
	private buffer = '';
	private readonly emitter = new EventEmitter();

	constructor(private child: ChildProcess) {
		child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
		child.stdout?.setEncoding('utf8');
		child.stderr?.on('data', (chunk: Buffer) => {
			logWarn(`sidecar stderr: ${chunk.toString().trim().slice(0, 500)}`);
		});
		child.on('exit', () => this.failAll(new Error('sidecar exited')));
	}

	onRequest(handler: (method: string, params: unknown, reply: (ok: boolean, resultOrError: unknown) => void) => void): void {
		this.emitter.on('req', handler);
	}

	onStreamEvent(handler: (requestId: number, event: string, data: unknown) => void): void {
		this.emitter.on('evt', handler);
	}

	onNotification(handler: (method: string, params: unknown) => void): void {
		this.emitter.on('ntf', handler);
	}

	sendCommand(method: RpcCommand['method'] | (string & {}), params?: unknown, timeoutMs = 30_000): Promise<unknown> {
		const id = this.nextId++;
		const message = { kind: 'cmd', id, method, params } as RpcCommand;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`sidecar command ${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
			this.write(message);
		});
	}

	sendReply(id: number, ok: boolean, resultOrError: unknown): void {
		const message: RpcMessage = ok
			? { kind: 'res', id, ok: true, result: resultOrError }
			: { kind: 'res', id, ok: false, error: resultOrError instanceof Error ? resultOrError.message : String(resultOrError) };
		this.write(message);
	}

	/** Внеочередной фрейм (стрим токенов и прочие события к запросу). */
	writeRaw(message: RpcMessage): void {
		this.write(message);
	}

	dispose(): void {
		this.failAll(new Error('rpc disposed'));
		this.emitter.removeAllListeners();
	}

	private onData(chunk: Buffer | string): void {
		this.buffer += chunk.toString();
		let idx: number;
		while ((idx = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, idx).trim();
			this.buffer = this.buffer.slice(idx + 1);
			if (line) {
				this.dispatch(line);
			}
		}
	}

	private dispatch(line: string): void {
		let message: RpcMessage;
		try {
			message = JSON.parse(line) as RpcMessage;
		} catch (err) {
			logError('sidecar sent invalid JSON', err);
			return;
		}
		switch (message.kind) {
			case 'res': {
				const entry = message.id !== undefined ? this.pending.get(message.id) : undefined;
				if (entry && message.id !== undefined) {
					this.pending.delete(message.id);
					clearTimeout(entry.timer);
					if (message.ok) {
						entry.resolve(message.result);
					} else {
						entry.reject(new Error(message.error ?? 'unknown sidecar error'));
					}
				}
				break;
			}
			case 'req': {
				const id = message.id ?? 0;
				this.emitter.emit('req', message.method ?? '', message.params, (ok: boolean, resultOrError: unknown) => {
					this.sendReply(id, ok, resultOrError);
				});
				break;
			}
			case 'evt':
				this.emitter.emit('evt', message.id ?? 0, message.event ?? '', message.data);
				break;
			case 'ntf':
				this.emitter.emit('ntf', message.method ?? '', message.params);
				break;
		}
	}

	private write(message: RpcMessage): void {
		try {
			this.child.stdin?.write(JSON.stringify(message) + '\n');
		} catch (err) {
			logError('failed to write to sidecar stdin', err);
		}
	}

	private failAll(error: Error): void {
		for (const [id, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(error);
			this.pending.delete(id);
		}
	}
}
