import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ApprovalPolicy, OrchestratorConfig } from '../util/config';
import { GitClient } from '../git/gitClient';
import { CACHEABLE_TOOLS, ToolCache } from './cache';
import { logInfo } from '../util/log';

export interface ToolDef {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	/** true = инструмент меняет состояние (запись, терминал) */
	mutating: boolean;
}

export interface ToolCallInput {
	name: string;
	input: Record<string, unknown>;
	/** Узел графа, который просит инструмент: нужен, чтобы пометить его карточку. */
	nodeId?: string;
	/** Рабочее дерево узла (Этап 4.1). Пусто — инструмент работает в корне workspace. */
	cwd?: string;
}

export interface ToolResult {
	ok: boolean;
	output: string;
	denied?: boolean;
}

/** Колбэк аппрува: UI (панель/модалка) решает — разрешить вызов или нет. */
export type ApprovalHandler = (tool: ToolDef, input: Record<string, unknown>, preview: string, nodeId?: string) => Promise<boolean>;

const OUTPUT_LIMIT = 8000;
const TERMINAL_TIMEOUT_MS = 180_000;

export const TOOL_DEFS: ToolDef[] = [
	{
		name: 'fs.readFile',
		description: 'Read a UTF-8 text file from the workspace. Returns file content (truncated if huge).',
		mutating: false,
		inputSchema: {
			type: 'object',
			properties: { path: { type: 'string', description: 'Workspace-relative path' } },
			required: ['path'],
		},
	},
	{
		name: 'fs.listFiles',
		description: 'List files in a workspace directory (non-recursive or glob pattern).',
		mutating: false,
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Workspace-relative directory, default root' },
				pattern: { type: 'string', description: 'Optional glob like **/*.ts' },
			},
		},
	},
	{
		name: 'fs.search',
		description: 'Search file contents in the workspace by substring or regex.',
		mutating: false,
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string' },
				pattern: { type: 'string', description: 'Optional glob to limit files' },
				regex: { type: 'boolean' },
			},
			required: ['query'],
		},
	},
	{
		name: 'grep',
		description: 'Search file contents by substring or regex (same as fs.search; cached by commit).',
		mutating: false,
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string' },
				pattern: { type: 'string', description: 'Optional glob to limit files' },
				regex: { type: 'boolean' },
			},
			required: ['query'],
		},
	},
	{
		name: 'symbols.list',
		description: 'List top-level symbols (functions/classes/types) per file, with file:line.',
		mutating: false,
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Optional workspace-relative directory to limit the scan' },
				pattern: { type: 'string', description: 'Optional glob like **/*.ts' },
			},
		},
	},
	{
		name: 'fs.writeFile',
		description: 'Write (create or overwrite) a UTF-8 text file in the workspace. Requires approval.',
		mutating: true,
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string' },
				content: { type: 'string' },
			},
			required: ['path', 'content'],
		},
	},
	{
		name: 'fs.delete',
		description: 'Delete a file or directory inside the workspace. Dangerous — guarded by an interrupt.',
		mutating: true,
		inputSchema: {
			type: 'object',
			properties: { path: { type: 'string' } },
			required: ['path'],
		},
	},
	{
		name: 'terminal.run',
		description: 'Run a shell command in the workspace root (tests, linters). Output is truncated.',
		mutating: true,
		inputSchema: {
			type: 'object',
			properties: { command: { type: 'string' } },
			required: ['command'],
		},
	},
	{
		name: 'diagnostics.get',
		description: 'Get current IDE diagnostics (errors/warnings) for workspace files.',
		mutating: false,
		inputSchema: {
			type: 'object',
			properties: { path: { type: 'string', description: 'Optional workspace-relative path filter' } },
		},
	},
	// --- Изоляция воркеров (Этап 4.1): git-операции исполняет расширение ---
	{
		name: 'git.worktreeAdd',
		description: 'Create a git worktree + branch for a worker node from the run base commit.',
		mutating: false,
		inputSchema: {
			type: 'object',
			properties: {
				worktree: { type: 'string' },
				branch: { type: 'string' },
				baseCommit: { type: 'string' },
			},
			required: ['worktree', 'branch'],
		},
	},
	{
		name: 'git.worktreeRemove',
		description: 'Remove a worker worktree and its branch (cleanup on reject/cancel).',
		mutating: false,
		inputSchema: {
			type: 'object',
			properties: {
				worktree: { type: 'string' },
				branch: { type: 'string' },
				workspaceRoot: { type: 'string' },
			},
			required: ['worktree'],
		},
	},
	{
		name: 'git.commitWorktree',
		description: 'Commit all changes inside a worker worktree onto its branch.',
		mutating: false,
		inputSchema: {
			type: 'object',
			properties: { cwd: { type: 'string' }, message: { type: 'string' } },
			required: ['cwd'],
		},
	},
	{
		name: 'git.diffStat',
		description: 'Diffstat between two refs inside a worktree — a short reference for results.',
		mutating: false,
		inputSchema: {
			type: 'object',
			properties: { cwd: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } },
			required: ['cwd', 'from', 'to'],
		},
	},
	// --- Merge узлов в run-ветку (Этап 4.3) и финальный патч (Этап 4.5) ---
	{
		name: 'git.mergeNode',
		description: 'Merge one node branch into the run branch. A conflict returns the file list, not an auto-resolve.',
		mutating: false,
		inputSchema: {
			type: 'object',
			properties: { cwd: { type: 'string' }, sourceBranch: { type: 'string' }, message: { type: 'string' } },
			required: ['cwd', 'sourceBranch'],
		},
	},
	{
		name: 'git.mergeContinue',
		description: 'Finish a merge after the human resolved conflicts in the run worktree.',
		mutating: false,
		inputSchema: {
			type: 'object',
			properties: { cwd: { type: 'string' } },
			required: ['cwd'],
		},
	},
	{
		name: 'git.mergeAbort',
		description: 'Abort an unfinished merge (reject/rollback).',
		mutating: false,
		inputSchema: {
			type: 'object',
			properties: { cwd: { type: 'string' } },
			required: ['cwd'],
		},
	},
	{
		name: 'git.finalPatch',
		description: 'Unified diff, stat and file list of the run branch against the base commit.',
		mutating: false,
		inputSchema: {
			type: 'object',
			properties: { cwd: { type: 'string' }, base: { type: 'string' }, runBranch: { type: 'string' } },
			required: ['cwd', 'base', 'runBranch'],
		},
	},
	{
		name: 'git.applyPatch',
		description: 'Merge the run branch into the user current branch (apply the final patch).',
		mutating: true,
		inputSchema: {
			type: 'object',
			properties: { cwd: { type: 'string' }, runBranch: { type: 'string' } },
			required: ['cwd', 'runBranch'],
		},
	},
	{
		name: 'git.readRef',
		description: 'Read a file content at a git ref (for the multi-diff editor).',
		mutating: false,
		inputSchema: {
			type: 'object',
			properties: { cwd: { type: 'string' }, ref: { type: 'string' }, path: { type: 'string' } },
			required: ['ref', 'path'],
		},
	},
];

