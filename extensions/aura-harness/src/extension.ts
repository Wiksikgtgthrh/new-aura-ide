/*---------------------------------------------------------------------------------------------
 *  Agent Harness — встроенный плагин Aura IDE.
 *
 *  Везёт с собой снапшот агентного харнесса (harness/ в папке расширения) и:
 *  - при первом запуске раскатывает его в ~/.agent-harness и ставит скилы во все
 *    обнаруженные цели (pi, opencode, zcode, agents, claude, codex, gemini, cursor);
 *  - при более новой встроенной версии предлагает обновление (расходящиеся файлы
 *    пользователя бэкапятся в ~/.agent-harness/backups/<метка>/);
 *  - отдаёт публичный API другим плагинам (оркестратор зовёт инструменты харнесса
 *    через него, без своего поиска путей).
 *
 *  Скрипты харнесса запускаются через ELECTRON_RUN_AS_NODE — системный Node.js
 *  пользователю не нужен.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Публичный API плагина (его структурно проверяет langgraph-orchestrator). */
export interface AuraHarnessApi {
	readonly apiVersion: number;
	/** Версия встроенного снапшота. */
	readonly version: string;
	/** Куда ставится харнесс (~/.agent-harness, уважает HARNESS_HOME). */
	readonly harnessRoot: string;
	/** Каталог инструментов харнесса (tools/*.mjs). */
	readonly toolsDir: string;
	isInstalled(): boolean;
	installedVersion(): string | undefined;
	/** Синхронизировать снапшот и прогнать install.mjs по обнаруженным целям. */
	install(): Promise<{ ok: boolean; output: string }>;
	/**
	 * Запустить инструмент харнесса (`doctor.mjs`, `orchestrator.mjs`, …).
	 * cwd — рабочая папка (для orchestrator.mjs это корень проекта с .agent-state).
	 */
	run(tool: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

const HARNESS_EXTENSION_ID = 'aura.aura-harness';

function homeDir(): string {
	return process.env.HARNESS_HOME || os.homedir();
}

function sha256(file: string): string {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function* walkFiles(dir: string): Generator<string> {
	if (!fs.existsSync(dir)) {
		return;
	}
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkFiles(full);
		} else if (entry.isFile()) {
			yield full;
		}
	}
}

/** Сравнение semver x.y.z: >0 — a новее. Отрезает префиксы вида «v». */
function compareVersions(a: string, b: string): number {
	const pa = a.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
	const pb = b.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] || 0) - (pb[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}
	return 0;
}

function readVersion(root: string): string | undefined {
	try {
		const manifest = JSON.parse(fs.readFileSync(path.join(root, 'harness.json'), 'utf8')) as { version?: string };
		return manifest.version;
	} catch {
		return undefined;
	}
}

class HarnessService implements AuraHarnessApi {
	readonly apiVersion = 1;
	readonly version: string;
	readonly harnessRoot: string;
	readonly toolsDir: string;

	private readonly payloadDir: string;
	private readonly output: vscode.OutputChannel;
	private installInFlight?: Promise<{ ok: boolean; output: string }>;

	constructor(context: vscode.ExtensionContext) {
		this.payloadDir = path.join(context.extensionPath, 'harness');
		this.harnessRoot = path.join(homeDir(), '.agent-harness');
		this.toolsDir = path.join(this.harnessRoot, 'tools');
		this.version = readVersion(this.payloadDir) ?? '0.0.0';
		this.output = vscode.window.createOutputChannel('Agent Harness');
	}

	isInstalled(): boolean {
		return readVersion(this.harnessRoot) !== undefined;
	}

	installedVersion(): string | undefined {
		return readVersion(this.harnessRoot);
	}

	/** Снапшот → ~/.agent-harness. Расходящиеся файлы бэкапятся, чужие файлы не трогаем. */
	syncPayload(): { written: number; unchanged: number; backedUp: number } {
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const backupRoot = path.join(this.harnessRoot, 'backups', stamp);
		const log = { written: 0, unchanged: 0, backedUp: 0 };
		for (const src of walkFiles(this.payloadDir)) {
			const rel = path.relative(this.payloadDir, src);
			const dest = path.join(this.harnessRoot, rel);
			if (fs.existsSync(dest)) {
				if (sha256(src) === sha256(dest)) {
					log.unchanged++;
					continue;
				}
				const backup = path.join(backupRoot, rel);
				fs.mkdirSync(path.dirname(backup), { recursive: true });
				fs.copyFileSync(dest, backup);
				log.backedUp++;
			}
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.copyFileSync(src, dest);
			log.written++;
		}
		return log;
	}

	async install(): Promise<{ ok: boolean; output: string }> {
		// Параллельные вызовы (автоустановка + кнопка) делят один прогон.
		this.installInFlight ??= this.doInstall().finally(() => { this.installInFlight = undefined; });
		return this.installInFlight;
	}

