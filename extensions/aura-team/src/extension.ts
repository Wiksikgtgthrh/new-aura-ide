/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { AuraApiClient } from './api/client';
import { connectGitHub, createGithubRepo, disconnectGitHub, hasGitHubToken, listGithubRepos, pickAndCloneGithubRepo } from './auth/github';
import { matchTeamProvider, mapAuraPriority, providerDraftFrom, importLabelOf, summarizeImport, type AuraApiKey, type AuraApiKeyExport, type ImportOutcome } from './keys/importMapping';
import { GitService } from './git/service';
import { branchNameForTask, taskRefInMessage } from './git/branchName';
import { AdminOverview, TeamRole } from './types';
import { TeamSyncService } from './git/teamSync';
import { ProfileManager } from './profile';
import { AuraState, BoardSnapshot, KeyGroup, Profile, Project, Session, TaskStatus, TeamActivityEvent, TeamApiKey, TeamSummary, TeamTask } from './types';
import { AuraTeamPublicApi, PUBLIC_API_VERSION, TeamTaskChanges } from './publicApi';
import { AuraTeamPanelProvider } from './webview/panelProvider';
import { ARCHIVE_FILTERS, humanBytes, isArchiveName, suggestedArchiveName } from './archives/rules';

const PANEL_VIEW_TYPE = 'auraTeam.panel';
/** Логин GitHub в globalState: подпись аккаунта в панели Git. */
const GITHUB_LOGIN_KEY = 'auraTeam.githubLogin';
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