export class ToolExecutor {
	constructor(
		private config: OrchestratorConfig,
		private approvalHandler: ApprovalHandler,
		private git: GitClient = new GitClient(),
		/** Кэш read-only тулов (Этап 5.3). Без него всё работает как раньше. */
		private cache?: ToolCache,
	) {
		this.git.setPath(this.config.gitPath);
	}

	updateConfig(config: OrchestratorConfig): void {
		this.config = config;
		this.git.setPath(config.gitPath);
	}

	async run(call: ToolCallInput): Promise<ToolResult> {
		const def = TOOL_DEFS.find(t => t.name === call.name);
		if (!def) {
			return { ok: false, output: `unknown tool: ${call.name}` };
		}
		if (!await this.isAllowed(def, call.input, call.nodeId)) {
			return { ok: false, output: 'denied by user or policy', denied: true };
		}
		const cacheKey = await this.cacheKeyFor(def, call);
		if (cacheKey) {
			const hit = this.cache?.get(cacheKey);
			if (hit !== undefined) {
				// Повторный read-only вызов в том же коммите не трогает файлы/git.
				logInfo(`tool ${def.name} cache hit`);
				return { ok: true, output: hit };
			}
		}
		try {
			const output = await this.execute(def.name, call.input, call.cwd);
			logInfo(`tool ${def.name} ok (${output.length} chars)`);
			if (cacheKey) {
				this.cache?.set(cacheKey, def.name, output);
			}
			return { ok: true, output };
		} catch (err) {
			return { ok: false, output: err instanceof Error ? err.message : String(err) };
		}
	}

