import * as vscode from 'vscode';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { RpcClient } from './rpcClient';
import { logError, logInfo, logWarn } from '../util/log';

const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 5 * 60_000;

/**
 * Состояние сайдкара для панели: 'off' — никогда не поднимали,
 * 'starting' — процесс поднимается, 'ready' — готов принимать команды,
 * 'error' — не запустился (в lastError — причина).
 */
export type SidecarState = 'off' | 'starting' | 'ready' | 'error';

/**
 * Жизненный цикл сайдкар-процесса: spawn, watchdog-рестарт, остановка.
 * Сайдкар — обычный node-процесс с JSON-RPC на stdio; при падении IDE
 * умирает вместе с родителем, граф восстанавливается из чекпоинта.
 */
export class SidecarProcessManager implements vscode.Disposable {
	private child?: ChildProcess;
	private rpc?: RpcClient;
	private restarts: number[] = [];
	private intentionallyStopped = true;
	private stateValue: SidecarState = 'off';
	private lastError?: string;
	private readonly onDidSpawnEmitter = new vscode.EventEmitter<RpcClient>();
	private readonly onDidExitEmitter = new vscode.EventEmitter<void>();
	private readonly onDidChangeStateEmitter = new vscode.EventEmitter<void>();

	/** Срабатывает при каждом (пере)запуске — на этом моменте надо перевесить обработчики RPC. */
	readonly onDidSpawn = this.onDidSpawnEmitter.event;
	readonly onDidExit = this.onDidExitEmitter.event;
	/** Сменилось состояние процесса: панель обновляет бейдж и подсказку. */
	readonly onDidChangeState = this.onDidChangeStateEmitter.event;

	constructor(private extensionUri: vscode.Uri, private getProxyEnv?: () => Record<string, string>) {}

	get isRunning(): boolean {
		return !!this.child && this.child.exitCode === null;
	}

	get state(): SidecarState {
		return this.stateValue;
	}

	/** Причина состояния 'error' — её панель показывает рядом с бейджем. */
	get stateError(): string | undefined {
		return this.lastError;
	}

	get client(): RpcClient | undefined {
		return this.rpc;
	}

	/** Идемпотентный запуск: панель прогревает процесс ещё до первой задачи. */
	async ensureStarted(): Promise<RpcClient> {
		if (this.isRunning && this.rpc) {
			return this.rpc;
		}
		return this.spawn();
	}

	async stop(): Promise<void> {
		this.intentionallyStopped = true;
		if (this.child && this.child.exitCode === null) {
			try {
				await this.rpc?.sendCommand('cancel', undefined, 5_000).catch(() => undefined);
			} finally {
				this.child.kill();
			}
		}
		this.cleanup();
	}

	dispose(): void {
		void this.stop();
		this.onDidSpawnEmitter.dispose();
		this.onDidExitEmitter.dispose();
		this.onDidChangeStateEmitter.dispose();
	}

	private async spawn(): Promise<RpcClient> {
		if (!this.canRestart()) {
			const message = `sidecar restarted more than ${MAX_RESTARTS} times in ${RESTART_WINDOW_MS / 60000} min — giving up`;
			this.setState('error', message);
			throw new Error(message);
		}
		const sidecarPath = path.join(this.extensionUri.fsPath, 'dist', 'sidecar.cjs');
		logInfo(`spawning sidecar: ${sidecarPath}`);
		this.intentionallyStopped = false;
		this.setState('starting');

		const child = spawn(process.execPath, [sidecarPath], {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: '1',
				AURA_ORM_MOCK_LLM: process.env.AURA_ORM_MOCK_LLM ?? '',
				// Сайдкар видит только адрес прокси и секрет запуска — никаких ключей.
				...(this.getProxyEnv?.() ?? {}),
			},
		});
		this.child = child;
		this.rpc = new RpcClient(child);
		this.restarts.push(Date.now());

		child.on('exit', (code, signal) => {
			logWarn(`sidecar exited: code=${code} signal=${signal}`);
			this.rpc?.dispose();
			this.rpc = undefined;
			this.child = undefined;
			this.onDidExitEmitter.fire();
			if (this.intentionallyStopped) {
				this.setState('off');
				return;
			}
			if (this.stateValue === 'error') {
				// Причина уже показана в панели — не перетираем её перезапуском.
				return;
			}
			this.setState('starting', `процесс завершился (код ${code ?? '?'}), перезапуск`);
			void this.spawn().catch(err => {
				this.setState('error', err instanceof Error ? err.message : String(err));
				logError('sidecar respawn failed', err);
			});
		});

		// Ошибка запуска (нет dist/sidecar.cjs, нет прав) приходит событием, а не исключением.
		child.on('error', err => {
			logError('sidecar process error', err);
			this.setState('error', err.message);
		});

		this.onDidSpawnEmitter.fire(this.rpc);
		this.setState('ready');
		return this.rpc;
	}

	private setState(state: SidecarState, error?: string): void {
		if (this.stateValue === state && this.lastError === error) {
			return;
		}
		this.stateValue = state;
		this.lastError = state === 'error' ? error : undefined;
		this.onDidChangeStateEmitter.fire();
	}

	private canRestart(): boolean {
		const cutoff = Date.now() - RESTART_WINDOW_MS;
		this.restarts = this.restarts.filter(t => t > cutoff);
		return this.restarts.length < MAX_RESTARTS;
	}

	private cleanup(): void {
		this.rpc?.dispose();
		this.rpc = undefined;
		this.child = undefined;
	}
}
