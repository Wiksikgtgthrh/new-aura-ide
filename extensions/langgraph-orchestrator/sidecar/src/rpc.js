'use strict';

/**
 * JSON-RPC сторона сайдкара: читает команды из stdin построчно,
 * шлёт запросы (chat.complete/tool.invoke), нотификации и события в stdout.
 */
class SidecarRpc {
	constructor(input, output) {
		this.input = input;
		this.output = output;
		this.nextId = 1;
		this.pending = new Map();
		this.eventHandlers = new Map();
		this.commandHandler = null;
		this.buffer = '';
		input.setEncoding('utf8');
		input.on('data', chunk => this.onData(chunk));
	}

	onCommand(handler) {
		this.commandHandler = handler;
	}

	/** Запрос к расширению; onEvent получает стрим-события (token и т.п.). */
	request(method, params, onEvent, timeoutMs = 600_000) {
		const id = this.nextId++;
		if (onEvent) {
			this.eventHandlers.set(id, onEvent);
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				this.eventHandlers.delete(id);
				reject(new Error(`extension request ${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.write({ kind: 'req', id, method, params: { ...(params || {}), requestId: id } });
		});
	}

	notify(method, params) {
		this.write({ kind: 'ntf', method, params });
	}

	respond(id, ok, resultOrError) {
		if (ok) {
			this.write({ kind: 'res', id, ok: true, result: resultOrError });
		} else {
			this.write({ kind: 'res', id, ok: false, error: resultOrError instanceof Error ? resultOrError.message : String(resultOrError) });
		}
	}

	onData(chunk) {
		this.buffer += chunk;
		let idx;
		while ((idx = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, idx).trim();
			this.buffer = this.buffer.slice(idx + 1);
			if (line) {
				this.dispatch(line);
			}
		}
	}

	dispatch(line) {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (message.kind === 'cmd' && this.commandHandler) {
			Promise.resolve()
				.then(() => this.commandHandler(message.method, message.params))
				.then(result => this.respond(message.id, true, result ?? null))
				.catch(err => this.respond(message.id, false, err));
			return;
		}
		if (message.kind === 'res') {
			const entry = this.pending.get(message.id);
			if (entry) {
				this.pending.delete(message.id);
				this.eventHandlers.delete(message.id);
				clearTimeout(entry.timer);
				if (message.ok) {
					entry.resolve(message.result);
				} else {
					entry.reject(new Error(message.error || 'extension error'));
				}
			}
			return;
		}
		if (message.kind === 'evt') {
			const handler = this.eventHandlers.get(message.id);
			if (handler) {
				handler(message.event, message.data);
			}
		}
	}

	write(message) {
		this.output.write(JSON.stringify(message) + '\n');
	}
}

module.exports = { SidecarRpc };