export async function activate(context: vscode.ExtensionContext): Promise<AuraTeamPublicApi> {
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
	// Публичное событие доски: другие расширения (оркестратор) следят за задачами,
	// не опрашивая сервер. Живёт в context.subscriptions — гасится вместе с расширением.
	const boardEmitter = new vscode.EventEmitter<BoardSnapshot | undefined>();
	context.subscriptions.push(boardEmitter);
	// Есть ли в окне оркестратор: команда регистрируется только активным оркестратором.
	// По этому признаку доска показывает кнопку «Отдать агентам».
	const orchestratorAvailable = async (): Promise<boolean> => {
		try { return (await vscode.commands.getCommands(true)).includes('orchestrator.runTeamTask'); } catch { return false; }
	};

	const demoMode = (): boolean => vscode.workspace.getConfiguration('auraTeam').get<boolean>('demoMode', false);
	// Язык UI Team: 'auto' — сначала общий переключатель aura.language (он один на всю
	// IDE: маркет, панели плагинов), затем язык IDE. Явные 'ru'/'en' приоритетнее всего.
	const uiLanguage = (): string => {
		const setting = vscode.workspace.getConfiguration('auraTeam').get<string>('uiLanguage', 'auto');
		if (setting === 'ru' || setting === 'en') { return setting; }
		const aura = vscode.workspace.getConfiguration('aura').get<string>('language', 'auto');
		return aura === 'ru' || aura === 'en' ? aura : vscode.env.language;
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

	// Права аккаунта выясняет не только Team, но и оболочка: AGGG спрашивает команду
	// `auraTeam.hasEntitlement` перед загрузкой внешнего ядра 5.2. Команда обязана
	// возвращать значение, поэтому регистрируем её напрямую, а не через register().
	context.subscriptions.push(vscode.commands.registerCommand('auraTeam.hasEntitlement', async (feature?: string) => {
		const wanted = String(feature ?? '').trim();
		// Оболочка (AGGG) спрашивает право на старте — возможно, раньше, чем Team
		// успел загрузить сессию. Тогда доступ к ядру 5.2 терялся из-за гонки:
		// подтягиваем сессию прямо здесь, а не надеемся на порядок инициализации.
		if (wanted.length > 0 && !state.session) {
			await refresh().catch(() => undefined);
		}
		const granted = wanted.length > 0 && (state.session?.entitlements ?? []).some(item => item.feature === wanted);
		return { granted };
	}));

	const demoSession = (profile: Profile): Session => ({
		user: { id: 'demo-me', email: profile.email || 'demo@aura.local', displayName: profile.nickname || 'Demo User' },
		teams: [{ id: 'demo', name: 'Aura Studio', role: 'owner' }]
	});

	// Демо-доска живёт между refresh-ами: иначе все правки (статус, удаление)
	// терялись при следующем broadcast, и «выполнено/удалить» в сайдбаре не работали.
	let demoBoardCache: BoardSnapshot | undefined;
	// Логин GitHub, под которым подключён аккаунт: показываем в панели вместо безликого «подключено».
	let githubLogin = context.globalState.get<string>(GITHUB_LOGIN_KEY);
	// Кэш активного инвайт-кода для сайдбара и вкладки приглашения.
	let currentInviteCode: string | null = null;
	let currentInviteExpires: string | null = null;
	/** Роль, с которой вступят по активному коду (сервер отдаёт её вместе с кодом). */
	let currentInviteRole: TeamRole | null = null;
	// Демо-корзина: удалённые в демо-режиме задачи (восстановление из канбана).
	const demoTrash: TeamTask[] = [];
	// Демо-каталог секции приглашения: поиск и отправка работают без сервера.
	const demoDirectory = (): Array<{ id: string; displayName: string; email: string | null }> => ([
		{ id: 'demo-1', displayName: 'Alex', email: 'alex@demo.dev' },
		{ id: 'demo-2', displayName: 'Mia', email: 'mia@demo.dev' },
		{ id: 'demo-3', displayName: 'Sam', email: 'sam@demo.dev' },
		{ id: 'demo-4', displayName: 'Nina', email: 'nina@demo.dev' },
		{ id: 'demo-5', displayName: 'Пётр Соколов', email: 'petr@demo.dev' }
	]);

	const demoBoard = (): BoardSnapshot => {
		if (demoBoardCache) { return demoBoardCache; }
		demoBoardCache = ({
		members: [
			{ id: 'demo-1', displayName: 'Alex', email: 'alex@demo.dev', role: 'maintainer', online: true },
			{ id: 'demo-2', displayName: 'Mia', email: 'mia@demo.dev', role: 'dev', online: true },
			{ id: 'demo-3', displayName: 'Sam', email: 'sam@demo.dev', role: 'viewer', online: false }
		],
		projects: [{ id: 'p1', teamId: 'demo', name: 'Aura IDE', gitUrl: 'https://github.com/Wiksikgtgthrh/new-aura-ide', defaultBranch: 'main' }],
		tasks: [
			{ id: 'dt1', teamId: 'demo', title: 'Дизайн вкладки Aura Team', description: 'Новый UI с анимациями\n- [x] Каркас экрана\n- [x] Токены движения\n- [ ] Карточки задач\n- [ ] Тесты\n- [ ] Релиз', status: 'doing', assigneeId: 'demo-me', assigneeName: 'Вы', position: 0, dueAt: new Date(Date.now() + 2 * 864e5).toISOString() },
			{ id: 'dt2', teamId: 'demo', title: 'Банк API-ключей', description: 'Маскирование и роли', status: 'review', assigneeId: 'demo-1', assigneeName: 'Alex', position: 0 },
			{ id: 'dt3', teamId: 'demo', title: 'Git-панель: ветки', description: 'Переключение веток из вкладки', status: 'todo', assigneeId: 'demo-2', assigneeName: 'Mia', position: 0 },
			{ id: 'dt4', teamId: 'demo', title: 'Регистрация (mock)', description: 'Форма без сервера, чисто для вида', status: 'done', assigneeId: 'demo-me', assigneeName: 'Вы', position: 0 },
			{ id: 'dt5', teamId: 'demo', title: 'Передача файлов', description: 'Позже, через сервер', status: 'todo', position: 0 }
		]
		}) as BoardSnapshot;
		return demoBoardCache;
	};

	const demoKeys = (): TeamApiKey[] => ([
		{ id: 'k1', label: 'OpenAI team key', keyHint: 'sk-…k3Nd', provider: 'openai', accessRole: 'dev', priority: 100, createdAt: new Date(Date.now() - 3 * 864e5).toISOString() },
		{ id: 'k2', label: 'Anthropic team key', keyHint: 'sk-ant-…Q9m', provider: 'anthropic', accessRole: 'maintainer', priority: 200, createdAt: new Date(Date.now() - 1 * 864e5).toISOString() }
	]);

	// Кэш git-снапшота: buildState() вызывается часто (каждый broadcast), а git log — дорогой.
	let gitCache: { at: number; value: Awaited<ReturnType<GitService['getSnapshot']>> } | undefined;
	// Подзадачи живут markdown-чекбоксами в описании задачи, а /summary описаний не отдаёт:
	// добираем прогресс из уже загруженной доски, чтобы сайдбар читался без открытия карточки.
	const subtaskProgress = (description?: string): { done: number; total: number } | undefined => {
		let done = 0, total = 0;
		for (const line of String(description ?? '').split('\n')) {
			const m = /^\s*[-*+]\s+\[( |x|X)\]\s*(.*)$/.exec(line);
			if (!m) { continue; }
			total++;
			if (m[1].toLowerCase() === 'x') { done++; }
		}
		return total ? { done, total } : undefined;
	};
	const withSubtaskProgress = (summary?: TeamSummary): TeamSummary | undefined => {
		if (!summary) { return summary; }
		const byId = new Map((state.board?.tasks ?? []).map(task => [task.id, task.description ?? '']));
		return { ...summary, myTasks: summary.myTasks.map(task => ({ ...task, subtasks: subtaskProgress(byId.get(task.id)) })) };
	};
	const buildState = async (): Promise<AuraState> => ({
		profile: profiles.get(),
		session: state.session,
		teamId: state.teamId,
		board: state.board,
		keys: state.keys,
		git: git ? ((gitCache && Date.now() - gitCache.at < 2000) ? gitCache.value : await gitSvc().getSnapshot().then(value => { gitCache = { at: Date.now(), value }; return value; }).catch(() => undefined)) : undefined,
		activity: state.activity,
		dismissedActivity: dismissedActivity(),
		summary: withSubtaskProgress(state.summary),
		// Демо активно и при живой демо-сессии (сервер не ответил на refresh): без этого
		// флага webview слал правки канбана в несуществующий сервер и молча откатывал их.
		demoMode: state.demo === true || (demoMode() && !state.session),
		simpleMode: simpleMode(),
		serverUrl: serverUrl(),
		signedIn: !!state.session,
		githubConnected: await hasGitHubToken(context),
		githubAccount: githubLogin,
		ideLanguage: vscode.env.language,
		uiLanguage: uiLanguage(),
		orchestratorAvailable: await orchestratorAvailable()
	});

	const launcher = new AuraTeamLauncherViewProvider((view, filter) => openTab(view, filter), () => buildState(), (id, args) => handlerFor(id, args));
	const broadcast = async (): Promise<void> => { const s = await buildState(); provider.broadcast(s); await launcher.push(); boardEmitter.fire(state.board); };

	// Общий переключатель языка: смена aura.language перерисовывает панель Team сразу,
	// без перезагрузки окна — маркет и панели не должны разъезжаться по языку.
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('aura.language') || e.affectsConfiguration('auraTeam.uiLanguage')) {
			void broadcast();
		}
	}));

	// Скрытые события ленты: локальный globalState, максимум 500 id, чистим несуществующие.
	const DISMISSED_KEY = 'auraTeam.dismissedActivity';
	// Память об импорте из Aura API: id ключа плагина → что уже перенесено в команду.
	const IMPORTED_AURA_KEYS = 'auraTeam.importedAuraKeys';
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
		// Скрытие локальное: перерисовываем из уже загруженного состояния, без похода на сервер.
		await broadcast();
	});
	// Удаление события для всей команды: только owner/maintainer, с явным подтверждением.
	register('auraTeam.deleteActivity', async (eventId?: number | string) => {
		const id = Number(eventId);
		if (!Number.isSafeInteger(id) || id <= 0) { return; }
		const me = (state.summary?.members ?? []).find(member => member.id === state.session?.user.id)?.role ?? '';
		if (me !== 'owner' && me !== 'maintainer') {
			void vscode.window.showWarningMessage(vscode.l10n.t('Only the owner or a maintainer can delete activity.'));
			return;
		}
		const deleteLabel = vscode.l10n.t('Delete');
		const confirmed = await vscode.window.showWarningMessage(
			vscode.l10n.t('Delete this activity entry for the whole team? This cannot be undone.'),
			{ modal: true },
			deleteLabel,
		);
		if (confirmed !== deleteLabel) { return; }
		await api.deleteActivity(requireTeam(state), id);
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
	/** Маскировать значение ключа: первые 3 символа + … + последние 4 символа. */
	const maskKey = (value: string): string => {
		if (!value || value.length < 8) { return value; }
		return value.slice(0, 3) + '…' + value.slice(-4);
	};

	const doRefresh = async (): Promise<void> => {
		const prevBoard = state.board;
		const prevActivity = state.activity;
		try {
			state.session = await api.getSession();
			state.demo = false;
			state.teamId = state.teamId && state.session.teams.some(team => team.id === state.teamId) ? state.teamId : state.session.teams[0]?.id;
			// Пять независимых чтений — одним залпом. По очереди это пять сетевых кругов
			// подряд: на удалённом сервере (40–60 мс на запрос) обновление доски ждало
			// ~270 мс вместо ~100 мс. Последователен ровно один шаг — teamId выше.
			// Ошибки ведут себя как раньше: getBoard и listApiKeys валят обновление
			// (и включается демо-фолбэк), остальные три глотают сбой сами.
			const teamId = state.teamId;
			const [board, keys, keyGroups, activity, summary] = await Promise.all([
				teamId ? api.getBoard(teamId) : undefined,
				teamId ? api.listApiKeys(teamId).then(items => items.map(k => ({ ...k, keyHint: maskKey(k.keyHint) }))) : undefined,
				teamId ? api.listKeyGroups(teamId).catch(() => undefined) : undefined,
				teamId ? api.getActivity(teamId).catch(() => undefined) : undefined,
				teamId ? api.getSummary(teamId).catch(() => undefined) : undefined
			]);
			state.board = board;
			state.keys = keys;
			state.keyGroups = keyGroups;
			state.activity = activity;
			state.summary = summary;
			pruneDismissedActivity();
			if (teamId) { api.connect(teamId); }
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
				state.summary = {
					members: state.board.members,
					myTasks: state.board.tasks.filter(task => task.assigneeId === 'demo-me' && task.status !== 'done').map(task => ({ id: task.id, title: task.title, status: task.status, dueAt: task.dueAt })),
					projects: state.board.projects
				};
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
		// Без retainContextWhenHidden: при переключении на другой раздел activity bar
		// вебвью сайдбара выгружается полностью и не держит фоновую активность.
		vscode.window.registerWebviewViewProvider('auraTeam.home', launcher),
		vscode.commands.registerCommand('auraTeam.invoke', async (id: string, args: unknown[]) => handlerFor(id, args)),
		vscode.commands.registerCommand('auraTeam.broadcast', () => broadcast()),
		vscode.commands.registerCommand('auraTeam.open', () => openTab('team')),
		vscode.commands.registerCommand('auraTeam.openProfile', () => openTab('profile')),
		vscode.commands.registerCommand('auraTeam.getState', () => buildState())
	);

	const handlerFor = async (id: string, args: unknown[]): Promise<unknown> => {
		// Команда была зарегистрирована только как VS Code-команда, поэтому вызов из webview
		// падал с «Unknown command» и молча гасился: панель не обновлялась после коммита.
		if (id === 'auraTeam.getState') { return buildState(); }
		// Демо-режим: правки задач применяем к кэшированной демо-доске, без сервера.
		// state.demo — живая демо-сессия (сервер не ответил); старое условие
		// `!state.session` при ней не срабатывало, и команды улетали в API.
		if (state.demo || (demoMode() && !state.session)) {
			const board = demoBoard();
			if (id === 'auraTeam.createTask' && typeof args[0] === 'string') {
				const status = (['todo', 'doing', 'review', 'done'] as TaskStatus[]).includes(args[1] as TaskStatus) ? args[1] as TaskStatus : 'todo';
				const task: TeamTask = {
					id: 'dt' + Date.now(), teamId: 'demo', title: args[0], description: '', status,
					position: board.tasks.filter(t => t.status === status).length,
					assigneeId: 'demo-me', assigneeName: state.session?.user.displayName ?? undefined
				};
				board.tasks.push(task);
				state.board = board;
				await broadcast();
				return task;
			}
			if (id === 'auraTeam.reorderTasks' && typeof args[0] === 'string' && Array.isArray(args[1])) {
				(args[1] as string[]).forEach((taskId, index) => {
					const task = board.tasks.find(t => t.id === taskId);
					if (task) { task.status = args[0] as TaskStatus; task.position = index; }
				});
				state.board = board;
				await broadcast();
				return { ok: true };
			}
			if (id === 'auraTeam.updateTask' && typeof args[0] === 'string') {
				const task = board.tasks.find(t => t.id === args[0]);
				if (task) { Object.assign(task, ...(typeof args[1] === 'object' && args[1] !== null ? [args[1] as Record<string, unknown>] : [])); }
				await broadcast();
				return task;
			}
			if (id === 'auraTeam.deleteTask' && typeof args[0] === 'string') {
				// Мягкое удаление: убираем из доски, но держим в демо-корзине.
				const index = board.tasks.findIndex(t => t.id === args[0]);
				if (index !== -1) {
					const [removed] = board.tasks.splice(index, 1);
					if (removed) { demoTrash.push(removed); }
				}
				state.board = board;
				await broadcast();
				return { ok: true };
			}
			if (id === 'auraTeam.restoreTask' && typeof args[0] === 'string') {
				// Восстановление из демо-корзины обратно на доску.
				const tIndex = demoTrash.findIndex(t => t.id === args[0]);
				if (tIndex !== -1) {
					const [restored] = demoTrash.splice(tIndex, 1);
					if (restored) { board.tasks.push(restored); }
					state.board = board;
				}
				await broadcast();
				return { ok: true };
			}
			if (id === 'auraTeam.listDeletedTasks') {
				return demoTrash.map(t => ({ id: t.id, title: t.title, status: t.status, deletedAt: new Date().toISOString() }));
			}
			if (id === 'auraTeam.sendInvite') { return { ok: true }; }
			if (id === 'auraTeam.copyToClipboard' && typeof args[0] === 'string') { await vscode.env.clipboard.writeText(args[0]); return { ok: true }; }
			if (id === 'auraTeam.currentInvite') { return { code: 'AURA-DEMO-CODE1', expiresAt: new Date(Date.now() + 3 * 864e5).toISOString() }; }
			if (id === 'auraTeam.revokeInvite') { return { ok: true }; }
			if (id === 'auraTeam.directory') {
				// Демо-каталог: приглашение проверяется без сервера, присутствие берётся из демо-команды.
				const inTeam = new Set((state.summary?.members ?? []).map(m => m.id));
				const q = String(args[0] ?? '').trim().toLowerCase();
				return demoDirectory()
					.filter(p => !q || p.displayName.toLowerCase().includes(q) || String(p.email ?? '').toLowerCase().includes(q))
					.map(p => ({ ...p, inTeam: inTeam.has(p.id) ? 1 : 0 }));
			}
			if (id === 'auraTeam.createInvite') { return { code: 'AURA-DEMO-CODE1', expiresAt: new Date(Date.now() + 3 * 864e5).toISOString() }; }
		}
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
	// Пункт «Обновить» в палитре команд: перечитать состояние с сервера и разослать его
	// во все представления. Команда была объявлена в package.json, но никем не
	// зарегистрирована — из палитры она молча ничего не делала (ловит test/manifest.test.mjs).
	register('auraTeam.refresh', async () => { await refresh(); await broadcast(); });
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
	// Вход через браузер (провайдер авторизации IDE), а не вставкой токена.
	register('auraTeam.connectGitHub', async () => {
		const result = await connectGitHub(context);
		githubLogin = result.login;
		await context.globalState.update(GITHUB_LOGIN_KEY, result.login);
		vscode.window.showInformationMessage(result.via === 'browser'
			? vscode.l10n.t('GitHub connected as {0}.', result.login)
			: vscode.l10n.t('GitHub is connected.'));
		await refresh();
		return result;
	});
	register('auraTeam.disconnectGitHub', async () => {
		if (!await confirm(vscode.l10n.t('Disconnect GitHub? Push and pull to private repositories will stop working.'))) { return; }
		await disconnectGitHub(context);
		githubLogin = undefined;
		await context.globalState.update(GITHUB_LOGIN_KEY, undefined);
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
			await vscode.commands.executeCommand('apiKeys.addTeamProxy', {
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
	// role — с какой ролью вступят по коду: панель шлёт выбранную в селекторе (по умолчанию dev).
	register('auraTeam.createInvite', async (role?: TeamRole) => {
		const teamId = requireTeam(state);
		const invite = await api.createInvite(teamId, role);
		currentInviteCode = invite.code;
		currentInviteExpires = invite.expiresAt ?? null;
		currentInviteRole = invite.role ?? role ?? 'dev';
		await vscode.env.clipboard.writeText(invite.code);
		vscode.window.showInformationMessage(vscode.l10n.t('Invite code {0} was copied.', invite.code));
		return invite;
	});
	// Открыть секцию приглашения в сайдбаре: доступно и из палитры команд, и из дерева.
	register('auraTeam.invite.open', async () => {
		// Кода в кэше нет — подтягиваем активный с сервера, чтобы секция открылась сразу с кодом.
		if (!state.demo && state.session && state.teamId && !currentInviteCode) {
			try {
				const invite = await api.getCurrentInvite(state.teamId);
				currentInviteCode = invite?.code ?? null;
				currentInviteExpires = invite?.expiresAt ?? null;
				currentInviteRole = invite?.role ?? 'dev';
			} catch { /* пустое состояние покажет кнопку создания кода */ }
		}
		// Приглашение живёт в сайдбаре: раскрываем секцию в панели, вкладку редактора не создаём.
		await launcher.revealInvite({ code: state.demo ? 'AURA-DEMO-CODE1' : currentInviteCode, expiresAt: currentInviteExpires, role: currentInviteRole });
	});
	register('auraTeam.currentInvite', async () => {
		const invite = await api.getCurrentInvite(requireTeam(state));
		currentInviteCode = invite?.code ?? null;
		currentInviteExpires = invite?.expiresAt ?? null;
		currentInviteRole = invite?.role ?? null;
		return invite;
	});
	// Персональное приглашение пользователя из каталога (сайдбар/вкладка приглашения):
	// роль выбирает приглашающий — приглашённый попадает в команду сразу с ней.
	register('auraTeam.sendInvite', async (userId?: string, role?: TeamRole) => {
		if (!userId) { return; }
		await api.sendInvite(requireTeam(state), String(userId), role);
		await refresh();
		return { ok: true };
	});
	// Копирование из webview (сайдбар/вкладка приглашения) — через основной процесс.
	register('auraTeam.copyToClipboard', async (text?: string) => {
		if (typeof text === 'string' && text) { await vscode.env.clipboard.writeText(text); }
		return { ok: true };
	});
	register('auraTeam.revokeInvite', async () => {
		// Отзыв рвёт уже розданные ссылки: спрашиваем подтверждение вне демо-режима.
		if (!state.demo && !(await confirm(vscode.l10n.t('Revoke the current invite code? Existing links stop working.')))) {
			return { ok: false, cancelled: true };
		}
		await api.revokeInvite(requireTeam(state));
		/* Кэш кода тоже сбрасываем: иначе следующий push возвращал отозванный код в панель,
		   и кнопка «Отозвать» выглядела неработающей. */
		currentInviteCode = null;
		currentInviteExpires = null;
		currentInviteRole = null;
		launcher.clearInvite();
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
	register('auraTeam.listDeletedTasks', async () => {
		return api.listDeletedTasks(requireTeam(state));
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
	register('auraTeam.createTask', async (title?: string, status?: string, assigneeId?: string) => {
		const created = await api.createTask(requireTeam(state), title ?? await requiredInput(vscode.l10n.t('Task title')), (status as never) ?? undefined, assigneeId);
		await refresh();
		return created;
	});
	register('auraTeam.updateTask', async (taskId?: string, changes?: { status?: TaskStatus; position?: number; assigneeId?: string | null; title?: string; description?: string; dueAt?: string | null }) => {
		if (!taskId) { throw new Error(vscode.l10n.t('Task ID is required.')); }
		const updated = await api.updateTask(requireTeam(state), taskId, { status: changes?.status, position: changes?.position, assigneeId: changes?.assigneeId, title: changes?.title, description: changes?.description, dueAt: changes?.dueAt ?? undefined });
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
	// Ключи из встроенного плагина Aura API: список для импорта + какие уже перенесены.
	const importedAuraKeys = (): Record<string, { teamKeyId?: string; label?: string; at?: string }> => context.globalState.get(IMPORTED_AURA_KEYS, {});
	const listAuraKeys = async (): Promise<AuraApiKey[]> => {
		try {
			const result = await vscode.commands.executeCommand('apiKeys.exportKeysList');
			return Array.isArray(result) ? result as AuraApiKey[] : [];
		} catch { return []; }
	};
	register('auraTeam.listAuraApiKeys', async () => listAuraKeys(), false);
	register('auraTeam.auraApiImportState', async () => {
		const keys = await listAuraKeys();
		// Плагин ключей — это workbench-модуль, а не расширение: наличие проверяем по его командам.
		const pluginInstalled = (await vscode.commands.getCommands(true)).includes('apiKeys.exportKeysList');
		return {
			// available=false — плагин ключей не установлен или в нём нет ключей: UI объяснит, что делать.
			available: keys.length > 0,
			pluginInstalled,
			keys,
			imported: importedAuraKeys(),
		};
	}, false);
	// Импорт ключей из плагина API Keys: провайдер подбирается или регистрируется по baseUrl,
	// что уже перенесено — помним, чтобы не плодить дубликаты.
	register('auraTeam.importFromAuraApi', async (input?: { keys?: Array<{ id: string; label?: string; priority?: string; groupId?: string }> }) => {
		const selected = input?.keys ?? [];
		if (!selected.length) { return { imported: 0, skipped: [], summary: '0/0' }; }
		// Метаданные берём из свежего списка плагина, а не из payload webview: id — единственное, что доверяем.
		const published = new Map((await listAuraKeys()).map(key => [key.id, key]));
		const teamId = requireTeam(state);
		const providers = await api.listProviders(teamId).catch(() => [] as Array<{ id: string; name: string; origin: string; builtin: boolean }>);
		const outcome: ImportOutcome = { imported: 0, skipped: [] };
		const remembered = importedAuraKeys();
		for (const entry of selected) {
			const source = published.get(entry.id);
			const item: AuraApiKey = { id: entry.id, name: source?.name, baseUrl: source?.baseUrl, model: source?.model, priority: entry.priority ?? source?.priority };
			const name = importLabelOf(item);
			try {
				const exported = await vscode.commands.executeCommand('apiKeys.exportKey', entry.id) as AuraApiKeyExport | undefined;
				if (!exported?.value) { outcome.skipped.push({ name, reason: 'no-secret' }); continue; }
				let provider = matchTeamProvider(providers, { provider: exported.provider, baseUrl: exported.baseUrl ?? item.baseUrl, name: item.name });
				if (!provider && (exported.baseUrl ?? item.baseUrl)) {
					// Свой шлюз: регистрируем провайдера команды и сразу импортируем ключ в него.
					const draft = providerDraftFrom({ name: exported.model || item.name, baseUrl: exported.baseUrl ?? item.baseUrl });
					const created = await api.createProvider(teamId, draft);
					provider = { id: created.id, name: draft.name, origin: draft.origin, builtin: false };
					providers.push({ id: created.id, name: draft.name, origin: draft.origin, builtin: false });
				}
				if (!provider) { outcome.skipped.push({ name, reason: 'no-provider', detail: exported.provider }); continue; }
				const label = entry.label || name;
				await api.storeApiKey(teamId, provider.id, exported.value, 'dev', label, mapAuraPriority(entry.priority ?? item.priority), entry.groupId);
				outcome.imported++;
				remembered[entry.id] = { label, at: new Date().toISOString() };
			} catch (error) {
				outcome.skipped.push({ name, reason: 'error', detail: errorMessage(error) });
			}
		}
		await context.globalState.update(IMPORTED_AURA_KEYS, remembered);
		await refresh();
		return { ...outcome, summary: summarizeImport(outcome) };
	}, false);
	/* ------------------------------------------------------------------ */
	/* Админ-панель и права на закрытые возможности                       */
	/* ------------------------------------------------------------------ */
	// Сервер сам решает, кто админ: интерфейс только не показывает раздел
	// остальным. Поэтому все вызовы ниже возвращают одну и ту же форму,
	// а отказ приходит как ошибка и показывается в тосте.
	const adminOverview = async (): Promise<AdminOverview> => {
		if (!state.session?.admin) { return { admin: false }; }
		const [features, grants, directory] = await Promise.all([
			api.adminFeatures(),
			api.adminGrants(),
			api.adminDirectory('')
		]);
		return {
			admin: true,
			features: features.features,
			roles: features.roles,
			admins: features.admins,
			account: grants.account,
			team: grants.team,
			users: directory.users,
			teams: directory.teams,
		};
	};
	register('auraTeam.adminState', async () => adminOverview(), false);
	// Поиск цели выдачи идёт на сервер: каталог команды может быть больше, чем
	// влезает в первый срез, а фильтр по имени/email делает сервер.
	register('auraTeam.adminDirectory', async (input?: { q?: string }) => {
		if (!state.session?.admin) { throw new Error(vscode.l10n.t('Admin rights are required.')); }
		const data = await api.adminDirectory(String(input?.q ?? '').trim());
		return { users: data.users, teams: data.teams };
	}, false);
	register('auraTeam.adminRedeem', async (code?: string) => {
		const value = String(code ?? '').trim();
		if (!value) { return { admin: false }; }
		const result = await api.adminRedeem(value);
		// Статус админа приезжает в сессии вместе с правами — обновляем состояние,
		// чтобы раздел появился без перезапуска окна.
		if (result.admin) { await refresh(); }
		return result;
	}, false);
	register('auraTeam.adminGrant', async (input?: { feature?: string; kind?: 'account' | 'team'; targetId?: string; minRole?: TeamRole; note?: string; revoke?: boolean }) => {
		if (!input?.feature || !input.targetId) { throw new Error(vscode.l10n.t('Choose a feature and a target.')); }
		await api.adminGrant({ feature: input.feature, kind: input.kind === 'team' ? 'team' : 'account', targetId: input.targetId, minRole: input.minRole, note: input.note, revoke: input.revoke === true });
		return adminOverview();
	}, false);
	register('auraTeam.adminSetAdmin', async (input?: { email?: string; revoke?: boolean }) => {
		const email = String(input?.email ?? '').trim();
		if (!email) { throw new Error(vscode.l10n.t('Enter the account email.')); }
		await api.adminSetAdmin(email, input?.revoke === true);
		return adminOverview();
	}, false);
	// Внешнее ядро AGGG 5.2: сервер отдаёт файлы только по праву. Кэш — по хэшу
	// ядра, поэтому повторный запуск ничего не перекачивает и не зависит от сети.
	register('auraTeam.agggAgent', async () => {
		const bundle = await api.agggAgent();
		const dir = vscode.Uri.joinPath(context.globalStorageUri, 'aggg52', bundle.digest.slice(0, 16));
		const marker = vscode.Uri.joinPath(dir, 'harness', 'core.txt');
		const cached = await Promise.resolve(vscode.workspace.fs.stat(marker)).then(() => true, () => false);
		if (!cached) {
			await vscode.workspace.fs.createDirectory(dir);
			for (const [name, content] of Object.entries(bundle.files)) {
				const segments = name.split('/');
				if (segments.length > 1) { await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dir, ...segments.slice(0, -1))); }
				await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, ...segments), Buffer.from(content, 'utf8'));
			}
		}
		return { path: dir.fsPath, version: bundle.version, cached };
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
		// Отключение без модалки подтверждения — действие обратимо тем же тумблером.
		await api.disableApiKey(requireTeam(state), key.id);
		await refresh();
	});
	register('auraTeam.enableApiKey', async (key?: TeamApiKey) => {
		if (!key) { return; }
		await api.enableApiKey(requireTeam(state), key.id);
		await refresh();
	});
	register('auraTeam.deleteApiKey', async (key?: TeamApiKey) => {
		if (!key) { return; }
		// Webview уже показал модалку подтверждения — повторный confirm() блокировал
		// выполнение и вызывал 10-секундный таймаут svc(), молча убивая удаление.
		await api.deleteApiKey(requireTeam(state), key.id);
		await refresh();
	});
	register('auraTeam.updateApiKey', async (keyId?: string, changes?: { label?: string; accessRole?: string; priority?: number; groupId?: string | null }) => {
		if (!keyId || !changes) { return; }
		await api.updateApiKey(requireTeam(state), String(keyId), changes);
		await refresh();
	});
	// Удаление участника из команды (права проверяет сервер; UI скрывает кнопку по роли).
	// Подтверждение спрашиваем здесь: обе панели приходят одной командой, а вкладка
	// показывает свой диалог и передаёт confirmed — двойного вопроса не будет.
	register('auraTeam.removeMember', async (memberId?: string, options?: { confirmed?: boolean }) => {
		if (!memberId) { return { ok: false }; }
		const member = state.board?.members.find(item => item.id === memberId) ?? state.summary?.members.find(item => item.id === memberId);
		if (!options?.confirmed) {
			const answer = await vscode.window.showWarningMessage(vscode.l10n.t('Remove {0} from the team?', member?.displayName ?? memberId), { modal: true }, vscode.l10n.t('Remove'));
			if (answer !== vscode.l10n.t('Remove')) { return { ok: false, cancelled: true }; }
		}
		await api.removeMember(requireTeam(state), memberId);
		vscode.window.showInformationMessage(vscode.l10n.t('The member was removed from the team.'));
		await refresh();
		return { ok: true };
	});
	// Лимиты сервера: клиент валидирует размер архива до отправки и показывает срок хранения.
	let limitsCache: { teamId: string; at: number; value: { archiveMaxBytes: number; archiveTtlDays: number; proxyRequestsPerDay: number } } | undefined;
	const teamLimits = async (): Promise<{ archiveMaxBytes: number; archiveTtlDays: number; proxyRequestsPerDay: number } | undefined> => {
		if (demoMode() || !state.teamId) { return undefined; }
		if (limitsCache && limitsCache.teamId === state.teamId && Date.now() - limitsCache.at < 300_000) { return limitsCache.value; }
		try { const value = await api.fetchLimits(state.teamId); limitsCache = { teamId: state.teamId, at: Date.now(), value }; return value; } catch { return undefined; }
	};
	register('auraTeam.fetchLimits', async () => teamLimits());
	// Проверить все ключи параллельно: обновляем снапшот и отдаём результаты в UI.
	register('auraTeam.checkAllKeys', async () => {
		const results = await api.checkAllKeys(requireTeam(state));
		try { state.keys = (await api.listApiKeys(requireTeam(state))).map(k => ({ ...k, keyHint: maskKey(k.keyHint) })); } catch { /* не критично */ }
		await broadcast();
		return results;
	});
	register('auraTeam.listProviders', async () => demoMode() ? [] : api.listProviders(requireTeam(state)));
	register('auraTeam.teamUsage', async () => demoMode() ? undefined : api.fetchUsage(requireTeam(state)));
	// Git: три вида отката — по файлу / revert / reset soft|hard (hard подтверждает UI).
	register('auraTeam.gitDiscardFile', async (filePath?: string) => {
		if (!filePath) { return; }
		await gitSvc().discardFile(filePath);
		await broadcast();
	});
	register('auraTeam.gitResetBranch', async (mode?: 'soft' | 'hard') => {
		if (mode !== 'soft' && mode !== 'hard') { return; }
		await gitSvc().resetBranch(mode);
		await broadcast();
	});
	// Экран без репозитория не тупик: открыть папку / инициализировать репозиторий.
	register('auraTeam.openWorkspaceFolder', async () => { await vscode.commands.executeCommand('workbench.action.files.openFolder'); });
	register('auraTeam.gitInit', async () => {
		const root = vscode.workspace.workspaceFolders?.[0];
		if (!root) { throw new Error(vscode.l10n.t('Open a folder first.')); }
		const { execFile } = await import('node:child_process');
		const { promisify } = await import('node:util');
		await promisify(execFile)('git', ['init'], { cwd: root.uri.fsPath });
		vscode.window.showInformationMessage(vscode.l10n.t('Git repository initialized.'));
		await refresh();
	});
	// Стриминговая загрузка с прогрессом и отменой + проверка лимита ДО отправки.
	const uploadWithProgress = async (uri: vscode.Uri, projectName: string, projectId?: string): Promise<{ id: string; projectId: string; expiresAt: string }> => {
		const limits = await teamLimits();
		let size = 0;
		try { size = (await vscode.workspace.fs.stat(uri)).size; } catch { /* недоступен stat — пусть сервер решит */ }
		const pickedName = uri.fsPath.split(/[\\/]/).pop() ?? 'project';
		// Сначала расширение, потом размер: сервер принимает только zip/rar
		// (остальное молча отклонялось после долгой загрузки).
		if (!isArchiveName(pickedName)) { throw new Error(vscode.l10n.t('Only .zip and .rar archives are accepted.')); }
		if (limits && size > limits.archiveMaxBytes) { throw new Error(vscode.l10n.t('The archive exceeds the server limit of {0}.', humanBytes(limits.archiveMaxBytes))); }
		const fileName = pickedName;
		return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Uploading {0}…', fileName), cancellable: true }, async (progress, token) => {
			let lastPercent = 0;
			const upload = api.uploadArchiveStream(requireTeam(state), uri.fsPath, projectName, projectId, (sent, total) => {
				if (total <= 0) { return; }
				const percent = Math.min(100, Math.floor((sent / total) * 100));
				if (percent > lastPercent) { progress.report({ increment: percent - lastPercent }); lastPercent = percent; }
			});
			const cancelled = new Promise<never>((_, reject) => token.onCancellationRequested(() => reject(new Error(vscode.l10n.t('Upload cancelled.')))));
			const result = await Promise.race([upload, cancelled]);
			vscode.window.showInformationMessage(vscode.l10n.t('Archive uploaded. It expires at {0}.', new Date(result.expiresAt).toLocaleString()));
			await refresh();
			return result;
		});
	};
	register('auraTeam.uploadArchive', async (projectName?: string) => {
		const uri = (await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: vscode.l10n.t('Upload archive'), filters: ARCHIVE_FILTERS }))?.[0];
		if (!uri) { return; }
		const fileName = uri.fsPath.split(/[\\/]/).pop() ?? 'project';
		// Без явного имени проекта берём имя файла без расширения — модалка не нужна.
		const name = projectName?.trim() || fileName.replace(/\.[^.]+$/, '') || 'project';
		return uploadWithProgress(uri, name);
	});
	// Скачивание: имя файла берём из заголовка сервера (RFC 5987) — раньше диалог
	// предлагал имя проекта без расширения, и файл сохранялся «никак».
	const saveArchive = async (archiveId: string, projectName?: string): Promise<void> => {
		if (!archiveId) { throw new Error(vscode.l10n.t('This project has no archive.')); }
		const { bytes, filename } = await api.downloadArchive(requireTeam(state), archiveId);
		const defaultName = suggestedArchiveName(projectName, filename);
		const destination = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.cwd()), defaultName),
			saveLabel: vscode.l10n.t('Save archive'),
			filters: ARCHIVE_FILTERS
		});
		if (!destination) { return; }
		await vscode.workspace.fs.writeFile(destination, bytes);
		vscode.window.showInformationMessage(vscode.l10n.t('Archive saved to {0}.', destination.fsPath));
	};
	register('auraTeam.downloadArchive', async (project?: Project) => {
		if (!project?.archiveId) { throw new Error(vscode.l10n.t('This project has no archive.')); }
		return saveArchive(project.archiveId, project.name);
	});
	register('auraTeam.downloadArchiveById', async (archive?: { id: string; projectName?: string }) => {
		if (!archive?.id) { throw new Error(vscode.l10n.t('This project has no archive.')); }
		return saveArchive(archive.id, archive.projectName);
	});
	register('auraTeam.listArchives', async () => {
		return api.listArchives(requireTeam(state));
	});
	// Удалять архив может только owner/maintainer (то же правило на сервере).
	register('auraTeam.deleteArchive', async (archiveId?: string) => {
		if (!canMaintain(state)) { throw new Error(vscode.l10n.t('Only the team owner or a maintainer can delete archives.')); }
		await api.deleteArchive(requireTeam(state), String(archiveId));
		await refresh();
		return { ok: true };
	});
	register('auraTeam.uploadArchiveTo', async (projectId?: string) => {
		// Загрузка новой версии в существующий проект.
		const project = state.board?.projects.find(p => p.id === projectId);
		if (!project) { throw new Error(vscode.l10n.t('Project not found.')); }
		const uri = (await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: vscode.l10n.t('Upload archive'), filters: ARCHIVE_FILTERS }))?.[0];
		if (!uri) { return; }
		return uploadWithProgress(uri, project.name, project.id);
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
		await reportCommitForLinking(commit);
		return commit;
	});
	register('auraTeam.updateProject', () => gitSvc().update());
	register('auraTeam.undoChanges', async (confirmed?: boolean) => { if (confirmed || await confirm(vscode.l10n.t('Discard all uncommitted changes?'))) { await gitSvc().undoUncommitted(); await broadcast(); } });
	register('auraTeam.revertLastCommit', async (confirmed?: boolean) => { if (confirmed || await confirm(vscode.l10n.t('Create a new commit that reverses the last commit?'))) { await gitSvc().revertLastCommit(); await broadcast(); } });
	register('auraTeam.restoreFile', async () => { const uri = await pickFile(); if (uri) { await gitSvc().restoreFile(uri, await requiredInput(vscode.l10n.t('Commit hash or tag'))); } });
	register('auraTeam.relink', async (url?: string) => gitSvc().relink(url ?? await requiredInput(vscode.l10n.t('New origin URL'))));
	register('auraTeam.history', () => gitSvc().showHistory());

	/**
	 * Докладываем серверу только коммиты со ссылкой на задачу: сервер связывает пару
	 * исключительно по `#<hex>` в сообщении и без ссылки отвечает 404 — раньше эти
	 * 404 попадали в общий catch и выглядели как ошибка коммита (а с непустым
	 * remoteUrl запрос ещё и уходил впустую).
	 */
	const reportCommitForLinking = async (commit: { hash: string; message: string; remoteUrl?: string }): Promise<boolean> => {
		const ref = taskRefInMessage(commit.message);
		if (!ref) { output.appendLine('[commit] сообщение без ссылки на задачу — коммит не связан'); return false; }
		if (!state.teamId) { return false; }
		try {
			await api.reportCommit(state.teamId, commit.hash, commit.remoteUrl ?? '', commit.message);
			output.appendLine(`[commit] связан с задачей #${ref}`);
			return true;
		} catch (error) {
			output.appendLine(`[commit] связка с задачей #${ref} не удалась: ${errorMessage(error)}`);
			vscode.window.showWarningMessage(vscode.l10n.t('The commit is saved, but the task link could not be reported: {0}', errorMessage(error)));
			return false;
		}
	};

	// Новые команды для git-панели вкладки
	register('auraTeam.commitAll', async (message: string) => {
		// Коммит выполняется всегда; пуш — отдельным шагом, чтобы ошибка отправки
		// не теряла коммит и попадала в тост, а не в молчаливое исключение.
		const repository = gitSvc().repository;
		const commit = await gitSvc().commitOnly(message, repository);
		const linked = await reportCommitForLinking(commit);
		let pushed = false;
		let pushError: string | undefined;
		if (commit.remoteUrl && repository) {
			try { await gitSvc().push(); pushed = true; } catch (error) {
				pushError = errorMessage(error);
				vscode.window.showWarningMessage(vscode.l10n.t('Committed locally, but push failed: {0}', pushError));
			}
		}
		await broadcast();
		return { ...commit, pushed, pushError, linked };
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
	// Командный стандарт: работа идёт в ветке задачи, а не в master/front.
	// Ветка создаётся из задачи — имя детерминировано, ссылка на задачу попадает в имя.
	register('auraTeam.createBranchFromTask', async (taskId?: string) => {
		const id = String(taskId ?? '');
		const task = (state.board?.tasks ?? []).find(item => item.id === id);
		if (!task) { throw new Error(vscode.l10n.t('Task not found.')); }
		const name = branchNameForTask(task.id, task.title);
		const existing = await gitSvc().listBranches();
		if (existing.includes(name)) { await gitSvc().checkout(name); } else { await gitSvc().createBranch(name); }
		await broadcast();
		return { branch: name, taskId: task.id };
	});
	/** Подсказка для коммита: ссылка на задачу в сообщении — то, по чему сервер связывает коммит. */
	register('auraTeam.taskCommitHint', async (taskId?: string) => {
		const id = String(taskId ?? '');
		return { ref: '#' + id.slice(0, 8), branch: branchNameForTask(id, (state.board?.tasks ?? []).find(item => item.id === id)?.title) };
	});
	register('auraTeam.commitSelected', async (message?: string, selectedPaths?: string[]) => {
		const paths = Array.isArray(selectedPaths) ? selectedPaths : [];
		const commit = await gitSvc().commitSelected(message ?? await requiredInput(vscode.l10n.t('Commit message')), paths);
		const linked = await reportCommitForLinking(commit);
		let pushed = false;
		let pushError: string | undefined;
		try { await gitSvc().push(); pushed = true; } catch (error) { pushError = errorMessage(error); }
		await broadcast();
		return { ...commit, pushed, pushError, linked };
	});

	// Профиль (локальный, без сервера)
	register('auraTeam.registerProfile', async (data?: { nickname?: string; email?: string; description?: string }) => {
		const profile = await profiles.save({ nickname: data?.nickname ?? '', email: data?.email ?? '', description: data?.description ?? '' });
		updateAvatar();
		await refresh();
		return profile;
	}, false);

	register('auraTeam.runTeamTask', async (taskId?: string) => {
		const id = String(taskId ?? '').trim();
		if (!id) { return { ok: false }; }
		// Публичная команда оркестратора: он сам решает, как замапить задачу в поток графа.
		await vscode.commands.executeCommand('orchestrator.runTeamTask', id);
		return { ok: true };
	});

	state.teamId = context.workspaceState.get<string>('auraTeam.teamId');
	await updateSimpleModeContext();
	await refresh();

	// Публичный API: только эти методы и ничего сверх — потребитель проверяет apiVersion.
	return {
		apiVersion: PUBLIC_API_VERSION,
		getSession: () => state.session,
		getBoard: (teamId: string) => api.getBoard(teamId),
		updateTask: async (teamId: string, taskId: string, changes: TeamTaskChanges) => {
			const updated = await api.updateTask(teamId, taskId, changes);
			await refresh();
			return updated;
		},
		createTask: async (teamId: string, title: string, status?: TaskStatus) => {
			const created = await api.createTask(teamId, title, status);
			await refresh();
			return created;
		},
		onDidChangeBoard: boardEmitter.event,
		listApiKeys: (teamId: string) => api.listApiKeys(teamId),
		createProxyToken: (teamId: string, provider: string, model: string) => api.createProxyToken(teamId, provider, model),
	};
}

/**
 * Сайдбар Team (activity bar) — живая навигация:
 *  • не вошёл → карточка «Войдите или создайте аккаунт» с кнопками;
 *  • вошёл → меню: профиль, команды, канбан, проекты, файлы, ключи, приглашение, выход.
 */
/**
 * Кодирует codicon.ttf из состава IDE в base64 для встраивания в webview.
 * Результат кэшируется: файл ~150 КБ, перекодировать при каждом открытии панели дорого.
 */
let codiconFontCache: string | undefined;
function getCodiconFontBase64(): string {
	if (codiconFontCache) { return codiconFontCache; }
	// Шрифт ищем в корне расширения (assets/) и выше — out/ чистится при пересборке.
	for (const candidate of [join(__dirname, '..', 'assets'), join(__dirname, '..', '..', 'assets'), __dirname]) {
		try { codiconFontCache = readFileSync(join(candidate, 'codicon.ttf')).toString('base64'); break; } catch { /* следующий путь */ }
	}
	codiconFontCache ??= '';
	return codiconFontCache;
}

class AuraTeamLauncherViewProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private lastState?: unknown;
	private lastInviteCode?: string;
	private lastInviteExpires: string | null = null;
	private lastInviteRole: string | null = null;
	/** Приглашение, запрошенное до создания панели: показываем при первом же ready. */
	private pendingInvite: { code: string | null; expiresAt: string | null; role?: string | null } | undefined;
	/** Панель видима в сайдбаре. В скрытом состоянии состояние не пушим — фоновая активность останавливается. */
	private visible = false;

	constructor(
		private readonly open: (view: string, filter?: unknown) => Promise<void>,
		private readonly getState: () => Promise<unknown>,
		private readonly invoke: (id: string, args: unknown[]) => Promise<unknown>
	) { }

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		this.visible = webviewView.visible;
		webviewView.onDidChangeVisibility(() => {
			this.visible = webviewView.visible;
			// Вернулись на панель — сразу проталкиваем свежее состояние.
			if (this.visible) { void this.push(); }
		});
		webviewView.onDidDispose(() => { this.view = undefined; this.visible = false; });
		webviewView.webview.options = { enableScripts: true };
		const nonce = String(Date.now()) + '-' + Math.floor(Math.random() * 1e9);
		// NB: replace() меняет только первое вхождение — nonce остался бы в CSP,
		// а <script nonce="__NONCE__"> был бы заблокирован CSP (пустой сайдбар).
		webviewView.webview.html = LAUNCHER_HTML
			.split('__CODICON_FONT__').join(getCodiconFontBase64())
			.split('__NONCE__').join(nonce);
		webviewView.webview.onDidReceiveMessage(async message => {
			if (message?.type === 'open' && typeof message.view === 'string') { await this.open(message.view, message.filter); }
			else if (message?.type === 'toast' && typeof message.text === 'string') { void vscode.window.showInformationMessage(message.text); }		else if (message?.type === 'invoke' && typeof message.command === 'string') {
			try {
				const result = await this.invoke(message.command, Array.isArray(message.args) ? message.args : []);
				// Код приглашения возвращается из auraTeam.currentInvite/createInvite — кладём в state для сайдбара.
				if (result && typeof result === 'object' && 'code' in (result as Record<string, unknown>)) {
					const invite = result as Record<string, unknown>;
					this.lastInviteCode = String(invite.code ?? '');
					this.lastInviteExpires = typeof invite.expiresAt === 'string' ? invite.expiresAt : null;
					this.lastInviteRole = typeof invite.role === 'string' ? invite.role : null;
				}
				void this.view?.webview.postMessage({ type: 'response', id: message.id, ok: true, result });
			} catch (error) {
				void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
				void this.view?.webview.postMessage({ type: 'response', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			await this.push();
		} else if (message?.type === 'ready') {
			await this.push();
			/* Команда могла запросить приглашение до создания панели. */
			if (this.pendingInvite) { const pending = this.pendingInvite; this.pendingInvite = undefined; void this.revealInvite(pending); }
		}
	});
	void this.push();
}

	/** Открыть секцию приглашения в панели (вкладку редактора больше не создаём). */
	async revealInvite(invite: { code: string | null; expiresAt?: string | null; role?: string | null }): Promise<void> {
		this.lastInviteCode = invite.code ?? undefined;
		this.lastInviteExpires = invite.expiresAt ?? null;
		this.lastInviteRole = invite.role ?? null;
		// Команда может прийти из палитры команд при скрытом сайдбаре — сначала показываем контейнер.
		await vscode.commands.executeCommand('workbench.view.extension.auraTeam');
		if (!this.view) { this.pendingInvite = { code: invite.code ?? null, expiresAt: invite.expiresAt ?? null, role: invite.role ?? null }; return; }
		void this.view.webview.postMessage({ type: 'inviteCode', invite: { code: invite.code ?? null, expiresAt: invite.expiresAt ?? null, role: invite.role ?? null } });
		await this.push();
	}
	/** Код отозван или протух: сбрасываем кэш, чтобы push() не вернул его в панель. */
	clearInvite(): void {
		this.lastInviteCode = undefined;
		this.lastInviteExpires = null;
		this.lastInviteRole = null;
		this.pendingInvite = undefined;
	}

	/** Протолкнуть свежее состояние в сайдбар (вызывается из broadcast). */
	async push(): Promise<void> {
		// Скрытая панель не получает обновления — состояние догоним при возврате видимости.
		if (!this.visible) { return; }
		this.lastState = await this.getState();
		if (this.view) {
			void this.view.webview.postMessage({ type: 'state', state: this.lastState, inviteCode: this.lastInviteCode, inviteExpires: this.lastInviteExpires, inviteRole: this.lastInviteRole ?? undefined });
		}
	}
}

const LAUNCHER_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-__NONCE__'; font-src data:;">
<style>
/* ---------- codicon-шрифт из состава IDE (base64) ---------- */
@font-face { font-family: 'codicon'; src: url(data:font/woff2;base64,__CODICON_FONT__) format('woff2'); }
.ci { font-family: 'codicon'; font-size: 16px; line-height: 1; display: inline-block; font-weight: normal; font-style: normal; text-decoration: none; -webkit-font-smoothing: antialiased; text-rendering: auto; }
/* ---------- шкала отступов 4/8/12/16/24/32, радиусы 6/10, токены движения (C1) ---------- */
:root {
\t--sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 20px; --sp-6: 24px;
\t--r-ctl: 6px; --r-card: 10px;
\t--dur-1: 90ms; --dur-2: 160ms; --dur-3: 240ms; --dur-4: 320ms;
\t--ease-out: cubic-bezier(.2, 0, 0, 1);
\t--ease-in: cubic-bezier(.4, 0, 1, 1);
\t--ease-inout: cubic-bezier(.4, 0, .2, 1);
\t--ease-snap: cubic-bezier(.34, 1.26, .64, 1);
}
@media (prefers-reduced-motion: reduce) {
\t:root { --dur-1: 1ms; --dur-2: 1ms; --dur-3: 1ms; --dur-4: 1ms; }
\t* { animation-duration: 1ms !important; animation-iteration-count: 1 !important; }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; padding: var(--sp-2) 0 var(--sp-4); font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); overflow: hidden; }
button { font-family: inherit; font-size: 13px; color: inherit; background: none; border: none; cursor: pointer; padding: 0; }
button:focus-visible, [tabindex]:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; border-radius: var(--r-ctl); }
#root { height: 100%; overflow-y: auto; padding: 0 var(--sp-2); }

