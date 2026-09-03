/*---------------------------------------------------------------------------------------------
 *  Aura API — юнит-тесты маппинга истории чата и инструментов в формат OpenAI.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatMessageRole, IChatMessage } from '../../../chat/common/languageModels.js';
import { toOpenAIMessages, toOpenAITools } from '../../browser/auraApiChatProvider.js';

suite('AuraApiChatProvider — маппинг в OpenAI', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('системный промпт, user, assistant с tool_use и tool_result → role:tool', () => {
		const history: IChatMessage[] = [
			{ role: ChatMessageRole.User, content: [{ type: 'text', value: 'Прочитай a.ts' }] },
			{
				role: ChatMessageRole.Assistant, content: [
					{ type: 'text', value: 'Смотрю.' },
					{ type: 'tool_use', name: 'read_file', toolCallId: 'call_1', parameters: { path: 'a.ts' } },
				]
			},
			{
				role: ChatMessageRole.User, content: [
					{ type: 'tool_result', toolCallId: 'call_1', value: [{ type: 'text', value: 'export const a = 1;' }] },
				]
			},
		];
		assert.deepStrictEqual(toOpenAIMessages(history, 'Будь краток.'), [
			{ role: 'system', content: 'Будь краток.' },
			{ role: 'user', content: 'Прочитай a.ts' },
			{ role: 'assistant', content: 'Смотрю.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
			{ role: 'tool', tool_call_id: 'call_1', content: 'export const a = 1;' },
		]);
	});

	test('пустые сообщения и tool_result с ошибкой без текста', () => {
		const history: IChatMessage[] = [
			{ role: ChatMessageRole.Assistant, content: [] },
			{ role: ChatMessageRole.User, content: [{ type: 'tool_result', toolCallId: 'c', value: [], isError: true }] },
		];
		assert.deepStrictEqual(toOpenAIMessages(history, ''), [
			{ role: 'tool', tool_call_id: 'c', content: 'Инструмент завершился с ошибкой.' },
		]);
	});

	test('toOpenAITools: схема → parameters, пустой список → undefined', () => {
		assert.strictEqual(toOpenAITools([]), undefined);
		assert.strictEqual(toOpenAITools(undefined), undefined);
		assert.deepStrictEqual(toOpenAITools([{ name: 'read_file', description: 'Читает файл', inputSchema: { type: 'object' } }, { name: 'noop', description: '—' }]), [
			{ type: 'function', function: { name: 'read_file', description: 'Читает файл', parameters: { type: 'object' } } },
			{ type: 'function', function: { name: 'noop', description: '—' } },
		]);
	});
});
