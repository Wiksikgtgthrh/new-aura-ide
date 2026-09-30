'use strict';

/**
 * Разбор вывода проверок проекта (Этап 4.2). В воркер уходят только первые
 * SCREEN_LINES строк ошибок и имена упавших тестов — не весь лог. Сырые логи
 * терминала в state никогда не попадают: их сжимает reducer.
 */

/** Сколько первых строк ошибок реально читает модель. */
const SCREEN_LINES = 40;
const MAX_TEST_NAMES = 20;

/** Шаблоны «упавший тест» для популярных раннеров (jest/vitest/mocha/go/pytest/tape). */
const TEST_PATTERNS = [
	/(?:FAIL|FAILED)\s+([^\s(]+)/i,
	/--- FAIL:\s*(\S+)/,
	/✗\s*(.+)/,
	/✕\s*(.+)/,
	/×\s*(.+)/,
	/●\s*(.+)/,
	/not ok\s+\d+\s*-?\s*(.+)/i,
];

/** Разбить вывод проверки: первые SCREEN_LINES непустых строк + имена упавших тестов. */
function parseFailures(output, maxLines = SCREEN_LINES) {
	const lines = String(output == null ? '' : output)
		.split(/\r?\n/)
		.map(line => line.trimEnd())
		.filter(line => line.trim() !== '');
	const excerpt = lines.slice(0, maxLines).join('\n');
	const tests = [];
	for (const line of lines) {
		for (const pattern of TEST_PATTERNS) {
			const match = line.match(pattern);
			if (match && match[1]) {
				const name = match[1].trim().slice(0, 120);
				if (name && !tests.includes(name)) {
					tests.push(name);
				}
				break;
			}
		}
		if (tests.length >= MAX_TEST_NAMES) {
			break;
		}
	}
	return { excerpt, tests, truncated: lines.length > maxLines };
}

/** Упала ли команда проверки: terminal.run печатает «(exit code N)» только при ошибке. */
function checkFailed(output) {
	const text = String(output == null ? '' : output);
	const match = text.match(/\(exit code (-?\d+)/);
	if (match) {
		return Number(match[1]) !== 0;
	}
	// Нет отметки кода — считаем успехом: отсутствие ошибки важнее догадок.
	return false;
}

/** Текст-инструкция воркеру на ретрай: только выжимка ошибок и упавшие тесты. */
function fixInstruction(goal, failure, attempt, limit) {
	const tests = failure && Array.isArray(failure.tests) && failure.tests.length
		? failure.tests.join(', ')
		: '—';
	const head = `\n\nПРОВЕРКИ ПРОЕКТА ПРОВАЛИЛИСЬ (правка ${attempt}/${limit}).`;
	const command = failure && failure.command ? `\nКоманда: ${failure.command}` : '';
	const body = failure && failure.excerpt ? `\nВывод (первые строки):\n${failure.excerpt}` : '';
	return `${goal}${head}${command}\nУпавшие тесты: ${tests}${body}\nИсправь причину провала и повтори проверки.`;
}

module.exports = { parseFailures, checkFailed, fixInstruction, SCREEN_LINES, MAX_TEST_NAMES };