/* ---------- единая сетка строки (A3): все строки панели — 20px | 1fr | auto ---------- */
.row {
\tdisplay: grid;
\tgrid-template-columns: 20px minmax(0, 1fr) auto;
\talign-items: center;
\tgap: var(--sp-2);
\tmin-height: 28px;
\tpadding: 0 var(--sp-2);
\tborder-radius: var(--r-ctl);
\tcursor: pointer;
\ttransition: background-color var(--dur-1) var(--ease-out), color var(--dur-1) var(--ease-out), border-color var(--dur-1) var(--ease-out);
}
.row:hover { background: var(--vscode-list-hoverBackground); }
.row > :first-child { width: 20px; display: grid; place-items: center; }
.row .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.row .end { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
.row .time { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.row .sub-count { margin-left: var(--sp-2); font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
/* действия строки: проявляются сдвигом на 4px внутрь (C2), без движения самой строки */
.row .actions { display: flex; gap: 2px; opacity: 0; transform: translateX(4px); transition: opacity var(--dur-2) var(--ease-out), transform var(--dur-2) var(--ease-out); }
.row:hover .actions, .row:focus-within .actions { opacity: 1; transform: none; }
.row .actions .danger:hover { color: var(--vscode-errorForeground); }

/* ---------- метки секций: та же левая граница, что у строк ---------- */
.side-label { display: flex; align-items: center; justify-content: space-between; font-size: 11px; font-weight: 400; letter-spacing: .04em; color: var(--vscode-descriptionForeground); margin: 0 var(--sp-2) var(--sp-3); text-transform: none; }
.side-label .label-actions { display: flex; gap: 2px; opacity: 0; transition: opacity var(--dur-2) var(--ease-out); }
.side-label:hover .label-actions, .side-label:focus-within .label-actions { opacity: 1; }
.section { margin-bottom: var(--sp-6); }
.section .list { display: flex; flex-direction: column; gap: var(--sp-1); }

/* ---------- нейтральные счётчики + roll чисел (C10) ---------- */
.count { min-width: 18px; height: 18px; padding: 0 var(--sp-1); display: inline-grid; place-items: center; font-size: 11px; border-radius: calc(1e3px); color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); font-variant-numeric: tabular-nums; }
.count > .count-text { grid-area: 1 / 1; }

/* ---------- профиль (A1: хендл только если есть; A5: точка онлайна — здесь) ---------- */
.me { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-1) var(--sp-2); margin-bottom: var(--sp-4); border-radius: var(--r-ctl); cursor: pointer; transition: background-color var(--dur-1) var(--ease-out); }
.me:hover { background: var(--vscode-list-hoverBackground); }
.ava { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 400; color: var(--vscode-sideBar-background); flex: none; position: relative; }
.ava .presence { position: absolute; right: -2px; bottom: -2px; width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); border: 2px solid var(--vscode-sideBar-background); }
.ava .presence.off { background: var(--vscode-descriptionForeground); }

