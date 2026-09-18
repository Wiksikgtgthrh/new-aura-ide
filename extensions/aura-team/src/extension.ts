/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AuraApiClient } from './api/client';
import { connectGitHub } from './auth/github';
import { GitService } from './git/service';
import { TeamSyncService } from './git/teamSync';
import { ProfileManager } from './profile';
import { AuraState, BoardSnapshot, Profile, Project, Session, TaskStatus, TeamActivityEvent, TeamApiKey, TeamSummary } from './types';
import { BoardPanel } from './views/board';
import { AuraTeamPanelProvider } from './webview/panelProvider';

const PANEL_VIEW_TYPE = 'auraTeam.panel';
const PANEL_SCHEME = 'aura-team';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const output = vscode.window.createOutputChannel('Team');
	const api = new AuraApiClient(context, output);
	const gitExtension = vscode.extensions.getExtension('vscode.git');
	await gitExtension?.activate();
	const git = new GitService(output);
	const profiles = new ProfileManager(context);
	const updateSimpleModeContext = async (): Promise<void> => vscode.commands.executeCommand('setContext', 'auraTeam.simpleMode', vscode.workspace.getConfiguration('auraTeam').get<boolean>('simpleMode', true));

	// Фоновый полуавтоматический синк GitHub (автопулл + автопуш по сохранению).
	let teamSync: TeamSyncService | undefined;
	try { teamSync = new TeamSyncService(git, output); context.subscriptions.push(teamSync); } catch { /* git недоступен */ }

	const state: { session?: Session; board?: BoardSnapshot; teamId?: string; keys?: TeamApiKey[]; demo?: boolean; activity?: TeamActivityEvent[]; summary?: TeamSummary } = {};
	const boardPanel = new BoardPanel(api, () => state.teamId, async () => refresh());
	const provider = new AuraTeamPanelProvider(context.extensionUri);

	const demoMode = (): boolean => vscode.workspace.getConfiguration('auraTeam').get<boolean>('demoMode', false);
	// Язык UI Team: 'ru' по умолчанию; 'auto' — язык IDE.
	const uiLanguage = (): string => {
		const setting = vscode.workspace.getConfiguration('auraTeam').get<string>('uiLanguage', 'ru');
		return setting === 'auto' ? vscode.env.language : setting;
	};
	const simpleMode = (): boolean => vscode.workspace.getConfiguration('auraTeam').get<boolean>('simpleMode', true);
	const serverUrl = (): string => vscode.workspace.getConfiguration('auraTeam').get<string>('serverUrl', 'https://auraide.xyz');

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
		activity: state.activity,
		summary: state.summary,
		demoMode: demoMode() && !state.session,
		simpleMode: simpleMode(),
		serverUrl: serverUrl(),
		signedIn: !!state.session,
		ideLanguage: vscode.env.language,
		uiLanguage: uiLanguage()
	});

	const broadcast = async (): Promise<void> => { provider.broadcast(await buildState()); };

	// Уведомления IDE: новые задачи, назначенные на тебя, и свежие события команды.
	let lastNotifiedActivityId: string | undefined;
	const notifyOnChanges = (previousBoard: BoardSnapshot | undefined, previousActivity: TeamActivityEvent[] | undefined): void => {
		const me = state.session?.user.id;
		if (previousBoard && me && state.board) {
			for (const task of state.board.tasks) {
				if (task.assigneeId === me && !previousBoard.tasks.some(prev => prev.id === task.id && prev.assigneeId === me)) {
					const onOther = previousBoard.tasks.some(prev => prev.id === task.id);
					if (onOther || !previousBoard.tasks.some(prev => prev.id === task.id)) {
						// Назначена тебе (ранее была без тебя) или создана сразу на тебя.
						if (previousBoard.tasks.some(prev => prev.id === task.id && prev.assigneeId !== me) || !previousBoard.tasks.some(prev => prev.id === task.id)) {
							void vscode.window.showInformationMessage(vscode.l10n.t('📋 Task assigned to you: {0}', task.title));
						}
					}
				}
			}
		}
		// Новые события в ленте (кроме собственных) — один тост на партию.
		if (previousActivity && state.activity?.length) {
			const fresh = state.activity.filter(ev => !previousActivity.some(prev => prev.createdAt === ev.createdAt && prev.action === ev.action) && ev.userId !== me);
			if (fresh.length) {
				const first = fresh[0];
				void vscode.window.showInformationMessage(vscode.l10n.t('🔔 {0}: {1}', first.userName, first.action));
			}
		}
		lastNotifiedActivityId = state.activity?.[0]?.targetId ?? lastNotifiedActivityId;
	};

	const refresh = async (): Promise<void> => {
		const prevBoard = state.board;
		const prevActivity = state.activity;
		try {
			state.session = await api.getSession();
			state.demo = false;
			state.teamId = state.teamId && state.session.teams.some(team => team.id === state.teamId) ? state.teamId : state.session.teams[0]?.id;
			state.board = state.teamId ? await api.getBoard(state.teamId) : undefined;
			state.keys = state.teamId ? await api.listApiKeys(state.teamId) : undefined;
			state.activity = state.teamId ? await api.getActivity(state.teamId).catch(() => undefined) : undefined;
			state.summary = state.teamId ? await api.getSummary(state.teamId).catch(() => undefined) : undefined;
			if (state.teamId) { api.connect(state.teamId); }
			notifyOnChanges(prevBoard, prevActivity);
		} catch (error) {
			state.session = undefined;
			state.board = undefined;
			state.keys = undefined;
			state.activity = undefined;
			state.summary = undefined;
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
		// Контекст для титулбара/меню: вошёл ли пользователь на сервере.
		await vscode.commands.executeCommand('setContext', 'auraTeam.signedIn', !!state.session && !state.demo);
		updateAvatar();
		await broadcast();
	};

	const openTab = async (view = 'team', filter?: unknown): Promise<void> => {
		const uri = vscode.Uri.from({ scheme: PANEL_SCHEME, authority: 'panel', path: '/Team', query: `view=${view}${filter ? `&filter=${encodeURIComponent(JSON.stringify(filter))}` : ''}` });
		try {
			await vscode.commands.executeCommand('vscode.openWith', uri, PANEL_VIEW_TYPE);
		} catch (error) {
			// Фолбэк: если кастомный редактор недоступен — обычная webview-панель.
			const panel = vscode.window.createWebviewPanel(PANEL_VIEW_TYPE, vscode.l10n.t('Team'), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
			provider.attachFallback(panel, view, filter as Record<string, string> | undefined);
			output.appendLine(`[open] fallback panel: ${errorMessage(error)}`);
		}
		// Если вкладка уже была открыта, HTML не перезагружается — применяем фильтр сообщением.
		if (filter) { provider.applyFilter(filter as Record<string, string>); }
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
		vscode.window.registerWebviewViewProvider('auraTeam.home', new AuraTeamLauncherViewProvider((view, filter) => openTab(view, filter), () => buildState(), (id, args) => handlerFor(id, args)), { webviewOptions: { retainContextWhenHidden: true } }),
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
	// Аватар в статус-баре виден ТОЛЬКО при живой серверной сессии.
	const updateAvatar = (): void => {
		const session = state.session && !state.demo ? state.session : undefined;
		if (!session) { avatar.hide(); return; }
		const name = session.user.displayName || profiles.get().nickname;
		const parts = name.trim().split(/\s+/);
		const initials = ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[1][0] : (parts[0]?.[1] ?? ''))).toUpperCase();
		avatar.text = `$(account) ${initials}`;
		avatar.tooltip = vscode.l10n.t('Team — {0}', name);
		avatar.command = 'auraTeam.statusMenu';
		avatar.show();
	};
	context.subscriptions.push(avatar, vscode.commands.registerCommand('auraTeam.statusMenu', async () => {
		const signedIn = Boolean(state.session);
		const items = signedIn ? [
			{ label: vscode.l10n.t('$(project) Open Team'), id: 'open' },
			{ label: vscode.l10n.t('$(account) Profile'), id: 'profile' },
			{ label: vscode.l10n.t('$(key) Change Password'), id: 'pass' },
			{ label: vscode.l10n.t('$(sign-out) Sign Out'), id: 'out' }
		] : [
			{ label: vscode.l10n.t('$(sign-in) Sign In'), id: 'in' },
			{ label: vscode.l10n.t('$(add) Register'), id: 'reg' }
		];
		const pick = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Team') });
		if (!pick) { return; }
		if (pick.id === 'open') { await openTab('team'); }
		else if (pick.id === 'profile') { await openTab('profile'); }
		else if (pick.id === 'pass') { await vscode.commands.executeCommand('auraTeam.changePassword'); }
		else if (pick.id === 'out') { await api.signOut().catch(() => undefined); await refresh(); }
		else if (pick.id === 'in') { await openTab('team'); }
		else if (pick.id === 'reg') { await openTab('team'); }
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
		if (password.length < 8) { throw new Error(vscode.l10n.t('Password must be at least 8 characters.')); }
		return await api.register(email, password, displayName);
	}, false);
	register('auraTeam.openRegister', async () => { await vscode.env.openExternal(vscode.Uri.parse(`${serverUrl().replace(/\/$/, '')}/register`)); });
	register('auraTeam.openExternal', async (url?: string) => { if (url && /^https?:\/\//.test(url)) { await vscode.env.openExternal(vscode.Uri.parse(url)); } });
	register('auraTeam.signOut', async () => { await api.signOut(); await refresh(); });
	register('auraTeam.changePassword', async (data?: { currentPassword?: string; newPassword?: string }) => {
		const currentPassword = data?.currentPassword ?? await vscode.window.showInputBox({ prompt: vscode.l10n.t('Current password'), password: true, ignoreFocusOut: true });
		const newPassword = data?.newPassword ?? await vscode.window.showInputBox({ prompt: vscode.l10n.t('New password (8+ characters)'), password: true, ignoreFocusOut: true });
		if (!currentPassword || !newPassword) { throw new Error(vscode.l10n.t('Both password fields are required.')); }
		if (newPassword.length < 8) { throw new Error(vscode.l10n.t('Password must be at least 8 characters.')); }
		await api.changePassword(currentPassword, newPassword);
		await refresh();
	}, false);
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
				name: 'Team · OpenAI',
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
	register('auraTeam.updateTask', async (taskId?: string, changes?: { status?: TaskStatus; position?: number; assigneeId?: string | null; title?: string; description?: string; dueAt?: string }) => {
		if (!taskId) { throw new Error(vscode.l10n.t('Task ID is required.')); }
		const updated = await api.updateTask(requireTeam(state), taskId, { status: changes?.status, position: changes?.position, assigneeId: changes?.assigneeId, title: changes?.title, description: changes?.description, dueAt: changes?.dueAt });
		await refresh();
		return updated;
	});
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
	register('auraTeam.uploadArchive', async (projectName?: string) => {
		const uri = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'tar.zst': ['zst', 'tzst'] } }))?.[0];
		if (!uri) { return; }
		const bytes = await vscode.workspace.fs.readFile(uri);
		if (bytes.byteLength > 50 * 1024 * 1024) { throw new Error(vscode.l10n.t('The archive exceeds 50 MiB.')); }
		const name = projectName?.trim() || await requiredInput(vscode.l10n.t('Project name'));
		const fileName = uri.fsPath.split(/[\\/]/).pop() ?? 'project.tar.zst';
		const result = await api.uploadArchive(requireTeam(state), fileName, name, bytes);
		vscode.window.showInformationMessage(vscode.l10n.t('Archive uploaded. It expires at {0}.', new Date(result.expiresAt).toLocaleString()));
		await refresh();
		return result;
	});
	register('auraTeam.downloadArchive', async (project?: Project) => {
		if (!project?.archiveId) { throw new Error(vscode.l10n.t('This project has no archive.')); }
		const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${project.name}.tar.zst`), filters: { 'tar.zst': ['zst'] } });
		if (!destination) { return; }
		await vscode.workspace.fs.writeFile(destination, await api.downloadArchive(requireTeam(state), project.archiveId));
		vscode.window.showInformationMessage(vscode.l10n.t('Archive saved to {0}.', destination.fsPath));
	});
	register('auraTeam.transferProject', async (projectId?: string, ownerMemberId?: string) => {
		const project = projectId ? state.board?.projects.find(p => p.id === projectId) : undefined;
		const target = ownerMemberId ? { id: ownerMemberId, label: ownerMemberId } : undefined;
		const selected = target ?? await vscode.window.showQuickPick(state.board?.members.map(m => ({ label: m.displayName, description: m.email, id: m.id })) ?? [], { placeHolder: vscode.l10n.t('New project owner') });
		if (!project?.id || !selected) { return; }
		await api.transferProject(requireTeam(state), project.id, selected.id);
		vscode.window.showInformationMessage(vscode.l10n.t('Project transferred to {0}.', selected.label));
		await refresh();
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
 * Сайдбар Team (activity bar) — живая навигация:
 *  • не вошёл → карточка «Войдите или создайте аккаунт» с кнопками;
 *  • вошёл → меню: профиль, команды, канбан, проекты, файлы, ключи, приглашение, выход.
 */
class AuraTeamLauncherViewProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private lastState?: unknown;

	constructor(
		private readonly open: (view: string, filter?: unknown) => Promise<void>,
		private readonly getState: () => Promise<unknown>,
		private readonly invoke: (id: string, args: unknown[]) => Promise<unknown>
	) { }

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		const nonce = String(Date.now()) + '-' + Math.floor(Math.random() * 1e9);
		webviewView.webview.html = LAUNCHER_HTML.replace('__NONCE__', nonce);
		webviewView.webview.onDidReceiveMessage(async message => {
			if (message?.type === 'open' && typeof message.view === 'string') { await this.open(message.view, message.filter); }
			else if (message?.type === 'invoke' && typeof message.command === 'string') {
				try { await this.invoke(message.command, Array.isArray(message.args) ? message.args : []); } catch { /* ошибка уже показана хэндлером */ }
				await this.push();
			} else if (message?.type === 'ready') { await this.push(); }
		});
		void this.push();
	}

	/** Протолкнуть свежее состояние в сайдбар (вызывается из broadcast). */
	async push(): Promise<void> {
		this.lastState = await this.getState();
		if (this.view) { void this.view.webview.postMessage({ type: 'state', state: this.lastState }); }
	}
}

const LAUNCHER_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-__NONCE__';">
<style>
	body { padding: 10px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
	.card { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 14px 12px; text-align: center; margin-bottom: 10px; animation: in .25s ease; }
	@keyframes in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
	.title { font-weight: 600; margin-bottom: 4px; }
	.sub { font-size: 12px; opacity: .75; margin-bottom: 12px; line-height: 1.4; }
	button { display: block; width: 100%; box-sizing: border-box; margin: 6px 0 0; padding: 7px 10px; border: none; border-radius: 6px; cursor: pointer;
		background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-size: 13px; transition: filter .15s ease, transform .1s ease; }
	button:hover { filter: brightness(1.12); } button:active { transform: scale(.98); }
	button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	.nav button { text-align: left; background: transparent; color: var(--vscode-foreground); display: flex; gap: 8px; align-items: center; padding: 8px 10px; border-radius: 8px; }
	.nav button:hover { background: var(--vscode-list-hoverBackground); }
	.me { display: flex; gap: 10px; align-items: center; text-align: left; margin-bottom: 10px; }
	.ava { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; flex: none; position: relative; }
	.ava::after { content: ''; position: absolute; right: -1px; bottom: -1px; width: 9px; height: 9px; border-radius: 50%; background: #3fb950; border: 2px solid var(--vscode-sideBar-background); }
	.id { font-size: 11px; opacity: .6; }
	hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 8px 0; }
	.danger { color: var(--vscode-errorForeground) !important; }
	.section { margin: 10px 0 2px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .6; display: flex; justify-content: space-between; align-items: center; }
	.section .count { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 8px; padding: 1px 7px; font-size: 10px; text-transform: none; }
	.section .count.hot { background: #d29922; color: #1f1300; animation: pulse 1.6s ease infinite; }
	@keyframes pulse { 50% { opacity: .55; } }
	.member { display: flex; gap: 8px; align-items: center; padding: 4px 8px; border-radius: 7px; animation: in .25s ease both; }
	.member:hover { background: var(--vscode-list-hoverBackground); cursor: pointer; }
	.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; margin-left: auto; }
	.dot.on { background: #3fb950; box-shadow: 0 0 6px #3fb95088; }
	.dot.off { background: var(--vscode-descriptionForeground); opacity: .4; }
	.m-ava { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 10px; font-weight: 700; flex: none; }
	.m-role { font-size: 10px; opacity: .55; margin-left: 6px; }
	.feed { display: flex; flex-direction: column; gap: 2px; }
	.feed-item { display: flex; gap: 7px; padding: 4px 8px; border-radius: 7px; font-size: 12px; line-height: 1.35; animation: in .25s ease both; align-items: baseline; }
	.feed-item:hover { background: var(--vscode-list-hoverBackground); }
	.feed-item .ico { flex: none; opacity: .8; font-size: 12px; }
	.feed-item .who { font-weight: 600; }
	.feed-item .what { opacity: .85; }
	.feed-item .when { margin-left: auto; flex: none; font-size: 10px; opacity: .45; }
	.taskline { display: flex; gap: 7px; align-items: center; padding: 4px 8px; border-radius: 7px; font-size: 12px; cursor: pointer; animation: in .25s ease both; }
	.taskline:hover { background: var(--vscode-list-hoverBackground); }
	.taskline .st { flex: none; font-size: 10px; padding: 1px 6px; border-radius: 6px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
	.taskline .due { margin-left: auto; font-size: 10px; opacity: .55; }
	.taskline .due.hot { color: #d29922; opacity: 1; font-weight: 600; }
	.projline { display: flex; gap: 7px; align-items: center; padding: 4px 8px; border-radius: 7px; font-size: 12px; cursor: pointer; animation: in .25s ease both; }
	.projline:hover { background: var(--vscode-list-hoverBackground); }
	.projline .br { margin-left: auto; font-size: 10px; opacity: .55; font-family: var(--vscode-editor-font-family); }
</style></head><body><div id="root"></div>
<script nonce="__NONCE__">
	const vscode = acquireVsCodeApi();
	let state;
	function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
	function initials(n) { const p = (n || '').trim().split(/\s+/).filter(Boolean); return ((p[0]?.[0] ?? '?') + (p.length > 1 ? p[1][0] : (p[0]?.[1] ?? ''))).toUpperCase(); }
	function timeAgo(iso) {
		if (!iso) { return ''; }
		const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
		if (s < 60) { return 'только что'; }
		if (s < 3600) { return Math.floor(s / 60) + ' мин'; }
		if (s < 86400) { return Math.floor(s / 3600) + ' ч'; }
		return Math.floor(s / 86400) + ' д';
	}
	function colorFor(id) {
		const colors = ['#6366f1', '#8b5cf6', '#d946ef', '#ec4899', '#f43f5e', '#f97316', '#f59e0b', '#10b981', '#14b8a6', '#0ea5e9', '#3b82f6'];
		let h = 0; for (const c of String(id ?? '')) { h = (h * 31 + c.charCodeAt(0)) >>> 0; }
		return colors[h % colors.length];
	}
	function describe(ev, ru) {
		const map = {
			'team.create': ru ? 'создал команду' : 'created team',
			'invite.create': ru ? 'создал код приглашения' : 'created an invite',
			'invite.accept': ru ? 'вступил в команду' : 'joined the team',
			'task.create': ru ? 'добавил задачу' : 'added task',
			'task.update': ru ? 'обновил задачу' : 'updated task',
			'task.commit_link': ru ? 'закоммитил в задачу' : 'committed to task',
			'member.role': ru ? 'сменил роль' : 'changed role',
			'key.create': ru ? 'добавил API-ключ' : 'added an API key',
			'key.disable': ru ? 'отключил API-ключ' : 'disabled an API key',
			'project.create': ru ? 'создал проект' : 'created project',
			'project.transfer': ru ? 'передал проект' : 'transferred project',
			'archive.upload': ru ? 'загрузил архив проекта' : 'uploaded a project archive'
		};
		return map[ev.action] ?? ev.action;
	}
	function render() {
		const root = document.getElementById('root');
		const ru = (state?.uiLanguage ?? 'ru') !== 'en';
		if (!state?.signedIn) {
			root.innerHTML = '<div class="card"><div class="title">' + (ru ? 'Командная работа' : 'Team work') + '</div><div class="sub">' +
				(ru ? 'Войдите или создайте аккаунт, чтобы работать с командой: проекты, канбан, задачи и общие ключи.' : 'Sign in or create an account to work with your team: projects, kanban, tasks and shared keys.') + '</div>' +
				'<button data-view="login">' + (ru ? 'Войти' : 'Sign in') + '</button><button class="secondary" data-view="register">' + (ru ? 'Создать аккаунт' : 'Create account') + '</button></div>' +
				'<div class="sub">' + esc(state?.serverUrl ?? '') + '</div>';
		} else {
			const u = state.session?.user ?? {};
			const summary = state.summary;
			const onlineCount = (summary?.members ?? []).filter(m => m.online).length;
			const soon = Date.now() + 48 * 3600 * 1000;
			const hotTasks = (summary?.myTasks ?? []).filter(t => t.dueAt && new Date(t.dueAt).getTime() < soon).length;
			const teamName = (state.session?.teams ?? []).find(t => t.id === state.teamId)?.name ?? '';
			const nav = [
				['board', '$(checklist)', ru ? 'Канбан и задачи' : 'Kanban & tasks'],
				['git', '$(git-branch)', ru ? 'Проекты и Git' : 'Projects & Git'],
				['files', '$(archive)', ru ? 'Файлы' : 'Files'],
				['keys', '$(key)', ru ? 'Ключи команды' : 'Team keys'],
				['profile', '$(account)', ru ? 'Профиль' : 'Profile']
			];
			let html = '<div class="me"><div class="ava" style="background:' + colorFor(u.id) + '">' + esc(initials(u.displayName)) + '</div><div><div>' + esc(u.displayName ?? '') + '</div><div class="id">' + esc(teamName || u.email || '') + '</div></div></div>';
			// Мои задачи
			const myTasks = summary?.myTasks ?? [];
			html += '<div class="section"><span>' + (ru ? 'Мои задачи' : 'My tasks') + '</span>' + (myTasks.length ? '<span class="count' + (hotTasks ? ' hot' : '') + '">' + myTasks.length + '</span>' : '') + '</div>';
			html += myTasks.length
				? myTasks.slice(0, 4).map(t => {
					const hot = t.dueAt && new Date(t.dueAt).getTime() < soon;
					return '<div class="taskline" data-view="board" data-task="' + esc(t.id) + '"><span class="st">' + esc(t.status) + '</span><span>' + esc(t.title) + '</span>' + (t.dueAt ? '<span class="due' + (hot ? ' hot' : '') + '">' + (hot ? '⏰ ' : '') + timeAgo(t.dueAt) + '</span>' : '') + '</div>';
				}).join('')
				: '<div class="feed-item"><span class="ico">✓</span><span class="what">' + (ru ? 'Незакрытых задач нет' : 'No open tasks') + '</span></div>';
			// Участники
			const members = summary?.members ?? [];
			html += '<div class="section"><span>' + (ru ? 'Команда' : 'Team') + '</span><span class="count">' + onlineCount + '/' + members.length + '</span></div>';
			html += members.slice(0, 8).map(m => '<div class="member" data-view="board" data-member="' + esc(m.id) + '"><div class="m-ava" style="background:' + colorFor(m.id) + '">' + esc(initials(m.displayName)) + '</div><span>' + esc(m.displayName) + '</span><span class="m-role">' + esc(m.role) + '</span><div class="dot ' + (m.online ? 'on' : 'off') + '"></div></div>').join('');
			// Лента событий
			const feed = state.activity ?? [];
			html += '<div class="section"><span>' + (ru ? 'События' : 'Activity') + '</span></div><div class="feed">';
			html += feed.length
				? feed.slice(0, 6).map(ev => '<div class="feed-item"><span class="ico">' + (ev.action.includes('commit') ? '⎇' : ev.action.includes('task') ? '☑' : ev.action.includes('invite') ? '✉' : '•') + '</span><span><span class="who">' + esc(ev.userName) + '</span> <span class="what">' + esc(describe(ev, ru)) + (ev.taskTitle ? ' «' + esc(ev.taskTitle) + '»' : '') + '</span></span><span class="when">' + timeAgo(ev.createdAt) + '</span></div>').join('')
				: '<div class="feed-item"><span class="what">' + (ru ? 'Пока тихо' : 'Nothing yet') + '</span></div>';
			html += '</div>';
			// Проекты
			const projects = summary?.projects ?? [];
			if (projects.length) {
				html += '<div class="section"><span>' + (ru ? 'Проекты' : 'Projects') + '</span><span class="count">' + projects.length + '</span></div>';
				html += projects.slice(0, 5).map(p => '<div class="projline" data-view="git"><span>⎇</span><span>' + esc(p.name) + '</span><span class="br">' + esc(p.defaultBranch) + '</span></div>').join('');
			}
			html += '<hr><div class="nav">' + nav.map(n => '<button data-view="' + n[0] + '"><span>' + n[1] + '</span>' + n[2] + '</button>').join('') +
				'<button id="invite"><span>$(add)</span>' + (ru ? 'Пригласить в команду' : 'Invite to team') + '</button></div>' +
				'<div class="nav"><button id="logout" class="danger"><span>$(sign-out)</span>' + (ru ? 'Выйти' : 'Sign out') + '</button></div>';
			root.innerHTML = html;
			document.getElementById('invite').onclick = () => vscode.postMessage({ type: 'invoke', command: 'auraTeam.createInvite', args: [] });
			document.getElementById('logout').onclick = () => vscode.postMessage({ type: 'invoke', command: 'auraTeam.signOut', args: [] });
		}
		for (const b of root.querySelectorAll('button[data-view]')) { b.onclick = () => vscode.postMessage({ type: 'open', view: b.dataset.view }); }
		for (const el of root.querySelectorAll('[data-view].member, [data-view].taskline, [data-view].projline')) { el.onclick = () => vscode.postMessage({ type: 'open', view: el.dataset.view, filter: el.dataset.member ? { member: el.dataset.member } : el.dataset.task ? { task: el.dataset.task } : undefined }); }
	}
	window.addEventListener('message', e => { if (e.data?.type === 'state') { state = e.data.state; render(); } });
	vscode.postMessage({ type: 'ready' });
</script></body></html>`;

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
