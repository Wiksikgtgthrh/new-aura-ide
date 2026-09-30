/*---------------------------------------------------------------------------------------------
 *  API Keys — тесты агента чата: запуск мультиагентной команды из диалога (`/team`),
 *  имена инструментов в wire-формате и системная подсказка.
 *  Запуск: mocha out/vs/workbench/contrib/auraApi/test/browser.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import { URI } from '../../../../../base/common/uri.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AuraChatAgent } from '../../browser/auraApiChatAgent.js';
import { AGENT_TEAM_SLASH_COMMAND } from '../../common/auraApiChatTools.js';
import type { IChatAgentRequest } from '../../../chat/common/participants/chatAgents.js';
import type { IChatProgress } from '../../../chat/common/chatService/chatService.js';
import type { IChatMessage, IChatResponsePart, ILanguageModelChatRequestOptions, ILanguageModelChatResponse, ILanguageModelsService } from '../../../chat/common/languageModels.js';
import type { ILanguageModelToolsService, IToolData, IToolInvocation, IToolResult } from '../../../chat/common/tools/languageModelToolsService.js';
import { AURA_READ_FILE_TOOL_ID } from '../../browser/auraApiTools.js';

const TEAM_TOOL_ID = 'auraOrchestrator_runTeam';
const TEAM_TOOL_REFERENCE = 'agent_team';

function makeTool(partial: Partial<IToolData> & { id: string }): IToolData {
	return {
		source: { type: 'extension', label: 'test', extensionId: new ExtensionIdentifier('publisher.ext') },
		displayName: partial.id,
		modelDescription: `инструмент ${partial.id}`,
		inputSchema: { type: 'object', properties: {} },
		...partial,
	};
}

function makeTeamTool(): IToolData {
	return makeTool({ id: TEAM_TOOL_ID, toolReferenceName: TEAM_TOOL_REFERENCE, displayName: 'Команда агентов' });
}

interface IRecordedModelRequest {
	modelId: string;
	messages: IChatMessage[];
	options: ILanguageModelChatRequestOptions;
}

/** Модель отвечает заранее заданными ответами по порядку; вызовы записываются. */
function makeModelsService(responses: IChatResponsePart[][], availableModels: string[] = ['apiKeys/k1']) {
	const requests: IRecordedModelRequest[] = [];
	const service: Partial<ILanguageModelsService> = {
		lookupLanguageModel: () => undefined,
		selectLanguageModels: async () => availableModels,
		// Порядок аргументов как в ILanguageModelsService: (modelId, from, messages, options, token).
		sendChatRequest: async (modelId: string, _from: unknown, messages: IChatMessage[], options: ILanguageModelChatRequestOptions) => {
			requests.push({ modelId, messages, options });
			const parts = responses.shift();
			if (!parts) {
				throw new Error('модель вызвана больше раз, чем задано в тесте');
			}
			return {
				stream: (async function* () { for (const part of parts) { yield part; } })(),
				result: Promise.resolve({}),
			} as ILanguageModelChatResponse;
		},
	};
	return { service: service as ILanguageModelsService, requests };
}

function makeToolsService(tools: IToolData[], options?: { result?: IToolResult; failWith?: Error }) {
	const invocations: IToolInvocation[] = [];
	const service: Partial<ILanguageModelToolsService> = {
		getTools: () => tools,
		invokeTool: async (dto: IToolInvocation) => {
			invocations.push(dto);
			if (options?.failWith) {
				throw options.failWith;
			}
			return options?.result ?? { content: [{ kind: 'text', value: 'отчёт команды' }] };
		},
	};
	return { service: service as ILanguageModelToolsService, invocations };
}

function makeRequest(message: string, command?: string): IChatAgentRequest {
	return {
		command,
		message,
		sessionResource: URI.parse('chat-session:/test'),
		requestId: 'r1',
		agentId: 'aura.chat',
	} as unknown as IChatAgentRequest;
}

/** Собираем текст, который агент отдал в чат, и все части прогресса. */
function collectProgress(): { parts: IChatProgress[][]; text: () => string } {
	const parts: IChatProgress[][] = [];
	return {
		parts,
		text: () => parts.flat().map(part => part.kind === 'markdownContent' ? part.content.value : '').join('\n'),
	};
}

/** Текст сообщения: и обычные text-партии, и содержимое tool_result (там вложенный массив). */
function messageText(message: IChatMessage): string {
	return message.content.map(part => {
		const typed = part as { type: string; value?: unknown };
		if (typed.type === 'text') {
			return String(typed.value ?? '');
		}
		if (typed.type === 'tool_result' && Array.isArray(typed.value)) {
			return (typed.value as Array<{ type?: string; value?: unknown }>)
				.map(nested => nested?.type === 'text' ? String(nested.value) : '')
				.join(' ');
		}
		return '';
	}).join('\n');
}