.me .who { min-width: 0; display: flex; flex-direction: column; }
.me .who .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.me .who .handle { font-size: 11px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* меню профиля — поповер (единственный допустимый box-shadow), вход через @starting-style (C7) */
.me-menu { position: absolute; z-index: 50; min-width: 160px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); border-radius: var(--r-card); box-shadow: 0 4px 16px color-mix(in srgb, var(--vscode-widget-shadow) 45%, transparent); padding: var(--sp-1); opacity: 1; transform: none; transition: opacity var(--dur-2) var(--ease-out), transform var(--dur-2) var(--ease-out), display var(--dur-2) allow-discrete; }
@starting-style { .me-menu { opacity: 0; transform: scale(.97); } }
.me-menu button { display: flex; align-items: center; gap: var(--sp-2); width: 100%; padding: var(--sp-2); border-radius: var(--r-ctl); text-align: left; transition: background-color var(--dur-1) var(--ease-out); }
.me-menu button:hover { background: var(--vscode-list-hoverBackground); }
.me-menu button.danger { color: color-mix(in srgb, var(--vscode-errorForeground) 60%, var(--vscode-foreground)); }

/* ---------- навигация: та же сетка строки ---------- */
.nav { display: flex; flex-direction: column; gap: 1px; }
.nav-item { display: grid; grid-template-columns: 20px minmax(0, 1fr); align-items: center; gap: var(--sp-2); width: 100%; min-height: 28px; padding: 0 var(--sp-2); border-radius: var(--r-ctl); text-align: left; font-size: 13px; color: var(--vscode-foreground); transition: background-color var(--dur-1) var(--ease-out), color var(--dur-1) var(--ease-out); }
.nav-item:hover { background: var(--vscode-list-hoverBackground); }
.nav-item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.nav-item > :first-child { display: grid; place-items: center; }
.nav-item .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- бейджи статусов (A4): фиксированная палитра, кроссфейд (C3) ---------- */
.badge { display: inline-grid; min-width: 62px; height: 16px; justify-content: center; align-items: center; font-size: 11px; padding: 0 var(--sp-1); border-radius: var(--r-ctl); background: color-mix(in srgb, currentColor 14%, transparent); transition: color var(--dur-2) var(--ease-out), background-color var(--dur-2) var(--ease-out); flex: none; }
.badge > .badge-text { grid-area: 1 / 1; }
.badge[data-state='in-progress'] { color: var(--vscode-charts-blue); }
.badge[data-state='review'] { color: var(--vscode-charts-purple); }
.badge[data-state='blocked'] { color: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow)); }
.badge[data-state='done'] { color: var(--vscode-charts-green); }
.badge[data-state='overdue'] { color: var(--vscode-errorForeground); }
/* однократный пульс подтверждения (C3) */
@keyframes pulseOnce {
\tfrom { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 45%, transparent); }
\tto { box-shadow: 0 0 0 7px transparent; }
}
.badge.just-changed::before { content: ''; position: absolute; inset: 0; border-radius: inherit; animation: pulseOnce 420ms var(--ease-out) 1; }

/* счётчик повторов события — инлайн без фона (A2) */
.rep { font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }

