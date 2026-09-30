'use strict';

/**
 * Предохранитель (Этап 4.4): классификация опасных действий воркера. Перед
 * таким вызовом граф поднимает interrupt(), и продолжение возможно только с
 * Command({resume:{approved, note}}). Никаких авто-разрешений по умолчанию.
 *
 * Секретов тут нет и быть не может: классификатор смотрит только на имя
 * инструмента и его входные аргументы.
 */

/** Опасные команды: сеть, push, необратимое удаление, публикация. */
const COMMAND_RULES = [
	{ kind: 'push', reason: 'git push', pattern: /\bgit\s+push\b/i },
	{ kind: 'publish', reason: 'публикация пакета', pattern: /\bnpm\s+(publish|version)\b/i },
	{ kind: 'network', reason: 'сетевая команда', pattern: /\b(curl|wget|nc|ncat|ssh|scp|rsync)\b/i },
	{ kind: 'destructive', reason: 'необратимое удаление', pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i },
	{ kind: 'destructive', reason: 'жёсткий сброс', pattern: /\bgit\s+reset\s+--hard\b/i },
	{ kind: 'destructive', reason: 'очистка рабочего дерева', pattern: /\bgit\s+clean\s+-[a-z]*f/i },
];

/** Защищённые файлы: секреты и конфиги из списка. */
const PROTECTED_PATTERNS = [
	{ kind: 'secrets', reason: 'файл с секретами', pattern: /(^|[\\/])\.env(\..*)?$/i },
	{ kind: 'config', reason: 'конфиг проекта', pattern: /(^|[\\/])(package|tsconfig|vite\.config|webpack\.config|jest\.config)\.json$/i },
	{ kind: 'secrets', reason: 'ключ/сертификат', pattern: /\.(pem|key|p12|pfx)$/i },
];

/**
 * Оценить вызов инструмента. {risky:false} — можно исполнять;
 * иначе {risky:true, kind, reason, target} — нужен interrupt.
 */
function classifyAction(name, input) {
	const args = input && typeof input === 'object' ? input : {};
	if (name === 'fs.delete') {
		return { risky: true, kind: 'delete', reason: 'удаление файла', target: String(args.path || '') };
	}
	if (name === 'terminal.run') {
		const command = String(args.command || '');
		for (const rule of COMMAND_RULES) {
			if (rule.pattern.test(command)) {
				return { risky: true, kind: rule.kind, reason: rule.reason, target: command.slice(0, 200) };
			}
		}
		return { risky: false };
	}
	if (name === 'fs.writeFile') {
		const filePath = String(args.path || '');
		for (const rule of PROTECTED_PATTERNS) {
			if (rule.pattern.test(filePath)) {
				return { risky: true, kind: rule.kind, reason: rule.reason, target: filePath };
			}
		}
	}
	return { risky: false };
}

/** Текст заголовка interrupt'а для карточки подтверждения. */
function guardTitle(action, language) {
	const target = action && action.target ? action.target : '';
	const reason = action && action.reason ? action.reason : 'опасное действие';
	return language === 'en'
		? `The agent wants a guarded action (${reason}). Approve? \`${target}\``
		: `Агент просит опасное действие (${reason}). Подтвердить? \`${target}\``;
}

module.exports = { classifyAction, guardTitle, COMMAND_RULES, PROTECTED_PATTERNS };
