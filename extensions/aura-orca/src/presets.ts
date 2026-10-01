/*---------------------------------------------------------------------------------------------
 *  Orca — пресеты CLI-агентов и сборка команды запуска.
 *  Модуль без vscode: покрыт test/presets.test.mjs (аргументы, env, квотинг для shell).
 *--------------------------------------------------------------------------------------------*/

export type CliId = 'claude' | 'codex' | 'gemini' | 'qwen' | 'opencode' | 'aider' | 'custom';

export interface CliPreset {
	id: CliId;
	name: string;
	vendor: string;
	/** Имя исполняемого файла по умолчанию (ищется в PATH). */
	binary: string;
	/** Команда установки для кнопки «Установить». */
	install: string;
	docsUrl: string;
	/** Переменная окружения для API-ключа. */
	keyEnv: string;
	/** Переменная для base URL (прокси/совместимый endpoint); пусто — CLI не поддерживает. */
	baseUrlEnv?: string;
	/** Переменная для модели (если CLI читает модель из env). */
	modelEnv?: string;
	/** Флаг модели в командной строке. */
	modelFlag?: string;
	/** Аргументы неинтерактивного запуска с задачей (для оркестратора). */
	headless: (prompt: string) => string[];
	/** Стартовая задача для интерактивного режима (если CLI умеет). */
	interactivePrompt?: (prompt: string) => string[];
	/** Цвет вкладки/бейджа. */
	color: string;
	/** Короткий глиф для бейджа. */
	glyph: string;
}

export const PRESETS: readonly CliPreset[] = [
	{
		id: 'claude', name: 'Claude Code', vendor: 'Anthropic', binary: 'claude', install: 'npm install -g @anthropic-ai/claude-code',
		docsUrl: 'https://docs.anthropic.com/en/docs/claude-code', keyEnv: 'ANTHROPIC_API_KEY', baseUrlEnv: 'ANTHROPIC_BASE_URL', modelEnv: 'ANTHROPIC_MODEL', modelFlag: '--model',
		interactivePrompt: prompt => [prompt],
		headless: prompt => ['-p', prompt, '--permission-mode', 'acceptEdits', '--output-format', 'text'], color: '#d97757', glyph: 'CC'
	},
	{
		id: 'codex', name: 'Codex CLI', vendor: 'OpenAI', binary: 'codex', install: 'npm install -g @openai/codex',
		docsUrl: 'https://github.com/openai/codex', keyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL', modelFlag: '--model',
		interactivePrompt: prompt => [prompt],
		headless: prompt => ['exec', '--full-auto', prompt], color: '#10a37f', glyph: 'CX'
	},
	{
		id: 'gemini', name: 'Gemini CLI', vendor: 'Google', binary: 'gemini', install: 'npm install -g @google/gemini-cli',
		docsUrl: 'https://github.com/google-gemini/gemini-cli', keyEnv: 'GEMINI_API_KEY', baseUrlEnv: 'GOOGLE_GEMINI_BASE_URL', modelEnv: 'GEMINI_MODEL', modelFlag: '--model',
		interactivePrompt: prompt => ['-i', prompt],
		headless: prompt => ['-p', prompt, '--yolo'], color: '#4285f4', glyph: 'GM'
	},
	{
		id: 'qwen', name: 'Qwen Code', vendor: 'Alibaba', binary: 'qwen', install: 'npm install -g @qwen-code/qwen-code',
		docsUrl: 'https://github.com/QwenLM/qwen-code', keyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL', modelEnv: 'OPENAI_MODEL', modelFlag: '--model',
		interactivePrompt: prompt => ['-i', prompt],
		headless: prompt => ['-p', prompt, '--yolo'], color: '#615ced', glyph: 'QW'
	},
	{
		id: 'opencode', name: 'opencode', vendor: 'SST', binary: 'opencode', install: 'npm install -g opencode-ai',
		docsUrl: 'https://opencode.ai/docs', keyEnv: 'ANTHROPIC_API_KEY', baseUrlEnv: undefined, modelFlag: '--model',
		interactivePrompt: prompt => ['--prompt', prompt],
		headless: prompt => ['run', prompt], color: '#f59e0b', glyph: 'OC'
	},
	{
		id: 'aider', name: 'Aider', vendor: 'Aider', binary: 'aider', install: 'python -m pip install -U aider-install && aider-install',
		docsUrl: 'https://aider.chat/docs/', keyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_API_BASE', modelFlag: '--model',
		headless: prompt => ['--message', prompt, '--yes-always', '--no-pretty'], color: '#14b8a6', glyph: 'AI'
	},
	{
		id: 'custom', name: 'Своя команда', vendor: '', binary: '', install: '',
		docsUrl: '', keyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL', modelFlag: undefined,
		headless: prompt => [prompt], color: '#94a3b8', glyph: '>_'
	}
];

export function presetById(id: string | undefined): CliPreset | undefined {
	return PRESETS.find(preset => preset.id === id);
}

/** Пользовательские настройки CLI (без секрета — он в SecretStorage). */
export interface CliSettings {
	/** Путь/имя бинарника вместо стандартного. */
	binary?: string;
	/** Доп. аргументы (строка, разбивается как в shell). */
	extraArgs?: string;
	baseUrl?: string;
	model?: string;
	/** Своё имя переменной для ключа (например OPENROUTER_API_KEY для opencode). */
	keyEnv?: string;
	/** Доп. переменные окружения: KEY=VALUE по строкам. */
	extraEnv?: string;
	/** Источник ключа: вручную или ключ плагина API Keys. */
	keySource?: 'manual' | 'api-plugin' | 'none';
	apiKeyId?: string;
}