.act-btn { width: 20px; height: 20px; display: grid; place-items: center; border-radius: var(--r-ctl); color: var(--vscode-descriptionForeground); transition: background-color var(--dur-1) var(--ease-out), color var(--dur-1) var(--ease-out); }
.act-btn:hover { background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); color: var(--vscode-foreground); }
.act-btn.danger:hover { color: var(--vscode-errorForeground); }
.act-btn .ci { font-size: 16px; }
/* ghost-кнопки «Показать все/ещё» — с тем же padding, что у строк (A3) */
.link-btn { display: grid; grid-template-columns: 20px minmax(0, 1fr); align-items: center; gap: var(--sp-2); min-height: 28px; padding: 0 var(--sp-2); font-size: 13px; color: var(--vscode-descriptionForeground); border-radius: var(--r-ctl); text-align: left; transition: background-color var(--dur-1) var(--ease-out), color var(--dur-1) var(--ease-out); }
.link-btn:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
.link-btn > :first-child { display: grid; place-items: center; }

.m-role { font-size: 11px; color: var(--vscode-descriptionForeground); }

/* ---------- события ---------- */
.ev-entity { color: var(--vscode-textLink-foreground); cursor: pointer; }
.ev-entity:hover { text-decoration: underline; }
/* раскрытие «Показать ещё» через grid-template-rows (C7) */
.collapsible { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--dur-3) var(--ease-out); }
.collapsible > div { overflow: hidden; min-height: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.collapsible[data-open='true'] { grid-template-rows: 1fr; }

/* ---------- тост undo (C5): вход 320ms, уход 160ms, полоска-таймер ---------- */
#undoToast { position: fixed; bottom: var(--sp-3); left: 50%; transform: translateX(-50%); z-index: 100; display: flex; align-items: center; gap: var(--sp-3); background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); border-radius: var(--r-card); box-shadow: 0 4px 16px color-mix(in srgb, var(--vscode-widget-shadow) 45%, transparent); padding: var(--sp-2) var(--sp-3); font-size: 12px; overflow: hidden; opacity: 1; transform: translateX(-50%); transition: opacity var(--dur-4) var(--ease-out), transform var(--dur-4) var(--ease-out), display var(--dur-2) allow-discrete; }
@starting-style { #undoToast { opacity: 0; transform: translateX(-50%) translateY(8px); } }
#undoToast.hidden { display: none; opacity: 0; transition: opacity var(--dur-2) var(--ease-in); }
#undoToast button { color: var(--vscode-textLink-foreground); font-size: 12px; }
#undoToast .timer { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: color-mix(in srgb, var(--vscode-textLink-foreground) 40%, transparent); transform-origin: left; }

/* ---------- приглашение: секция внутри сайдбара (вкладка редактора не нужна) ---------- */
#secInvite[data-open='false'] { display: none; }
.invite-code { display: flex; align-items: center; gap: var(--sp-2); min-height: 32px; padding: 0 var(--sp-1) 0 var(--sp-2); border: 1px solid color-mix(in srgb, var(--vscode-foreground) 22%, transparent); border-radius: var(--r-ctl); }
.invite-code .code { flex: 1; min-width: 0; font-size: 13px; letter-spacing: .04em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; user-select: all; }
.invite-code .expires { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.invite-hint { margin: var(--sp-3) var(--sp-2) 0; font-size: 11px; line-height: 1.45; color: var(--vscode-descriptionForeground); }
.invite-actions { display: flex; gap: var(--sp-2); margin-top: var(--sp-2); }
.invite-actions button { flex: 1; min-height: 28px; padding: 0 var(--sp-2); border-radius: var(--r-ctl); background: var(--vscode-button-secondaryBackground, color-mix(in srgb, var(--vscode-foreground) 10%, transparent)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); font-size: 12px; text-align: center; transition: background-color var(--dur-1) var(--ease-out); }
.invite-actions button:hover { background: var(--vscode-button-secondaryHoverBackground, color-mix(in srgb, var(--vscode-foreground) 16%, transparent)); }
.invite-actions button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.invite-search { width: 100%; min-height: 28px; margin-top: var(--sp-4); padding: 0 var(--sp-2); font-family: inherit; font-size: 12px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: var(--r-ctl); }
.invite-search::placeholder { color: var(--vscode-input-placeholderForeground); }
/* Роль приглашения: компактная строка с селектом — видна и до создания кода. */
.invite-role-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); margin-top: var(--sp-4); }
.invite-role-row label { font-size: 11px; color: var(--vscode-descriptionForeground); }
.invite-role-row select { flex: 0 0 auto; min-height: 24px; padding: 0 var(--sp-1); font-family: inherit; font-size: 12px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: var(--r-ctl); }
.invite-hit .email { display: block; font-size: 11px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.invite-hit .btn-invite { min-height: 20px; padding: 0 var(--sp-2); border-radius: var(--r-ctl); font-size: 11px; white-space: nowrap; background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); transition: background-color var(--dur-1) var(--ease-out); }
.invite-hit .btn-invite:hover { background: color-mix(in srgb, var(--vscode-foreground) 18%, transparent); }
.invite-hit .btn-invite[data-sent='true'] { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); background: none; cursor: default; }
.invite-empty { padding: var(--sp-2); font-size: 11px; color: var(--vscode-descriptionForeground); }

/* ---------- вход ---------- */
.signin { padding: var(--sp-3) var(--sp-2); }
.signin .sub { font-size: 12px; color: var(--vscode-descriptionForeground); line-height: 1.45; margin-bottom: var(--sp-3); }
.signin button { display: block; width: 100%; padding: var(--sp-2); margin-bottom: var(--sp-2); border-radius: var(--r-ctl); background: var(--vscode-button-background); color: var(--vscode-button-foreground); text-align: center; transition: background-color var(--dur-1) var(--ease-out); }
.signin button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }

.empty-line { font-size: 12px; color: var(--vscode-descriptionForeground); padding: 2px var(--sp-2); }
</style></head><body><div id="root"></div>
<div id="undoToast" class="hidden"><span id="undoText"></span><button id="undoBtn"></button><span class="timer" id="undoTimer"></span></div>
<script nonce="__NONCE__">
'use strict';
const vscode = acquireVsCodeApi();
let state;
let activeNav = 'board';
let feedLimit = 3;
let staticRendered = false; // профиль+навигация рендерятся один раз, списки обновляются построчно
/* ---------- приглашение в команду: секция сайдбара ---------- */
let inviteOpen = false;
let inviteQuery = '';
let inviteResults = null;
let inviteSearchTimer;
let inviteBusy = false;
const invitedIds = new Set();
const I18N = {
\t	ru: { inviteNoCode: 'Кода пока нет — создайте его, чтобы приглашать коллег.', inviteCreate: 'Создать код', copyCode: 'Скопировать код', copiedCode: 'Код скопирован', inviteHint: 'Передайте код коллеге — он вступит в команду через «Присоединиться».', inviteNew: 'Новый код', inviteRevoke: 'Отозвать', inviteSearch: 'Поиск по имени или email…', inviteSearchHint: 'Начните вводить имя или email.', inviteSearchFail: 'Не удалось загрузить каталог', inviteNotFound: 'Никого не найдено', inviteSend: 'Пригласить', invited: 'Приглашён', inviteSent: 'Приглашение отправлено', expiresToday: 'истекает сегодня', expiresInDays: 'истекает через {0} дн.', expired: 'истёк', loading: 'Загружаем…', close: 'Закрыть', requestTimeout: 'Команда не ответила', requestFailed: 'Команда завершилась ошибкой', myTasks: 'Мои задачи', subtasks: 'Подзадачи', team: 'Команда', events: 'События', showAll: 'Показать все', showMore: 'Показать ещё', online: 'в сети', offlineAgo: 'был(а) в сети', justNow: 'только что', min: 'мин', hour: 'ч', day: 'д', yesterday: 'вчера', done: 'Выполнить', move: 'Сменить статус', del: 'Удалить', clear: 'Очистить', you: 'вы', deleted: 'Задача удалена', undo: 'Отменить', invite: 'Пригласить в команду', noTasks: 'Незакрытых задач нет', quiet: 'Пока тихо', hideEvent: 'Скрыть только у себя', delEvent: 'Удалить для всей команды', hiddenEvents: 'скрытых у вас', showHidden: 'Вернуть скрытые', signin: 'Войти', signup: 'Создать аккаунт', signinSub: 'Войдите или создайте аккаунт, чтобы работать с командой: проекты, канбан, задачи и общие ключи.', profile: 'Профиль', logout: 'Выйти', inWork: 'в работе', review: 'ревью', blocked: 'блок', ready: 'готово', overdue: 'просрочено', roleOwner: 'Владелец', roleMaintainer: 'Совладелец', roleDev: 'Разработчик', roleViewer: 'Зритель', removeMember: 'Удалить из команды', memberRemoved: 'Участник удалён из команды', inviteRevoked: 'Код отозван — старый больше не действует', inviteRoleTitle: 'Приглашать с ролью', inviteCodeRole: 'роль: {0}', inviteRoleCurrent: 'Активный код выдан на роль «{0}»', times2: '×' },
\t	en: { inviteNoCode: 'No code yet — create one to invite teammates.', inviteCreate: 'Create code', copyCode: 'Copy code', copiedCode: 'Code copied', inviteHint: 'Share the code — your teammate joins with “Join”.', inviteNew: 'New code', inviteRevoke: 'Revoke', inviteSearch: 'Search by name or email…', inviteSearchHint: 'Start typing a name or email.', inviteSearchFail: 'Could not load the directory', inviteNotFound: 'Nobody found', inviteSend: 'Invite', invited: 'Invited', inviteSent: 'Invitation sent', expiresToday: 'expires today', expiresInDays: 'expires in {0} d', expired: 'expired', loading: 'Loading…', close: 'Close', requestTimeout: 'The command did not answer', requestFailed: 'The command failed', myTasks: 'My tasks', subtasks: 'Subtasks', team: 'Team', events: 'Activity', showAll: 'Show all', showMore: 'Show more', online: 'online', offlineAgo: 'last seen', justNow: 'just now', min: 'min', hour: 'h', day: 'd', yesterday: 'yesterday', done: 'Mark done', move: 'Change status', del: 'Delete', clear: 'Clear', you: 'you', deleted: 'Task deleted', undo: 'Undo', invite: 'Invite to team', noTasks: 'No open tasks', quiet: 'Nothing yet', hideEvent: 'Hide for me only', delEvent: 'Delete for the whole team', hiddenEvents: 'hidden by you', showHidden: 'Restore hidden', signin: 'Sign in', signup: 'Create account', signinSub: 'Sign in or create an account to work with your team: projects, kanban, tasks and shared keys.', profile: 'Profile', logout: 'Sign out', inWork: 'in progress', review: 'review', blocked: 'blocked', ready: 'done', overdue: 'overdue', roleOwner: 'Owner', roleMaintainer: 'Maintainer', roleDev: 'Developer', roleViewer: 'Viewer', removeMember: 'Remove from team', memberRemoved: 'The member was removed from the team', inviteRevoked: 'Code revoked — the old one no longer works', inviteRoleTitle: 'Invite with role', inviteCodeRole: 'role: {0}', inviteRoleCurrent: 'The active code grants the role “{0}”', times2: '\\u00d7' }
};
const t = (k) => (I18N[(state?.uiLanguage === 'en') ? 'en' : 'ru'] ?? I18N.ru)[k];

/* codicon-иконки: codepoints из codiconsLibrary.ts IDE */
const CP = { checklist: 0xeab3, sourceControl: 0xea68, files: 0xeaf0, key: 0xeb11, personAdd: 0xebcd, check: 0xeab2, arrowSwap: 0xebcb, trash: 0xea81, clearAll: 0xeabf, account: 0xeb99, logOut: 0xea6e, copy: 0xebcc, refresh: 0xeb37, arrowRight: 0xeab6, closeSmall: 0xea76, history: 0xeaa3 };
const ci = (name) => '<span class="ci" aria-hidden="true">&#x' + CP[name].toString(16) + ';</span>';

