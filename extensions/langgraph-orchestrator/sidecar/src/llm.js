'use strict';

/** Тиры по умолчанию для ролей; supervisor/coder — высокий, остальные ниже. */
const ROLE_TIERS = {
	supervisor: 'high',
	coder: 'high',
	tester: 'low',
	'security-auditor': 'mid',
	reviewer: 'mid',
};

const TIER_UP = { low: 'mid', mid: 'high' };
const TIERS = ['high', 'mid', 'low'];

function tierFor(role) {
	return ROLE_TIERS[role] || 'mid';
}

/**
 * Тир подзадачи: хинт супервизора (tier: low|mid|high) важнее роли.
 * Так генерация бойлерплейта уходит на дешёвый тир даже у coder'а,
 * а тяжёлый рефакторинг — на высокий, даже если роль обычно дешевле.
 */
function tierForRole(role, tierOverride) {
	if (tierOverride && TIERS.includes(tierOverride)) {
		return tierOverride;
	}
	return tierFor(role);
}

/**
 * Клиент LLM сайдкара: ходит в расширение за локальный HTTP-прокси (AURA_PROXY_URL),
 * секретов не видит — только тир. RPC-путь остаётся фолбэком для mock/тестов,
 * когда переменной окружения нет. В mock-режиме (AURA_ORM_MOCK_LLM=1) отдаёт
 * детерминированные ответы — используется в тестах графа без расхода ключей.
 */
class LlmClient {
	constructor(rpc, options) {
		this.rpc = rpc;
		this.mock = options && options.mock;
		this.escalationThreshold = (options && options.escalationThreshold) || 2;
		this.proxyUrl = (options && options.proxyUrl) || process.env.AURA_PROXY_URL || '';
		this.runToken = (options && options.runToken) || process.env.AURA_RUN_TOKEN || '';
		this.mockState = { supervisorCalls: 0 };
	}

	/**
	 * Один запрос к модели. С прокси тир выбирает расширение: фейловер внутри тира
	 * и подъём на тир выше живут там, поэтому здесь один вызов без повторов.
	 * tierOverride — тир-хинт подзадачи из плана супервизора.
	 * @returns {Promise<{text, toolCalls, usedTier, usedKeyName}>}
	 */
	async complete(role, messages, tools, onToken, tierOverride) {
		if (this.mock) {
			return this.mockComplete(role, messages, tierOverride);
		}
		if (this.proxyUrl) {
			return this.completeViaProxy(role, messages, tools, tierOverride);
		}
		return this.completeViaRpc(role, messages, tools, onToken, tierOverride);
	}

	/** Путь через локальный прокси: в теле запроса тир, а не модель. */
	async completeViaProxy(role, messages, tools, tierOverride) {
		const tier = tierForRole(role, tierOverride);
		let response;
		try {
			response = await fetch(`${this.proxyUrl}/v1/chat/completions`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${this.runToken}`,
				},
				body: JSON.stringify({
					role,
					tier,
					messages,
					tools: tools && tools.length ? tools : undefined,
				}),
			});
		} catch (err) {
			throw new Error(`llm proxy unreachable at ${this.proxyUrl}: ${err && err.message ? err.message : err}`);
		}
		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			throw new Error(`llm proxy HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
		}
		const result = await response.json();
		return {
			text: result.text || '',
			toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls : [],
			usedTier: result.usedTier,
			usedKeyName: result.usedKeyName,
			usage: result.usage,
		};
	}

	/** Фолбэк-путь через RPC (mock/тесты и окружения без прокси). */
	async completeViaRpc(role, messages, tools, onToken, tierOverride) {
		let tier = tierForRole(role, tierOverride);
		let lastError = null;
		for (let attempt = 0; attempt <= this.escalationThreshold; attempt++) {
			try {
				return await this.rpc.request('chat.complete', {
					role,
					tier,
					messages,
					tools: tools && tools.length ? tools : undefined,
				}, onToken ? (event, data) => {
					if (event === 'token') {
						onToken(data);
					}
				} : undefined);
			} catch (err) {
				lastError = err;
				const up = TIER_UP[tier];
				if (!up || attempt >= this.escalationThreshold) {
					break;
				}
				tier = up;
			}
		}
		throw lastError || new Error(`llm failed for role ${role}`);
	}

	mockComplete(role, messages, tierOverride) {
		if (role === 'supervisor') {
			this.mockState.supervisorCalls += 1;
			const last = messages[messages.length - 1];
			const alreadyWorked = typeof last.content === 'string' && last.content.includes('MOCK worker');
			if (this.mockState.supervisorCalls === 1 && !alreadyWorked) {
				return Promise.resolve({
					text: JSON.stringify({
						nodes: [
							{ id: 'coder#1.0', kind: 'code', goal: 'implement the feature', deps: [] },
							{ id: 'tester#1.1', kind: 'test', goal: 'cover with tests', deps: [] },
							{ id: 'security-auditor#1.2', kind: 'security', goal: 'check for vulnerabilities', deps: [] },
						],
					}),
					toolCalls: [],
					usedTier: 'mock',
					usedKeyName: 'mock',
				});
			}
			return Promise.resolve({
				text: JSON.stringify({ finish: 'MOCK summary: all done' }),
				toolCalls: [],
				usedTier: 'mock',
				usedKeyName: 'mock',
			});
		}
		return Promise.resolve({
			text: `MOCK worker ${role}: done${tierOverride ? ` [tier:${tierOverride}]` : ''}`,
			toolCalls: [],
			usedTier: 'mock',
			usedKeyName: 'mock',
		});
	}
}

module.exports = { LlmClient, tierFor, tierForRole, ROLE_TIERS };