suite('AuraChatAgent — запуск команды агентов из чата', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('/team без задачи: подсказка и ни одного обращения к модели', async () => {
		const models = makeModelsService([], []);
		const tools = makeToolsService([makeTeamTool()]);
		const agent = new AuraChatAgent(models.service, tools.service);
		const progress = collectProgress();

		const result = await agent.invoke(makeRequest('   ', AGENT_TEAM_SLASH_COMMAND), parts => progress.parts.push(parts), [], CancellationToken.None);

		assert.match(progress.text(), /Опишите задачу после команды/);
		assert.equal(models.requests.length, 0);
		assert.deepEqual(result, {});
	});

	test('/team работает, даже когда моделей нет: команда идёт по ключам банка Team', async () => {
		const models = makeModelsService([], []);
		const tools = makeToolsService([makeTeamTool()]);
		const agent = new AuraChatAgent(models.service, tools.service);
		const progress = collectProgress();

		await agent.invoke(makeRequest('добавь настройки темы', AGENT_TEAM_SLASH_COMMAND), parts => progress.parts.push(parts), [], CancellationToken.None);

		assert.equal(models.requests.length, 0, 'выбор модели не должен происходить на пути /team');
		assert.equal(tools.invocations.length, 1);
		assert.equal(tools.invocations[0].toolId, TEAM_TOOL_ID);
		assert.deepEqual(tools.invocations[0].parameters, { task: 'добавь настройки темы' });
		assert.match(progress.text(), /отчёт команды/);
	});

	test('/team без установленного оркестратора: понятная ошибка вместо тишины', async () => {
		const models = makeModelsService([], []);
		const tools = makeToolsService([makeTool({ id: 'auraTeam.runTask' })]);
		const agent = new AuraChatAgent(models.service, tools.service);
		const progress = collectProgress();

		const result = await agent.invoke(makeRequest('задача', AGENT_TEAM_SLASH_COMMAND), parts => progress.parts.push(parts), [], CancellationToken.None);

		assert.match(progress.text(), /LangGraph Orchestrator/);
		assert.ok(result.errorDetails?.message, 'окно должно показать ошибку, а не пустой ответ');
		assert.equal(tools.invocations.length, 0);
	});

	test('/team: сбой инструмента превращается в сообщение, а не в необработанное исключение', async () => {
		const models = makeModelsService([], []);
		const tools = makeToolsService([makeTeamTool()], { failWith: new Error('нет живых ключей') });
		const agent = new AuraChatAgent(models.service, tools.service);
		const progress = collectProgress();

		const result = await agent.invoke(makeRequest('задача', AGENT_TEAM_SLASH_COMMAND), parts => progress.parts.push(parts), [], CancellationToken.None);

		assert.match(progress.text(), /нет живых ключей/);
		assert.equal(result.errorDetails?.message, 'нет живых ключей');
	});

	test('обычный запрос: имена инструментов уходят модели в wire-формате', async () => {
		const tools = [
			makeTool({ id: 'auraTeam.runTask' }),
			makeTool({ id: 'copilot_searchCodebase', toolReferenceName: 'codebase' }),
			makeTeamTool(),
		];
		const models = makeModelsService([[{ type: 'text', value: 'привет' }]]);
		const agent = new AuraChatAgent(models.service, makeToolsService(tools).service);
		const progress = collectProgress();

		await agent.invoke(makeRequest('привет'), parts => progress.parts.push(parts), [], CancellationToken.None);

		const spec = models.requests[0].options.tools as Array<{ name: string }>;
		assert.deepEqual(spec.map(t => t.name), ['auraTeam_runTask', 'codebase', TEAM_TOOL_REFERENCE]);
		for (const tool of spec) {
			assert.match(tool.name, /^[A-Za-z0-9_-]{1,64}$/, `имя ${tool.name} не пройдёт шлюз`);
		}
	});

	test('системная подсказка перечисляет инструменты и объясняет про команду', async () => {
		const tools = [makeTool({ id: 'codebase' }), makeTeamTool()];
		const models = makeModelsService([[{ type: 'text', value: 'ок' }]]);
		const agent = new AuraChatAgent(models.service, makeToolsService(tools).service);

		await agent.invoke(makeRequest('привет'), () => undefined, [], CancellationToken.None);

		const system = models.requests[0].messages[0];
		assert.equal(system.role, 0, 'первым должно быть системное сообщение');
		assert.match(messageText(system), /Доступные инструменты в этом запросе: codebase, agent_team/);
		assert.match(messageText(system), /вызови agent_team/);
	});

	test('вызов инструмента по санитизированному имени возвращается к исходному id', async () => {
		const tools = [makeTool({ id: 'auraTeam.runTask' }), makeTeamTool()];
		const models = makeModelsService([
			[{ type: 'tool_use', name: 'auraTeam_runTask', toolCallId: 'c1', parameters: { task: 'x' } }],
			[{ type: 'text', value: 'готово' }],
		]);
		const toolsService = makeToolsService(tools, { result: { content: [{ kind: 'text', value: 'нашли 3 файла' }] } });
		const agent = new AuraChatAgent(models.service, toolsService.service);
		const progress = collectProgress();

		await agent.invoke(makeRequest('найди'), parts => progress.parts.push(parts), [], CancellationToken.None);

		assert.equal(toolsService.invocations.length, 1);
		assert.equal(toolsService.invocations[0].toolId, 'auraTeam.runTask');
		const followUp = models.requests[1].messages.at(-1);
		assert.equal(followUp?.role, 1);
		assert.match(messageText(followUp!), /нашли 3 файла/);
		assert.match(progress.text(), /готово/);
	});

	test('инструмент команды вызывается моделью как обычный инструмент', async () => {
		const tools = [makeTeamTool()];
		const models = makeModelsService([
			[{ type: 'tool_use', name: TEAM_TOOL_REFERENCE, toolCallId: 'c9', parameters: { task: 'покрой тестами' } }],
			[{ type: 'text', value: 'команда закончила' }],
		]);
		const toolsService = makeToolsService(tools, { result: { content: [{ kind: 'text', value: 'Итог: 4 из 4 агентов завершили работу.' }] } });
		const agent = new AuraChatAgent(models.service, toolsService.service);

		await agent.invoke(makeRequest('покрой тестами модуль'), () => undefined, [], CancellationToken.None);

		assert.equal(toolsService.invocations[0].toolId, TEAM_TOOL_ID);
		assert.deepEqual(toolsService.invocations[0].parameters, { task: 'покрой тестами' });
	});

	test('служебные internal-инструменты модели не отдаются, а инструменты расширений — отдаются', async () => {
		const tools = [
			makeTool({ id: 'vscode_askQuestions', source: { type: 'internal', label: 'core' } }),
			makeTool({ id: AURA_READ_FILE_TOOL_ID, source: { type: 'internal', label: 'core' } }),
			makeTool({ id: 'mermaid.render' }),
			makeTool({ id: 'без-схемы', inputSchema: undefined }),
		];
		const models = makeModelsService([[{ type: 'text', value: 'ок' }]]);
		const agent = new AuraChatAgent(models.service, makeToolsService(tools).service);

		await agent.invoke(makeRequest('привет'), () => undefined, [], CancellationToken.None);

		const names = (models.requests[0].options.tools as Array<{ name: string }>).map(t => t.name);
		assert.deepEqual(names, [AURA_READ_FILE_TOOL_ID, 'mermaid_render'], 'служебный internal-инструмент и инструмент без схемы модели не отдаются');
	});

	test('слеш-команда /team зарегистрирована у агента чата', () => {
		// Без записи в регистрации агента `/team` уходит модели как обычный текст,
		// и команда становится недоступной — поэтому проверяем собранный модуль,
		// а не только обработчик в агента.
		const compiled = readFileSync(new URL('../../browser/auraApi.contribution.js', import.meta.url), 'utf8');
		assert.match(compiled, /name: AGENT_TEAM_SLASH_COMMAND/);
		assert.match(compiled, /slashCommands: \[/);
	});

	test('неизвестный инструмент в ответе модели не ломает цикл', async () => {
		const tools = [makeTool({ id: 'codebase' })];
		const models = makeModelsService([
			[{ type: 'tool_use', name: 'нет_такого', toolCallId: 'c1', parameters: {} }],
			[{ type: 'text', value: 'ладно' }],
		]);
		const toolsService = makeToolsService(tools);
		const agent = new AuraChatAgent(models.service, toolsService.service);
		const progress = collectProgress();

		await agent.invoke(makeRequest('сделай'), parts => progress.parts.push(parts), [], CancellationToken.None);

		assert.equal(toolsService.invocations.length, 0);
		const followUp = models.requests[1].messages.at(-1);
		assert.match(messageText(followUp!), /Неизвестный инструмент: нет_такого/);
	});
});
