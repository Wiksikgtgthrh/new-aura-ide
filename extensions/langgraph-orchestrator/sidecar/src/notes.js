'use strict';

/**
 * Человекочитаемые подписи вызовов инструментов для карточек доски.
 * Агент долго «молчит», пока читает файлы, — по ноте видно, чем он занят.
 * Модуль чистый (без RPC), поэтому проверяется node-тестами.
 */

const TOOL_TITLES = {
	'fs.readFile': 'читаю',
	'fs.listFiles': 'смотрю файлы',
	'fs.search': 'ищу',
	'fs.writeFile': 'пишу',
	'terminal.run': 'запускаю',
	'diagnostics.get': 'собираю ошибки',
};

/** В строку карточки больше не влезает. */
const NOTE_LIMIT = 120;

/** «читаю src/panel/template.html», «запускаю npm test» — по вызову инструмента. */
function describeToolCall(name, input) {
	const title = TOOL_TITLES[name] || String(name || 'инструмент');
	const arg = argumentOf(name, input);
	return shorten(arg ? `${title} ${arg}` : title, NOTE_LIMIT);
}

/** Аргумент, по которому видно суть вызова: путь, запрос или команда. */
function argumentOf(name, input) {
	if (!input || typeof input !== 'object') {
		return '';
	}
	if (name === 'terminal.run') {
		return String(input.command || '');
	}
	return String(input.path || input.query || input.pattern || '');
}

/** Постановка задачи из плана супервизора — тоже в одну строку карточки. */
function shorten(text, limit) {
	const flat = String(text || '').replace(/\s+/g, ' ').trim();
	const cap = limit || NOTE_LIMIT;
	return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

module.exports = { describeToolCall, argumentOf, shorten, TOOL_TITLES, NOTE_LIMIT };
