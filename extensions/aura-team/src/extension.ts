/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AuraApiClient } from './api/client';
import { connectGitHub } from './auth/github';
import { GitService } from './git/service';
import { ProfileManager } from './profile';
import { AuraState, BoardSnapshot, Profile, Project, Session, TeamApiKey } from './types';
import { BoardPanel } from './views/board';
import { AuraTeamPanelProvider } from './webview/panelProvider';

const PANEL_VIEW_TYPE = 'auraTeam.panel';
const PANEL_SCHEME = 'aura-team';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const output = vscode.window.createOutputChannel('Aura Team');
	const api = new AuraApiClient(context, output);
	const gitExtension = vscode.extensions.getExtension('vscode.git');
	await gitExtension?.activate();
	const git = new GitService(output);
	const profiles = new ProfileManager(context);
	const updateSimpleModeContext = async (): Promise<void> => vscode.commands.executeCommand('setContext', 'auraTeam.simpleMode', vscode.workspace.getConfiguration('auraTeam').get<boolean>('simpleMode', true));

	const state: { session?: Session; board?: BoardSnapshot; teamId?: string; keys?: TeamApiKey[]; demo?: boolean } = {};
	const boardPanel = new BoardPanel(api, () => state.teamId, async () => refresh());
	const provider = new AuraTeamPanelProvider(context.extensionUri);

	const demoMode = (): boolean => vscode.workspace.getConfiguration('auraTeam').get<boolean>('demoMode', true);
	const simpleMode = (): boolean => vscode.workspace.getConfiguration('auraTeam').get<boolean>('simpleMode', true);
	const serverUrl = (): string => vscode.workspace.getConfiguration('auraTeam').get<string>('serverUrl', 'http://localhost:3210');

	// ------------------------------------------------------------------
	// Хэндлер-слой: каждая команда реализована один раз и доступна и
	// палитре команд (с уведомлением об ошибке), и webview-вкладке
	// (результат/ошибка возвращаются в UI, без дублей уведомлений).
	// ------------------------------------------------------------------
	const handlers = new Map<string, (...args: never[]) => Promise<unknown>>();
	const register = (id: string, fn: (...args: never[]) => Promise<unknown>, notify = true): void => {
		handlers.set(id, fn);
		context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: never[]) => {
			try { await fn(...args); } catch (error) { if (notify) { vscode.window.showErrorMessage(errorMessage(error)); } }
		}));
	};

	const demoSession = (profile: Profile): Session => ({
		user: { id: 'demo-me', email: profile.email || 'demo@aura.local', displayName: profile.nickname || 'Demo User' },
		teams: [{ id: 'demo', name: 'Aura Studio', role: 'owner' }]
	});

	const demoBoard = (): BoardSnapshot => ({
		members: [
			{ id: 'demo-1', displayName: 'Alex', email: 'alex@demo.dev', role: 'maintainer', online: true },
			{ id: 'demo-2', displayName: 'Mia', email: 'mia@demo.dev', role: 'dev', online: true },
			{ id: 'demo-3', displayName: 'Sam', email: 'sam@demo.dev', role: 'viewer', online: false }
		],
		projects: [{ id: 'p1', teamId: 'demo', name: 'Aura IDE', gitUrl: 'https://github.com/Wiksikgtgthrh/new-aura-ide', defaultBranch: 'main' }],
		tasks: [
			{ id: 'dt1', teamId: 'demo', title: 'Дизайн вкладки Aura Team', description: 'Новый UI с анимациями', status: 'doing', assigneeId: 'demo-me', assigneeName: 'Вы', position: 0, dueAt: new Date(Date.now() + 2 * 864e5).toISOString() },
			{ id: 'dt2', teamId: 'demo', title: 'Банк API-ключей', description: 'Маскирование и роли', status: 'review', assigneeId: 'demo-1', assigneeName: 'Alex', position: 0 },
			{ id: 'dt3', teamId: 'demo', title: 'Git-панель: ветки', description: 'Переключение веток из вкладки', status: 'todo', assigneeId: 'demo-2', assigneeName: 'Mia', position: 0 },
			{ id: 'dt4', teamId: 'demo', title: 'Регистрация (mock)', description: 'Форма без сервера, чисто для вида', status: 'done', assigneeId: 'demo-me', assigneeName: 'Вы', position: 0 },
			{ id: 'dt5', teamId: 'demo', title: 'Передача файлов', description: 'Позже, через сервер', status: 'backlog', position: 0 }
		]
	});

	const demoKeys = (): TeamApiKey[] => ([
		{ id: 'k1', label: 'OpenAI team key', keyHint: 'sk-…k3Nd', provider: 'openai', accessRole: 'dev', priority: 100, createdAt: new Date(Date.now() - 3 * 864e5).toISOString() },
		{ id: 'k2', label: 'Anthropic team key', keyHint: 'sk-ant-…Q9m', provider: 'anthropic', accessRole: 'maintainer', priority: 200, createdAt: new Date(Date.now() - 1 * 864e5).toISOString() }
	]);

	const buildState = async (): Promise<AuraState> => ({
		profile: profiles.get(),
		session: state.session,
		teamId: state.teamId,
		board: state.board,
		keys: state.keys,
		git: await git.getSnapshot().catch(() => undefined),
		demoMode: demoMode() && !state.session,
		simpleMode: simpleMode(),
		serverUrl: serverUrl(),
		signedIn: !!state.session
	});

	const broadcast = async (): Promise<void> => { provider.broadcast(await buildState()); };

	const refresh = async (): Promise<void> => {
		try {
			state.session = await api.getSession();
			state.demo = false;
			state.teamId = state.teamId && state.session.teams.some(team => team.id === state.teamId) ? state.teamId : state.session.teams[0]?.id;
			state.board = state.teamId ? await api.getBoard(state.teamId) : undefined;
			state.keys = state.teamId ? await api.listApiKeys(state.teamId) : undefined;
			if (state.teamId) { api.connect(state.teamId); }
		} catch (error) {
			state.session = undefined;
			state.board = undefined;
			state.keys = undefined;
			state.demo = false;
			output.appendLine(`[api] ${errorMessage(error)}`);
			// Демо-режим: сервер недоступен, но профиль есть — показываем образец.
			if (demoMode() && profiles.get().nickname) {
				state.demo = true;
				state.session = demoSession(profiles.get());
				state.teamId = 'demo';
				state.board = demoBoard();
				state.keys = demoKeys();
			}
		}
		await broadcast();
	};

	const openTab = async (view = 'team'): Promise<void> => {
		const uri = vscode.Uri.from({ scheme: PANEL_SCHEME, authority: 'panel', path: '/Aura Team', query: `view=${view}` });
		try {
			await vscode.commands.executeCommand('vscode.openWith', uri, PANEL_VIEW_TYPE);
		} catch (error) {
			// Фолбэк: если кастомный редактор недоступен — обычная webview-панель.
			const panel = vscode.window.createWebviewPanel(PANEL_VIEW_TYPE, vscode.l10n.t('Aura Team'), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
			provider.attachFallback(panel, view);
			output.appendLine(`[open] fallback panel: ${errorMessage(error)}`);
		}
	};

	// ------------------------------------------------------------------
	// Регистрация провайдера вкладки + схема виртуального документа
	// ------------------------------------------------------------------
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(PANEL_VIEW_TYPE, provider, {
			webviewOptions: { retainContextWhenHidden: true, enableFindWidget: false },
			supportsMultipleEditorsPerDocument: false
		}),
		vscode.workspace.registerTextDocumentContentProvider(PANEL_SCHEME, { provideTextDocumentContent: () => '' }),
		vscode.window.registerWebviewViewProvider('auraTeam.home', new AuraTeamLauncherViewProvider(() => openTab('team')), { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.commands.registerCommand('auraTeam.invoke', async (id: string, args: unknown[]) => handlerFor(id, args)),
		vscode.commands.registerCommand('auraTeam.broadcast', () => broadcast()),
		vscode.commands.registerCommand('auraTeam.open', () => openTab('team')),
		vscode.commands.registerCommand('auraTeam.openProfile', () => openTab('profile')),
		vscode.commands.registerCommand('auraTeam.getState', () => buildState())
	);

	const handlerFor = async (id: string, args: unknown[]): Promise<unknown> => {
		const handler = handlers.get(id);
		if (!handler) { throw new Error(vscode.l10n.t('Unknown command: {0}', id)); }
		return handler(...(args as never[]));
	};

	// ------------------------------------------------------------------
	// Статус-бар: аватар профиля + быстрые действия
	// ------------------------------------------------------------------
	const avatar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
	const updateAvatar = (): void => {
		const profile = profiles.get();
		avatar.text = `$(account) ${profiles.initials()}`;
		avatar.tooltip = profile.nickname ? vscode.l10n.t('Aura Team — {0}', profile.nickname) : vscode.l10n.t('Aura Team — set up your profile');
		avatar.command = 'auraTeam.statusMenu';
	};
	context.subscriptions.push(avatar, vscode.commands.registerCommand('auraTeam.statusMenu', async () => {
		const pick = await vscode.window.showQuickPick([
			{ label: vscode.l10n.t('$(project) Open Aura Team'), id: 'open' },
			{ label: vscode.l10n.t('$(account) Profile'), id: 'profile' },
			{ label: vscode.l10n.t('$(sign-out) Sign Out'), id: 'out' }
		], { placeHolder: vscode.l10n.t('Aura Team') });
		if (pick?.id === 'open') { await openTab('team'); }
		else if (pick?.id === 'profile') { await openTab('profile'); }
		else if (pick?.id === 'out') { await api.signOut().catch(() => undefined); await refresh(); }
	}));
	updateAvatar();

	// ------------------------------------------------------------------
	// Команды (хэндлеры)
	// ------------------------------------------------------------------
	register('auraTeam.signIn', () => openTab('team'));
	register('auraTeam.login', async (data?: { email?: string; password?: string }) => {
		const email = data?.email ?? await requiredInput(vscode.l10n.t('Email'));
		const password = data?.password ?? await vscode.window.showInputBox({ prompt: vscode.l10n.t('Password'), password: true, ignoreFocusOut: true });
		if (!password) { throw new Error(vscode.l10n.t('The password is required.')); }
		await api.login(email, password);
		await refresh();
		const session = state.session;
		if (session && !profiles.get().nickname) {
			await profiles.save({ nickname: session.user.displayName, email: session.user.email });
			updateAvatar();
			await broadcast();
		}
	}, false);
	register('auraTeam.register', async (data?: { displayName?: string; email?: string; password?: string }) => {
		const email = data?.email?.trim();
		const displayName = data?.displayName?.trim();
		const password = data?.password ?? '';
		if (!email?.includes('@')) { throw new Error(vscode.l10n.t('Enter a valid email.')); }
		if (!displayName || displayName.length < 2) { throw new Error(vscode.l10n.t('Display name must be at least 2 characters.')); }
		if (password.length < 10) { throw new Error(vscode.l10n.t('Password must be at least 10 characters.')); }
		return await api.register(email, password, displayName);
	}, false);
	register('auraTeam.openRegister', async () => { await vscode.env.openExternal(vscode.Uri.parse(`${serverUrl().replace(/\/$/, '')}/register`)); });
	register('auraTeam.signOut', async () => { await api.signOut(); await refresh(); });
	register('auraTeam.selectTeam', async (teamId?: string) => {
		if (teamId) {
			state.teamId = teamId;
			await context.workspaceState.update('auraTeam.teamId', teamId);
			await refresh();
			return;
		}
		const selected = await vscode.window.showQuickPick(state.session?.teams.map(team => ({ label: team.name, description: team.role, id: team.id })) ?? [], { placeHolder: vscode.l10n.t('Select a team') });
		if (selected) { state.teamId = selected.id; await context.workspaceState.update('auraTeam.teamId', selected.id); await refresh(); }
	});
	register('auraTeam.toggleSimpleMode', async () => {
		const configuration = vscode.workspace.getConfiguration('auraTeam');
		const next = !configuration.get<boolean>('simpleMode', true);
		await configuration.update('simpleMode', next, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(next ? vscode.l10n.t('Simple Git mode is enabled.') : vscode.l10n.t('Advanced Git mode is enabled.'));
	});
	register('auraTeam.connectGitHub', async () => { await connectGitHub(context); vscode.window.showInformationMessage(vscode.l10n.t('GitHub is connected.')); });
	register('auraTeam.connectAuraApi', async () => {
		const teamId = requireTeam(state);
		const model = await requiredInput(vscode.l10n.t('Model ID'));
		const credential = await api.createProxyToken(teamId, 'openai', model);
		try {
			await vscode.commands.executeCommand('auraApi.addTeamProxy', {
				name: 'Aura Team · OpenAI',
				baseUrl: `${api.getServerUrl()}/v1/teams/${teamId}/proxy/openai/v1`,
				model,
				token: credential.token,
				provider: 'openai-compatible'
			});
			vscode.window.showInformationMessage(vscode.l10n.t('Team AI proxy was added to Aura API.'));
		} catch (error) {
			await api.revokeProxyToken(teamId, credential.id).catch(() => undefined);
			throw new Error(vscode.l10n.t('Install the Aura API plugin before connecting the team proxy. {0}', errorMessage(error)));
		}
	});
	register('auraTeam.createTeam', async (name?: string) => { const teamName = name ?? await requiredInput(vscode.l10n.t('Team name')); await api.createTeam(teamName); await refresh(); });
	register('auraTeam.joinTeam', async (code?: string) => { const inviteCode = code ?? await requiredInput(vscode.l10n.t('Invite code')); await api.joinTeam(inviteCode); await refresh(); });
	register('auraTeam.createInvite', async () => {
		const teamId = requireTeam(state);
		const invite = await api.createInvite(teamId);
		await vscode.env.clipboard.writeText(invite.code);
		vscode.window.showInformationMessage(vscode.l10n.t('Invite code {0} was copied.', invite.code));
		return invite;
	});
	register('auraTeam.changeRole', async (memberId?: string, role?: string) => {
		const member = memberId ? state.board?.members.find(item => item.id === memberId) : undefined;
		const target = member ?? await vscode.window.showQuickPick(state.board?.members.filter(item => item.role !== 'owner').map(item => ({ label: item.displayName, description: item.role, id: item.id })) ?? [], { placeHolder: vscode.l10n.t('Select a team member') });
		const nextRole = role ?? await vscode.window.showQuickPick(['maintainer', 'dev', 'viewer'], { placeHolder: vscode.l10n.t('Select the new role') });
		if (target && nextRole) { await api.changeRole(requireTeam(state), target.id, nextRole); await refresh(); }
	});
	register('auraTeam.createProject', async (name?: string, gitUrl?: string, branch?: string) => {
		await api.createProject(requireTeam(state), name ?? await requiredInput(vscode.l10n.t('Project name')), gitUrl ?? await requiredInput(vscode.l10n.t('Git repository URL')), branch ?? await requiredInput(vscode.l10n.t('Default branch'), 'main'));
		await refresh();
	});
	register('auraTeam.createTask', async (title?: string, status?: string) => { await api.createTask(requireTeam(state), title ?? await requiredInput(vscode.l10n.t('Task title')), (status as never) ?? undefined); await refresh(); });
	register('auraTeam.storeApiKey', async (key?: { provider?: string; accessRole?: string; label?: string; priority?: string; value?: string }) => {
		const provider = key?.provider ?? await vscode.window.showQuickPick(['openai', 'anthropic'], { placeHolder: vscode.l10n.t('Provider') });
		const accessRole = key?.accessRole ?? await vscode.window.showQuickPick(['owner', 'maintainer', 'dev', 'viewer'], { placeHolder: vscode.l10n.t('Minimum role allowed to use this key') });
		if (!provider || !accessRole) { return; }
		const label = key?.label ?? await requiredInput(vscode.l10n.t('Key name'), `${provider} team key`);
		const priorityText = key?.priority ?? await requiredInput(vscode.l10n.t('Priority (0 is highest)'), '100');
		const priority = Number(priorityText);
		if (!Number.isInteger(priority) || priority < 0 || priority > 1000) { throw new Error(vscode.l10n.t('Priority must be an integer from 0 to 1000.')); }
		const value = key?.value ?? await vscode.window.showInputBox({ prompt: vscode.l10n.t('API key'), password: true, ignoreFocusOut: true });
		if (!value) { return; }
		await api.storeApiKey(requireTeam(state), provider, value, accessRole, label, priority);
		vscode.window.showInformationMessage(vscode.l10n.t('The API key is encrypted on the server.'));
		await refresh();
	});
	register('auraTeam.disableApiKey', async (key?: TeamApiKey) => {
		if (!key) { return; }
		if (!await confirm(vscode.l10n.t('Disable {0}? Existing clients will immediately stop using it.', key.label))) { return; }
		await api.disableApiKey(requireTeam(state), key.id);
		vscode.window.showInformationMessage(vscode.l10n.t('The team API key was disabled.'));
		await refresh();
	});
	register('auraTeam.uploadArchive', async () => {
		const uri = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'tar.zst': ['zst', 'tzst'] } }))?.[0];
		if (!uri) { return; }
		const bytes = await vscode.workspace.fs.readFile(uri);
		if (bytes.byteLength > 50 * 1024 * 1024) { throw new Error(vscode.l10n.t('The archive exceeds 50 MiB.')); }
		const result = await api.uploadArchive(requireTeam(state), uri.path.split('/').pop() ?? 'project.tar.zst', await requiredInput(vscode.l10n.t('Project name')), bytes);
		vscode.window.showInformationMessage(vscode.l10n.t('Archive uploaded. It expires at {0}.', new Date(result.expiresAt).toLocaleString()));
		await refresh();
	});
	register('auraTeam.downloadArchive', async (project?: Project) => {
		if (!project?.archiveId) { throw new Error(vscode.l10n.t('This project has no archive.')); }
		const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${project.name}.tar.zst`), filters: { 'tar.zst': ['zst'] } });
		if (!destination) { return; }
		await vscode.workspace.fs.writeFile(destination, await api.downloadArchive(requireTeam(state), project.archiveId));
		vscode.window.showInformationMessage(vscode.l10n.t('Archive saved to {0}.', destination.fsPath));
	});
	register('auraTeam.openBoard', async () => { if (!state.board) { await refresh(); } if (state.board) { await boardPanel.show(state.board); } });
	register('auraTeam.getProject', async (project?: Project) => git.getProject(project?.gitUrl ?? await requiredInput(vscode.l10n.t('Git repository URL'))));
	register('auraTeam.saveWork', async (message?: string) => {
		const commit = await git.saveWork(message ?? await requiredInput(vscode.l10n.t('Commit message'), 'task #TASK_ID: describe the completed work'));
		if (state.teamId && commit.remoteUrl) { await api.reportCommit(state.teamId, commit.hash, commit.remoteUrl, commit.message); }
		return commit;
	});
	register('auraTeam.updateProject', () => git.update());
	register('auraTeam.undoChanges', async (confirmed?: boolean) => { if (confirmed || await confirm(vscode.l10n.t('Discard all uncommitted changes?'))) { await git.undoUncommitted(); await broadcast(); } });
	register('auraTeam.revertLastCommit', async (confirmed?: boolean) => { if (confirmed || await confirm(vscode.l10n.t('Create a new commit that reverses the last commit?'))) { await git.revertLastCommit(); await broadcast(); } });
	register('auraTeam.restoreFile', async () => { const uri = await pickFile(); if (uri) { await git.restoreFile(uri, await requiredInput(vscode.l10n.t('Commit hash or tag'))); } });
	register('auraTeam.relink', async (url?: string) => git.relink(url ?? await requiredInput(vscode.l10n.t('New origin URL'))));
	register('auraTeam.history', () => git.showHistory());

	// Новые команды для git-панели вкладки
	register('auraTeam.commitAll', async (message: string) => {
		const commit = await git.commitAll(message);
		if (state.teamId && commit.remoteUrl) { await api.reportCommit(state.teamId, commit.hash, commit.remoteUrl, commit.message); }
		await broadcast();
		return commit;
	});
	register('auraTeam.push', async () => { await git.push(); await broadcast(); });
	register('auraTeam.pull', async () => { await git.update(); await broadcast(); });
	register('auraTeam.checkout', async (branch: string) => { await git.checkout(branch); await broadcast(); });
	register('auraTeam.listBranches', () => git.listBranches());

	// Профиль (локальный, без сервера)
	register('auraTeam.registerProfile', async (data?: { nickname?: string; email?: string; description?: string }) => {
		const profile = await profiles.save({ nickname: data?.nickname ?? '', email: data?.email ?? '', description: data?.description ?? '' });
		updateAvatar();
		await refresh();
		return profile;
	}, false);

	state.teamId = context.workspaceState.get<string>('auraTeam.teamId');
	await updateSimpleModeContext();
	await refresh();
}

/**
 * Лаунчер в activity bar: клик по иконке Aura Team мгновенно открывает
 * вкладку и закрывает сайдбар — таб-поверхность без боковой панели-плагина.
 */
class AuraTeamLauncherViewProvider implements vscode.WebviewViewProvider {
	constructor(private readonly open: () => Promise<void>) { }
	resolveWebviewView(webviewView: vscode.WebviewView): void {
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';"></head><body style="display:flex;align-items:center;justify-content:center;box-sizing:border-box;min-height:100vh;margin:0;padding:12px;font-family:var(--vscode-font-family);background:transparent"><div style="color:var(--vscode-descriptionForeground);font-size:12px;text-align:center">Aura Team…</div></body></html>`;
		// Иконка = лаунчер: сначала мгновенно закрыть сайдбар (пустая панель не живёт),
		// затем открыть вкладку Aura Team.
		void vscode.commands.executeCommand('workbench.action.closeSidebar');
		void this.open().catch(() => undefined);
	}
}

function requireTeam(state: { teamId?: string }): string {
	if (!state.teamId) { throw new Error(vscode.l10n.t('Create or join a team first.')); }
	return state.teamId;
}

async function requiredInput(prompt: string, value?: string): Promise<string> {
	const result = await vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true });
	if (!result?.trim()) { throw new Error(vscode.l10n.t('The value is required.')); }
	return result.trim();
}

async function confirm(message: string): Promise<boolean> {
	return await vscode.window.showWarningMessage(message, { modal: true }, vscode.l10n.t('Continue')) === vscode.l10n.t('Continue');
}

async function pickFile(): Promise<vscode.Uri | undefined> {
	const selection = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false });
	return selection?.[0];
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function deactivate(): void { }
