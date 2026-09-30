/*---------------------------------------------------------------------------------------------
 *  API Keys — юнит-тесты моста «чат → команда агентов»: имена инструментов для wire-формата
 *  и системная подсказка агента. Запуск: mocha out/vs/workbench/contrib/auraApi/test/browser.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	AGENT_TEAM_ENABLED_WHEN, AGENT_TEAM_PLUGIN_ID, AGENT_TEAM_TOOL_ID, AGENT_TEAM_TOOL_REFERENCE_NAME,
	buildChatSystemPrompt, isAgentTeamTool, toToolName, uniqueWireToolNames,
} from '../../common/auraApiChatTools.js';

suite('AuraApiChatTools — имена инструментов и системная подсказка', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('toToolName: точки и пробелы заменяются — шлюзы не принимают такие имена', () => {
		assert.equal(toToolName('auraTeam.runTask'), 'auraTeam_runTask');
		assert.equal(toToolName('mcp.foo/bar baz'), 'mcp_foo_bar_baz');
		assert.equal(toToolName('read_file'), 'read_file');
	});

	test('toToolName: пустое имя и имя с цифры не остаются без буквы', () => {
		assert.equal(toToolName(''), 'tool');
		assert.equal(toToolName('   '), 'tool');
		assert.equal(toToolName('2fast'), '_2fast');
	});

	test('toToolName: имя длиннее 64 символов обрезается', () => {
		const name = toToolName('a'.repeat(120));
		assert.equal(name.length, 64);
	});

	test('uniqueWireToolNames: совпавшие после санитизации имена разводятся суффиксом', () => {
		const names = uniqueWireToolNames(['auraTeam.run', 'auraTeam/run', 'auraTeam run']);
		assert.deepEqual(names, ['auraTeam_run', 'auraTeam_run_2', 'auraTeam_run_3']);
		assert.equal(new Set(names).size, 3);
	});

	test('uniqueWireToolNames: порядок сохраняется — по нему строится карта вызовов', () => {
		assert.deepEqual(uniqueWireToolNames(['b', 'a', 'b']), ['b', 'a', 'b_2']);
	});

	test('agent_team и /team гейтятся флагом плагина оркестратора в маркете', () => {
		assert.equal(AGENT_TEAM_PLUGIN_ID, 'langgraph-orchestrator');
		assert.equal(AGENT_TEAM_ENABLED_WHEN, 'auraPlugin.langgraph-orchestrator.enabled == true');
	});

	test('isAgentTeamTool: инструмент команды узнаётся по ссылочному имени и по id', () => {
		assert.equal(isAgentTeamTool({ id: AGENT_TEAM_TOOL_ID }), true);
		assert.equal(isAgentTeamTool({ id: 'other', toolReferenceName: AGENT_TEAM_TOOL_REFERENCE_NAME }), true);
		assert.equal(isAgentTeamTool({ id: 'copilot_searchCodebase', toolReferenceName: 'codebase' }), false);
	});

	test('buildChatSystemPrompt: перечисляет инструменты запроса, а не зашитый список', () => {
		const prompt = buildChatSystemPrompt({ toolNames: ['read_file', 'write_file'] });
		assert.match(prompt, /Доступные инструменты в этом запросе: read_file, write_file/);
		assert.match(prompt, /вызывай write_file/);
	});

	test('buildChatSystemPrompt: про команду агентов говорится только когда она есть', () => {
		const without = buildChatSystemPrompt({ toolNames: ['read_file'] });
		assert.doesNotMatch(without, /мультиагентная команда/);

		const withTeam = buildChatSystemPrompt({ toolNames: ['read_file', 'agent_team'], teamToolName: 'agent_team' });
		assert.match(withTeam, /вызови agent_team/);
		assert.match(withTeam, /мультиагентная команда/);
		assert.match(withTeam, /Для правки одного файла команду не зови/);
	});

	test('buildChatSystemPrompt: пустой список инструментов не оставляет висящую строку', () => {
		const prompt = buildChatSystemPrompt({ toolNames: [] });
		assert.doesNotMatch(prompt, /Доступные инструменты/);
		assert.match(prompt, /Ты — агент в IDE Aura/);
	});
});