function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function initials(n) { const p = (n || '').trim().split(/\\\\s+/).filter(Boolean); return ((p[0]?.[0] ?? '?') + (p.length > 1 ? p[1][0] : (p[0]?.[1] ?? ''))).toUpperCase(); }
function timeAgo(iso) {
\tif (!iso) { return ''; }
\tconst s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
\tif (s < 60) { return t('justNow'); }
\tif (s < 3600) { return Math.floor(s / 60) + ' ' + t('min'); }
\tif (s < 86400) { return Math.floor(s / 3600) + ' ' + t('hour'); }
\tif (s < 172800) { return t('yesterday'); }
\treturn Math.floor(s / 86400) + ' ' + t('day');
}
/* A5: палитра из 8 приглушённых оттенков, hash(userId) % 8 */
const AVA_HUES = [215, 262, 305, 347, 20, 42, 145, 190];
function colorFor(id) {
\tlet h = 0; for (const c of String(id ?? '')) { h = (h * 31 + c.charCodeAt(0)) >>> 0; }
\tconst hue = AVA_HUES[h % AVA_HUES.length];
\treturn 'color-mix(in srgb, hsl(' + hue + ' 45% 55%) 65%, var(--vscode-editor-background))';
}
/* A4: фиксированная палитра статусов, никакого хеширования строки в цвет */
function statusMeta(task) {
\tif (task.dueAt && new Date(task.dueAt).getTime() < Date.now() && task.status !== 'done') { return { state: 'overdue', label: t('overdue') }; }
\tconst map = { doing: ['in-progress', t('inWork')], review: ['review', t('review')], blocked: ['blocked', t('blocked')], done: ['done', t('ready')] };
\treturn map[task.status] ? { state: map[task.status][0], label: map[task.status][1] } : null;
}
function describe(ev) {
\tconst ru = state?.uiLanguage !== 'en';
\tconst map = {
\t\t'team.create': ru ? 'создал команду' : 'created team',
\t\t'invite.create': ru ? 'создал код приглашения' : 'created an invite',
\t\t'invite.accept': ru ? 'вступил в команду' : 'joined the team',
\t\t'task.create': ru ? 'добавил задачу' : 'added task',
\t\t'task.update': ru ? 'обновил задачу' : 'updated task',
\t\t'task.commit_link': ru ? 'закоммитил в задачу' : 'committed to task',
\t\t'member.role': ru ? 'сменил роль' : 'changed role',
\t\t'member.add': ru ? 'добавил участника' : 'added a member',
\t\t'membership.remove': ru ? 'убрал участника из команды' : 'removed a member from the team',
\t\t'invite.revoke': ru ? 'отозвал код приглашения' : 'revoked the invite code',
\t\t'key.create': ru ? 'добавил API-ключ' : 'added an API key',
\t\t'key.disable': ru ? 'отключил API-ключ' : 'disabled an API key',
\t\t'project.create': ru ? 'создал проект' : 'created project',
\t\t'project.transfer': ru ? 'передал проект' : 'transferred project',
\t\t'archive.upload': ru ? 'загрузил архив проекта' : 'uploaded a project archive',
\t\t'activity.delete': ru ? 'удалил событие' : 'deleted an activity entry'
\t};
\treturn map[ev.action] ?? ev.action;
}
/* ---------- движение: утилиты C3/C5/C6/C10 ---------- */
/* C3: кроссфейд текста бейджа + цвет через currentColor */
function setStatus(badge, st) {
\tif (!badge || badge.dataset.state === st.state) { return; }
\tconst old = badge.querySelector('.badge-text');
\tif (!old) { return; }
\tif (!old.textContent) { badge.dataset.state = st.state; old.textContent = st.label; return; }
\tconst next = old.cloneNode(false);
\tnext.dataset.key = st.state; next.textContent = st.label;
\tnext.style.opacity = '0';
\tbadge.appendChild(next);
\tbadge.dataset.state = st.state;
\told.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'cubic-bezier(.4,0,1,1)' }).onfinish = () => old.remove();
\tnext.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'cubic-bezier(.2,0,0,1)', fill: 'forwards' });
\tbadge.classList.add('just-changed');
\tsetTimeout(() => badge.classList.remove('just-changed'), 450);
}
/* C10: вертикальный roll числа */
function rollNumber(el, text) {
\tif (!el) { return; }
\tconst cur = el.querySelector('.count-text');
\tif (cur && cur.textContent === String(text)) { return; }
\tif (!cur) { el.innerHTML = '<span class="count-text">' + esc(text) + '</span>'; return; }
\tconst next = document.createElement('span');
\tnext.className = 'count-text';
\tnext.textContent = String(text);
\tnext.style.opacity = '0';
\tel.appendChild(next);
\tcur.animate([{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(-8px)', opacity: 0 }], { duration: 160, easing: 'cubic-bezier(.4,0,1,1)' }).onfinish = () => cur.remove();
\tnext.animate([{ transform: 'translateY(8px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 160, easing: 'cubic-bezier(.2,0,0,1)', fill: 'forwards' });
}
/* C6: FLIP — при перестроении списка существующие едут на новые места, новые появляются без анимации */
function flip(container, mutate) {
\tconst items = [...container.children];
\tconst before = new Map(items.map(el => [el, el.getBoundingClientRect()]));
\tmutate();
\tfor (const el of container.children) {
\t\tconst b = before.get(el); if (!b) { continue; }
\t\tconst a = el.getBoundingClientRect();
\t\tconst dy = b.top - a.top, dx = b.left - a.left;
\t\tif (!dx && !dy) { continue; }
\t\tel.animate([{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.4,0,.2,1)' });
\t}
}
/* C5: схлопывание строки (уезжает вбок и гаснет, затем высота) */
async function collapseRow(row) {
\tconst h = row.getBoundingClientRect().height;
\trow.style.overflow = 'hidden';
\tawait row.animate(
\t\t[{ transform: 'none', opacity: 1 }, { transform: 'translateX(-24px)', opacity: 0 }],
\t\t{ duration: 160, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }
\t).finished;
\tawait row.animate(
\t\t[{ height: h + 'px', marginBottom: '2px' }, { height: '0px', marginBottom: '0px' }],
\t\t{ duration: 240, easing: 'cubic-bezier(.2,0,0,1)', fill: 'forwards' }
\t).finished;
}
/* C5: тост с полоской-таймером; несколько удалений подряд — один тост со счётчиком */
const pendingDeletes = [];
let undoTimer;
/* C5: тост с полоской-таймером; несколько удалений подряд — один тост со счётчиком.
   Запрос уходит на сервер сразу (там soft-delete в корзину): раньше он откладывался
   на 5 секунд, и перерисовка вебвью теряла его — задача оставалась живой. */
function showUndoToast(count) {
	const toast = document.getElementById('undoToast');
	clearTimeout(undoTimer);
	document.getElementById('undoText').textContent = t('deleted') + (count > 1 ? ' (' + count + ')' : '');
	const timerEl = document.getElementById('undoTimer');
	timerEl.style.transition = 'none';
	timerEl.style.transform = 'scaleX(1)';
	void timerEl.offsetWidth;
	timerEl.style.transition = 'transform 5s linear';
	timerEl.style.transform = 'scaleX(0)';
	const btn = document.getElementById('undoBtn');
	btn.textContent = t('undo');
	btn.onclick = () => {
		clearTimeout(undoTimer);
		toast.classList.add('hidden');
		/* отмена: возвращаем удалённые на сервере — строки приедут через broadcast/FLIP */
		pendingDeletes.splice(0).forEach((id) => vscode.postMessage({ type: 'invoke', command: 'auraTeam.restoreTask', args: [id] }));
		render();
	};
	toast.classList.remove('hidden');
	undoTimer = setTimeout(() => {
		toast.classList.add('hidden');
		/* запрос уже отправлен: очередь нужна только для отмены */
		pendingDeletes.length = 0;
		render();
	}, 5000);
}
async function deleteTask(id, row) {
	if (!pendingDeletes.includes(id)) { pendingDeletes.push(id); }
	vscode.postMessage({ type: 'invoke', command: 'auraTeam.deleteTask', args: [id] });
	if (row) { await collapseRow(row); row.remove(); }
	showUndoToast(pendingDeletes.length);
}
/* Кик участника: подтверждение спрашивает расширение (модалка), панель только просит. */
async function kickMember(memberId) {
	if (!memberId) { return; }
	try {
		const result = await invokeRemote('auraTeam.removeMember', [memberId]);
		if (result && result.ok === false) { return; }
		toastText(t('memberRemoved'));
	} catch (err) {
		toastText(err.message);
	}
}

/* Сайдбар не умел ждать ответ на invoke: добавляем корреляцию по id —
   без неё каталог приглашений и код с сервера получить было нечем. */
let nextRequestId = 1;
const pendingRequests = new Map();
function invokeRemote(command, args) {
	const id = nextRequestId++;
	return new Promise((resolve, reject) => {
		pendingRequests.set(id, { resolve, reject });
		vscode.postMessage({ type: 'invoke', id, command, args });
		setTimeout(() => {
			const pending = pendingRequests.get(id);
			if (pending) { pendingRequests.delete(id); pending.reject(new Error(t('requestTimeout'))); }
		}, 12000);
	});
}
function toastText(text) { if (text) { vscode.postMessage({ type: 'toast', text }); } }
/* Приглашение живёт в сайдбаре: вкладка редактора уводила от контекста,
   а результат оставался только в уведомлении. */
function inviteExpiresLabel() {
	const iso = state._inviteExpires;
	if (!iso) { return ''; }
	const days = (new Date(iso).getTime() - Date.now()) / 864e5;
	if (!(days > 0)) { return t('expired'); }
	/* Math.round, а не floor: свежий 7-дневный код показывался как «6 дн.» */
	return days < 1 ? t('expiresToday') : t('expiresInDays').replace('{0}', Math.round(days));
}
/* Роль приглашения: селектор задаёт и роль кода, и роль персональных приглашений.
   Список ограничен своей ролью — совладельца зовёт только владелец (то же правило на сервере). */
let inviteRole = 'dev';
function invitableRoles() {
	const myRole = (state.session?.teams ?? []).find(team => team.id === state.teamId)?.role ?? 'viewer';
	if (myRole === 'owner') { return ['maintainer', 'dev', 'viewer']; }
	if (myRole === 'maintainer') { return ['dev', 'viewer']; }
	return ['dev'];
}
function inviteRoleLabel(role) { return t('role' + String(role ?? '').charAt(0).toUpperCase() + String(role ?? '').slice(1)); }
function inviteRoleRowHtml() {
	const roles = invitableRoles();
	/* Роль могла стать недоступной (сменили свою) — мягко возвращаемся к допустимой. */
	if (!roles.includes(inviteRole)) { inviteRole = roles[0]; }
	return '<div class="invite-role-row"><label for="inviteRole">' + esc(t('inviteRoleTitle')) + '</label>' +
		'<select id="inviteRole">' + roles.map(role => '<option value="' + role + '"' + (role === inviteRole ? ' selected' : '') + '>' + esc(inviteRoleLabel(role)) + '</option>').join('') + '</select></div>';
}
function inviteCodeHtml() {
	const code = state._inviteCode;
	if (!code) {
		return '<div class="invite-hint">' + esc(t('inviteNoCode')) + '</div>' +
			'<div class="invite-actions"><button class="primary" id="inviteCreateBtn">' + esc(t('inviteCreate')) + '</button></div>';
	}
	/* Мета кода: срок действия и роль, с которой вступят по нему. */
	const codeRole = state._inviteRole ? inviteRoleLabel(state._inviteRole) : '';
	const meta = [inviteExpiresLabel(), codeRole ? t('inviteCodeRole').replace('{0}', codeRole) : ''].filter(Boolean).join(' · ');
	/* Селектор управляет новыми кодами: если активный код выдан на другую роль, говорим об этом прямо. */
	const mismatch = codeRole && state._inviteRole !== inviteRole
		? '<div class="invite-hint">' + esc(t('inviteRoleCurrent').replace('{0}', codeRole)) + '</div>' : '';
	return '<div class="invite-code"><span class="code" title="' + esc(code) + '">' + esc(code) + '</span>' +
		(meta ? '<span class="expires">' + esc(meta) + '</span>' : '') +
		'<button class="act-btn" id="inviteCopyBtn" aria-label="' + esc(t('copyCode')) + '" title="' + esc(t('copyCode')) + '">' + ci('copy') + '</button></div>' +
		mismatch +
		'<div class="invite-hint">' + esc(t('inviteHint')) + '</div>' +
		'<div class="invite-actions"><button id="inviteNewBtn">' + esc(t('inviteNew')) + '</button>' +
		'<button id="inviteRevokeBtn">' + esc(t('inviteRevoke')) + '</button></div>';
}
function inviteHitHtml(person, meId) {
	const member = (state.summary?.members ?? []).find((m) => m.id === person.id);
	const isMe = person.id === meId;
	const sent = invitedIds.has(person.id) || Boolean(member);
	const dot = member ? presenceHtml(member, isMe) : '';
	return '<div class="row invite-hit">' +
		'<span class="ava" style="background:' + colorFor(person.id) + ';width:20px;height:20px;font-size:11px">' + esc(initials(person.displayName)) + dot + '</span>' +
		'<span class="title">' + esc(person.displayName) + (person.email ? '<span class="email">' + esc(person.email) + '</span>' : '') + '</span>' +
		'<span class="end"><button class="btn-invite" data-invite-user="' + esc(person.id) + '"' + (sent ? ' data-sent="true" disabled' : '') + '>' + esc(sent ? t('invited') : t('inviteSend')) + '</button></span></div>';
}
function renderInviteSection() {
	const section = document.getElementById('secInvite');
	if (!section) { return; }
	section.dataset.open = inviteOpen ? 'true' : 'false';
	if (!inviteOpen) { return; }
	const body = document.getElementById('inviteBody');
	if (!body) { return; }
	/* Поле поиска создаём один раз: перерисовка списка не должна отбирать фокус. */
	if (!body.querySelector('#inviteCodeSlot')) {
		/* Селектор роли — часть скелета: он не должен пересоздаваться при обновлении кода. */
		body.innerHTML = '<div id="inviteRoleRow"></div>' +
			'<div id="inviteCodeSlot"></div>' +
			'<input class="invite-search" id="inviteSearch" type="search" autocomplete="off" spellcheck="false" placeholder="' + esc(t('inviteSearch')) + '" value="' + esc(inviteQuery) + '">' +
			'<div class="list" id="inviteResults"></div>';
	} else {
		const input = document.getElementById('inviteSearch');
		if (input && document.activeElement !== input && input.value !== inviteQuery) { input.value = inviteQuery; }
	}
	/* Роль считаем до блока кода: подсказка про активный код сравнивает его роль с выбранной. */
	const roleRow = body.querySelector('#inviteRoleRow');
	if (roleRow) {
		const roleHtml = inviteRoleRowHtml();
		if (roleRow.innerHTML !== roleHtml) { roleRow.innerHTML = roleHtml; }
	}
	const slot = body.querySelector('#inviteCodeSlot');
	const slotHtml = inviteCodeHtml();
	if (slot.innerHTML !== slotHtml) { slot.innerHTML = slotHtml; }
	const results = document.getElementById('inviteResults');
	if (results) {
		if (inviteResults === null) {
			const html = '<div class="invite-empty">' + esc(inviteBusy ? t('loading') : t('inviteSearchHint')) + '</div>';
			if (results.innerHTML !== html) { results.innerHTML = html; }
		} else if (!inviteResults.length) {
			const html = '<div class="invite-empty">' + esc(t('inviteNotFound')) + '</div>';
			if (results.innerHTML !== html) { results.innerHTML = html; }
		} else {
			/* Подсказка — отдельный узел: без явного удаления она висела первой строкой
			   над уже приехавшими результатами каталога. */
			results.querySelector('.invite-empty')?.remove();
			syncList(results, inviteResults, (person) => inviteHitHtml(person, state.session?.user?.id), (person) => person.id);
		}
	}
	/* Перерисовка блока кода заменяет кнопки: обработчики вешаем здесь же, а не у вызывающего,
	   иначе ответ каталога «отвязывал» скопировать/отозвать до следующего действия пользователя. */
	wireInvite();
}
function wireInviteRows(scope) {
	for (const btn of scope.querySelectorAll('[data-invite-user]')) {
		if (btn.dataset.wired === 'true') { continue; }
		btn.dataset.wired = 'true';
		btn.onclick = () => { void sendInvite(btn); };
	}
}
function wireInvite() {
	const section = document.getElementById('secInvite');
	if (!section) { return; }
	const on = (id, fn) => { const el = document.getElementById(id); if (el) { el.onclick = fn; } };
	on('inviteCloseBtn', () => setInviteOpen(false));
	on('inviteCopyBtn', () => { void copyInviteCode(); });
	on('inviteCreateBtn', () => { void regenerateInvite(); });
	on('inviteNewBtn', () => { void regenerateInvite(); });
	on('inviteRevokeBtn', () => { void revokeInvite(); });
	const roleSelect = document.getElementById('inviteRole');
	if (roleSelect && roleSelect.dataset.wired !== 'true') {
		roleSelect.dataset.wired = 'true';
		roleSelect.onchange = () => { inviteRole = roleSelect.value; renderInviteSection(); };
	}
	const input = document.getElementById('inviteSearch');
	if (input && input.dataset.wired !== 'true') {
		input.dataset.wired = 'true';
		input.oninput = () => {
			inviteQuery = input.value;
			clearTimeout(inviteSearchTimer);
			inviteSearchTimer = setTimeout(() => { void loadDirectory(inviteQuery); }, 250);
		};
	}
	wireInviteRows(section);
}
function setInviteOpen(open) {
	inviteOpen = Boolean(open);
	updateNav();
	renderInviteSection();
	wireInvite();
	if (!inviteOpen) { return; }
	if (!state._inviteCode && !inviteBusy) { void askInviteCode(); }
	void loadDirectory(inviteQuery);
}
async function loadDirectory(query) {
	inviteBusy = true;
	renderInviteSection();
	try {
		const rows = await invokeRemote('auraTeam.directory', [query ?? '']);
		inviteResults = Array.isArray(rows) ? rows : [];
	} catch {
		inviteResults = [];
		toastText(t('inviteSearchFail'));
	} finally {
		inviteBusy = false;
		renderInviteSection();
	}
}
async function askInviteCode() {
		inviteBusy = true;
	try {
		const invite = await invokeRemote('auraTeam.currentInvite', []);
		state._inviteCode = invite?.code ?? null;
		state._inviteExpires = invite?.expiresAt ?? null;
		state._inviteRole = invite?.role ?? null;
	} catch { /* пустое состояние с кнопкой создания */ }
	inviteBusy = false;
	renderInviteSection();
	wireInvite();
}
async function copyInviteCode() {
	if (!state._inviteCode) { return; }
	vscode.postMessage({ type: 'invoke', command: 'auraTeam.copyToClipboard', args: [state._inviteCode] });
	toastText(t('copiedCode'));
}
async function regenerateInvite() {
	try {
		/* Код создаётся сразу с выбранной ролью: вступивший получит именно её. */
		const invite = await invokeRemote('auraTeam.createInvite', [inviteRole]);
		state._inviteCode = invite?.code ?? null;
		state._inviteExpires = invite?.expiresAt ?? null;
		state._inviteRole = invite?.role ?? inviteRole;
		invitedIds.clear();
		toastText(t('copiedCode'));
	} catch (err) {
		toastText(err.message);
	}
	renderInviteSection();
	wireInvite();
}
async function revokeInvite() {
	let result;
	try { result = await invokeRemote('auraTeam.revokeInvite', []); } catch (err) { toastText(err.message); return; }
	/* Отмена подтверждения в расширении не должна выглядеть как сработавший отзыв. */
	if (result && result.ok === false) { renderInviteSection(); return; }
	state._inviteCode = null;
	state._inviteExpires = null;
	toastText(t('inviteRevoked'));
	renderInviteSection();
}
/* Отправка помечает кнопку сразу — список не перезагружается, фокус не теряется. */
async function sendInvite(btn) {
	const id = btn.dataset.inviteUser;
	/* Повторный клик (в т.ч. по копии строки из прошлых перерисовок) — не второй запрос. */
	if (!id || btn.dataset.sent === 'true') { return; }
	invitedIds.add(id);
	btn.dataset.sent = 'true';
	btn.disabled = true;
	btn.textContent = t('invited');
	try { await invokeRemote('auraTeam.sendInvite', [id, inviteRole]); toastText(t('inviteSent')); } catch (err) {
		invitedIds.delete(id);
		btn.dataset.sent = 'false';
		btn.disabled = false;
		btn.textContent = t('inviteSend');
		toastText(err.message);
	}
}
function render() {
\tconst root = document.getElementById('root');
\tif (!state?.signedIn) {
\t\tstaticRendered = false;
\t\troot.innerHTML = '<div class="signin"><div class="sub">' + esc(t('signinSub')) + '</div>' +
\t\t\t'<button data-view="login">' + esc(t('signin')) + '</button>' +
\t\t\t'<button class="secondary" data-view="register">' + esc(t('signup')) + '</button></div>';
\t\tfor (const b of root.querySelectorAll('button[data-view]')) { b.onclick = () => vscode.postMessage({ type: 'open', view: b.dataset.view }); }
\t\treturn;
\t}
\tconst u = state.session?.user ?? {};
\tif (!staticRendered) {
\t\t/* статичные части — один раз (C7/C11: каскада нет) */
\t\tconst teamName = (state.session?.teams ?? []).find(tm => tm.id === state.teamId)?.name ?? '';
\t\t/* A1: хендл/подпись — только если есть и не дублирует имя */
\t\tconst sub = teamName && teamName !== u.displayName ? teamName : '';
\t\tlet html = '<div class="me" id="meRow" tabindex="0" role="button" aria-haspopup="menu" title="' + esc(u.displayName ?? '') + '">' +
\t\t\t'<span class="ava" style="background:' + colorFor(u.id) + '">' + esc(initials(u.displayName)) + '<span class="presence" title="' + esc(t('online')) + '"></span></span>' +
\t\t\t'<span class="who"><span class="name">' + esc(u.displayName ?? '') + '</span>' +
\t\t\t(sub ? '<span class="handle">' + esc(sub) + '</span>' : '') +
\t\t\t'</span></div>';
\t\tconst navItems = [
\t\t\t['board', state.uiLanguage === 'en' ? 'Kanban & tasks' : 'Канбан и задачи', 'checklist'],
\t\t\t['git', state.uiLanguage === 'en' ? 'Projects & Git' : 'Проекты и Git', 'sourceControl'],
\t\t\t['files', state.uiLanguage === 'en' ? 'Files' : 'Файлы', 'files'],
\t\t\t['keys', state.uiLanguage === 'en' ? 'Team keys' : 'Ключи команды', 'key'],
\t\t\t['invite', t('invite'), 'personAdd']
\t\t];
\t\thtml += '<nav aria-label="Team"><ul class="nav" style="list-style:none;margin:0;padding:0" id="navList">';
\t\tfor (const [view, label, icon] of navItems) {
\t\t\thtml += '<li><button class="nav-item" data-view="' + view + '"' + (view !== 'invite' && activeNav === view ? ' aria-current="page"' : '') + '>' + ci(icon) + '<span class="title">' + esc(label) + '</span></button></li>';
\t\t}
\t\thtml += '</ul></nav>';
\t\thtml += '<div class="section" id="secTasks"><div class="side-label"><span>' + esc(t('myTasks')) + '</span><span class="count" id="tasksCount"></span></div><div class="list" id="taskList"></div></div>';
\t\thtml += '<div class="section" id="secTeam"><div class="side-label"><span>' + esc(t('team')) + '</span><span class="count" id="teamCount"></span></div><div class="list" id="teamList"></div></div>';
\t\thtml += '<div class="section" id="secInvite" data-open="false"><div class="side-label"><span>' + esc(t('invite')) + '</span><span class="label-actions"><button class="act-btn" id="inviteCloseBtn" aria-label="' + esc(t('close')) + '" title="' + esc(t('close')) + '">' + ci('closeSmall') + '</button></span></div><div id="inviteBody"></div></div>';
		html += '<div class="section" id="secEvents"><div class="side-label"><span>' + esc(t('events')) + '</span><span class=\"label-actions\"><button class=\"act-btn\" id=\"restoreFeedBtn\" style=\"display:none\" aria-label=\"' + esc(t('showHidden')) + '\" title=\"' + esc(t('showHidden')) + '\">' + ci('history') + '</button><button class=\"act-btn\" id=\"clearFeedBtn\" aria-label="' + esc(t('clear')) + '" title="' + esc(t('clear')) + '">' + ci('clearAll') + '</button></span></div><div class="list" id="eventList"></div></div>';
\t\troot.innerHTML = html;
\t\tbindStaticHandlers();
\t\tstaticRendered = true;
\t}
\tupdateNav();
\tupdateLists();
	renderInviteSection();
	wireInvite();
}
function updateNav() {
\tfor (const b of document.querySelectorAll('.nav-item[data-view]')) {
\t\t/* «Пригласить» — не отдельный экран, а раскрывающаяся секция панели. */
\t\tif (b.dataset.view === 'invite') { b.classList.toggle('active', inviteOpen); }
\t\telse if (activeNav === b.dataset.view) { b.setAttribute('aria-current', 'page'); }
\t\telse { b.removeAttribute('aria-current'); }
\t}
}
function subCountHtml(task) {
\tconst s = task && task.subtasks;
\treturn s && s.total ? ' <span class="sub-count" title="' + esc(t('subtasks')) + '">' + s.done + '/' + s.total + '</span>' : '';
}
function taskRowHtml(task) {
\tconst st = statusMeta(task);
\treturn '<div class="row task-row" tabindex="0" data-task="' + esc(task.id) + '" data-view="board">' +
\t\t'<span></span>' +
\t\t'<span class="title">' + (st ? '<span class="badge" data-state="' + st.state + '"><span class="badge-text" data-key="' + st.state + '">' + esc(st.label) + '</span></span> ' : '') + esc(task.title) + subCountHtml(task) + '</span>' +
\t\t'<span class="end"><span class="time">' + esc(timeAgo(task.dueAt)) + '</span>' +
\t\t'<span class="actions">' +
\t\t'<button class="act-btn" data-done-task="' + esc(task.id) + '" aria-label="' + esc(t('done')) + '" title="' + esc(t('done')) + '">' + ci('check') + '</button>' +
\t\t'<button class="act-btn" data-status-task="' + esc(task.id) + '" aria-label="' + esc(t('move')) + '" title="' + esc(t('move')) + '">' + ci('arrowSwap') + '</button>' +
\t\t'<button class="act-btn danger" data-del-task="' + esc(task.id) + '" aria-label="' + esc(t('del')) + '" title="' + esc(t('del')) + '">' + ci('trash') + '</button>' +
\t\t'</span></span></div>';
}
/* Присутствие: зелёная точка — в сети, серая — был(а) в сети; детали в title. */
function presenceHtml(member, isMe) {
	const online = Boolean(member.online) || isMe;
	const title = online ? t('online') : (member.lastSeenAt ? t('offlineAgo') + ' ' + timeAgo(member.lastSeenAt) : t('offlineAgo') + ': —');
	return '<span class=\"presence ' + (online ? 'live' : 'off') + '\" title=\"' + esc(title) + '\"></span>';
}
/* Роль в сайдбаре печаталась сырым owner/dev/viewer — теперь по-русски (или по-английски). */
function memberRoleLabel(m, isMe) {
	if (isMe) { return t('you'); }
	const raw = String(m.role ?? '').trim();
	if (raw.length < 2 || raw === m.displayName) { return ''; }
	return t('role' + raw.charAt(0).toUpperCase() + raw.slice(1)) ?? raw;
}
function memberRoleHtml(m, isMe) {
	const label = memberRoleLabel(m, isMe);
	return label ? '<span class=\"m-role\">' + esc(label) + '</span>' : '';
}
/* Кик по роли: владелец убирает любого кроме владельца, совладелец — dev/viewer. */
function canKickMember(m, meId) {
	if (!m || m.id === meId || m.role === 'owner') { return false; }
	const myRole = (state.session?.teams ?? []).find(team => team.id === state.teamId)?.role ?? 'viewer';
	return myRole === 'owner' || (myRole === 'maintainer' && ['dev', 'viewer'].includes(m.role));
}
function memberKickHtml(m, meId) {
	if (!canKickMember(m, meId)) { return ''; }
	return '<button class=\"act-btn danger\" data-kick-member=\"' + esc(m.id) + '\" aria-label=\"' + esc(t('removeMember')) + '\" title=\"' + esc(t('removeMember')) + '\">' + ci('closeSmall') + '</button>';
}
function memberRowHtml(m, meId) {
	const isMe = m.id === meId;
	const role = memberRoleHtml(m, isMe);
	return '<div class=\"row member-row\" tabindex=\"0\" data-member=\"' + esc(m.id) + '\" data-view=\"board\">' +
		'<span class=\"ava\" style=\"background:' + colorFor(m.id) + ';width:20px;height:20px;font-size:11px\">' + esc(initials(m.displayName)) + presenceHtml(m, isMe) + '</span>' +
		'<span class=\"title\">' + esc(m.displayName) + '</span>' +
		'<span class=\"end\">' + role + '<span class=\"actions\">' + memberKickHtml(m, meId) + '</span></span></div>';
}
/* Событие: ✕ скрывает запись только у вас, корзина (owner/maintainer) удаляет
   её из аудита для всей команды. */
function eventRowHtml(ev, evKey, canDelete) {
	/* A2: счётчик повторов — инлайн ×N сразу после сущности */
	const rep = ev.count > 1 ? ' <span class=\"rep\">' + t('times2') + ev.count + '</span>' : '';
	const delBtn = canDelete && ev.id ? '<button class=\"act-btn danger\" data-del-event=\"' + esc(ev.id) + '\" aria-label=\"' + esc(t('delEvent')) + '\" title=\"' + esc(t('delEvent')) + '\">' + ci('trash') + '</button>' : '';
	return '<div class=\"row ev-row\" data-evkey=\"' + esc(evKey) + '\">' +
		'<span></span>' +
		'<span class=\"title\">' + esc(ev.userName) + ' ' + esc(describe(ev)) + (ev.taskTitle ? ' <span class=\"ev-entity\" data-view=\"board\">«' + esc(ev.taskTitle) + '»</span>' : '') + rep + '</span>' +
		'<span class=\"end\"><span class=\"time\">' + esc(timeAgo(ev.latestAt)) + '</span>' +
		'<span class=\"actions\">' + delBtn +
		'<button class=\"act-btn\" data-dismiss-ev=\"' + esc(evKey) + '\" aria-label=\"' + esc(t('hideEvent')) + '\" title=\"' + esc(t('hideEvent')) + '\">' + ci('closeSmall') + '</button>' +
		'</span></span></div>';
}
function syncList(container, wanted, makeHtml, keyOf, onExisting) {
\t/* diff-обновление: существующие обновляем на месте (без анимации появления), новые — без анимации, пропавшие — схлопываем */
\tconst existingByKey = new Map();
\tfor (const el of [...container.querySelectorAll('[data-keyid]')]) { existingByKey.set(el.dataset.keyid, el); }
\tconst newHtml = [];
\tconst kept = new Set();
\tfor (const item of wanted) {
\t\tconst key = keyOf(item);
\t\tconst el = existingByKey.get(key);
\t\t/* Строка переиспользуется, даже когда обновлять её нечем: раньше без onExisting
\t\t   она создавалась заново, и список приглашений дублировался на каждом обновлении. */
\t\tif (el) { if (onExisting) { onExisting(el, item); } kept.add(key); }
\t\telse { newHtml.push({ key, html: makeHtml(item) }); kept.add(key); }
\t}
\tconst removed = [];
\tfor (const [key, el] of existingByKey) { if (!kept.has(key)) { removed.push(el); } }
\tflip(container, () => {
\t\t/* новые — в правильный порядок */
\t\tconst anchorMap = new Map(wanted.map((item, i) => [keyOf(item), i]));
\t\tfor (const { key, html } of newHtml) {
\t\t\tconst tpl = document.createElement('template');
\t\t\ttpl.innerHTML = html.trim();
\t\t\tconst node = tpl.content.firstElementChild;
\t\t\tnode.dataset.keyid = key;
\t\t\tlet anchor = null;
\t\t\tconst myIdx = anchorMap.get(key);
\t\t\tfor (let i = myIdx + 1; i < wanted.length; i++) {
\t\t\t\tconst probe = container.querySelector('[data-keyid="' + CSS.escape(keyOf(wanted[i])) + '"]');
\t\t\t\tif (probe) { anchor = probe; break; }
\t\t\t}
\t\t\tif (anchor) { container.insertBefore(node, anchor); } else { container.appendChild(node); }
\t\t}
\t\tfor (const el of removed) { el.remove(); }
\t});
\t/* пропавшие схлопываем после FLIP-перестановки */
\tfor (const el of removed) { void el; }
\treturn removed;
}
function updateLists() {
\tconst u = state.session?.user ?? {};
\tconst summary = state.summary;
\tconst myTasks = (summary?.myTasks ?? []).filter((task) => !pendingDeletes.includes(task.id));
\trollNumber(document.getElementById('tasksCount'), myTasks.length);
\tconst taskList = document.getElementById('taskList');
\tconst shownTasks = myTasks.slice(0, 5);
\tconst taskExtras = document.getElementById('taskExtras');
\tif (myTasks.length > 5 && !taskExtras) {
\t\tconst btn = document.createElement('button');
\t\tbtn.className = 'link-btn'; btn.id = 'taskExtras'; btn.dataset.view = 'board';
\t\tbtn.innerHTML = ci('arrowRight') + '<span class="title">' + esc(t('showAll')) + ' (' + myTasks.length + ')</span>';
\t\tbtn.onclick = () => vscode.postMessage({ type: 'open', view: 'board' });
\t\ttaskList.after(btn);
\t} else if (myTasks.length <= 5 && taskExtras) { taskExtras.remove(); }
\tsyncList(taskList, shownTasks, (task) => taskRowHtml(task), (task) => task.id, (el, task) => {
\t\tconst st = statusMeta(task);
\t\tconst badge = el.querySelector('.badge');
\t\tconst titleEl = el.querySelector('.title');
\t\tif (st && !badge) { titleEl.insertAdjacentHTML('afterbegin', '<span class="badge" data-state="' + st.state + '"><span class="badge-text" data-key="' + st.state + '">' + esc(st.label) + '</span></span> '); }
\t\telse if (st && badge) { setStatus(badge, st); }
\t\telse if (!st && badge) { badge.remove(); }
\t\tconst sub = titleEl.querySelector('.sub-count');
\t\tif (sub && !(task.subtasks && task.subtasks.total)) { sub.remove(); }
\t\telse if (sub) { const label = task.subtasks.done + '/' + task.subtasks.total; if (sub.textContent !== label) { sub.textContent = label; } }
\t\telse if (task.subtasks && task.subtasks.total) { titleEl.insertAdjacentHTML('beforeend', ' <span class="sub-count" title="' + esc(t('subtasks')) + '">' + task.subtasks.done + '/' + task.subtasks.total + '</span>'); }
\t\tconst time = el.querySelector('.time');
\t\tif (time) { time.textContent = timeAgo(task.dueAt); }
\t});

\tconst members = [...(summary?.members ?? [])].sort((a, b) => Number(Boolean(b.online)) - Number(Boolean(a.online)) || String(a.displayName).localeCompare(String(b.displayName)));
\tconst onlineCount = members.filter(m => m.online).length;
\tconst teamCountEl = document.getElementById('teamCount');
\tteamCountEl.title = onlineCount + ' ' + t('online') + ' — ' + members.length;
\trollNumber(teamCountEl, onlineCount);
\tsyncList(document.getElementById('teamList'), members.slice(0, 8), (m) => memberRowHtml(m, u.id), (m) => m.id, (el, m) => {
\t\tconst isMe = m.id === u.id;
\t\tconst dot = el.querySelector('.presence');
		if (dot) {
			const dotOnline = Boolean(m.online) || isMe;
			dot.classList.toggle('live', dotOnline);
			dot.classList.toggle('off', !dotOnline);
			dot.title = dotOnline ? t('online') : (m.lastSeenAt ? t('offlineAgo') + ' ' + timeAgo(m.lastSeenAt) : t('offlineAgo') + ': —');
		}
		const end = el.querySelector('.end');
		/* Роль и кнопка кика обновляются точечно: end.innerHTML стирал бы кнопку. */
		const label = memberRoleLabel(m, isMe);
		let roleEl = end.querySelector('.m-role');
		if (label && !roleEl) { end.insertAdjacentHTML('afterbegin', memberRoleHtml(m, isMe)); roleEl = end.querySelector('.m-role'); }
		else if (!label && roleEl) { roleEl.remove(); roleEl = null; }
		else if (label && roleEl && roleEl.textContent !== label) { roleEl.textContent = label; }
		const actions = end.querySelector('.actions');
		const kickNow = actions ? actions.querySelector('[data-kick-member]') : null;
		const kickWant = memberKickHtml(m, u.id);
		if (kickWant && !kickNow && actions) { actions.insertAdjacentHTML('beforeend', kickWant); }
		else if (!kickWant && kickNow) { kickNow.remove(); }

\t});

\t/* события: схлопывание дублей, feedLimit первых, хвост в collapsible (C7) */
\tconst dismissed = new Set(state.dismissedActivity ?? []);
\tconst key = (ev) => ev.createdAt + '|' + ev.action + '|' + ev.userId;
\tconst me = members.find((m) => m.id === u.id);
	const canDeleteEvents = Boolean(me && (me.role === 'owner' || me.role === 'maintainer'));
	const feedAll = (state.activity ?? []).filter(ev => !dismissed.has(key(ev)));
	const hiddenEvents = (state.activity ?? []).length - feedAll.length;
	const restoreFeedBtn = document.getElementById('restoreFeedBtn');
	if (restoreFeedBtn) {
		restoreFeedBtn.style.display = hiddenEvents ? '' : 'none';
		restoreFeedBtn.title = t('showHidden') + ' (' + hiddenEvents + ' ' + t('hiddenEvents') + ')';
	}
\tconst collapsed = [];
\tfor (const ev of feedAll) {
\t\tconst last = collapsed[collapsed.length - 1];
\t\tif (last && last.userId === ev.userId && last.action === ev.action && last.taskTitle === ev.taskTitle) { last.count += 1; last.latestAt = ev.createdAt; }
\t\telse { collapsed.push({ ...ev, count: 1, latestAt: ev.createdAt }); }
\t}
\tconst eventList = document.getElementById('eventList');
\tconst head = collapsed.slice(0, feedLimit);
\tconst tail = collapsed.slice(feedLimit);
\t/* хвост оборачиваем в collapsible */
\tlet tailWrap = document.getElementById('eventTail');
\tif (tail.length && !tailWrap) {
\t\ttailWrap = document.createElement('div');
\t\ttailWrap.className = 'collapsible'; tailWrap.id = 'eventTail';
\t\ttailWrap.innerHTML = '<div class="list" id="eventTailList"></div>';
\t\teventList.after(tailWrap);
\t\trequestAnimationFrame(() => { tailWrap.dataset.open = 'true'; });
\t} else if (!tail.length && tailWrap) { tailWrap.dataset.open = 'false'; setTimeout(() => tailWrap.remove(), 250); }
\tconst tailList = document.getElementById('eventTailList');
\tsyncList(eventList, head, (ev) => eventRowHtml(ev, key(ev), canDeleteEvents), (ev) => key(ev), (el, ev) => {
\t\tconst rep = ev.count > 1 ? t('times2') + ev.count : '';
\t\tconst repEl = el.querySelector('.rep');
\t\tif (rep && !repEl) { el.querySelector('.title').insertAdjacentHTML('beforeend', ' <span class="rep">' + esc(rep) + '</span>'); }
\t\telse if (rep && repEl) { repEl.textContent = rep; }
\t\telse if (!rep && repEl) { repEl.remove(); }
\t\tel.querySelector('.time').textContent = timeAgo(ev.latestAt);
\t});
\tif (tailList) { syncList(tailList, tail, (ev) => eventRowHtml(ev, key(ev), canDeleteEvents), (ev) => key(ev), (el, ev) => { el.querySelector('.time').textContent = timeAgo(ev.latestAt); }); }
\tconst clearFeedBtn = document.getElementById('clearFeedBtn');
\tclearFeedBtn.style.display = collapsed.length ? '' : 'none';
}
function bindStaticHandlers() {
\tfor (const b of document.querySelectorAll('.nav-item[data-view]')) {
\t\tb.onclick = () => {
\t\t\tconst view = b.dataset.view;
\t\t\tif (view === 'invite') { setInviteOpen(!inviteOpen); return; }
\t\t\tactiveNav = view;
\t\t\tupdateNav();
\t\t\tvscode.postMessage({ type: 'open', view });
\t\t};
\t}
\tbindArrowNav(document.getElementById('navList'));
\tconst meRow = document.getElementById('meRow');
\tmeRow.onclick = toggleMeMenu;
\tmeRow.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMeMenu(); } };
\tbindListHandlers();
\tconst clearFeedBtn = document.getElementById('clearFeedBtn');
\tclearFeedBtn.onclick = () => {
\t\tconst dismissed = new Set(state.dismissedActivity ?? []);
\t\tconst key = (ev) => ev.createdAt + '|' + ev.action + '|' + ev.userId;
\t\tfor (const ev of (state.activity ?? [])) { if (!dismissed.has(key(ev))) { vscode.postMessage({ type: 'invoke', command: 'auraTeam.dismissActivity', args: [key(ev)] }); } }
\t};
	const restoreFeedBtn = document.getElementById('restoreFeedBtn');
	if (restoreFeedBtn) {
		restoreFeedBtn.onclick = () => {
			state.dismissedActivity = [];
			vscode.postMessage({ type: 'invoke', command: 'auraTeam.undismissAllActivity', args: [] });
			render();
		};
	}
}
function bindListHandlers() {
\tconst root = document.getElementById('root');
\t/* делегирование: обработчики не пересоздаются при diff-обновлении строк */
\troot.onkeydown = (e) => {
\t\tconst row = e.target.closest('.task-row, .member-row');
\t\tif (!row) { return; }
\t\tif (e.key === 'Enter') {
\t\t\tif (row.classList.contains('task-row')) { vscode.postMessage({ type: 'open', view: 'board', filter: { task: row.dataset.task } }); }
\t\t\telse { vscode.postMessage({ type: 'open', view: 'board', filter: { member: row.dataset.member } }); }
\t\t}
\t\tif (e.key === 'Delete' && row.classList.contains('task-row')) { deleteTask(row.dataset.task, row); }
\t};
\troot.onclick = (e) => {
\t\tconst doneBtn = e.target.closest('[data-done-task]');
\t\tif (doneBtn) { e.stopPropagation(); vscode.postMessage({ type: 'invoke', command: 'auraTeam.updateTask', args: [doneBtn.dataset.doneTask, { status: 'done' }] }); return; }
\t\tconst statusBtn = e.target.closest('[data-status-task]');
\t\tif (statusBtn) {
\t\t\te.stopPropagation();
\t\t\tconst task = (state?.summary?.myTasks ?? []).find(x => x.id === statusBtn.dataset.statusTask);
\t\t\tconst cycle = ['todo', 'doing', 'review', 'done'];
\t\t\tconst next = cycle[(cycle.indexOf(task?.status ?? 'todo') + 1) % cycle.length];
\t\t\tvscode.postMessage({ type: 'invoke', command: 'auraTeam.updateTask', args: [statusBtn.dataset.statusTask, { status: next }] });
\t\t\treturn;
\t\t}
\t\tconst delBtn = e.target.closest('[data-del-task]');
\t\tif (delBtn) { e.stopPropagation(); const row = delBtn.closest('.task-row'); deleteTask(delBtn.dataset.delTask, row); return; }
\t\t/* кик участника — прямо из строки команды, с подтверждением в расширении */
\t\tconst kickBtn = e.target.closest('[data-kick-member]');
\t\tif (kickBtn) { e.stopPropagation(); void kickMember(kickBtn.dataset.kickMember); return; }
\t\t/* событие — точечное скрытие (та же команда, что у «Очистить», но для одной записи) */
\t\tconst dismissBtn = e.target.closest('[data-dismiss-ev]');
		if (dismissBtn) {
			e.stopPropagation();
			/* мгновенно убираем строку локально: скрытие локальное, сервер не нужен */
			const evHideKey = dismissBtn.dataset.dismissEv;
			state.dismissedActivity = [...(state.dismissedActivity ?? []), evHideKey];
			dismissBtn.closest('.ev-row')?.remove();
			vscode.postMessage({ type: 'invoke', command: 'auraTeam.dismissActivity', args: [evHideKey] });
			return;
		}
\t\tconst delEvBtn = e.target.closest('[data-del-event]');
		if (delEvBtn) {
			e.stopPropagation();
			vscode.postMessage({ type: 'invoke', command: 'auraTeam.deleteActivity', args: [delEvBtn.dataset.delEvent] });
			return;
		}
		const entity = e.target.closest('.ev-entity');
\t\tif (entity) { e.stopPropagation(); vscode.postMessage({ type: 'open', view: 'board' }); return; }
\t\tconst row = e.target.closest('.task-row, .member-row');
\t\tif (row) {
\t\t\tif (row.classList.contains('task-row')) { vscode.postMessage({ type: 'open', view: 'board', filter: { task: row.dataset.task } }); }
\t\t\telse { vscode.postMessage({ type: 'open', view: 'board', filter: { member: row.dataset.member } }); }
\t\t}
\t};
}
function bindArrowNav(list) {
\tif (!list) { return; }
\tlist.onkeydown = (e) => {
\t\tif (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') { return; }
\t\tconst items = [...list.querySelectorAll('button, [tabindex="0"]')];
\t\te.preventDefault();
\t\tconst idx = items.indexOf(document.activeElement);
\t\tconst next = e.key === 'ArrowDown' ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
\t\titems[next]?.focus();
\t};
}
function toggleMeMenu() {
\tconst existing = document.getElementById('meMenu');
\tif (existing) { existing.remove(); return; }
\tconst menu = document.createElement('div');
\tmenu.id = 'meMenu';
\tmenu.className = 'me-menu';
\tconst meRow = document.getElementById('meRow');
\tconst rect = meRow.getBoundingClientRect();
\tmenu.style.top = (rect.bottom + 4) + 'px';
\tmenu.style.left = rect.left + 'px';
\tmenu.innerHTML = '<button data-act="profile">' + ci('account') + esc(t('profile')) + '</button>' +
\t\t'<button class="danger" data-act="logout">' + ci('logOut') + esc(t('logout')) + '</button>';
\tdocument.body.appendChild(menu);
\tmenu.querySelector('[data-act="profile"]').onclick = () => { menu.remove(); vscode.postMessage({ type: 'open', view: 'profile' }); };
\tmenu.querySelector('[data-act="logout"]').onclick = () => { menu.remove(); vscode.postMessage({ type: 'invoke', command: 'auraTeam.signOut', args: [] }); };
\tsetTimeout(() => {
\t\tconst close = (e) => { if (!menu.contains(e.target) && e.target !== meRow) { menu.remove(); document.removeEventListener('pointerdown', close); } };
\t\tdocument.addEventListener('pointerdown', close);
\t}, 0);
}
window.addEventListener('message', e => {
\t/* ответ на invoke: разрешаем ожидающий промис (каталог, код приглашения) */
\tif (e.data?.type === 'response') {
\t\tconst pending = pendingRequests.get(e.data.id);
\t\tif (pending) {
\t\t\tpendingRequests.delete(e.data.id);
\t\t\tif (e.data.ok) { pending.resolve(e.data.result); } else { pending.reject(new Error(e.data.error || t('requestFailed'))); }
\t\t}
\t\treturn;
\t}
\tif (e.data?.type === 'openInvite') { setInviteOpen(true); return; }
\tif (e.data?.type === 'state') {
\t\tstate = e.data.state;
\t\tif (typeof e.data.inviteCode === 'string') { state._inviteCode = e.data.inviteCode || null; }
\t\tif (e.data.inviteExpires !== undefined) { state._inviteExpires = e.data.inviteExpires; }
\t\tif (e.data.inviteRole !== undefined) { state._inviteRole = e.data.inviteRole ?? null; }
\t\t/* diff-обновление списков на месте: строки не перерисовываются целиком, фокус и скролл сохраняются */
\t\tif (staticRendered) { updateLists(); updateNav(); renderInviteSection(); wireInvite(); } else { render(); }
\t}
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;

function requireTeam(state: { teamId?: string }): string {
	if (!state.teamId) { throw new Error(vscode.l10n.t('Create or join a team first.')); }
	return state.teamId;
}

/**
 * Роль текущего пользователя в активной команде.
 * Сервер решает то же самое (`requireRole`), а расширение проверяет заранее,
 * чтобы кнопка удаления не приводила к 403 после нажатия.
 */
export function roleInTeam(state: { teamId?: string; session?: Session }): string {
	return state.session?.teams.find(team => team.id === state.teamId)?.role ?? 'viewer';
}

/** owner/maintainer: удаление архивов, удаление событий ленты и прочие необратимые действия. */
export function canMaintain(state: { teamId?: string; session?: Session }): boolean {
	return ['owner', 'maintainer'].includes(roleInTeam(state));
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
