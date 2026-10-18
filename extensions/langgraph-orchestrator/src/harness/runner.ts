/*---------------------------------------------------------------------------------------------
 *  Мост к Agent Harness. Оркестратор НЕ зависит от плагина на этапе сборки:
 *  публичный API ищется через vscode.extensions.getExtension; без плагина
 *  пробуем живую копию ~/.agent-harness/tools; нет и её — мост молча выключен,
 *  вкладка «Харнесс» на доске честно показывает недоступность.
 *
 *  Запуск скриптов — через ELECTRON_RUN_AS_NODE: системный Node.js не нужен.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logWarn } from '../util/log';

/** Версия публичного API aura-harness, которую понимает оркестратор. */
export const HARNESS_API_VERSION = 1;
const HARNESS_EXTENSION_ID = 'aura.aura-harness';
/** Владелец, под которым панель берёт и закрывает задачи очереди. */
export const PANEL_AGENT = 'aura-panel';

/** Структурное описание чужого API — импорт из другого расширения не нужен. */
export interface HarnessPublicApi {
	readonly apiVersion: number;
	readonly version: string;
	readonly harnessRoot: string;
	readonly toolsDir: string;
	isInstalled(): boolean;
	installedVersion(): string | undefined;
	install(): Promise<{ ok: boolean; output: string }>;
	run(tool: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface HarnessRunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Задача очереди харнесса (срез orchestrator.mjs status --json). */
export interface HarnessTask {
	id: string;
	title: string;
	role: string;
	risk: string;
	status: 'awaiting_approval' | 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
	attempts: number;
	maxAttempts: number;
	owner: string | null;
	verified: boolean;
	deps: string[];
	lastError: { class: string; message: string; at: string } | null;
	updatedAt: string;
}

function looksCompatible(value: unknown): value is HarnessPublicApi {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const api = value as Partial<HarnessPublicApi>;
	return api.apiVersion === HARNESS_API_VERSION
		&& typeof api.run === 'function'
		&& typeof api.isInstalled === 'function';
}

export class HarnessRunner implements vscode.Disposable {
	private api?: HarnessPublicApi;
	private fallbackToolsDir?: string;
	private resolved = false;
	/** Последнее разосланное значение доступности: событие — только при реальной смене. */
	private lastFired?: boolean;

	private readonly availabilityEmitter = new vscode.EventEmitter<boolean>();
	readonly onDidChangeAvailability = this.availabilityEmitter.event;

	get available(): boolean {
		return Boolean(this.api ?? this.fallbackToolsDir);
	}

	get source(): 'extension' | 'runtime' | 'none' {
		if (this.api) {
			return 'extension';
		}
		if (this.fallbackToolsDir) {
			return 'runtime';
		}
		return 'none';
	}

	get version(): string | undefined {
		if (this.api) {
			return this.api.installedVersion() ?? this.api.version;
		}
		if (this.fallbackToolsDir) {
			try {
				const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(this.fallbackToolsDir), 'harness.json'), 'utf8')) as { version?: string };
				return manifest.version;
			} catch {
				return undefined;
			}
		}
		return undefined;
	}

	/** Подключиться к aura-harness (или к живой копии в ~/.agent-harness). Идемпотентно. */
	async resolve(): Promise<boolean> {
		try {
			const extension = vscode.extensions.getExtension(HARNESS_EXTENSION_ID);
			if (extension) {
				const exports: unknown = extension.isActive ? extension.exports : await extension.activate();
				if (looksCompatible(exports) && exports.isInstalled()) {
					this.api = exports;
					this.fallbackToolsDir = undefined;
				}
			}
		} catch (err) {
			logWarn(`harness bridge: extension resolve failed: ${err instanceof Error ? err.message : err}`);
		}
		if (!this.api) {
			// Фолбэк: харнесс стоит, но плагин выключен/не собран — читаем напрямую.
			const toolsDir = path.join(process.env.HARNESS_HOME || os.homedir(), '.agent-harness', 'tools');
			this.fallbackToolsDir = fs.existsSync(path.join(toolsDir, 'orchestrator.mjs')) ? toolsDir : undefined;
		}
		this.resolved = true;
		if (this.available !== this.lastFired) {
			this.lastFired = this.available;
			this.availabilityEmitter.fire(this.available);
		}
		return this.available;
	}

	async run(tool: string, args: string[], cwd?: string): Promise<HarnessRunResult> {
		if (!this.resolved) {
			await this.resolve();
		}
		if (this.api) {
			return this.api.run(tool, args, cwd);
		}
		if (!this.fallbackToolsDir) {
			throw new Error('Agent Harness недоступен: плагин aura-harness не установлен и ~/.agent-harness не найден');
		}
		const script = path.join(this.fallbackToolsDir, tool);
		return new Promise((resolve, reject) => {
			const child = cp.spawn(process.execPath, [script, ...args], {
				cwd,
				env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
			});
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', chunk => { stdout += String(chunk); });
			child.stderr.on('data', chunk => { stderr += String(chunk); });
			child.on('error', reject);
			child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
		});
	}

	/** Очередь задач проекта (.agent-state/tasks.json в корне workspace). Пусто — если очереди нет. */
	async listTasks(workspaceRoot: string): Promise<HarnessTask[]> {
		const result = await this.run('orchestrator.mjs', ['status', '--json'], workspaceRoot);
		if (result.code !== 0) {
			// Нет .agent-state — это не ошибка доски, а пустая очередь.
			if (/ENOENT|no such file/i.test(result.stderr)) {
				return [];
			}
			throw new Error(result.stderr.trim() || `orchestrator status exited ${result.code}`);
		}
		try {
			const state = JSON.parse(result.stdout) as { tasks?: Record<string, HarnessTask> };
			return Object.values(state.tasks ?? {}).sort((a, b) => a.updatedAt < b.updatedAt ? -1 : 1);
		} catch {
			return [];
		}
	}

	dispose(): void {
		this.availabilityEmitter.dispose();
	}
}
