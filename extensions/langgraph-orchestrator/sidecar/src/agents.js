'use strict';

const { describeToolCall } = require('./notes');

const MAX_AGENT_ROUNDS = 8;

const ROLE_PROMPTS = {
	coder: 'You are the CODER agent. Implement the assigned change in the workspace. Read files before editing. Write complete file contents. When done, reply with a short summary of what changed.',
	tester: 'You are the TESTER agent. Cover the assigned area with tests and run them via terminal.run. Fix trivial issues if needed. Reply with what you tested and the test outcome.',
	'security-auditor': 'You are the SECURITY AUDITOR agent. Review the assigned area for vulnerabilities (injection, secrets in code, unsafe eval, path traversal, weak crypto). Do not modify files. Reply with a findings list, each with severity.',
	reviewer: 'You are the REVIEWER agent. Review the changes for correctness, style and consistency. Do not modify files. Reply with verdict (approve/changes requested) and reasons.',
};

/** Токены одного ответа модели: провайдеры называют их по-разному. */
function usageTokens(result) {
	const usage = result && result.usage;
	if (!usage || typeof usage !== 'object') {
		return 0;
	}
	const total = Number(usage.totalTokens ?? usage.total_tokens ?? 0);
	if (total > 0) {
		return total;
	}
	return Number(usage.inputTokens ?? usage.input_tokens ?? 0) + Number(usage.outputTokens ?? usage.output_tokens ?? 0);
}

/**
 * Разбор учёта одного ответа (Этап 5.1): токены входа/выхода и стоимость.
 * Провайдеры называют поля по-разному, поэтому принимаем оба стиля.
 */
function usageOf(result) {
	const usage = result && result.usage && typeof result.usage === 'object' ? result.usage : {};
	const inputTokens = Number(usage.inputTokens ?? usage.input_tokens ?? 0) || 0;
	const outputTokens = Number(usage.outputTokens ?? usage.output_tokens ?? 0) || 0;
	const costUsd = Number(usage.costUsd ?? usage.cost_usd ?? 0) || 0;
	const total = Number(usage.totalTokens ?? usage.total_tokens ?? 0) || (inputTokens + outputTokens) || usageTokens(result);
	return { inputTokens, outputTokens, costUsd, total };
}

/**
 * Агентный цикл «модель → tool calls → результаты» для одного воркера.
 * Инструменты исполняются в расширении через RPC tool.invoke (nodeId нужен ему,
 * чтобы пометить карточку «ждёт подтверждения»).
 * onNote/onKey — живые ноты для панели: что агент делает и каким ключом отвечает.
 * Возвращает {text, tokens}: токены нужны reducer'у для бюджетной сводки.
 */
async function runAgentLoop(options) {
	const { role, instruction, tools, llm, invokeTool, onText, shouldAbort, onNote, onKey, nodeId, tierOverride } = options;
	// Лимиты бюджета узла (Этап 5.1): 0 — без лимита. Проверяем после каждого
	// ответа модели, поэтому узел останавливается до следующего расхода.
	const tokenLimit = Number(options.tokenLimit) > 0 ? Number(options.tokenLimit) : 0;
	const costLimit = Number(options.costLimit) > 0 ? Number(options.costLimit) : 0;
	// Спан на каждый вызов модели (Этап 5.2): только метаданные, без промптов.
	const tracer = options.tracer || null;
	const messages = [
		{ role: 'system', content: ROLE_PROMPTS[role] || `You are the ${role} agent.` },
		{ role: 'user', content: instruction },
	];
	let tokens = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let costUsd = 0;
	const exceeded = () => (tokenLimit > 0 && tokens >= tokenLimit) || (costLimit > 0 && costUsd >= costLimit);
	const spent = () => ({ text: 'agent stopped: budget exceeded', tokens, inputTokens, outputTokens, costUsd, budgetExceeded: true });

	for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
		if (shouldAbort && shouldAbort()) {
			throw new Error('aborted');
		}
		const span = tracer ? tracer.start('llm', { kind: 'llm', node: nodeId || role, role }) : null;
		let result;
		try {
			result = await llm.complete(role, messages, tools, onText, tierOverride);
		} catch (err) {
			if (span) {
				span.end({ status: 'error', tier: tierOverride || '', error: err && err.message ? String(err.message) : String(err) });
			}
			throw err;
		}
		const usage = usageOf(result);
		if (span) {
			span.end({
				status: 'ok',
				tier: result.usedTier || tierOverride || '',
				model: result.usedKeyName || '',
				tokensIn: usage.inputTokens,
				tokensOut: usage.outputTokens,
				cost: usage.costUsd,
			});
		}
		tokens += usage.total;
		inputTokens += usage.inputTokens;
		outputTokens += usage.outputTokens;
		costUsd += usage.costUsd;
		if (onKey) {
			onKey({ usedKeyName: result.usedKeyName, usedTier: result.usedTier });
		}
		if (exceeded()) {
			return spent();
		}
		const toolCalls = result.toolCalls || [];
		if (toolCalls.length === 0) {
			return { text: result.text || '', tokens, inputTokens, outputTokens, costUsd };
		}

		messages.push({ role: 'assistant', content: result.text || '', toolCalls });
		for (const call of toolCalls) {
			if (shouldAbort && shouldAbort()) {
				throw new Error('aborted');
			}
			if (onNote) {
				onNote(describeToolCall(call.name, call.input || {}));
			}
			let toolResult;
			try {
				toolResult = await invokeTool(call.name, call.input || {}, nodeId);
			} catch (err) {
				// Предохранитель поднимает interrupt() прямо из вызова инструмента.
				// Это сигнал управления графом, его нельзя глотать как ошибку тула.
				if (isInterruptError(err)) {
					throw err;
				}
				toolResult = { ok: false, output: err instanceof Error ? err.message : String(err) };
			}
			messages.push({
				role: 'tool',
				toolCallId: call.id,
				content: toolResult && toolResult.output !== undefined ? String(toolResult.output) : JSON.stringify(toolResult),
			});
		}
	}
	return { text: 'agent stopped: round limit reached', tokens, inputTokens, outputTokens, costUsd };
}

/** interrupt()/bubble-up LangGraph: сигнал заморозить граф, а не ошибка инструмента. */
function isInterruptError(err) {
	return !!err && (err.is_bubble_up === true || err.name === 'GraphInterrupt' || err.name === 'NodeInterrupt');
}

module.exports = { runAgentLoop, ROLE_PROMPTS, MAX_AGENT_ROUNDS, usageTokens, usageOf, isInterruptError };
