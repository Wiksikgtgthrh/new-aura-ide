/*---------------------------------------------------------------------------------------------
 *  API Keys — мост чата к мультиагентной команде оркестратора.
 *  Чистые помощники: имена инструментов для wire-формата OpenAI и системная подсказка,
 *  которая объясняет модели, когда поручать задачу команде. Зависимости — только pure
 *  common-модули (флаги Aura Market), чтобы всё проверялось обычными mocha-тестами.
 *--------------------------------------------------------------------------------------------*/

import { auraPluginEnabledWhenClause } from '../../auraMarket/common/auraMarketCatalog.js';

/** id инструмента в langgraph-orchestrator: должен совпадать с contributes.languageModelTools[].name. */
export const AGENT_TEAM_TOOL_ID = 'auraOrchestrator_runTeam';

/** Имя, под которым инструмент команды виден модели (`toolReferenceName`). */
export const AGENT_TEAM_TOOL_REFERENCE_NAME = 'agent_team';

/** Слеш-команда чата: `/team <задача>` — запуск команды без участия модели. */
export const AGENT_TEAM_SLASH_COMMAND = 'team';

/** Плагин-владелец команды агентов в Aura Market. */
export const AGENT_TEAM_PLUGIN_ID = 'langgraph-orchestrator';

/**
 * when-клауза инструмента и слэш-команды: пока «LangGraph Orchestrator» отключён в маркете,
 * `agent_team` не попадает в список инструментов модели, а `/team` — в подсказки чата.
 * Тот же текст стоит в `contributes.languageModelTools[].when` расширения.
 */
export const AGENT_TEAM_ENABLED_WHEN = auraPluginEnabledWhenClause(AGENT_TEAM_PLUGIN_ID);

/** OpenAI-совместимые шлюзы принимают в имени функции только [A-Za-z0-9_-], до 64 символов. */
const TOOL_NAME_PATTERN = /[^A-Za-z0-9_-]/g;
const TOOL_NAME_LIMIT = 64;

/**
 * Имя инструмента для wire-формата. Идентификаторы встроенных инструментов содержат точки
 * (`auraTeam.runTask`, `mcp.foo.bar`) — с ними шлюз отвечает 400 на весь запрос, поэтому
 * точки и прочие недопустимые символы заменяются подчёркиванием.
 */
export function toToolName(name: string): string {
	let sanitized = String(name ?? '').trim().replace(TOOL_NAME_PATTERN, '_');
	if (!sanitized) {
		sanitized = 'tool';
	}
	if (/^[0-9]/.test(sanitized)) {
		sanitized = `_${sanitized}`;
	}
	return sanitized.slice(0, TOOL_NAME_LIMIT);
}

/**
 * Уникальные wire-имена для набора инструментов: два разных идентификатора могут
 * после санитизации совпасть, и тогда модель просто не увидит второй инструмент.
 * Порядок сохраняется — по нему строится карта «имя → инструмент».
 */
export function uniqueWireToolNames(names: readonly string[]): string[] {
	const used = new Set<string>();
	return names.map(name => {
		const base = toToolName(name).slice(0, TOOL_NAME_LIMIT - 4);
		let candidate = base;
		let suffix = 2;
		while (used.has(candidate)) {
			candidate = `${base}_${suffix++}`;
		}
		used.add(candidate);
		return candidate;
	});
}

export interface IChatAgentToolSummary {
	id: string;
	toolReferenceName?: string;
}

/** Инструмент команды агентов — от плагина оркестратора, если тот установлен. */
export function isAgentTeamTool(tool: IChatAgentToolSummary): boolean {
	return tool.toolReferenceName === AGENT_TEAM_TOOL_REFERENCE_NAME || tool.id === AGENT_TEAM_TOOL_ID;
}

export interface IChatSystemPromptTools {
	/** Wire-имена инструментов, которые уходят модели в этом запросе. */
	toolNames: readonly string[];
	/** Wire-имя инструмента команды агентов, если он доступен. */
	teamToolName?: string;
}

const CORE_INSTRUCTIONS = 'Ты — агент в IDE Aura. Чтобы выполнить задачу, используй доступные инструменты: читай и создавай файлы (read_file, write_file, list_files), запускай команды (run_in_terminal). Не печатай код в ответе, если его нужно записать в файл, — вызывай write_file. Действуй самостоятельно, без просьб «скажите мне, когда будете готовы».';

/**
 * Системная подсказка агента чата. Список инструментов подставляется по факту запроса:
 * раньше он был зашит в текст, и модель не знала ни про инструменты расширений,
 * ни про команду агентов.
 */
export function buildChatSystemPrompt(tools: IChatSystemPromptTools): string {
	const lines = [CORE_INSTRUCTIONS];
	const names = (tools.toolNames ?? []).filter(Boolean);
	if (names.length) {
		lines.push(`Доступные инструменты в этом запросе: ${names.join(', ')}.`);
	}
	if (tools.teamToolName) {
		lines.push(`Если задача большая или затрагивает несколько файлов (правка + тесты + проверка), вызови ${tools.teamToolName} — это мультиагентная команда (кодер, тестировщик, аудит безопасности, ревьюер), она работает на ключах команды и показывает прогресс прямо в чате. Для правки одного файла команду не зови.`);
	}
	return lines.join('\n');
}