	/**
	 * Ключ кэша для read-only тула: инструмент + аргументы + коммит + грязность
	 * дерева. Вне git (нет sha) не кэшируем: ключ не смог бы инвалидироваться.
	 */
	private async cacheKeyFor(def: ToolDef, call: ToolCallInput): Promise<string | undefined> {
		if (!this.cache || def.mutating || !CACHEABLE_TOOLS.has(def.name)) {
			return undefined;
		}
		try {
			const base = this.baseDir(call.cwd);
			const commit = await this.git.head(base);
			if (!commit) {
				return undefined;
			}
			const dirty = await this.git.statusPorcelain(base);
			return ToolCache.key(def.name, call.input, commit, dirty);
		} catch {
			return undefined;
		}
	}

	private async isAllowed(def: ToolDef, input: Record<string, unknown>, nodeId?: string): Promise<boolean> {
		const policy: ApprovalPolicy = this.config.approvals;
		if (policy === 'auto-readonly' && def.mutating) {
			return false;
		}
		if (!def.mutating && policy !== 'confirm-all') {
			return true;
		}
		if (def.name === 'terminal.run' && policy !== 'confirm-all') {
			const command = String(input.command ?? '');
			if (this.config.terminalAllowlist.some(prefix => command.trimStart().startsWith(prefix))) {
				return true;
			}
		}
		return this.approvalHandler(def, input, this.previewOf(def, input), nodeId);
	}

	private previewOf(def: ToolDef, input: Record<string, unknown>): string {
		if (def.name === 'fs.writeFile') {
			const content = String(input.content ?? '');
			return `${input.path}\n\n${content.slice(0, 4000)}${content.length > 4000 ? '\n…(truncated)' : ''}`;
		}
		return JSON.stringify(input, null, 2).slice(0, 2000);
	}

	private async execute(name: string, input: Record<string, unknown>, cwd?: string): Promise<string> {
		switch (name) {
			case 'fs.readFile': return this.readFile(String(input.path ?? ''), cwd);
			case 'fs.listFiles': return this.listFiles(String(input.path ?? ''), input.pattern ? String(input.pattern) : undefined, cwd);
			case 'fs.search': return this.search(String(input.query ?? ''), input.pattern ? String(input.pattern) : undefined, Boolean(input.regex), cwd);
			case 'grep': return this.search(String(input.query ?? ''), input.pattern ? String(input.pattern) : undefined, Boolean(input.regex), cwd);
			case 'symbols.list': return this.listSymbols(input.path ? String(input.path) : undefined, input.pattern ? String(input.pattern) : undefined, cwd);
			case 'fs.writeFile': return this.writeFile(String(input.path ?? ''), String(input.content ?? ''), cwd);
			case 'fs.delete': return this.deletePath(String(input.path ?? ''), cwd);
			case 'terminal.run': return this.runTerminal(String(input.command ?? ''), cwd, Number(input.timeoutMs) || undefined);
			case 'diagnostics.get': return this.getDiagnostics(input.path ? String(input.path) : undefined);
			case 'git.worktreeAdd': return this.worktreeAdd(input);
			case 'git.worktreeRemove': return this.worktreeRemove(input);
			case 'git.commitWorktree': return this.commitWorktree(input);
			case 'git.diffStat': return this.diffStat(input);
			case 'git.mergeNode': return this.mergeNode(input);
			case 'git.mergeContinue': return this.mergeContinue(input);
			case 'git.mergeAbort': return this.mergeAbort(input);
			case 'git.finalPatch': return this.finalPatch(input);
			case 'git.applyPatch': return this.applyPatch(input);
			case 'git.readRef': return this.readRef(input);
			default: throw new Error(`no executor for ${name}`);
		}
	}

