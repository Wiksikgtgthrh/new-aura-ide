'use strict';

/**
 * Трейсинг (Этап 5.2): спаны на ноды графа и на каждый вызов модели.
 *
 * Спаны держатся в кольцевом буфере (последние maxSpans), опционально
 * дописываются в JSONL-файл и отправляются на OTLP-endpoint. В спане только
 * метаданные (нода, тир, модель, токены, стоимость, длительность) — никаких
 * промптов, ответов и ключей: трейс не должен хранить секреты.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_SPANS = 500;

/** Дескриптор активного спана: end() фиксирует длительность и отправляет наружу. */
class SpanHandle {
	constructor(tracer, span) {
		this.tracer = tracer;
		this.span = span;
		this.done = false;
	}
	end(extra) {
		if (this.done) {
			return this.span;
		}
		this.done = true;
		return this.tracer.finish(this.span, extra);
	}
}

class Tracer {
	constructor(options) {
		const opts = options || {};
		this.enabled = opts.enabled !== false;
		this.maxSpans = Number(opts.maxSpans) > 0 ? Number(opts.maxSpans) : DEFAULT_MAX_SPANS;
		this.file = typeof opts.file === 'string' ? opts.file : '';
		this.otlpEndpoint = typeof opts.otlpEndpoint === 'string' ? opts.otlpEndpoint : '';
		this.traceId = typeof opts.traceId === 'string' ? opts.traceId : '';
		this.onSpan = typeof opts.onSpan === 'function' ? opts.onSpan : null;
		this.spans = [];
		this.seq = 0;
	}

	/** Начать спан. Возвращает дескриптор с end(extra). */
	start(name, attrs) {
		const span = {
			id: `${this.traceId || 'run'}-${++this.seq}`,
			traceId: this.traceId,
			name: String(name || 'span'),
			startedAt: Date.now(),
			...(attrs || {}),
		};
		return new SpanHandle(this, span);
	}

	/** Завершить спан: длительность, буфер, файл, OTLP, колбэк в host. */
	finish(span, extra) {
		const finished = {
			...span,
			...(extra || {}),
			durationMs: Math.max(0, Date.now() - (span.startedAt || Date.now())),
		};
		this.spans.push(finished);
		if (this.spans.length > this.maxSpans) {
			this.spans.splice(0, this.spans.length - this.maxSpans);
		}
		this.appendToFile(finished);
		this.exportOtlp(finished);
		if (this.onSpan) {
			try {
				this.onSpan(finished);
			} catch {
				// Колбэк в UI не должен ронять граф.
			}
		}
		return finished;
	}

	list() {
		return this.spans.slice();
	}

	/** Агрегаты для панели: топ нод по времени и по деньгам. */
	summary() {
		const nodes = new Map();
		for (const span of this.spans) {
			if (span.kind !== 'node') {
				continue;
			}
			const key = span.node || span.name;
			const entry = nodes.get(key) || { node: key, durationMs: 0, cost: 0, tokens: 0, spans: 0 };
			entry.durationMs += Number(span.durationMs) || 0;
			entry.cost += Number(span.cost) || 0;
			entry.tokens += (Number(span.tokensIn) || 0) + (Number(span.tokensOut) || 0);
			entry.spans += 1;
			nodes.set(key, entry);
		}
		const all = [...nodes.values()];
		return {
			byTime: [...all].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5),
			byCost: [...all].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens).slice(0, 5),
			totalSpans: this.spans.length,
		};
	}

	/** JSONL best-effort: ошибки записи не должны ломать запуск. */
	appendToFile(span) {
		if (!this.file) {
			return;
		}
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			fs.appendFileSync(this.file, `${JSON.stringify(span)}\n`, 'utf8');
		} catch {
			// Диск недоступен — трейс живёт в памяти.
		}
	}

	/** OTLP/JSON best-effort: без endpoint или без fetch просто ничего не делаем. */
	exportOtlp(span) {
		if (!this.otlpEndpoint || typeof fetch !== 'function') {
			return;
		}
		const url = `${this.otlpEndpoint.replace(/\/$/, '')}/v1/traces`;
		const body = {
			resourceSpans: [{
				scopeSpans: [{
					scope: { name: 'aura.langgraph-orchestrator' },
					spans: [{
						traceId: span.traceId || span.id,
						spanId: span.id,
						name: span.name,
						startTimeUnixNano: String((span.startedAt || Date.now()) * 1e6),
						endTimeUnixNano: String(((span.startedAt || Date.now()) + (span.durationMs || 0)) * 1e6),
						attributes: Object.entries({
							node: span.node, tier: span.tier, model: span.model,
							tokens_in: span.tokensIn, tokens_out: span.tokensOut,
							cost: span.cost, retries: span.retries, status: span.status,
						}).filter(([, value]) => value !== undefined && value !== null && value !== '')
							.map(([key, value]) => ({ key, value: { stringValue: String(value) } })),
					}],
				}],
			}],
		};
		try {
			void fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => undefined);
		} catch {
			// Экспорт опционален.
		}
	}
}

/** Обёртка «спан вокруг асинхронного шага» с фиксацией статуса. */
async function withSpan(tracer, name, attrs, fn) {
	if (!tracer) {
		return fn();
	}
	const span = tracer.start(name, attrs);
	try {
		const result = await fn();
		span.end({ status: 'ok' });
		return result;
	} catch (err) {
		span.end({ status: 'error', error: err && err.message ? String(err.message) : String(err) });
		throw err;
	}
}

module.exports = { Tracer, SpanHandle, withSpan, DEFAULT_MAX_SPANS };