	private async doInstall(): Promise<{ ok: boolean; output: string }> {
		const sync = this.syncPayload();
		this.output.appendLine(`[sync] written=${sync.written} unchanged=${sync.unchanged} backedUp=${sync.backedUp}`);
		const result = await this.run('install.mjs', []);
		this.output.append(result.stdout);
		if (result.stderr.trim()) {
			this.output.appendLine(result.stderr);
		}
		return { ok: result.code === 0, output: result.stdout + result.stderr };
	}

	run(tool: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
		const script = path.join(this.toolsDir, tool);
		return new Promise((resolve, reject) => {
			if (!fs.existsSync(script)) {
				reject(new Error(`Harness tool not found: ${script}`));
				return;
			}
			// ELECTRON_RUN_AS_NODE превращает бинарник IDE в Node.js — системная нода не нужна.
			const child = cp.spawn(process.execPath, [script, ...args], {
				cwd: cwd ?? this.harnessRoot,
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

	showOutput(): void {
		this.output.show(true);
	}

	/** doctor с выводом в канал плагина (команда «Проверить окружение»). */
	async doctor(): Promise<void> {
		this.output.show(true);
		this.output.appendLine(`[doctor] harness ${this.installedVersion() ?? '?'} at ${this.harnessRoot}`);
		const result = await this.run('doctor.mjs', []);
		this.output.appendLine(result.stdout);
		if (result.stderr.trim()) {
			this.output.appendLine(result.stderr);
		}
	}
}

async function autoInstall(service: HarnessService): Promise<void> {
	if (!vscode.workspace.getConfiguration('auraHarness').get<boolean>('autoInstall', true)) {
		return;
	}
	const installed = service.installedVersion();
	if (installed === undefined) {
		const result = await service.install();
		if (result.ok) {
			void vscode.window.showInformationMessage(`Agent Harness ${service.version} установлен в ${service.harnessRoot}`);
		} else {
			service.showOutput();
			void vscode.window.showErrorMessage('Agent Harness: установка не удалась — подробности в выводе «Agent Harness».');
		}
		return;
	}
	if (compareVersions(service.version, installed) > 0) {
		const update = 'Обновить';
		const pick = await vscode.window.showInformationMessage(
			`Доступен Agent Harness ${service.version} (установлен ${installed}). Обновить? Расходящиеся файлы будут сохранены в backups.`,
			update, 'Позже',
		);
		if (pick === update) {
			const result = await service.install();
			if (result.ok) {
				void vscode.window.showInformationMessage(`Agent Harness обновлён до ${service.version}.`);
			} else {
				service.showOutput();
			}
		}
	}
}

export function activate(context: vscode.ExtensionContext): AuraHarnessApi {
	const service = new HarnessService(context);

	context.subscriptions.push(
		vscode.commands.registerCommand('auraHarness.install', async () => {
			const result = await service.install();
			if (result.ok) {
				void vscode.window.showInformationMessage(`Agent Harness ${service.version}: установлен/обновлён (${service.harnessRoot}).`);
			} else {
				service.showOutput();
				void vscode.window.showErrorMessage('Agent Harness: установка завершилась с ошибкой — см. вывод «Agent Harness».');
			}
		}),
		vscode.commands.registerCommand('auraHarness.doctor', async () => {
			if (!service.isInstalled()) {
				void vscode.window.showWarningMessage('Agent Harness ещё не установлен — выполните «Harness: Установить/обновить харнесс».');
				return;
			}
			await service.doctor();
		}),
		vscode.commands.registerCommand('auraHarness.status', async () => {
			const installed = service.installedVersion();
			if (installed === undefined) {
				void vscode.window.showInformationMessage(`Agent Harness: не установлен. Встроенная версия — ${service.version}.`);
				return;
			}
			let targets = '';
			try {
				const record = JSON.parse(fs.readFileSync(path.join(service.harnessRoot, 'installed.json'), 'utf8')) as { targets?: string[]; at?: string };
				targets = ` Цели: ${(record.targets ?? []).join(', ')}. Установлен: ${record.at ?? '?'}.`;
			} catch { /* installed.json ещё не писался */ }
			void vscode.window.showInformationMessage(`Agent Harness: установлен ${installed}, встроен ${service.version}.${targets}`);
		}),
		vscode.commands.registerCommand('auraHarness.openFolder', async () => {
			await vscode.env.openExternal(vscode.Uri.file(service.harnessRoot));
		}),
	);

	// Автоустановка не блокирует активацию: прогоняем в фоне.
	void autoInstall(service).catch(err => {
		console.error('[aura-harness] auto-install failed', err);
	});

	return service;
}

/** Для тестов и моста оркестратора: id, под которым нас ищут другие плагины. */
export const harnessExtensionId = HARNESS_EXTENSION_ID;