	// ---- git (Этап 4.1) ----

	/** Рабочее дерево узла в .aura/worktrees — заводится только для write-узлов. */
	private async worktreeAdd(input: Record<string, unknown>): Promise<string> {
		const root = this.workspaceRootFs();
		if (!await this.git.isRepo(root)) {
			// Не репозиторий — изоляция выключается, воркер работает в корне.
			return JSON.stringify({ isolated: false, reason: 'not a git repository' });
		}
		const worktree = this.assertInsideWorkspace(String(input.worktree ?? ''));
		const branch = String(input.branch ?? '');
		const baseCommit = String(input.baseCommit ?? '') || await this.git.head(root);
		await this.git.worktreeAdd(root, worktree, branch, baseCommit);
		fs.mkdirSync(path.dirname(worktree), { recursive: true });
		return JSON.stringify({ isolated: true, worktree, branch });
	}

	private async worktreeRemove(input: Record<string, unknown>): Promise<string> {
		const root = String(input.workspaceRoot ?? '') || this.workspaceRootFs();
		const worktree = this.assertInsideWorkspace(String(input.worktree ?? ''));
		const branch = String(input.branch ?? '') || undefined;
		await this.git.worktreeRemove(root, worktree, branch);
		await this.git.prune(root);
		return JSON.stringify({ removed: true, worktree, branch: branch ?? '' });
	}

	private async commitWorktree(input: Record<string, unknown>): Promise<string> {
		const cwd = this.assertInsideWorkspace(String(input.cwd ?? ''));
		const message = String(input.message ?? 'aura orchestrator: node result');
		const info = await this.git.commitAll(cwd, message);
		return JSON.stringify(info);
	}

	private async diffStat(input: Record<string, unknown>): Promise<string> {
		const cwd = this.assertInsideWorkspace(String(input.cwd ?? ''));
		const stat = await this.git.diffStat(cwd, String(input.from ?? 'HEAD'), String(input.to ?? 'HEAD'));
		return JSON.stringify({ diffStat: stat });
	}

	/** Merge одного узла в run-ветку. Конфликт — файлы наружу, без авто-резолва. */
	private async mergeNode(input: Record<string, unknown>): Promise<string> {
		const cwd = this.assertInsideWorkspace(String(input.cwd ?? ''));
		const info = await this.git.mergeBranch(cwd, String(input.sourceBranch ?? ''), String(input.message ?? ''));
		return JSON.stringify(info);
	}

	private async mergeContinue(input: Record<string, unknown>): Promise<string> {
		const cwd = this.assertInsideWorkspace(String(input.cwd ?? ''));
		return JSON.stringify(await this.git.mergeContinue(cwd));
	}

	private async mergeAbort(input: Record<string, unknown>): Promise<string> {
		const cwd = this.assertInsideWorkspace(String(input.cwd ?? ''));
		await this.git.mergeAbort(cwd);
		return JSON.stringify({ aborted: true });
	}

	private async finalPatch(input: Record<string, unknown>): Promise<string> {
		const cwd = this.assertInsideWorkspace(String(input.cwd ?? ''));
		const base = String(input.base ?? '');
		const runBranch = String(input.runBranch ?? '');
		const [stat, files, diff] = await Promise.all([
			this.git.diffStat(cwd, base, runBranch),
			this.git.filesChanged(cwd, base, runBranch),
			this.git.diff(cwd, base, runBranch),
		]);
		return JSON.stringify({ stat, files, diff });
	}