/** Разбор строки аргументов: пробелы, "двойные" и 'одинарные' кавычки. */
export function splitArgs(text: string | undefined): string[] {
	const out: string[] = [];
	let current = '';
	let quote: '"' | "'" | undefined;
	let has = false;
	for (const char of String(text ?? '')) {
		if (quote) {
			if (char === quote) { quote = undefined; } else { current += char; }
			continue;
		}
		if (char === '"' || char === "'") { quote = char; has = true; continue; }
		if (/\s/.test(char)) {
			if (has || current) { out.push(current); current = ''; has = false; }
			continue;
		}
		current += char;
	}
	if (has || current) { out.push(current); }
	return out;
}

/** KEY=VALUE по строкам → объект; комментарии # и пустые строки пропускаются. */
export function parseEnvLines(text: string | undefined): Record<string, string> {
	const env: Record<string, string> = {};
	for (const raw of String(text ?? '').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) { continue; }
		const eq = line.indexOf('=');
		if (eq <= 0) { continue; }
		const key = line.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { continue; }
		env[key] = line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
	}
	return env;
}

/** Переменные окружения для запуска: ключ, base URL, модель, свои переменные. */
export function buildEnv(preset: CliPreset, settings: CliSettings, secret: string | undefined): Record<string, string> {
	const env: Record<string, string> = { ...parseEnvLines(settings.extraEnv) };
	const keyEnv = (settings.keyEnv || preset.keyEnv).trim();
	if (secret && keyEnv) { env[keyEnv] = secret; }
	if (settings.baseUrl && preset.baseUrlEnv) { env[preset.baseUrlEnv] = settings.baseUrl.trim(); }
	if (settings.model && preset.modelEnv) { env[preset.modelEnv] = settings.model.trim(); }
	return env;
}

/** Полный список аргументов: модель флагом, доп. аргументы, затем задача (если headless). */
export function buildArgs(preset: CliPreset, settings: CliSettings, prompt?: string, mode: 'interactive' | 'headless' = 'headless'): string[] {
	const args: string[] = [];
	if (settings.model && preset.modelFlag) { args.push(preset.modelFlag, settings.model.trim()); }
	args.push(...splitArgs(settings.extraArgs));
	if (prompt !== undefined && prompt !== '') {
		if (mode === 'headless') { args.push(...preset.headless(prompt)); }
		else if (preset.interactivePrompt) { args.push(...preset.interactivePrompt(prompt)); }
	}
	return args;
}

export function binaryOf(preset: CliPreset, settings: CliSettings): string {
	return (settings.binary || preset.binary).trim();
}

/** Квотинг аргумента для POSIX-шелла (bash/zsh/sh). */
export function quotePosix(arg: string): string {
	if (arg === '') { return "''"; }
	if (/^[A-Za-z0-9_\-+=.,/:@%]+$/.test(arg)) { return arg; }
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Квотинг для PowerShell: одинарные кавычки, удвоение внутренних. */
export function quotePowerShell(arg: string): string {
	if (/^[A-Za-z0-9_\-+=.,/:\\@%]+$/.test(arg)) { return arg; }
	return `'${arg.replace(/'/g, "''")}'`;
}

/** Квотинг для cmd.exe: двойные кавычки, удвоение внутренних, переводы строк → пробел. */
export function quoteCmd(arg: string): string {
	const flat = arg.replace(/\r?\n/g, ' ');
	if (/^[A-Za-z0-9_\-+=.,/:\\@]+$/.test(flat)) { return flat; }
	return `"${flat.replace(/"/g, '""').replace(/%/g, '%%')}"`;
}

export type ShellKind = 'posix' | 'powershell' | 'cmd';

/** Строка команды для отправки в терминал выбранного шелла. */
export function commandLine(binary: string, args: string[], shell: ShellKind): string {
	const quote = shell === 'powershell' ? quotePowerShell : shell === 'cmd' ? quoteCmd : quotePosix;
	const head = shell === 'powershell' && /[\s']/.test(binary) ? `& ${quotePowerShell(binary)}` : quote(binary);
	return [head, ...args.map(quote)].join(' ');
}

/** Тип шелла по пути (терминал VS Code сообщает shellPath). */
export function shellKindOf(shellPath: string | undefined, platform: string): ShellKind {
	const name = String(shellPath ?? '').toLowerCase().split(/[\\/]/).pop() ?? '';
	if (name.includes('pwsh') || name.includes('powershell')) { return 'powershell'; }
	if (name === 'cmd.exe' || name === 'cmd') { return 'cmd'; }
	if (!name) { return platform === 'win32' ? 'powershell' : 'posix'; }
	return 'posix';
}

/** Слаг для имени ветки/папки worktree. */
export function slug(text: string, max = 32): string {
	return String(text ?? '').toLowerCase()
		.replace(/[^a-z0-9а-яё]+/gi, '-')
		.replace(/[а-яё]/g, ch => ({ а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' } as Record<string, string>)[ch] ?? '')
		.replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, max).replace(/-$/, '') || 'agent';
}

/** Маска секрета для UI: последние 4 символа. */
export function maskSecret(secret: string | undefined): string {
	if (!secret) { return ''; }
	return secret.length <= 8 ? '••••' : `••••${secret.slice(-4)}`;
}

/** Хвост вывода с лимитом (ANSI-коды вычищаются: оркестратору нужен текст). */
export function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return String(text ?? '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '').replace(/\r(?!\n)/g, '\n');
}

export function tail(text: string, limit = 8000): string {
	return text.length > limit ? '…' + text.slice(text.length - limit + 1) : text;
}
