/*---------------------------------------------------------------------------------------------
 *  Orca — CLI-агенты во вкладках-терминалах.
 *
 *  Claude Code, Codex, Gemini CLI, Qwen Code, opencode, Aider (или своя команда)
 *  запускаются в терминалах-вкладках редактора: интерактивно или задачей «без участия».
 *  Каждый агент может работать в своей ветке (git worktree), чтобы несколько агентов
 *  шли параллельно и не мешали друг другу. Ключи, base URL и модель задаются в
 *  настройках CLI (ключ — в SecretStorage) или берутся из плагина API Keys.
 *  Оркестратор вызывает агентов через команду auraOrca.runHeadless.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChildProcess, exec, execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { CliId, CliPreset, CliSettings, PRESETS, binaryOf, buildArgs, buildEnv, commandLine, maskSecret, presetById, quoteCmd, shellKindOf, slug, stripAnsi, tail } from './presets';
import { WorktreeInfo, Worktrees } from './worktree';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const SETTINGS_KEY = 'auraOrca.cliSettings';
const secretKey = (id: string): string => `auraOrca.key.${id}`;

type Mode = 'interactive' | 'headless';
type Status = 'starting' | 'running' | 'exited' | 'failed' | 'idle';

interface Session {
	id: string;
	cli: CliId;
	title: string;
	mode: Mode;
	cwd: string;
	task?: string;
	worktree?: WorktreeInfo;
	status: Status;
	exitCode?: number;
	startedAt: number;
	endedAt?: number;
	output: string;
	error?: string;
	terminal?: vscode.Terminal;
	child?: ChildProcess;
	execution?: vscode.TerminalShellExecution;
	done?: Promise<void>;
}

interface LaunchInput { cli?: string; task?: string; title?: string; mode?: Mode; worktree?: boolean; count?: number; cwd?: string; }

export function activate(context: vscode.ExtensionContext): unknown {
	const output = vscode.window.createOutputChannel('Orca');
	context.subscriptions.push(output);
	const log = (line: string): void => output.appendLine(line);
	const gitPath = (): string => vscode.workspace.getConfiguration('git').get<string>('path') || 'git';
	const worktrees = new Worktrees(gitPath, log);
	const sessions: Session[] = [];
	let panel: vscode.WebviewPanel | undefined;
	const installedCache = new Map<string, { at: number; path?: string }>();

	/* ---------------- Настройки CLI ---------------- */
	const allSettings = (): Record<string, CliSettings> => context.globalState.get<Record<string, CliSettings>>(SETTINGS_KEY, {});
	const settingsOf = (id: string): CliSettings => allSettings()[id] ?? {};
	const saveSettings = async (id: string, value: CliSettings): Promise<void> => {
		await context.globalState.update(SETTINGS_KEY, { ...allSettings(), [id]: value });
	};

	/** Ключ, base URL и модель: вручную (SecretStorage) или из плагина API Keys. */
	const resolveCredentials = async (preset: CliPreset, settings: CliSettings): Promise<{ secret?: string; settings: CliSettings; source: string }> => {
		if (settings.keySource === 'none') { return { settings, source: 'none' }; }
		if (settings.keySource === 'api-plugin' && settings.apiKeyId) {
			try {
				const exported = await vscode.commands.executeCommand<{ value?: string; baseUrl?: string; model?: string } | undefined>('apiKeys.exportKey', settings.apiKeyId);
				if (exported?.value) {
					return { secret: exported.value, settings: { ...settings, baseUrl: settings.baseUrl || exported.baseUrl, model: settings.model || exported.model }, source: 'api-plugin' };
				}
			} catch (error) { log(`[keys] apiKeys.exportKey: ${String(error)}`); }
			throw new Error(vscode.l10n.t('The API Keys plugin key for {0} is unavailable.', preset.name));
		}
		return { secret: await context.secrets.get(secretKey(preset.id)), settings, source: 'manual' };
	};

	const whichBinary = async (binary: string): Promise<string | undefined> => {
		if (!binary) { return undefined; }
		const cached = installedCache.get(binary);
		if (cached && Date.now() - cached.at < 60_000) { return cached.path; }
		let found: string | undefined;
		try {
			const result = await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [binary], { timeout: 5000 });
			found = result.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean);
		} catch { found = undefined; }
		installedCache.set(binary, { at: Date.now(), path: found });
		return found;
	};

	const workspaceCwd = (): string | undefined => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

	/* ---------------- Запуск ---------------- */
	const newId = (): string => Math.random().toString(36).slice(2, 10);
	const terminalLocation = (): vscode.TerminalOptions['location'] =>
		vscode.workspace.getConfiguration('auraOrca').get<string>('terminalLocation', 'editor') === 'panel'
			? vscode.TerminalLocation.Panel
			: { viewColumn: vscode.ViewColumn.Active, preserveFocus: false };

	const finish = (session: Session, code: number | undefined, error?: string): void => {
		if (session.status === 'exited' || session.status === 'failed') { return; }
		session.exitCode = code;
		session.endedAt = Date.now();
		session.status = error || (code !== undefined && code !== 0) ? 'failed' : 'exited';
		session.error = error;
		void pushState();
	};

	/** Интерактивный агент: обычный терминал-вкладка, команда через shell integration. */
	const startInteractive = (session: Session, preset: CliPreset, binary: string, args: string[], env: Record<string, string>): void => {
		const terminal = vscode.window.createTerminal({
			name: `${preset.name} · ${session.title}`,
			cwd: session.cwd,
			env,
			iconPath: new vscode.ThemeIcon('hubot'),
			location: terminalLocation(),
			isTransient: true
		});
		session.terminal = terminal;
		session.status = 'running';
		terminal.show(false);
		const shell = shellKindOf((terminal.creationOptions as vscode.TerminalOptions).shellPath ?? vscode.env.shell, process.platform);
		const line = commandLine(binary, args, shell);
		let sent = false;
		const send = (): void => {
			if (sent) { return; }
			sent = true;
			if (terminal.shellIntegration) { session.execution = terminal.shellIntegration.executeCommand(line); } else { terminal.sendText(line, true); }
		};
		if (terminal.shellIntegration) { send(); return; }
		const listener = vscode.window.onDidChangeTerminalShellIntegration(event => {
			if (event.terminal === terminal) { listener.dispose(); send(); }
		});
		setTimeout(() => { listener.dispose(); send(); }, 3000);
	};

	/** Задача без участия: процесс с живым выводом в псевдотерминале и кодом выхода. */
	const startHeadless = (session: Session, preset: CliPreset, binary: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<void> => {
		const write = new vscode.EventEmitter<string>();
		const echo = (text: string): void => { write.fire(text.replace(/\r?\n/g, '\r\n')); };
		let resolveDone: () => void = () => undefined;
		const done = new Promise<void>(resolve => { resolveDone = resolve; });
		const pty: vscode.Pseudoterminal = {
			onDidWrite: write.event,
			open: () => {
				echo(`\x1b[2m$ ${binary} ${args.map(arg => arg.length > 80 ? arg.slice(0, 77) + '…' : arg).join(' ')}\x1b[0m\n`);
				let child: ChildProcess;
				try {
					child = process.platform === 'win32'
						? spawn(commandLine(binary, args, 'cmd'), { cwd: session.cwd, env: { ...process.env, ...env }, shell: true, windowsHide: true })
						: spawn(binary, args, { cwd: session.cwd, env: { ...process.env, ...env } });
				} catch (error) {
					echo(`\x1b[31m${String(error)}\x1b[0m\n`);
					finish(session, undefined, String(error));
					resolveDone();
					return;
				}
				session.child = child;
				session.status = 'running';
				void pushState();
				child.stdin?.end();
				const onData = (chunk: Buffer): void => {
					const text = chunk.toString('utf8');
					echo(text);
					session.output = tail(session.output + stripAnsi(text), 200_000);
				};
				child.stdout?.on('data', onData);
				child.stderr?.on('data', onData);
				const timer = timeoutMs > 0 ? setTimeout(() => { echo(`\n\x1b[33m⏱ timeout ${Math.round(timeoutMs / 1000)}s\x1b[0m\n`); child.kill(); }, timeoutMs) : undefined;
				child.on('error', error => {
					if (timer) { clearTimeout(timer); }
					const message = (error as NodeJS.ErrnoException).code === 'ENOENT' ? vscode.l10n.t('{0} is not installed or not in PATH.', binary) : String(error);
					echo(`\n\x1b[31m${message}\x1b[0m\n`);
					finish(session, undefined, message);
					resolveDone();
				});
				child.on('close', code => {
					if (timer) { clearTimeout(timer); }
					echo(`\n\x1b[2m— ${vscode.l10n.t('finished, exit code {0}', String(code ?? '?'))} —\x1b[0m\n`);
					finish(session, code ?? undefined);
					resolveDone();
				});
			},
			close: () => { session.child?.kill(); }
		};
		const terminal = vscode.window.createTerminal({ name: `${preset.name} · ${session.title}`, pty, iconPath: new vscode.ThemeIcon('hubot'), location: terminalLocation(), isTransient: true });
		session.terminal = terminal;
		terminal.show(true);
		return done;
	};

	const launch = async (input: LaunchInput, timeoutMs = 0): Promise<Session[]> => {
		const preset = presetById(input.cli);
		if (!preset) { throw new Error(vscode.l10n.t('Unknown CLI agent: {0}', String(input.cli))); }
		const stored = settingsOf(preset.id);
		const binary = binaryOf(preset, stored);
		if (!binary) { throw new Error(vscode.l10n.t('Set the command for "{0}" in Orca settings.', preset.name)); }
		const credentials = await resolveCredentials(preset, stored);
		const env = buildEnv(preset, credentials.settings, credentials.secret);
		const mode: Mode = input.mode === 'headless' ? 'headless' : 'interactive';
		const count = Math.max(1, Math.min(6, Number(input.count) || 1));
		const baseCwd = input.cwd || workspaceCwd();
		if (!baseCwd) { throw new Error(vscode.l10n.t('Open a folder first.')); }
		const isolate = input.worktree === true || count > 1;
		const root = isolate ? await worktrees.root(baseCwd) : undefined;
		if (isolate && !root) { throw new Error(vscode.l10n.t('Parallel agents need a git repository: each agent works in its own branch.')); }
		const task = String(input.task ?? '').trim();
		const baseTitle = String(input.title ?? '').trim() || (task ? task.split(/\s+/).slice(0, 6).join(' ') : preset.name);
		const started: Session[] = [];
		for (let index = 0; index < count; index++) {
			const id = newId();
			const title = count > 1 ? `${baseTitle} #${index + 1}` : baseTitle;
			const session: Session = { id, cli: preset.id, title, mode, cwd: baseCwd, task: task || undefined, status: 'starting', startedAt: Date.now(), output: '' };
			if (isolate && root) {
				session.worktree = await worktrees.create(root, `${preset.id}-${slug(title, 24)}-${id.slice(0, 4)}`);
				session.cwd = session.worktree.path;
			}
			sessions.unshift(session);
			const args = buildArgs(preset, credentials.settings, task || undefined, mode);
			log(`[launch] ${preset.name} (${mode}) in ${session.cwd}; env: ${Object.keys(env).join(', ') || '—'}; key: ${credentials.source}`);
			if (mode === 'headless') {
				if (!task) { throw new Error(vscode.l10n.t('A task is required for a headless run.')); }
				session.done = startHeadless(session, preset, binary, args, env, timeoutMs);
			} else {
				startInteractive(session, preset, binary, args, env);
			}
			started.push(session);
		}
		await pushState();
		return started;
	};

	context.subscriptions.push(
		vscode.window.onDidCloseTerminal(terminal => {
			const session = sessions.find(item => item.terminal === terminal);
			if (!session) { return; }
			session.terminal = undefined;
			if (session.mode === 'interactive') { finish(session, terminal.exitStatus?.code); }
			void pushState();
		}),
		vscode.window.onDidEndTerminalShellExecution(event => {
			const session = sessions.find(item => item.execution === event.execution);
			if (session) { finish(session, event.exitCode); }
		})
	);

	/** Деревья, оставшиеся с прошлой сессии окна: их можно слить или удалить. */
	const restoreWorktrees = async (): Promise<void> => {
		const cwd = workspaceCwd();
		const root = cwd ? await worktrees.root(cwd) : undefined;
		if (!root) { return; }
		for (const info of await worktrees.list(root)) {
			if (sessions.some(item => item.worktree?.path === info.path)) { continue; }
			const cli = (PRESETS.find(preset => info.branch.startsWith(`orca/${preset.id}-`))?.id ?? 'custom') as CliId;
			sessions.push({ id: newId(), cli, title: info.branch.replace(/^orca\//, ''), mode: 'interactive', cwd: info.path, worktree: info, status: 'idle', startedAt: Date.now(), output: '' });
		}
	};

	/* ---------------- Действия с сессией ---------------- */
	const sessionById = (id: string | undefined): Session => {
		const session = sessions.find(item => item.id === id);
		if (!session) { throw new Error(vscode.l10n.t('Agent session not found.')); }
		return session;
	};
	const stop = (session: Session): void => {
		if (session.child && session.status === 'running') { session.child.kill(); }
		if (session.mode === 'interactive' && session.terminal) { session.terminal.dispose(); }
	};

	const openChanges = async (session: Session): Promise<void> => {
		if (!session.worktree) { throw new Error(vscode.l10n.t('This agent works in the main folder — see Source Control.')); }
		const changes = await worktrees.changes(session.worktree);
		if (changes.files.length === 0) { void vscode.window.showInformationMessage(vscode.l10n.t('The agent has not changed any files yet.')); return; }
		const dir = mkdtempSync(join(tmpdir(), 'orca-base-'));
		const entries: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = [];
		for (const file of changes.files.slice(0, 80)) {
			const current = vscode.Uri.file(join(session.worktree.path, file.path));
			let original: vscode.Uri | undefined;
			if (file.status !== 'A') {
				const target = join(dir, file.path.replace(/[\\/]/g, '__'));
				writeFileSync(target, await worktrees.showAt(session.worktree, file.path));
				original = vscode.Uri.file(target);
			}
			entries.push([current, original, file.status === 'D' ? undefined : current]);
		}
		await vscode.commands.executeCommand('vscode.changes', `Orca · ${session.title}`, entries);
	};

	/* ---------------- Состояние для вебвью ---------------- */
	const serializeSession = (session: Session) => ({
		id: session.id, cli: session.cli, title: session.title, mode: session.mode, cwd: session.cwd, task: session.task,
		worktree: session.worktree ? { branch: session.worktree.branch, path: session.worktree.path } : undefined,
		status: session.status, exitCode: session.exitCode, startedAt: session.startedAt, endedAt: session.endedAt,
		error: session.error, hasTerminal: Boolean(session.terminal), output: session.mode === 'headless' ? tail(session.output, 6000) : ''
	});
	const cliState = async () => Promise.all(PRESETS.map(async preset => {
		const stored = settingsOf(preset.id);
		const binary = binaryOf(preset, stored);
		const secret = await context.secrets.get(secretKey(preset.id));
		return {
			id: preset.id, name: preset.name, vendor: preset.vendor, color: preset.color, glyph: preset.glyph, install: preset.install, docsUrl: preset.docsUrl,
			binary, defaultBinary: preset.binary, keyEnv: preset.keyEnv, baseUrlEnv: preset.baseUrlEnv ?? '', modelEnv: preset.modelEnv ?? '', modelFlag: preset.modelFlag ?? '',
			path: await whichBinary(binary), settings: stored, keyMask: maskSecret(secret), hasKey: Boolean(secret)
		};
	}));
	const buildState = async () => ({
		language: uiLanguage(),
		workspace: workspaceCwd() ?? '',
		clis: await cliState(),
		sessions: sessions.map(serializeSession)
	});
	const pushState = async (): Promise<void> => {
		if (!panel) { return; }
		try { await panel.webview.postMessage({ type: 'state', state: await buildState() }); } catch { /* панель закрыта */ }
	};
	const uiLanguage = (): 'ru' | 'en' => {
		const configured = vscode.workspace.getConfiguration('aura').get<string>('language', 'auto');
		const value = configured === 'ru' || configured === 'en' ? configured : vscode.env.language;
		return String(value).toLowerCase().startsWith('ru') ? 'ru' : 'en';
	};

	/* ---------------- Команды (палитра + вебвью) ---------------- */
	const handlers = new Map<string, (...args: never[]) => Promise<unknown>>();
	const register = (id: string, fn: (...args: never[]) => Promise<unknown>): void => {
		handlers.set(id, fn);
		context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: never[]) => {
			try { return await fn(...args); } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); return undefined; }
		}));
	};

	const openPanel = async (): Promise<void> => {
		if (panel) { panel.reveal(); return; }
		await restoreWorktrees().catch(error => log(`[restore] ${String(error)}`));
		panel = vscode.window.createWebviewPanel('auraOrca.panel', 'Orca', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
		panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'orca.svg');
		const nonce = newId() + newId();
		panel.webview.html = readFileSync(join(context.extensionPath, 'media', 'panel.html'), 'utf8')
			.split('__NONCE__').join(nonce)
			.split('__CSP__').join(panel.webview.cspSource);
		panel.onDidDispose(() => { panel = undefined; }, undefined, context.subscriptions);
		panel.webview.onDidReceiveMessage(async (message: { type?: string; id?: number; command?: string; args?: unknown[] }) => {
			if (message?.type === 'ready') { await pushState(); return; }
			if (message?.type !== 'invoke' || !message.command) { return; }
			const handler = handlers.get(message.command);
			try {
				if (!handler) { throw new Error(`unknown command ${message.command}`); }
				const result = await handler(...((message.args ?? []) as never[]));
				void panel?.webview.postMessage({ type: 'response', id: message.id, ok: true, result });
			} catch (error) {
				void panel?.webview.postMessage({ type: 'response', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		}, undefined, context.subscriptions);
	};

	register('auraOrca.open', openPanel);
	register('auraOrca.getState', buildState);
	register('auraOrca.newAgent', async (input?: LaunchInput) => {
		if (!input?.cli) {
			const pick = await vscode.window.showQuickPick(PRESETS.filter(preset => preset.id !== 'custom' || binaryOf(preset, settingsOf(preset.id))).map(preset => ({ label: preset.name, description: preset.vendor, id: preset.id })), { placeHolder: vscode.l10n.t('Which CLI agent to start?') });
			if (!pick) { return undefined; }
			input = { cli: pick.id };
		}
		const started = await launch(input);
		return started.map(serializeSession);
	});
	register('auraOrca.focus', async (id?: string) => { const session = sessionById(id); session.terminal?.show(false); });
	register('auraOrca.stop', async (id?: string) => { stop(sessionById(id)); await pushState(); });
	register('auraOrca.restart', async (id?: string) => {
		const session = sessionById(id);
		stop(session);
		const index = sessions.indexOf(session);
		if (index >= 0) { sessions.splice(index, 1); }
		const started = await launch({ cli: session.cli, task: session.task, title: session.title, mode: session.mode, cwd: session.cwd });
		return started.map(serializeSession);
	});
	register('auraOrca.dismiss', async (id?: string) => {
		const session = sessionById(id);
		stop(session);
		sessions.splice(sessions.indexOf(session), 1);
		await pushState();
	});
	register('auraOrca.changes', async (id?: string) => {
		const session = sessionById(id);
		if (!session.worktree) { return undefined; }
		return worktrees.changes(session.worktree);
	});
	register('auraOrca.openChanges', async (id?: string) => openChanges(sessionById(id)));
	register('auraOrca.merge', async (id?: string) => {
		const session = sessionById(id);
		if (!session.worktree) { throw new Error(vscode.l10n.t('This agent works in the main folder — nothing to merge.')); }
		const root = await worktrees.root(dirname(dirname(dirname(session.worktree.path)))) ?? workspaceCwd();
		if (!root) { throw new Error(vscode.l10n.t('Open a folder first.')); }
		const result = await worktrees.merge(root, session.worktree, `orca(${session.cli}): ${session.title}`);
		if (result.conflicts) { await vscode.commands.executeCommand('workbench.view.scm'); }
		await pushState();
		return result;
	});
	register('auraOrca.removeWorktree', async (id?: string) => {
		const session = sessionById(id);
		if (!session.worktree) { return; }
		stop(session);
		const root = await worktrees.root(dirname(dirname(dirname(session.worktree.path)))) ?? workspaceCwd();
		if (root) { await worktrees.remove(root, session.worktree); }
		sessions.splice(sessions.indexOf(session), 1);
		await pushState();
	});
	register('auraOrca.openFolder', async (id?: string) => {
		const session = sessionById(id);
		await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(session.cwd), { forceNewWindow: true });
	});

	/* Настройки CLI */
	register('auraOrca.saveCliSettings', async (id?: string, value?: CliSettings & { apiKey?: string; clearKey?: boolean }) => {
		const preset = presetById(id);
		if (!preset || !value) { throw new Error(vscode.l10n.t('Unknown CLI agent: {0}', String(id))); }
		const { apiKey, clearKey, ...rest } = value;
		const clean: CliSettings = {};
		for (const [key, raw] of Object.entries(rest) as [keyof CliSettings, string | undefined][]) {
			const text = typeof raw === 'string' ? raw.trim() : raw;
			if (text) { (clean as Record<string, string>)[key] = text; }
		}
		if (clean.baseUrl && !/^https?:\/\//i.test(clean.baseUrl)) { throw new Error(vscode.l10n.t('Base URL must start with http:// or https://')); }
		if (clean.keyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(clean.keyEnv)) { throw new Error(vscode.l10n.t('Invalid environment variable name.')); }
		await saveSettings(preset.id, clean);
		if (clearKey) { await context.secrets.delete(secretKey(preset.id)); }
		else if (apiKey && apiKey.trim()) { await context.secrets.store(secretKey(preset.id), apiKey.trim()); }
		installedCache.delete(binaryOf(preset, clean));
		await pushState();
	});
	register('auraOrca.install', async (id?: string) => {
		const preset = presetById(id);
		if (!preset?.install) { return; }
		const terminal = vscode.window.createTerminal({ name: `Orca · ${preset.name} install`, iconPath: new vscode.ThemeIcon('cloud-download') });
		terminal.show();
		terminal.sendText(preset.install, true);
		installedCache.clear();
	});
	register('auraOrca.checkCli', async (id?: string) => {
		const preset = presetById(id);
		if (!preset) { throw new Error(vscode.l10n.t('Unknown CLI agent: {0}', String(id))); }
		const binary = binaryOf(preset, settingsOf(preset.id));
		installedCache.delete(binary);
		const path = await whichBinary(binary);
		if (!path) { return { ok: false, path: undefined, version: '' }; }
		try {
			const result = process.platform === 'win32'
				? await execAsync(`${quoteCmd(binary)} --version`, { timeout: 20000, windowsHide: true })
				: await execFileAsync(binary, ['--version'], { timeout: 20000 });
			return { ok: true, path, version: String(result.stdout || result.stderr).trim().split('\n')[0] };
		} catch (error) {
			return { ok: false, path, version: '', error: error instanceof Error ? error.message : String(error) };
		}
	});
	register('auraOrca.apiPluginKeys', async () => {
		try {
			const list = await vscode.commands.executeCommand<Array<{ id: string; name?: string; baseUrl?: string; model?: string }>>('apiKeys.exportKeysList');
			return Array.isArray(list) ? list : [];
		} catch { return []; }
	});
	register('auraOrca.openExternal', async (url?: string) => { if (url && /^https:\/\//.test(url)) { await vscode.env.openExternal(vscode.Uri.parse(url)); } });
	register('auraOrca.openSettings', async () => { await vscode.commands.executeCommand('workbench.action.openSettings', 'auraOrca'); });

	/* ---------------- API для оркестратора ---------------- */
	register('auraOrca.listAgents', async () => (await cliState()).map(cli => ({
		id: cli.id, name: cli.name, installed: Boolean(cli.path), configured: cli.hasKey || cli.settings.keySource === 'api-plugin' || cli.settings.keySource === 'none'
	})));
	/** Задача CLI-агенту без участия: ждём завершения, возвращаем код и хвост вывода. */
	register('auraOrca.runHeadless', async (input?: { agent?: string; task?: string; cwd?: string; title?: string; timeoutMs?: number }) => {
		const agent = input?.agent || vscode.workspace.getConfiguration('auraOrca').get<string>('defaultAgent', 'claude');
		const task = String(input?.task ?? '').trim();
		if (!task) { throw new Error(vscode.l10n.t('A task is required for a headless run.')); }
		const timeout = Math.max(10_000, Math.min(60 * 60_000, Number(input?.timeoutMs) || 15 * 60_000));
		const [session] = await launch({ cli: agent, task, cwd: input?.cwd, title: input?.title || `orchestrator: ${task.slice(0, 40)}`, mode: 'headless' }, timeout);
		await session.done;
		return { ok: session.status === 'exited', agent: session.cli, exitCode: session.exitCode, error: session.error, output: tail(session.output, 8000), sessionId: session.id };
	});

	return { version: 1 };
}

export function deactivate(): void { }
