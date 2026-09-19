/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { AuraApiClient } from './api/client';
import { connectGitHub, createGithubRepo, disconnectGitHub, hasGitHubToken, listGithubRepos, pickAndCloneGithubRepo } from './auth/github';
import { GitService } from './git/service';
import { TeamSyncService } from './git/teamSync';
import { ProfileManager } from './profile';
import { AuraState, BoardSnapshot, KeyGroup, Profile, Project, Session, TaskStatus, TeamActivityEvent, TeamApiKey, TeamSummary } from './types';
import { AuraTeamPanelProvider } from './webview/panelProvider';

const PANEL_VIEW_TYPE = 'auraTeam.panel';
const PANEL_SCHEME = 'aura-team';

/**
 * Автозапуск локального Team-сервера: если настройка указывает на localhost и
 * сервер ещё не отвечает — поднимаем его скриптом start-local.mjs (секрет
 * генерируется один раз и хранится в aura-team-server/data/.jwt-secret).
 */
async function autoStartLocalServer(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
	const configured = vscode.workspace.getConfiguration('auraTeam').get<string>('serverUrl', 'https://auraide.xyz');
	if (!vscode.workspace.getConfiguration('auraTeam').get<boolean>('autoStartServer', true)) { return; }
	let url: URL;
	try { url = new URL(configured); } catch { return; }
	if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) { return; }
	const probe = async (): Promise<boolean> => fetch(`${url.origin}/health`, { signal: AbortSignal.timeout(1500) }).then(r => r.ok).catch(() => false);
	if (await probe()) { return; }
	// Ищем aura-team-server/scripts/start-local.mjs вверх по дереву каталогов
	// (в репозитории — <root>/aura-team-server рядом с <root>/extensions).
	let dir = context.extensionPath;
	let serverRoot: string | undefined;
	for (let i = 0; i < 6 && dir; i++) {
		const candidate = join(dir, 'aura-team-server');
		if (existsSync(join(candidate, 'scripts', 'start-local.mjs'))) { serverRoot = candidate; break; }
		const parent = dirname(dir);
		if (parent === dir) { break; }
		dir = parent;
	}
	if (!serverRoot) { output.appendLine('[server] autostart skipped: aura-team-server not found near extension'); return; }
	const script = join(serverRoot, 'scripts', 'start-local.mjs');
	if (!existsSync(script)) { output.appendLine(`[server] autostart skipped: ${script} not found`); return; }
	output.appendLine(`[server] not responding on ${url.origin}, starting local server...`);
	const child = spawn(process.execPath, [script], { cwd: serverRoot, stdio: 'ignore', detached: true });
	child.unref();
	// Ждём до 10 секунд, пока сервер начнёт отвечать.
	for (let i = 0; i < 20; i++) {
		await new Promise(resolve => setTimeout(resolve, 500));
		if (await probe()) { output.appendLine(`[server] local server is up at ${url.origin}`); return; }
	}
	output.appendLine('[server] local server did not start within 10s');
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const output = vscode.window.createOutputChannel('Team');
	// Локальный сервер поднимаем до первого запроса API (не блокируя активацию дольше 10с).
	void autoStartLocalServer(context, output);
	const api = new AuraApiClient(context, output);
	const gitExtension = vscode.extensions.getExtension('vscode.git');
	await gitExtension?.activate();
	// Учётные данные для git push/pull/clone на github.com — из сохранённого токена.
	// GitService/getVSCodeGit может упасть (git-расширение недоступно) — не роняем весь activate.
	let git: GitService | undefined;
	try { git = new GitService(output); } catch (error) { output.appendLine(`[git] unavailable: ${errorMessage(error)}`); }
	if (git) { context.subscriptions.push(git.registerGitHubCredentials(context)); }
	const profiles = new ProfileManager(context);
	const updateSimpleModeContext = async (): Promise<void> => vscode.commands.executeCommand('setContext', 'auraTeam.simpleMode', vscode.workspace.getConfiguration('auraTeam').get<boolean>('simpleMode', true));

	// Фоновый полуавтоматический синк GitHub (автопулл + автопуш по сохранению).
	let teamSync: TeamSyncService | undefined;
	if (git) { try { teamSync = new TeamSyncService(git, output); context.subscriptions.push(teamSync); } catch { /* git недоступен */ } }

	const gitSvc = (): GitService => { if (!git) { throw new Error(vscode.l10n.t('Git extension is unavailable.')); } return git; };

	const state: { session?: Session; board?: BoardSnapshot; teamId?: string; keys?: TeamApiKey[]; keyGroups?: KeyGroup[]; demo?: boolean; activity?: TeamActivityEvent[]; summary?: TeamSummary } = {};
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
			{ id: 'dt5', teamId: 'demo', title: 'Передача файлов', description: 'Позже, через сервер', status: 'todo', position: 0 }
		]
	});

	const demoKeys = (): TeamApiKey[] => ([
		{ id: 'k1', label: 'OpenAI team key', keyHint: 'sk-…k3Nd', provider: 'openai', accessRole: 'dev', priority: 100, createdAt: new Date(Date.now() - 3 * 864e5).toISOString() },
		{ id: 'k2', label: 'Anthropic team key', keyHint: 'sk-ant-…Q9m', provider: 'anthropic', accessRole: 'maintainer', priority: 200, createdAt: new Date(Date.now() - 1 * 864e5).toISOString() }
	]);

	// Кэш git-снапшота: buildState() вызывается часто (каждый broadcast), а git log — дорогой.
	let gitCache: { at: number; value: Awaited<ReturnType<GitService['getSnapshot']>> } | undefined;
	const buildState = async (): Promise<AuraState> => ({
		profile: profiles.get(),
		session: state.session,
		teamId: state.teamId,
		board: state.board,
		keys: state.keys,
		git: git ? ((gitCache && Date.now() - gitCache.at < 2000) ? gitCache.value : await gitSvc().getSnapshot().then(value => { gitCache = { at: Date.now(), value }; return value; }).catch(() => undefined)) : undefined,
		activity: state.activity,
		dismissedActivity: dismissedActivity(),
		summary: state.summary,
		demoMode: demoMode() && !state.session,
		simpleMode: simpleMode(),
		serverUrl: serverUrl(),
		signedIn: !!state.session,
		githubConnected: await hasGitHubToken(context),
		ideLanguage: vscode.env.language,
		uiLanguage: uiLanguage()
	});

	const launcher = new AuraTeamLauncherViewProvider((view, filter) => openTab(view, filter), () => buildState(), (id, args) => handlerFor(id, args));
	const broadcast = async (): Promise<void> => { const s = await buildState(); provider.broadcast(s); await launcher.push(); };

	// Скрытые события ленты: локальный globalState, максимум 500 id, чистим несуществующие.
	const DISMISSED_KEY = 'auraTeam.dismissedActivity';
	const dismissedActivity = (): string[] => context.globalState.get<string[]>(DISMISSED_KEY, []);
	const evKey = (ev: { createdAt: string; action: string; userId: string }): string => `${ev.createdAt}|${ev.action}|${ev.userId}`;
	const pruneDismissedActivity = (): void => {
		const ids = dismissedActivity();
		if (!ids.length) { return; }
		const alive = new Set((state.activity ?? []).map(evKey));
		const next = ids.filter(id => alive.has(id)).slice(-500);
		if (next.length !== ids.length) { void context.globalState.update(DISMISSED_KEY, next); }
	};
	register('auraTeam.dismissActivity', async (key?: string) => {
		const ids = dismissedActivity();
		if (key && !ids.includes(key)) { await context.globalState.update(DISMISSED_KEY, [...ids.slice(-499), key]); }
		await refresh();
	});
	register('auraTeam.undismissAllActivity', async () => {
		await context.globalState.update(DISMISSED_KEY, []);
		await refresh();
	});

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

	// Защита от параллельных refresh: частые переключения вкладок вызывали гонки
	// (несколько одновременных getBoard/getSummary/git snapshot) и «зависание» IDE.
	let refreshing: Promise<void> | undefined;
	const refresh = async (): Promise<void> => {
		if (refreshing) { return refreshing; }
		refreshing = doRefresh().finally(() => { refreshing = undefined; });
		return refreshing;
	};
	const doRefresh = async (): Promise<void> => {
		const prevBoard = state.board;
		const prevActivity = state.activity;
		try {
			state.session = await api.getSession();
			state.demo = false;
			state.teamId = state.teamId && state.session.teams.some(team => team.id === state.teamId) ? state.teamId : state.session.teams[0]?.id;
			state.board = state.teamId ? await api.getBoard(state.teamId) : undefined;
			state.keys = state.teamId ? await api.listApiKeys(state.teamId) : undefined;
			state.keyGroups = state.teamId ? await api.listKeyGroups(state.teamId).catch(() => undefined) : undefined;
			state.activity = state.teamId ? await api.getActivity(state.teamId).catch(() => undefined) : undefined;
			pruneDismissedActivity();
			state.summary = state.teamId ? await api.getSummary(state.teamId).catch(() => undefined) : undefined;
			if (state.teamId) { api.connect(state.teamId); }
			notifyOnChanges(prevBoard, prevActivity);
		} catch (error) {
			state.session = undefined;
			state.board = undefined;
			state.keys = undefined;
			state.keyGroups = undefined;
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
		// Переиспользование: если вкладка Team уже открыта — не создаём копию,
		// а переключаем существующий webview на нужный раздел сообщением.
		const typedFilter = filter as Record<string, string> | undefined;
		if (view !== 'team' && provider.navigate(view, typedFilter)) { return; }
		// Фильтр канбана для уже открытой вкладки тоже применяется сообщением.
		if (view === 'team' && filter && provider.panelsOpen()) {
			provider.applyFilter(typedFilter);
			return;
		}
		// Фиксированный URI без query: разные query создают разные документы-клоны,
		// поэтому «Team» открывается всегда одним документом aura-team://panel/Team.
		const uri = vscode.Uri.from({ scheme: PANEL_SCHEME, authority: 'panel', path: '/Team' });
		try {
			if (view !== 'team') { provider.queueNavigate(view, typedFilter); }
			await vscode.commands.executeCommand('vscode.openWith', uri, PANEL_VIEW_TYPE);
		} catch (error) {
			// Фолбэк: если кастомный редактор недоступен — обычная webview-панель.
			const panel = vscode.window.createWebviewPanel(PANEL_VIEW_TYPE, vscode.l10n.t('Team'), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
			provider.attachFallback(panel, view, typedFilter);
			output.appendLine(`[open] fallback panel: ${errorMessage(error)}`);
		}
		if (filter) { provider.applyFilter(typedFilter); }
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
		vscode.window.registerWebviewViewProvider('auraTeam.home', launcher, { webviewOptions: { retainContextWhenHidden: true } }),
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
		else if (pick.id === 'in') { await openTab('login'); }
		else if (pick.id === 'reg') { await openTab('register'); }
	}));
	updateAvatar();

	// ------------------------------------------------------------------
	// Команды (хэндлеры)
	// ------------------------------------------------------------------
	register('auraTeam.signIn', () => openTab('login'));
	register('auraTeam.signUp', () => openTab('register'));
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
	register('auraTeam.connectGitHub', async () => { await connectGitHub(context); vscode.window.showInformationMessage(vscode.l10n.t('GitHub is connected.')); await refresh(); });
	register('auraTeam.disconnectGitHub', async () => {
		if (!await confirm(vscode.l10n.t('Forget the saved GitHub token? Push/pull to private repos will stop working.'))) { return; }
		await disconnectGitHub(context);
		vscode.window.showInformationMessage(vscode.l10n.t('GitHub disconnected.'));
		await refresh();
	}, false);
	register('auraTeam.listGithubRepos', async () => {
		const repos = await listGithubRepos(context);
		return repos.map(r => ({ fullName: r.full_name, private: r.private, defaultBranch: r.default_branch, url: r.html_url, updatedAt: r.updated_at }));
	});
	register('auraTeam.cloneGithubRepo', async () => { await pickAndCloneGithubRepo(context, (url) => gitSvc().getProject(url)); });
	register('auraTeam.createGithubRepo', async () => {
		if (!await hasGitHubToken(context)) { throw new Error(vscode.l10n.t('Connect GitHub first — paste a token with the "repo" scope.')); }
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) { throw new Error(vscode.l10n.t('Open a folder to publish first.')); }
		const defaultName = folder.name.replace(/[^\w.\-]/g, '-') || 'project';
		const name = (await vscode.window.showInputBox({ prompt: vscode.l10n.t('Repository name'), value: defaultName, ignoreFocusOut: true }))?.trim();
		if (!name) { return; }
		if (!/^[\w.\-]{1,100}$/.test(name)) { throw new Error(vscode.l10n.t('Repository name: only letters, digits, dot, dash, underscore.')); }
		const visibility = await vscode.window.showQuickPick([
			{ label: vscode.l10n.t('Private'), value: true, description: vscode.l10n.t('Only you and collaborators') },
			{ label: 'Public', value: false, description: 'github.com' }
		], { placeHolder: vscode.l10n.t('Repository visibility') });
		if (!visibility) { return; }
		const url = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Creating repository…') },
			() => createGithubRepo(context, name, visibility.value)
		);
		const firstCommit = await vscode.window.showInputBox({ prompt: vscode.l10n.t('First commit message'), value: 'Initial commit', ignoreFocusOut: true });
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Publishing to GitHub…') },
			() => gitSvc().initAndPublish(url, firstCommit?.trim() || 'Initial commit')
		);
		vscode.window.showInformationMessage(vscode.l10n.t('Published to {0} ✓', url));
		await refresh();
	});
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
	register('auraTeam.currentInvite', async () => {
		const invite = await api.getCurrentInvite(requireTeam(state));
		return invite;
	});
	register('auraTeam.revokeInvite', async () => {
		await api.revokeInvite(requireTeam(state));
		vscode.window.showInformationMessage(vscode.l10n.t('Old invite code revoked.'));
		return { ok: true };
	});
	register('auraTeam.directory', async (q?: string) => {
		return api.directory(requireTeam(state), q ?? '');
	});
	register('auraTeam.reorderTasks', async (status: TaskStatus, orderedIds: string[]) => {
		await api.reorderTasks(requireTeam(state), status, orderedIds);
		await refresh();
	});
	register('auraTeam.deleteTask', async (taskId?: string) => {
		await api.deleteTask(requireTeam(state), String(taskId));
		await refresh();
		return { ok: true };
	});
	register('auraTeam.restoreTask', async (taskId?: string) => {
		await api.restoreTask(requireTeam(state), String(taskId));
		await refresh();
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
	register('auraTeam.storeApiKey', async (key?: { provider?: string; accessRole?: string; label?: string; priority?: string; value?: string; groupId?: string }) => {
		const provider = key?.provider ?? await vscode.window.showQuickPick(['openai', 'anthropic'], { placeHolder: vscode.l10n.t('Provider') });
		const accessRole = key?.accessRole ?? await vscode.window.showQuickPick(['owner', 'maintainer', 'dev', 'viewer'], { placeHolder: vscode.l10n.t('Minimum role allowed to use this key') });
		if (!provider || !accessRole) { return; }
		const label = key?.label ?? await requiredInput(vscode.l10n.t('Key name'), `${provider} team key`);
		const priorityText = key?.priority ?? await requiredInput(vscode.l10n.t('Priority (0 is highest)'), '100');
		const priority = Number(priorityText);
		if (!Number.isInteger(priority) || priority < 0 || priority > 1000) { throw new Error(vscode.l10n.t('Priority must be an integer from 0 to 1000.')); }
		const value = key?.value ?? await vscode.window.showInputBox({ prompt: vscode.l10n.t('API key'), password: true, ignoreFocusOut: true });
		if (!value) { return; }
		await api.storeApiKey(requireTeam(state), provider, value, accessRole, label, priority, key?.groupId);
		vscode.window.showInformationMessage(vscode.l10n.t('The API key is encrypted on the server.'));
		await refresh();
	});
	register('auraTeam.createKeyGroup', async (input?: { name?: string; priority?: number }) => {
		const name = input?.name ?? await requiredInput(vscode.l10n.t('Group name'));
		const priority = input?.priority ?? 1;
		await api.createKeyGroup(requireTeam(state), name, priority);
		await refresh();
	}, false);
	register('auraTeam.pingKey', async (keyId?: string) => {
		if (!keyId) { return; }
		const result = await api.pingKey(requireTeam(state), keyId);
		await refresh();
		return result;
	}, false);
	// Импорт ключей из встроенного плагина Aura API: ключи копируются в банк команды.
	register('auraTeam.importFromAuraApi', async (input?: { keys?: Array<{ id: string; label?: string; priority?: string; groupId?: string }> }) => {
		const selected = input?.keys ?? [];
		if (!selected.length) { return { imported: 0 }; }
		const teamId = requireTeam(state);
		let imported = 0;
		for (const item of selected) {
			try {
				const provider = await vscode.commands.executeCommand('auraApi.exportKey', item.id);
				if (!provider || typeof provider !== 'object') { continue; }
				const exportInfo = provider as { value?: string; provider?: string; baseUrl?: string; model?: string };
				if (!exportInfo.value) { continue; }
				const mapped = exportInfo.provider === 'anthropic' ? 'anthropic' : 'openai';
				await api.storeApiKey(teamId, mapped, exportInfo.value, 'dev', item.label || exportInfo.model || 'Imported key', item.priority ? Number(item.priority) || 100 : 100, item.groupId);
				imported++;
			} catch { /* ключ недоступен — пропускаем */ }
		}
		await refresh();
		return { imported };
	}, false);
	// Список ключей плагина Aura API для импорта в банк команды.
	register('auraTeam.listAuraApiKeys', async () => {
		try {
			const result = await vscode.commands.executeCommand('auraApi.exportKeysList');
			return Array.isArray(result) ? result : [];
		} catch { return []; }
	}, false);
	// Аватар: сохранение dataURL (JPEG, до ~200 КБ после сжатия на стороне webview).
	register('auraTeam.setAvatar', async (dataUrl?: string) => {
		if (!dataUrl || !dataUrl.startsWith('data:image/')) { throw new Error(vscode.l10n.t('Invalid image.')); }
		if (dataUrl.length > 280_000) { throw new Error(vscode.l10n.t('Image is too large (max ~200 KB).')); }
		await profiles.save({ avatar: dataUrl } as never);
		updateAvatar();
		await broadcast();
		return profiles.get();
	}, false);
	register('auraTeam.disableApiKey', async (key?: TeamApiKey) => {
		if (!key) { return; }
		if (!await confirm(vscode.l10n.t('Disable {0}? Existing clients will immediately stop using it.', key.label))) { return; }
		await api.disableApiKey(requireTeam(state), key.id);
		vscode.window.showInformationMessage(vscode.l10n.t('The team API key was disabled.'));
		await refresh();
	});
	register('auraTeam.deleteApiKey', async (key?: TeamApiKey) => {
		if (!key) { return; }
		if (!await confirm(vscode.l10n.t('Delete {0} permanently? This cannot be undone.', key.label))) { return; }
		await api.deleteApiKey(requireTeam(state), key.id);
		vscode.window.showInformationMessage(vscode.l10n.t('The team API key was deleted.'));
		await refresh();
	});
	register('auraTeam.updateApiKey', async (keyId?: string, changes?: { label?: string; accessRole?: string; priority?: number; groupId?: string | null }) => {
		if (!keyId || !changes) { return; }
		await api.updateApiKey(requireTeam(state), String(keyId), changes);
		await refresh();
	});
	register('auraTeam.uploadArchive', async (projectName?: string) => {
		const uri = (await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: vscode.l10n.t('Upload archive') }))?.[0];
		if (!uri) { return; }
		const bytes = await vscode.workspace.fs.readFile(uri);
		if (bytes.byteLength > 50 * 1024 * 1024) { throw new Error(vscode.l10n.t('The archive exceeds 50 MiB.')); }
		const fileName = uri.fsPath.split(/[\\/]/).pop() ?? 'project';
		// Без явного имени проекта берём имя файла без расширения — модалка не нужна.
		const name = projectName?.trim() || fileName.replace(/\.[^.]+$/, '') || 'project';
		const result = await api.uploadArchive(requireTeam(state), fileName, name, bytes);
		vscode.window.showInformationMessage(vscode.l10n.t('Archive uploaded. It expires at {0}.', new Date(result.expiresAt).toLocaleString()));
		await refresh();
		return result;
	});
	register('auraTeam.downloadArchive', async (project?: Project) => {
		if (!project?.archiveId) { throw new Error(vscode.l10n.t('This project has no archive.')); }
		const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(project.name), filters: { 'All files': ['*'] } });
		if (!destination) { return; }
		await vscode.workspace.fs.writeFile(destination, await api.downloadArchive(requireTeam(state), project.archiveId));
		vscode.window.showInformationMessage(vscode.l10n.t('Archive saved to {0}.', destination.fsPath));
	});
	register('auraTeam.downloadArchiveById', async (archive?: { id: string; projectName?: string }) => {
		if (!archive?.id) { throw new Error(vscode.l10n.t('This project has no archive.')); }
		const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(archive.projectName || 'archive'), filters: { 'All files': ['*'] } });
		if (!destination) { return; }
		await vscode.workspace.fs.writeFile(destination, await api.downloadArchive(requireTeam(state), archive.id));
		vscode.window.showInformationMessage(vscode.l10n.t('Archive saved to {0}.', destination.fsPath));
	});
	register('auraTeam.listArchives', async () => {
		return api.listArchives(requireTeam(state));
	});
	register('auraTeam.deleteArchive', async (archiveId?: string) => {
		await api.deleteArchive(requireTeam(state), String(archiveId));
		await refresh();
		return { ok: true };
	});
	register('auraTeam.uploadArchiveTo', async (projectId?: string) => {
		// Загрузка новой версии в существующий проект.
		const project = state.board?.projects.find(p => p.id === projectId);
		if (!project) { throw new Error(vscode.l10n.t('Project not found.')); }
		const uri = (await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: vscode.l10n.t('Upload archive') }))?.[0];
		if (!uri) { return; }
		const bytes = await vscode.workspace.fs.readFile(uri);
		if (bytes.byteLength > 50 * 1024 * 1024) { throw new Error(vscode.l10n.t('The archive exceeds 50 MiB.')); }
		const fileName = uri.fsPath.split(/[\\/]/).pop() ?? 'project';
		const result = await api.uploadArchive(requireTeam(state), fileName, project.name, bytes, project.id);
		vscode.window.showInformationMessage(vscode.l10n.t('Archive uploaded. It expires at {0}.', new Date(result.expiresAt).toLocaleString()));
		await refresh();
		return result;
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
	register('auraTeam.openBoard', async () => { /* канбан живёт во вкладке Team (route 'board'); отдельная панель удалена (Этап 8) */ });
	register('auraTeam.getProject', async (project?: Project) => gitSvc().getProject(project?.gitUrl ?? await requiredInput(vscode.l10n.t('Git repository URL'))));
	register('auraTeam.saveWork', async (message?: string) => {
		const commit = await gitSvc().saveWork(message ?? await requiredInput(vscode.l10n.t('Commit message'), 'task #TASK_ID: describe the completed work'));
		if (state.teamId && commit.remoteUrl) { await api.reportCommit(state.teamId, commit.hash, commit.remoteUrl, commit.message); }
		return commit;
	});
	register('auraTeam.updateProject', () => gitSvc().update());
	register('auraTeam.undoChanges', async (confirmed?: boolean) => { if (confirmed || await confirm(vscode.l10n.t('Discard all uncommitted changes?'))) { await gitSvc().undoUncommitted(); await broadcast(); } });
	register('auraTeam.revertLastCommit', async (confirmed?: boolean) => { if (confirmed || await confirm(vscode.l10n.t('Create a new commit that reverses the last commit?'))) { await gitSvc().revertLastCommit(); await broadcast(); } });
	register('auraTeam.restoreFile', async () => { const uri = await pickFile(); if (uri) { await gitSvc().restoreFile(uri, await requiredInput(vscode.l10n.t('Commit hash or tag'))); } });
	register('auraTeam.relink', async (url?: string) => gitSvc().relink(url ?? await requiredInput(vscode.l10n.t('New origin URL'))));
	register('auraTeam.history', () => gitSvc().showHistory());

	// Новые команды для git-панели вкладки
	register('auraTeam.commitAll', async (message: string) => {
		// Коммит выполняется всегда; пуш — отдельным шагом, чтобы ошибка отправки
		// не теряла коммит и попадала в тост, а не в молчаливое исключение.
		const repository = gitSvc().repository;
		const commit = await gitSvc().commitOnly(message, repository);
		if (state.teamId && commit.remoteUrl) { await api.reportCommit(state.teamId, commit.hash, commit.remoteUrl, commit.message); }
		let pushed = false;
		let pushError: string | undefined;
		if (commit.remoteUrl && repository) {
			try { await gitSvc().push(); pushed = true; } catch (error) {
				pushError = errorMessage(error);
				vscode.window.showWarningMessage(vscode.l10n.t('Committed locally, but push failed: {0}', pushError));
			}
		}
		await broadcast();
		return { ...commit, pushed, pushError };
	});
	register('auraTeam.push', async () => { await gitSvc().push(); await broadcast(); });
	register('auraTeam.pull', async () => { await gitSvc().update(); await broadcast(); });
	register('auraTeam.checkout', async (branch: string) => { await gitSvc().checkout(branch); await broadcast(); });
	register('auraTeam.listBranches', () => gitSvc().listBranches());
	register('auraTeam.branchInfo', () => gitSvc().branchInfo());
	register('auraTeam.createBranch', async (name?: string) => {
		const branchName = name ?? await requiredInput(vscode.l10n.t('New branch name'));
		await gitSvc().createBranch(branchName);
		await broadcast();
	});
	register('auraTeam.deleteBranch', async (name?: string) => {
		const branchName = name ?? await requiredInput(vscode.l10n.t('Branch to delete'));
		if (branchName === gitSvc().repository?.state.HEAD?.name) { throw new Error(vscode.l10n.t('Cannot delete the current branch.')); }
		await gitSvc().deleteBranch(branchName);
		await broadcast();
	});
	register('auraTeam.taskCommits', async (taskId?: string) => {
		return api.taskCommits(requireTeam(state), String(taskId));
	});
	register('auraTeam.taskHistory', async (taskId?: string) => {
		return api.taskHistory(requireTeam(state), String(taskId));
	});
	register('auraTeam.showDiff', async (filePath?: string) => {
		if (filePath) { await gitSvc().showDiff(String(filePath)); }
	});
	register('auraTeam.commitSelected', async (message?: string, selectedPaths?: string[]) => {
		const paths = Array.isArray(selectedPaths) ? selectedPaths : [];
		const commit = await gitSvc().commitSelected(message ?? await requiredInput(vscode.l10n.t('Commit message')), paths);
		if (state.teamId && commit.remoteUrl) { await api.reportCommit(state.teamId, commit.hash, commit.remoteUrl, commit.message); }
		let pushed = false;
		let pushError: string | undefined;
		try { await gitSvc().push(); pushed = true; } catch (error) { pushError = errorMessage(error); }
		await broadcast();
		return { ...commit, pushed, pushError };
	});

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
		// NB: replace() меняет только первое вхождение — nonce остался бы в CSP,
		// а <script nonce="__NONCE__"> был бы заблокирован CSP (пустой сайдбар).
		webviewView.webview.html = LAUNCHER_HTML.split('__NONCE__').join(nonce);
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
	.nav button { text-align: left; background: transparent; color: var(--vscode-foreground); display: flex; gap: 9px; align-items: center; padding: 7px 10px; border-radius: 8px; font-size: 12.5px; line-height: 1; }
	.nav .n-ico { width: 16px; height: 16px; display: grid; place-items: center; flex: none; opacity: .8; }
	.nav .n-ico svg { width: 16px; height: 16px; }
	.nav button:hover { background: var(--vscode-list-hoverBackground); }
	.me { display: flex; gap: 10px; align-items: center; text-align: left; margin-bottom: 10px; }
	.ava { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; flex: none; position: relative; }
	.ava::after { content: ''; position: absolute; right: -1px; bottom: -1px; width: 9px; height: 9px; border-radius: 50%; background: #3fb950; border: 2px solid var(--vscode-sideBar-background); }
	.id { font-size: 11px; opacity: .6; }
	hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 8px 0; }
	.danger { color: color-mix(in srgb, var(--vscode-errorForeground) 60%, var(--vscode-foreground)) !important; }
	.section { margin: 12px 0 4px; padding: 0 8px; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; opacity: .65; display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
	.section .count { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 999px; padding: 1px 8px; font-size: 10px; text-transform: none; letter-spacing: 0; font-weight: 500; }
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
	.feed-item { display: flex; gap: 7px; padding: 4px 8px; border-radius: 7px; font-size: 12px; line-height: 1.35; animation: in .25s ease both; align-items: center; }
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
				'<button data-view="login">' + (ru ? 'Войти' : 'Sign in') + '</button><button class="secondary" data-view="register">' + (ru ? 'Создать аккаунт' : 'Create account') + '</button></div>';
			// NB: view 'login' / 'register' открывают вкладку с нужной формой авторизации.
		} else {
			const u = state.session?.user ?? {};
			const summary = state.summary;
			const onlineCount = (summary?.members ?? []).filter(m => m.online).length;
			const soon = Date.now() + 48 * 3600 * 1000;
			const hotTasks = (summary?.myTasks ?? []).filter(t => t.dueAt && new Date(t.dueAt).getTime() < soon).length;
			const teamName = (state.session?.teams ?? []).find(t => t.id === state.teamId)?.name ?? '';
			const icons = {
				board: '<svg viewBox="0 0 24 24" fill="none"><path d="M9 6h11M9 12h11M9 18h11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M4 6l1.4 1.4L8 4.8M4 12l1.4 1.4L8 10.8M4 18l1.4 1.4L8 16.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
				git: '<svg viewBox="0 0 24 24" fill="none"><circle cx="6" cy="6" r="2.6" stroke="currentColor" stroke-width="1.8"/><circle cx="6" cy="18" r="2.6" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="9" r="2.6" stroke="currentColor" stroke-width="1.8"/><path d="M6 8.6v6.8M18 11.6c0 3-2.5 4.4-6 4.9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
				files: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 8l8-4.5L20 8v8l-8 4.5L4 16V8z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M4.4 8.4L12 12.6l7.6-4.2M12 12.6V20" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
				keys: '<svg viewBox="0 0 24 24" fill="none"><circle cx="8" cy="14" r="3.6" stroke="currentColor" stroke-width="1.8"/><path d="M11 11L20 4M16.5 7.5L19 10M14 6l2.2 2.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
				profile: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8.4" r="3.6" stroke="currentColor" stroke-width="1.8"/><path d="M5 20c1.4-3.4 3.9-5 7-5s5.6 1.6 7 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
				add: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
				logout: '<svg viewBox="0 0 24 24" fill="none"><path d="M14 4h-8a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 6 20h8M10 12h10.5M17 8.5l3.5 3.5-3.5 3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
			};
			const nav = [
				['board', ru ? 'Канбан и задачи' : 'Kanban & tasks'],
				['git', ru ? 'Проекты и Git' : 'Projects & Git'],
				['files', ru ? 'Файлы' : 'Files'],
				['keys', ru ? 'Ключи команды' : 'Team keys'],
				['profile', ru ? 'Профиль' : 'Profile']
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
			// Лента событий: локально скрытые (dismissed) не показываем; свайп вправо скрывает.
			const dismissed = new Set(state.dismissedActivity ?? []);
			const key = (ev) => ev.createdAt + '|' + ev.action + '|' + ev.userId;
			const feedAll = state.activity ?? [];
			const showHiddenMode = state._showHiddenActivity === true;
			const feed = showHiddenMode ? feedAll.filter(ev => dismissed.has(key(ev))) : feedAll.filter(ev => !dismissed.has(key(ev)));
			html += '<div class="section"><span>' + (ru ? 'События' : 'Activity') + '</span>' + (dismissed.size && !showHiddenMode ? '<span class="count" id="showHiddenBtn" style="cursor:pointer">' + dismissed.size + ' ' + (ru ? 'скрыт' : 'hidden') + '</span>' : showHiddenMode ? '<span class="count" id="showHiddenBtn" style="cursor:pointer">←</span>' : '') + '</div><div class="feed">';
			html += feed.length
				? feed.slice(0, 6).map(ev => '<div class="feed-item" data-evkey="' + esc(key(ev)) + '"><span class="ico">' + (ev.action.includes('commit') ? '⎇' : ev.action.includes('task') ? '☑' : ev.action.includes('invite') ? '✉' : '•') + '</span><span><span class="who">' + esc(ev.userName) + '</span> <span class="what">' + esc(describe(ev, ru)) + (ev.taskTitle ? ' «' + esc(ev.taskTitle) + '»' : '') + '</span></span><span class="when">' + timeAgo(ev.createdAt) + '</span></div>').join('')
				: '<div class="feed-item"><span class="what">' + (showHiddenMode ? (ru ? 'Скрытых событий нет' : 'No hidden events') : (ru ? 'Пока тихо' : 'Nothing yet')) + '</span></div>';
			html += '</div>';
			// Проекты
			const projects = summary?.projects ?? [];
			if (projects.length) {
				html += '<div class="section"><span>' + (ru ? 'Проекты' : 'Projects') + '</span><span class="count">' + projects.length + '</span></div>';
				html += projects.slice(0, 5).map(p => '<div class="projline" data-view="git"><span>⎇</span><span>' + esc(p.name) + '</span><span class="br">' + esc(p.defaultBranch) + '</span></div>').join('');
			}
			html += '<hr><div class="nav">' + nav.map(n => '<button data-view="' + n[0] + '"><span class="n-ico">' + icons[n[0]] + '</span>' + n[1] + '</button>').join('') +
				'<button id="invite"><span class="n-ico">' + icons.add + '</span>' + (ru ? 'Пригласить в команду' : 'Invite to team') + '</button></div>' +
				'<div class="nav"><button id="logout" class="danger"><span class="n-ico">' + icons.logout + '</span>' + (ru ? 'Выйти' : 'Sign out') + '</button></div>';
			root.innerHTML = html;
			document.getElementById('invite').onclick = () => vscode.postMessage({ type: 'invoke', command: 'auraTeam.createInvite', args: [] });
			document.getElementById('logout').onclick = () => vscode.postMessage({ type: 'invoke', command: 'auraTeam.signOut', args: [] });
		}
		for (const b of root.querySelectorAll('button[data-view]')) { b.onclick = () => vscode.postMessage({ type: 'open', view: b.dataset.view }); }			for (const el of root.querySelectorAll('[data-view].member, [data-view].taskline, [data-view].projline')) { el.onclick = () => vscode.postMessage({ type: 'open', view: el.dataset.view, filter: el.dataset.member ? { member: el.dataset.member } : el.dataset.task ? { task: el.dataset.task } : undefined }); }
			// Свайп-скрытие событий ленты: долгое удержание не нужно — короткий свайп вправо.
			for (const el of root.querySelectorAll('[data-evkey]')) {
				let sx = 0, active = false;
				el.style.touchAction = 'pan-y';
				el.onpointerdown = (e) => { sx = e.clientX; active = true; };
				el.onpointerup = (e) => {
					if (!active) { return; }
					active = false;
					if (e.clientX - sx > 60) { vscode.postMessage({ type: 'invoke', command: 'auraTeam.dismissActivity', args: [el.dataset.evkey] }); }
				};
			}
			const hiddenBtn = document.getElementById('showHiddenBtn');
			if (hiddenBtn) { hiddenBtn.onclick = () => { state._showHiddenActivity = !showHiddenMode; render(); }; }
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