	/**
	 * Применить финальный патч: run-ветка вливается в текущую ветку пользователя.
	 * Конфликт не разрешаем сами — возвращаем список файлов на решение человека.
	 */
	private async applyPatch(input: Record<string, unknown>): Promise<string> {
		const cwd = String(input.cwd ?? '') || this.workspaceRootFs();
		const info = await this.git.mergeBranch(cwd, String(input.runBranch ?? ''), 'aura orchestrator: apply run patch');
		return JSON.stringify(info);
	}

	/** Содержимое файла на конкретной ссылке — для multi-diff редактора. */
	private async readRef(input: Record<string, unknown>): Promise<string> {
		const cwd = String(input.cwd ?? '') || this.workspaceRootFs();
		const content = await this.git.showFile(cwd, String(input.ref ?? ''), String(input.path ?? ''));
		return content;
	}

	// ---- fs ----

	private workspaceRoot(): vscode.Uri {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			throw new Error('no workspace folder open');
		}
		return folder.uri;
	}

	private workspaceRootFs(): string {
		return this.workspaceRoot().fsPath;
	}

	/**
	 * База для относительных путей: рабочее дерево узла (cwd) или корень workspace.
	 * cwd обязан лежать внутри workspace — иначе это выход за пределы песочницы.
	 */
	private baseDir(cwd?: string): string {
		const root = path.normalize(this.workspaceRootFs());
		if (!cwd) {
			return root;
		}
		const normalized = path.normalize(cwd);
		if (normalized !== root && !normalized.startsWith(root + path.sep)) {
			throw new Error(`working directory escapes workspace: ${cwd}`);
		}
		return normalized;
	}

	/** Абсолютный путь внутри песочницы (workspace или его worktree). */
	private assertInsideWorkspace(target: string): string {
		if (!target) {
			throw new Error('path is required');
		}
		const normalized = path.normalize(target);
		const root = path.normalize(this.workspaceRootFs());
		if (normalized !== root && !normalized.startsWith(root + path.sep)) {
			throw new Error(`path escapes workspace: ${target}`);
		}
		return normalized;
	}

	private resolveSafe(relativePath: string, cwd?: string): vscode.Uri {
		const base = this.baseDir(cwd);
		const target = path.normalize(path.isAbsolute(relativePath) ? relativePath : path.join(base, relativePath));
		if (target !== base && !target.startsWith(base + path.sep)) {
			throw new Error(`path escapes workspace: ${relativePath}`);
		}
		return vscode.Uri.file(target);
	}

	private async readFile(relativePath: string, cwd?: string): Promise<string> {
		const uri = this.resolveSafe(relativePath, cwd);
		const bytes = await vscode.workspace.fs.readFile(uri);
		const text = Buffer.from(bytes).toString('utf8');
		return text.length > OUTPUT_LIMIT ? text.slice(0, OUTPUT_LIMIT) + '\n…(truncated)' : text;
	}

	private async listFiles(relativePath: string, pattern: string | undefined, cwd?: string): Promise<string> {
		const base = vscode.Uri.file(this.baseDir(cwd));
		const glob = pattern ?? (relativePath ? `${relativePath.replace(/\/$/, '')}/**/*` : '**/*');
		const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(base, glob), '**/{node_modules,.git,dist,out}/**', 500);
		return uris.map(u => path.relative(base.fsPath, u.fsPath)).sort().join('\n') || '(empty)';
	}

	private async search(query: string, pattern: string | undefined, regex: boolean, cwd?: string): Promise<string> {
		if (!query) {
			throw new Error('query is required');
		}
		const base = path.normalize(this.baseDir(cwd));
		const files = await vscode.workspace.findFiles(pattern ?? '**/*.{ts,tsx,js,jsx,json,md,py,css,html}', '**/{node_modules,.git,dist,out}/**', 200);
		const needle = regex ? new RegExp(query, 'i') : undefined;
		const hits: string[] = [];
		for (const file of files) {
			if (hits.length >= 100) {
				break;
			}
			const text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
			const lines = text.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const matched = needle ? needle.test(lines[i]) : lines[i].includes(query);
				if (matched) {
					const rel = path.relative(base, file.fsPath);
					hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
					if (hits.length >= 100) {
						break;
					}
				}
			}
		}
		return hits.join('\n') || '(no matches)';
	}

	/**
	 * Список символов: простой статический разбор верхнеуровневых объявлений.
	 * Полноценный index не тянем — цель — дешёвый обзор и кэш по коммиту.
	 */
	private async listSymbols(relativePath?: string, pattern?: string, cwd?: string): Promise<string> {
		const base = path.normalize(this.baseDir(cwd));
		const glob = pattern ?? (relativePath ? `${relativePath.replace(/\/$/, '')}/**/*.{ts,tsx,js,jsx}` : '**/*.{ts,tsx,js,jsx}');
		const files = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(base), glob), '**/{node_modules,.git,dist,out}/**', 200);
		const symbolPattern = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z0-9_$]+)/;
		const out: string[] = [];
		for (const file of files) {
			if (out.length >= 300) {
				break;
			}
			let text: string;
			try {
				text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
			} catch {
				continue;
			}
			const rel = path.relative(base, file.fsPath);
			const lines = text.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const match = symbolPattern.exec(lines[i]);
				if (match) {
					out.push(`${rel}:${i + 1}: ${match[1]} ${match[2]}`);
					if (out.length >= 300) {
						break;
					}
				}
			}
		}
		return out.sort().join('\n') || '(no symbols)';
	}

	private async writeFile(relativePath: string, content: string, cwd?: string): Promise<string> {
		const uri = this.resolveSafe(relativePath, cwd);
		const edit = new vscode.WorkspaceEdit();
		edit.deleteFile(uri, { ignoreIfNotExists: true });
		edit.createFile(uri, { ignoreIfExists: true });
		edit.insert(uri, new vscode.Position(0, 0), content);
		const applied = await vscode.workspace.applyEdit(edit);
		if (!applied) {
			throw new Error('WorkspaceEdit rejected');
		}
		const doc = await vscode.workspace.openTextDocument(uri);
		await doc.save();
		return `written ${relativePath} (${content.length} chars)`;
	}

	private async deletePath(relativePath: string, cwd?: string): Promise<string> {
		const uri = this.resolveSafe(relativePath, cwd);
		await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
		return `deleted ${relativePath}`;
	}

	private runTerminal(command: string, cwd?: string, timeoutMs?: number): Promise<string> {
		const dir = this.baseDir(cwd);
		// Таймаут из настройки проверок, но не больше жёсткого потолка команды.
		const timeout = timeoutMs ? Math.min(Math.max(1_000, timeoutMs), 10 * 60_000) : TERMINAL_TIMEOUT_MS;
		return new Promise(resolve => {
			cp.exec(command, { cwd: dir, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
				let out = '';
				if (stdout) {
					out += stdout;
				}
				if (stderr) {
					out += (out ? '\n--- stderr ---\n' : '') + stderr;
				}
				if (error) {
					out += `\n(exit code ${error.code ?? 'unknown'}${error.killed ? ', killed by timeout' : ''})`;
				}
				if (out.length > OUTPUT_LIMIT) {
					const head = out.slice(0, OUTPUT_LIMIT / 2);
					const tail = out.slice(-OUTPUT_LIMIT / 2);
					out = `${head}\n…(truncated)…\n${tail}`;
				}
				resolve(out || '(no output)');
			});
		});
	}

	private async getDiagnostics(relativePath?: string): Promise<string> {
		const root = this.workspaceRoot();
		const all = vscode.languages.getDiagnostics();
		const lines: string[] = [];
		for (const [uri, items] of all) {
			if (items.length === 0) {
				continue;
			}
			const rel = path.relative(root.fsPath, uri.fsPath);
			if (relativePath && !rel.endsWith(relativePath)) {
				continue;
			}
			for (const d of items.slice(0, 20)) {
				const severity = ['error', 'warning', 'info', 'hint'][d.severity] ?? 'unknown';
				lines.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} [${severity}] ${d.message.slice(0, 300)}`);
			}
			if (lines.length >= 200) {
				break;
			}
		}
		return lines.join('\n') || '(no diagnostics)';
	}
}
