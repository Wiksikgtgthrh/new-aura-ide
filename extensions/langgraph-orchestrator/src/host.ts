import * as vscode from 'vscode';
import * as path from 'path';
import { KeyRegistry } from './keys/registry';
import { RouterProxy, ChatRequest, ChatResult, ChatUsage } from './llm/routerProxy';
import { PriceTable, costOf, priceFor, priceTableOf } from './llm/pricing';
import { TierStore } from './llm/tierStore';
import { CatalogModel, ModelCatalog, toCatalogInputs } from './llm/modelCatalog';
import { LocalLlmProxy } from './llm/localProxy';
import { ToolExecutor, ToolDef, TOOL_DEFS } from './tools';
import { ToolCache } from './tools/cache';
import { GitClient } from './git/gitClient';
import { ORCHESTRATOR_SCHEME } from './panel/panelProvider';
import { RpcClient } from './sidecar/rpcClient';
import { SidecarProcessManager, SidecarState } from './sidecar/processManager';
import { BudgetConfig, KeyTier, ModelPriceRule, OrchestratorConfig, UiLanguage, normalizeBudget, readConfig } from './util/config';
import { BudgetProfile, allProfiles, budgetFromProfile, findProfile, normalizeProfiles, profileFromBudget } from './util/budgetProfiles';
import { resolveUiLanguage } from './util/language';
import { logError, logInfo, logWarn } from './util/log';
import { STATE_PUSH_INTERVAL_MS, createThrottle } from './util/throttle';
import { ProgressTracker, RunStatus, TeamRunResult } from './team/report';
import { TeamBridge } from './team/bridge';
import {
	TeamBoardTask, TeamTaskStatus, TEAM_TASK_THREAD_KEY, normalizeTaskTitle, outcomeNote, pickAgentTasks,
	statusForOutcome, taskTextForGraph, threadIdForTask, withOrchestratorNote, withThreadMapping,
} from './team/sync';

export interface GraphNodeState {
	id: string;
	role: string;
	status: 'idle' | 'running' | 'waiting-approval' | 'done' | 'error' | 'skipped' | 'needs_human';
	tier?: string;
	keyName?: string;
	/** Раунд супервизора, в котором поставлена подзадача (для карточки). */
	round?: number;
	startedAt?: number;
	finishedAt?: number;
	error?: string;
	note?: string;
}

export interface PendingApproval {
	id: number;
	toolName: string;
	preview: string;
	/** Узел, чей вызов инструмента ждёт решения — карточка помечается «ждёт подтверждения». */
	nodeId?: string;
	resolve: (approved: boolean) => void;
}

/** Блок итога запуска в шапке доски: сколько запланировано, раунд, итог. */
export interface RunInfo {
	status: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
	round: number;
	maxRounds: number;
	/** Сколько подзадач запланировал супервизор (включая ещё не запущенные). */
	planned: number;
	startedAt?: number;
	finishedAt?: number;
	summary?: string;
	/** true — граф остановлен interrupt'ом и ждёт решения из панели. */
	awaitingInterrupt?: boolean;
	/** Что за решение ждёт: подпись interrupt'а для карточки. */
	interrupt?: { node?: string; role?: string; title?: string };
}

/** Спан трейсинга (Этап 5.2): только метаданные, без промптов и ключей. */
export interface TraceSpan {
	id: string;
	name: string;
	kind: 'node' | 'llm';
	node?: string;
	role?: string;
	tier?: string;
	model?: string;
	tokens?: number;
	tokensIn?: number;
	tokensOut?: number;
	cost?: number;
	retries?: number;
	status?: string;
	startedAt: number;
	durationMs: number;
}

/** Строка журнала панели: уровень и нода дают точные фильтры во вкладке Log. */
export interface LogEntry {
	ts: number;
	level: 'info' | 'warn' | 'error';
	/** id подзадачи/роли, если событие к ней привязано. */
	node?: string;
	message: string;
}

export interface TraceSummary {
	byTime: Array<{ node: string; durationMs: number; cost: number; tokens: number; spans: number }>;
	byCost: Array<{ node: string; durationMs: number; cost: number; tokens: number; spans: number }>;
	totalSpans: number;
}

/** Расход моделей оркестратора и (если Team отдаёт) траты команды — Этап 5.1. */
export interface BudgetState {
	limits: { runTokens: number; runCost: number; nodeTokens: number; nodeCost: number };
	/** Цены за 1M токенов по тирам — редактируются из панели. */
	prices: Record<KeyTier, { input: number; output: number }>;
	/** Пер-модельные переопределения цен (по подстроке имени). */
	modelPrices: Array<{ match: string; input: number; output: number }>;
	/** Именованные наборы лимитов/цен (Этап 5.1+): встроенные пресеты + пользовательские. */
	profiles: Array<{ name: string; builtin: boolean }>;
	/** Активный профиль; пусто — бюджет настроен вручную. */
	activeProfile: string;
	tokens: number;
	cost: number;
	perModel: Array<{ model: string; tier: string; tokens: number; cost: number; calls: number }>;
	/** Командный расход по людям: доступен только если Team API отдаёт usage. */
	team: { available: boolean; perUser: Array<{ userId: string; name: string; requests: number }>; totalRequests: number };
}

export interface PanelState {
	running: boolean;
	paused: boolean;
	keys: ReturnType<KeyRegistry['list']>;
	/** Единый каталог моделей двух источников (личный и командный банк) с тирами. */
	models: CatalogModel[];
	nodes: GraphNodeState[];
	approvals: Array<{ id: number; toolName: string; preview: string; nodeId?: string }>;
	/** Активный interrupt графа (подтверждение рискованной подзадачи), если есть. */
	interrupt?: { node?: string; role?: string; title?: string };
	/** Последний снапшот графа: DAG-план и ретраи для карточек доски. */
	lastCheckpoint?: GraphCheckpoint;
	/** Готовый финальный патч запуска: файлы + diffstat, кнопки Применить/Отклонить. */
	patch?: RunPatch;
	log: string[];
	lastTask?: string;
	sidecarAlive: boolean;
	/** Состояние сайдкара с причиной: бейдж в шапке больше не гадает. */
	sidecar: { state: SidecarState; error?: string };
	run: RunInfo;
	/** Бюджет запуска: лимиты, расход и разбивка по моделям (Этап 5.1). */
	budget: BudgetState;
	/** Трейс запуска: спаны нод/LLM и топы по времени и деньгам (Этап 5.2). */
	trace: { spans: TraceSpan[]; summary: TraceSummary };
	/** Структурный журнал для вкладки Log: уровень и нода фильтруются точно. */
	logs: LogEntry[];
	/** Справочник запуска: чем стартует граф (планнер и параллель). */
	runDefaults: { planner: string; plannerTier: string; maxParallel: number };
	uiLanguage: UiLanguage;
	/** Доска тимы для вкладки Board: available=false — плагина Team нет, вкладка скрыта. */
	team: { available: boolean; tasks: TeamBoardTask[] };
}

const LOG_LIMIT = 300;
const CHECKPOINT_DIR = '.aura/orchestrator/checkpoints';
/** Профили бюджета в globalState (Этап 5.1+): переживают рестарт IDE. */
const BUDGET_PROFILES_KEY = 'orchestrator.budgetProfiles';
const BUDGET_ACTIVE_KEY = 'orchestrator.budgetActive';

/** Снапшот графа из сайдкара (checkpoint-нотификация): машина времени читает его в панели. */
/** Итоговый патч run-ветки: ссылки для UI, без сырого диффа в state. */
export interface RunPatch {
	runBranch: string;
	base: string;
	worktree: string;
	files: string[];
	stat: string;
}

export interface GraphCheckpoint {
	task?: string;
	round?: number;
	/** Сжатые результаты: ссылки на дифф/коммит вместо сырых логов. */
	results?: Record<string, {
		status?: string; summary?: string; diff_stat?: string; commit?: string; tokens?: number; cost?: number;
		/** Ссылки изоляции (Этап 4.1): по branch открывается diff ноды. */
		branch?: string; worktree?: string;
		inputTokens?: number; outputTokens?: number;
		/** Причина остановки: budget | checks. */
		reason?: string;
	}>;
	summary?: string;
	plan?: Array<{
		id?: string; goal?: string; deps?: string[]; tier?: string; kind?: string; files_hint?: string[];
		agent?: string; confirm?: boolean;
		/** Старые имена полей — для чекпоинтов, сохранённых прошлыми версиями. */
		key?: string; instruction?: string; dependsOn?: string[]; tierOverride?: string;
	}>;
	itemState?: Record<string, string>;
	attempts?: Record<string, number>;
	/** node_id -> {worktree, branch}: изоляция узлов (Этап 4.1). */
	isolations?: Record<string, { worktree?: string; branch?: string }>;
	budget?: { tokens: number; cost: number };
	errors?: Array<{ node: string; message: string }>;
	savedAt?: number;
}

export class OrchestratorHost implements vscode.Disposable {
	private readonly context: vscode.ExtensionContext;
	private config: OrchestratorConfig;
	private tierStore: TierStore;
	private registry: KeyRegistry;
	private catalog: ModelCatalog;
	private router: RouterProxy;
	private proxy: LocalLlmProxy;
	private tools: ToolExecutor;
	private readonly git = new GitClient();
	/** Кэш read-only тулов (Этап 5.3), живёт в globalStorage. */
	private readonly toolCache: ToolCache;
	private sidecar: SidecarProcessManager;
	private readonly bridge = new TeamBridge();
	/** Кэш доски тимы для панели и автозабора. */
	private teamTasks: TeamBoardTask[] = [];
	/** Задачи, которые автозабор уже пытался взять: второй раз не трогаем (защита от цикла). */
	private readonly autoGrabAttempted = new Set<string>();
	/** Ставится синхронно: второй клик по задаче до старта графа не запускает второй прогон. */
	private teamRunPending = false;
	private rpc?: RpcClient;
	/** Секрет запуска: сайдкар получает его в env, API-ключи — никогда. */
	private readonly runToken = LocalLlmProxy.newToken();
	/** Таблица цен (Этап 5.1): собрана из настроек, обновляется при их смене. */
	private priceTable: PriceTable;
	/** Расход моделей текущего/последнего запуска — для панели Budget. */
	private budgetUsage = { tokens: 0, cost: 0, perModel: new Map<string, { model: string; tier: string; tokens: number; cost: number; calls: number }>() };
	/** Траты команды по людям, если Team API их отдаёт (иначе available=false). */
	private teamUsage: BudgetState['team'] = { available: false, perUser: [], totalRequests: 0 };
	/** Спаны трейса текущего/последнего запуска (Этап 5.2). */
	private traceSpans: TraceSpan[] = [];
	/** Структурный журнал панели: те же строки, что в log, но с уровнем и нодой. */
	private logEntries: LogEntry[] = [];
	/** База запуска: по ней открывается diff отдельной ноды. */
	private lastBaseCommit = '';

	private nodes: GraphNodeState[] = [];
	private logLines: string[] = [];
	private approvals = new Map<number, PendingApproval>();
	private nextApprovalId = 1;
	private running = false;
	private paused = false;
	/** Последний снапшот графа: узнаваем alive-состояние для «машины времени». */
	private lastGraphCheckpoint?: GraphCheckpoint;
	private patchReady?: RunPatch;
	/** Текст запасного единого диффа (если multi-diff недоступен). */
	private patchDiffText = '';
	private lastTask?: string;
	private lastRunStatus: RunStatus = 'done';
	private run: RunInfo = { status: 'idle', round: 0, maxRounds: 0, planned: 0 };
	/** Колбэк завершения текущего запуска: резолвится по graph.finished/error/cancelled. */
	private activeRun?: () => void;
	private readonly disposables: vscode.Disposable[] = [];

	private readonly onStateEmitter = new vscode.EventEmitter<PanelState>();
	readonly onDidChangeState = this.onStateEmitter.event;
	/** Просьба переключить вкладку панели (команды палитры и клавиши). */
	private readonly onTabEmitter = new vscode.EventEmitter<string>();
	readonly onDidRequestTab = this.onTabEmitter.event;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
		this.config = readConfig();
		this.tierStore = new TierStore(context.globalState, { overrides: this.config.tierOverrides });
		this.registry = new KeyRegistry(this.config, this.tierStore);
		this.router = new RouterProxy(this.registry);
		this.catalog = new ModelCatalog(() => toCatalogInputs(this.registry.list()));
		this.priceTable = priceTableOf(this.config.budget);
		this.proxy = new LocalLlmProxy({
			router: this.router,
			catalog: this.catalog,
			token: this.runToken,
			prices: this.priceTable,
			onUsage: usage => this.recordUsage(usage),
		});
		this.git.setPath(this.config.gitPath);
		// Кэш read-only тулов (Этап 5.3): SQLite в globalStorage расширения.
		this.toolCache = new ToolCache(path.join(context.globalStorageUri.fsPath, 'tool-cache.db'));
		this.tools = new ToolExecutor(this.config, (tool, input, preview, nodeId) => this.requestApproval(tool, input, preview, nodeId), this.git, this.toolCache);
		this.sidecar = new SidecarProcessManager(context.extensionUri, (): Record<string, string> => {
			const url = this.proxy.url;
			return url ? { AURA_PROXY_URL: url, AURA_RUN_TOKEN: this.runToken } : {};
		});
		this.disposables.push(this.registry, this.sidecar, this.proxy, this.bridge, this.onStateEmitter, this.onTabEmitter);
		this.disposables.push({ dispose: () => this.toolCache.dispose() });
		this.disposables.push(this.bridge.onDidChangeBoard(() => { void this.refreshTeamBoard(); }));
		this.disposables.push(this.bridge.onDidChangeAvailability(() => { void this.updateContextKeys(); this.pushState(); }));
		this.disposables.push(this.sidecar.onDidSpawn(rpc => this.attachRpc(rpc)));
		this.disposables.push(this.sidecar.onDidExit(() => this.pushState()));
		this.disposables.push(this.sidecar.onDidChangeState(() => this.pushState()));
		this.disposables.push(this.registry.onDidChange(() => this.pushState()));
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
			// Общий переключатель Aura: 'auto' панели обязан отреагировать сразу,
			// иначе язык маркета и панели разъедутся до перезагрузки окна.
			if (e.affectsConfiguration('aura.language')) {
				this.pushState();
			}
			if (e.affectsConfiguration('langgraphOrchestrator')) {
				this.config = readConfig();
				this.priceTable = priceTableOf(this.config.budget);
				this.tierStore.setOverrides(this.config.tierOverrides);
				this.registry.updateConfig(this.config);
				this.tools.updateConfig(this.config);
				this.git.setPath(this.config.gitPath);
				void this.registry.refresh();
			}
		}));
	}

	async init(): Promise<void> {
		await this.registry.refresh();
		// Мост к Team — до прогрева: если плагина нет, вкладка Board просто скрыта.
		await this.bridge.resolve();
		void this.refreshTeamBoard();
		// Команда Team существует после его активации мостом — перерисовываем доску,
		// чтобы на карточках сразу появилась кнопка «Отдать агентам».
		if (this.bridge.available) {
			void vscode.commands.executeCommand('auraTeam.broadcast').then(undefined, () => undefined);
		}
		// Прокси поднимается до прогрева сайдкара: адрес и токен уходят в env процесса.
		await this.ensureProxy();
		// Прогрев сайдкара: процесс поднимается, пока пользователь смотрит на панель, а не
		// в момент первой задачи. Панель видит «поднимается» вместо пугающего «не запущен».
		void this.sidecar.ensureStarted().catch(err => logWarn(`sidecar warm-up failed: ${err instanceof Error ? err.message : err}`));
		// Контекст-ключи фиксируем явно: мост мог не прислать событие (нет плагина).
		await this.updateContextKeys();
	}

	// ---- команды ----

	async startTask(task?: string): Promise<void> {
		if (!task) {
			task = await vscode.window.showInputBox({
				title: 'LangGraph Оркестратор — задача',
				placeHolder: 'Например: добавь страницу настроек, покрой тестами и проверь на уязвимости',
				ignoreFocusOut: true,
			});
		}
		if (!task?.trim()) {
			return;
		}
		const started = await this.beginTask(task.trim());
		if (!started.ok) {
			vscode.window.showErrorMessage(`Оркестратор: ${started.error}`);
		}
	}

	/**
	 * Запуск команды агентов по задаче из чата: та же постановка задачи, что и у команды,
	 * плюс поток прогресса — по строке на изменение состояния агента. Ждём завершения графа
	 * (или отмены), поэтому промис резолвится вместе с graph.finished/error/cancelled.
	 */
	async runTeamTask(
		task: string,
		options: { maxWorkers?: number; onProgress?: (line: string) => void; threadId?: string },
		token: vscode.CancellationToken,
	): Promise<TeamRunResult> {
		const tracker = new ProgressTracker(options.onProgress);
		const failure = (error: string): TeamRunResult => ({ task, status: 'error', nodes: this.nodes, log: [...this.logLines, error] });
		if (this.running) {
			return failure('Команда уже работает над другой задачей: дождитесь завершения или отмените запуск (кнопка «Отмена» в панели).');
		}

		// Резолвер ставим до старта: мгновенный сбой (нет ключей, битый сайдкар) успевает
		// прислать graph.error раньше, чем мы дойдём до ожидания ниже, и тогда без этой
		// строки промис ждал бы вечно.
		const finished = new Promise<void>(resolve => { this.activeRun = resolve; });
		const started = await this.beginTask(task, options.maxWorkers, options.threadId);
		if (!started.ok) {
			this.activeRun = undefined;
			return failure(started.error);
		}
		tracker.update(this.panelState());

		const subscription = this.onDidChangeState(state => tracker.update(state));
		const cancellation = token.onCancellationRequested(() => { void this.cancel(); });
		try {
			await finished;
		} finally {
			subscription.dispose();
			cancellation.dispose();
			this.activeRun = undefined;
		}
		return { task, status: token.isCancellationRequested ? 'cancelled' : this.lastRunStatus, nodes: this.nodes, log: this.logLines };
	}

	/** Общая часть запуска: панель, команда и инструмент чата ставят задачу одинаково. */
	private async beginTask(task: string, maxWorkers?: number, threadId?: string): Promise<{ ok: true } | { ok: false; error: string }> {
		try {
			await this.ensureProxy();
			const rpc = await this.sidecar.ensureStarted();
			this.nodes = [];
			this.logLines = [];
			this.budgetUsage = { tokens: 0, cost: 0, perModel: new Map() };
			this.traceSpans = [];
			this.logEntries = [];
			this.lastTask = task;
			this.lastRunStatus = 'done';
			this.run = { status: 'running', round: 0, maxRounds: 0, planned: 0, startedAt: Date.now() };
			const checkpoint = await this.readCheckpoint();
			// База запуска: от неё создаются ветки узлов и считается итоговый патч (Этап 4).
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
			const baseCommit = workspaceRoot ? await this.git.head(workspaceRoot) : '';
			this.lastBaseCommit = baseCommit;
			await rpc.sendCommand('start', {
				task: this.lastTask,
				// Поток графа из задачи доски: повторный клик продолжает тот же запуск.
				threadId,
				maxParallelWorkers: maxWorkers ?? this.config.maxParallelWorkers,
				escalationThreshold: this.config.escalationThreshold,
				maxVerifyRetries: this.config.maxVerifyRetries,
				verifyCommand: this.config.verifyCommand,
				// Самолечение (Этап 4.2): команды проверок проекта и жёсткий лимит итераций.
				checks: this.config.checks,
				maxFixIterations: this.config.maxFixIterations,
				// Бюджет запуска/узла (Этап 5.1): лимиты уходят сайдкару, цены — нет.
				budget: {
					runTokens: this.config.budget.runTokens,
					runCost: this.config.budget.runCost,
					nodeTokens: this.config.budget.nodeTokens,
					nodeCost: this.config.budget.nodeCost,
				},
				// Трейсинг (Этап 5.2): файл — в .aura рядом с чекпоинтами, когда включён.
				trace: {
					enabled: this.config.trace.enabled,
					file: this.config.trace.file ? this.traceFileUri()?.fsPath : '',
					otlpEndpoint: this.config.trace.otlpEndpoint,
					maxSpans: this.config.trace.maxSpans,
				},
				resumeState: checkpoint ?? undefined,
				checkpointFile: this.checkpointStoreUri()?.fsPath,
				tools: TOOL_DEFS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
				workspaceRoot,
				baseCommit,
				// Язык панели: на нём же команда пишет заметки и итог запуска.
				language: resolveUiLanguage(this.config.uiLanguage, vscode.env.language, auraLanguageSetting()),
			});
			this.running = true;
			this.paused = false;
			await this.updateContextKeys();
			this.pushState();
			return { ok: true };
		} catch (err) {
			logError('startTask failed', err);
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	async pause(): Promise<void> {
		await this.rpc?.sendCommand('pause').catch(() => undefined);
		this.paused = true;
		await this.updateContextKeys();
		this.pushState();
	}

	async resume(): Promise<void> {
		await this.rpc?.sendCommand('resume').catch(() => undefined);
		this.paused = false;
		await this.updateContextKeys();
		this.pushState();
	}

	async cancel(): Promise<void> {
		await this.rpc?.sendCommand('cancel').catch(() => undefined);
		this.running = false;
		this.paused = false;
		await this.updateContextKeys();
		this.pushState();
	}

	// ---- вызовы из панели (invoke) ----

	async invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
		switch (command) {
			case 'getState': return this.panelState();
			case 'startTask': return this.startTask(String(args.task ?? ''));
			case 'pause': return this.pause();
			case 'resume': return this.resume();
			case 'cancel': return this.cancel();
			case 'approval.resolve': return this.resolveApproval(Number(args.id), Boolean(args.approved));
			case 'node.cancel': return this.cancelNode(String(args.nodeId ?? ''));
			case 'sidecar.start': return this.startSidecar();
			case 'interrupt.resolve': return this.resolveInterrupt(Boolean(args.approved), args.note ? String(args.note) : undefined);
			case 'graph.history': return this.sendSidecarCommand('history', { limit: Number(args.limit ?? 20) });
			case 'graph.rewind': return this.sendSidecarCommand('rewind', { checkpointId: String(args.checkpointId ?? '') });
			case 'graph.patchState': return this.sendSidecarCommand('patchState', { checkpointId: String(args.checkpointId ?? ''), patch: args.patch });
			case 'keys.setTier': {
				const keyId = String(args.keyId);
				const source = this.registry.get(keyId)?.source === 'team' ? 'team' : 'personal';
				// Тиp хранится в globalState и переживает перезапуск IDE.
				await this.tierStore.setTier(source, keyId, args.tier as KeyTier);
				return this.registry.refresh();
			}
			case 'keys.setExcluded':
				this.registry.setExcluded(String(args.keyId), Boolean(args.excluded));
				return this.panelState();
			case 'keys.refresh': return this.registry.refresh();
			case 'keys.check': return this.checkKeys(args.keyId ? [String(args.keyId)] : undefined);
			case 'keys.checkAll': return this.checkKeys(undefined);
			case 'patch.apply': return this.applyPatch();
			case 'patch.reject': return this.rejectPatch();
			case 'patch.openDiff': return this.openPatchDiff();
			case 'node.restart': return this.restartNode(String(args.nodeId ?? ''));
			case 'node.openDiff': return this.openNodeDiff(String(args.nodeId ?? ''));
			case 'clearCheckpoint': return this.clearCheckpoint();
			case 'team.refresh': return this.refreshTeamBoard();
			case 'team.runTask': return this.runTeamTaskById(String(args.taskId ?? ''));
			case 'team.createTask': return this.createTeamTask(String(args.title ?? ''), String(args.status ?? 'todo'));
			case 'toolCache.clear': this.toolCache.clear(); return { cleared: true };
			case 'toolCache.stats': return { entries: this.toolCache.size() };
			case 'budget.update': return this.updateBudget(args);
			case 'budget.profile.apply': return this.applyBudgetProfile(String(args.name ?? ''));
			case 'budget.profile.save': return this.saveBudgetProfile(String(args.name ?? ''));
			case 'budget.profile.remove': return this.removeBudgetProfile(String(args.name ?? ''));
			default: throw new Error(`unknown invoke: ${command}`);
		}
	}

	panelState(): PanelState {
		return {
			running: this.running,
			paused: this.paused,
			keys: this.registry.list(),
			models: this.catalog.list(),
			nodes: this.nodes,
			approvals: [...this.approvals.values()].map(({ id, toolName, preview, nodeId }) => ({ id, toolName, preview, nodeId })),
			interrupt: this.run.awaitingInterrupt ? this.run.interrupt : undefined,
			log: this.logLines.slice(-LOG_LIMIT),
			lastTask: this.lastTask,
			sidecarAlive: this.sidecar.isRunning,
			sidecar: { state: this.sidecar.state, error: this.sidecar.stateError },
			run: { ...this.run },
			logs: this.logEntries.slice(-LOG_LIMIT),
			runDefaults: { planner: 'auto', plannerTier: 'high', maxParallel: this.config.maxParallelWorkers },
			lastCheckpoint: this.lastGraphCheckpoint,
			patch: this.patchReady,
			// Язык панели отдаём уже разрешённым: 'auto' считается здесь по языку IDE,
			// а не в браузере по navigator.language — иначе интерфейс и текст агентов могут разойтись.
			uiLanguage: resolveUiLanguage(this.config.uiLanguage, vscode.env.language, auraLanguageSetting()),
			team: { available: this.bridge.available, tasks: this.teamTasks },
			budget: this.budgetState(),
			trace: this.traceState(),
		};
	}

	/**
	 * Попросить панель открыть вкладку. Если панель ещё не готова, провайдер
	 * запомнит просьбу и применит её на первый `ready` от webview.
	 */
	requestTab(tab: string): void {
		this.onTabEmitter.fire(tab);
	}

	/** Трейс для панели: спаны + агрегаты. Хранится в памяти host, не в графе. */
	private traceState(): { spans: TraceSpan[]; summary: TraceSummary } {
		return { spans: this.traceSpans.slice(-400), summary: this.traceSummary() };
	}

	/** Агрегаты трейса: топ нод по времени и по деньгам (Этап 5.2). */
	private traceSummary(): TraceSummary {
		const nodes = new Map<string, { node: string; durationMs: number; cost: number; tokens: number; spans: number }>();
		for (const span of this.traceSpans) {
			if (span.kind !== 'node') {
				continue;
			}
			const key = span.node || span.name;
			const entry = nodes.get(key) ?? { node: key, durationMs: 0, cost: 0, tokens: 0, spans: 0 };
			entry.durationMs += Number(span.durationMs) || 0;
			entry.cost += Number(span.cost) || 0;
			entry.tokens += (Number(span.tokensIn) || 0) + (Number(span.tokensOut) || 0);
			entry.spans += 1;
			nodes.set(key, entry);
		}
		const all = [...nodes.values()];
		return {
			byTime: [...all].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5),
			byCost: [...all].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens).slice(0, 5),
			totalSpans: this.traceSpans.length,
		};
	}

	/**
	 * Правка бюджета из панели: лимиты и цены пишутся в настройки (Global),
	 * не трогая то, что пользователь уже задал. Значения санитизируются через
	 * normalizeBudget: мусор и отрицательные становятся «без лимита»/дефолтом.
	 */
	// ---- профили бюджета (Этап 5.1+) ----

	private userBudgetProfiles(): BudgetProfile[] {
		return normalizeProfiles(this.context.globalState.get(BUDGET_PROFILES_KEY, []));
	}

	private allBudgetProfiles(): BudgetProfile[] {
		return allProfiles(this.userBudgetProfiles());
	}

	private activeBudgetProfile(): string {
		return this.context.globalState.get<string>(BUDGET_ACTIVE_KEY, '') || '';
	}

	private profilesForPanel(): { profiles: Array<{ name: string; builtin: boolean }>; active: string } {
		return {
			profiles: this.allBudgetProfiles().map(profile => ({ name: profile.name, builtin: Boolean(profile.builtin) })),
			active: this.activeBudgetProfile(),
		};
	}

	/** Запись бюджета в настройки (Global): общий путь для ручной правки и профилей. */
	private async writeBudget(next: BudgetConfig): Promise<void> {
		const cfg = vscode.workspace.getConfiguration('langgraphOrchestrator');
		await cfg.update('budget', next, vscode.ConfigurationTarget.Global);
	}

	/** Применить профиль: его лимиты и цены становятся текущим бюджетом. */
	private async applyBudgetProfile(name: string): Promise<unknown> {
		const profile = findProfile(this.allBudgetProfiles(), String(name || '').trim());
		if (!profile) {
			return { ok: false, error: 'профиль не найден' };
		}
		try {
			await this.writeBudget(budgetFromProfile(profile));
			await this.context.globalState.update(BUDGET_ACTIVE_KEY, profile.name);
			this.appendLog(`профиль бюджета «${profile.name}» применён (применится к следующему запуску)`);
			this.pushState();
			return {
				ok: true,
				active: profile.name,
				profiles: this.profilesForPanel().profiles,
				profile: {
					limits: { ...profile.limits },
					prices: { ...profile.prices },
					modelPrices: profile.modelPrices.map(rule => ({ ...rule })),
				},
			};
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** Сохранить текущий бюджет как именованный профиль (встроенные имена заняты). */
	private async saveBudgetProfile(name: string): Promise<unknown> {
		const clean = String(name || '').trim().slice(0, 60);
		if (!clean) {
			return { ok: false, error: 'пустое имя профиля' };
		}
		if (findProfile(this.allBudgetProfiles(), clean)?.builtin) {
			return { ok: false, error: 'имя занято встроенным профилем' };
		}
		try {
			const existing = this.userBudgetProfiles().filter(profile => profile.name !== clean);
			await this.context.globalState.update(BUDGET_PROFILES_KEY, [...existing, profileFromBudget(clean, this.config.budget)]);
			await this.context.globalState.update(BUDGET_ACTIVE_KEY, clean);
			this.appendLog(`профиль бюджета «${clean}» сохранён`);
			this.pushState();
			return { ok: true, active: clean, profiles: this.profilesForPanel().profiles };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** Удалить пользовательский профиль (встроенные не удаляются). */
	private async removeBudgetProfile(name: string): Promise<unknown> {
		const clean = String(name || '').trim();
		if (!findProfile(this.userBudgetProfiles(), clean)) {
			return { ok: false, error: 'профиль не найден или встроенный' };
		}
		try {
			const next = this.userBudgetProfiles().filter(profile => profile.name !== clean);
			await this.context.globalState.update(BUDGET_PROFILES_KEY, next);
			if (this.activeBudgetProfile() === clean) {
				await this.context.globalState.update(BUDGET_ACTIVE_KEY, '');
			}
			this.appendLog(`профиль бюджета «${clean}» удалён`);
			this.pushState();
			return { ok: true, active: this.activeBudgetProfile(), profiles: this.profilesForPanel().profiles };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	private async updateBudget(args: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
		try {
			const cfg = vscode.workspace.getConfiguration('langgraphOrchestrator');
			const current = normalizeBudget(cfg.get('budget'));
			const limits = args.limits && typeof args.limits === 'object' ? args.limits as Record<string, unknown> : null;
			const prices = args.prices && typeof args.prices === 'object' ? args.prices as Record<string, unknown> : null;
			const models = Array.isArray(args.modelPrices) ? args.modelPrices as ModelPriceRule[] : null;
			const next: BudgetConfig = normalizeBudget({
				...current,
				...(limits ? { ...limits } : {}),
				...(prices ? { prices: { ...current.prices, ...prices } } : {}),
				...(models ? { modelPrices: models } : {}),
			});
			await cfg.update('budget', next, vscode.ConfigurationTarget.Global);
			// Ручная правка — это уже не профиль: снимаем активную метку.
			await this.context.globalState.update(BUDGET_ACTIVE_KEY, '');
			this.appendLog('бюджет обновлён из панели (применится к следующему запуску)');
			this.pushState();
			return { ok: true };
		} catch (err) {
			logWarn(`budget.update failed: ${err instanceof Error ? err.message : err}`);
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** Приём спана от сайдкара: кольцевой буфер + мягкий троттлинг отрисовки. */
	private recordSpan(span: TraceSpan): void {
		if (!span || typeof span !== 'object') {
			return;
		}
		this.traceSpans.push(span);
		if (this.traceSpans.length > 1000) {
			this.traceSpans.splice(0, this.traceSpans.length - 1000);
		}
		this.pushState();
	}

	/** Бюджет для панели: лимиты из настроек + расход текущего запуска. */
	private budgetState(): BudgetState {
		const budget = this.config.budget;
		return {
			limits: {
				runTokens: budget.runTokens,
				runCost: budget.runCost,
				nodeTokens: budget.nodeTokens,
				nodeCost: budget.nodeCost,
			},
			prices: {
				high: { ...budget.prices.high },
				mid: { ...budget.prices.mid },
				low: { ...budget.prices.low },
			},
			modelPrices: budget.modelPrices.map(rule => ({ ...rule })),
			profiles: this.profilesForPanel().profiles,
			activeProfile: this.activeBudgetProfile(),
			tokens: this.budgetUsage.tokens,
			cost: this.budgetUsage.cost,
			perModel: [...this.budgetUsage.perModel.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
			team: this.teamUsage,
		};
	}

	/** Учёт одного ответа модели: суммарно и по моделям — для панели. */
	private recordUsage(usage: ChatUsage): void {
		const tokens = (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0);
		const cost = Number(usage.costUsd) || 0;
		this.budgetUsage.tokens += tokens;
		this.budgetUsage.cost += cost;
		const key = `${usage.model}\u00b7${usage.tier}`;
		const entry = this.budgetUsage.perModel.get(key) ?? { model: usage.model || '(unknown)', tier: usage.tier, tokens: 0, cost: 0, calls: 0 };
		entry.tokens += tokens;
		entry.cost += cost;
		entry.calls += 1;
		this.budgetUsage.perModel.set(key, entry);
	}

	/** Приписать стоимость к результату RPC-пути и учесть расход (путь прокси считает сам). */
	private priceResult(result: ChatResult): ChatResult {
		const usage = result.usage ?? {
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
			costUsd: 0,
			model: result.usedKeyName,
			tier: result.usedTier,
		};
		const priced: ChatUsage = {
			...usage,
			costUsd: costOf(
				{ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
				priceFor(this.priceTable, usage.model, result.usedTier),
			),
		};
		this.recordUsage(priced);
		return { ...result, usage: priced };
	}

	/** Подъём сайдкара из панели: кнопка «Запустить» на бейдже. */
	async startSidecar(): Promise<{ state: SidecarState; error?: string }> {
		try {
			await this.ensureProxy();
			await this.sidecar.restartManually();
		} catch (err) {
			logWarn(`sidecar start failed: ${err instanceof Error ? err.message : err}`);
		}
		this.pushState();
		return { state: this.sidecar.state, error: this.sidecar.stateError };
	}

	/**
	 * Перепроверка живости и пинга: без id — все ключи (личные у ядра и командные
	 * у командного банка), с id — только указанные личные.
	 */
	private async checkKeys(ids?: string[]): Promise<ReturnType<KeyRegistry['list']>> {
		try {
			await vscode.commands.executeCommand('apiKeys.checkKeys', ids?.length ? { ids } : undefined);
		} catch (err) {
			// Без плагина API Keys пинги взять негде — статусы остаются из vscode.lm.
			logWarn(`apiKeys.checkKeys failed: ${err instanceof Error ? err.message : err}`);
		}
		if (!ids?.length) {
			try {
				// Пинг командных ключей живёт на сервере команды: просим его перепроверить.
				await vscode.commands.executeCommand('auraTeam.invoke', 'auraTeam.checkAllKeys', []);
			} catch (err) {
				logWarn(`auraTeam.checkAllKeys failed: ${err instanceof Error ? err.message : err}`);
			}
		}
		return this.registry.refresh();
	}

	/** Решение по interrupt'у графа: публичный хэндлер для команды и панели. */
	async resolveInterruptPublic(approved: boolean, note?: string): Promise<void> {
		await this.resolveInterrupt(approved, note);
	}

	/** Решение по interrupt'у графа: продолжить рискованную подзадачу или нет. */
	private async resolveInterrupt(approved: boolean, note?: string): Promise<{ resuming: boolean; approved: boolean }> {
		if (!this.rpc) {
			return { resuming: false, approved };
		}
		try {
			const result = await this.rpc.sendCommand('interrupt.resolve', { approved, note }) as { resuming: boolean; approved: boolean };
			this.appendLog(`interrupt: ${approved ? 'подтверждено' : 'отклонено'} пользователем`);
			this.run = { ...this.run, status: 'running', awaitingInterrupt: false, interrupt: undefined };
			this.pushState();
			return result;
		} catch (err) {
			logWarn(`interrupt.resolve failed: ${err instanceof Error ? err.message : err}`);
			return { resuming: false, approved };
		}
	}

	/** RPC-команда сайдкару с логированием сбоев — тонкая обёртка для invoke. */
	private async sendSidecarCommand<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
		if (!this.rpc) {
			throw new Error('сайдкар не запущен');
		}
		return await this.rpc.sendCommand(method, params) as T;
	}

	/** Отмена одной подзадачи: остальные агенты продолжают работу. */
	/**
	 * Применить финальный патч (Этап 4.5): run-ветка вливается в текущую ветку
	 * пользователя. Конфликт не разрешается сами — отдаём файлы в панель.
	 */
	private async applyPatch(): Promise<{ ok: boolean; conflicts?: string[]; error?: string }> {
		const patch = this.patchReady;
		if (!patch) {
			return { ok: false, error: 'патч не готов' };
		}
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
		if (!root) {
			return { ok: false, error: 'нет открытой папки' };
		}
		try {
			const info = await this.git.mergeBranch(root, patch.runBranch, 'aura orchestrator: apply run patch');
			if (!info.ok) {
				return { ok: false, conflicts: info.conflicts };
			}
			// Патч применён — рабочие деревья и ветки больше не нужны.
			await this.rpc?.sendCommand('cleanup').catch(() => undefined);
			this.patchReady = undefined;
			this.appendLog('финальный патч применён');
			this.pushState();
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** Отклонить патч: worktree и ветки удаляются, следов в рабочем дереве нет. */
	private async rejectPatch(): Promise<{ ok: boolean }> {
		await this.rpc?.sendCommand('cleanup').catch(() => undefined);
		this.patchReady = undefined;
		this.appendLog('финальный патч отклонён: изоляция очищена');
		this.pushState();
		return { ok: true };
	}

	/** Multi-diff: оригинал из base-коммита, изменённое — из run-ветки. */
	private async openPatchDiff(): Promise<{ opened: boolean }> {
		const patch = this.patchReady;
		if (!patch || patch.files.length === 0) {
			return { opened: false };
		}
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
		const source = vscode.Uri.parse(`${ORCHESTRATOR_SCHEME}://patch/${encodeURIComponent(patch.runBranch)}`);
		const resources = patch.files.map(file => ({
			originalUri: vscode.Uri.from({ scheme: ORCHESTRATOR_SCHEME, authority: 'git', path: `/${file}`, query: `ref=${encodeURIComponent(patch.base)}` }),
			modifiedUri: vscode.Uri.from({ scheme: ORCHESTRATOR_SCHEME, authority: 'git', path: `/${file}`, query: `ref=${encodeURIComponent(patch.runBranch)}` }),
		}));
		try {
			// Заголовок diff-редактора — имя ветки запуска (она уже начинается с aura/).
			await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', { multiDiffSourceUri: source, title: patch.runBranch, resources });
			return { opened: true };
		} catch (err) {
			logWarn(`openMultiDiffEditor failed: ${err instanceof Error ? err.message : err}`);
			// Запасной вариант: единый патч как виртуальный документ.
			const doc = await this.git.diff(root, patch.base, patch.runBranch).catch(() => '');
			const uri = vscode.Uri.from({ scheme: ORCHESTRATOR_SCHEME, authority: 'diff', path: '/aura.patch' });
			this.patchDiffText = doc;
			const open = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(open, { preview: false });
			return { opened: true };
		}
	}

	/**
	 * Перезапуск одной ноды: сайдкар возвращает подзадачу в очередь и продолжает
	 * граф. Работает только на остановленном графе — так же, как rewind/patch.
	 */
	private async restartNode(nodeId: string): Promise<{ restarted: boolean; error?: string }> {
		if (!nodeId || !this.rpc) {
			return { restarted: false, error: 'нет узла для перезапуска' };
		}
		try {
			await this.rpc.sendCommand('restartNode', { nodeId });
			this.appendLog(`перезапуск узла: ${nodeId}`, 'info', nodeId);
			this.pushState();
			return { restarted: true };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.appendLog(`перезапуск ${nodeId} не удался: ${message}`, 'warn', nodeId);
			this.pushState();
			return { restarted: false, error: message };
		}
	}

	/** Diff одной ноды: её ветка против базы запуска, файлы берём из git. */
	private async openNodeDiff(nodeId: string): Promise<{ opened: boolean }> {
		const result = this.lastGraphCheckpoint?.results?.[nodeId];
		const branch = result?.branch || '';
		const base = this.lastBaseCommit;
		if (!branch || !base) {
			return { opened: false };
		}
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
		try {
			const files = await this.git.filesChanged(root, base, branch);
			if (files.length === 0) {
				return { opened: false };
			}
			const source = vscode.Uri.parse(`${ORCHESTRATOR_SCHEME}://node/${encodeURIComponent(branch)}`);
			const resources = files.map(file => ({
				originalUri: vscode.Uri.from({ scheme: ORCHESTRATOR_SCHEME, authority: 'git', path: `/${file}`, query: `ref=${encodeURIComponent(base)}` }),
				modifiedUri: vscode.Uri.from({ scheme: ORCHESTRATOR_SCHEME, authority: 'git', path: `/${file}`, query: `ref=${encodeURIComponent(branch)}` }),
			}));
			await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', { multiDiffSourceUri: source, title: nodeId, resources });
			return { opened: true };
		} catch (err) {
			logWarn(`openNodeDiff failed: ${err instanceof Error ? err.message : err}`);
			return { opened: false };
		}
	}

	/** Содержимое файла на ссылке для виртуальных URI multi-diff. */
	async provideVirtualContent(uri: vscode.Uri): Promise<string> {
		if (uri.authority === 'diff') {
			return this.patchDiffText;
		}
		const params = new URLSearchParams(uri.query || '');
		const ref = params.get('ref') || '';
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
		return this.git.showFile(root, ref, uri.path.replace(/^\//, ''));
	}

	private async cancelNode(nodeId: string): Promise<{ cancelled: boolean }> {
		if (!nodeId || !this.rpc) {
			return { cancelled: false };
		}
		try {
			await this.rpc.sendCommand('cancelNode', { nodeId });
			const node = this.nodes.find(n => n.id === nodeId);
			if (node) {
				this.appendLog(`${node.role}: отменён вручную`);
			}
		} catch (err) {
			logWarn(`cancelNode ${nodeId} failed: ${err instanceof Error ? err.message : err}`);
		}
		this.pushState();
		return { cancelled: true };
	}

	dispose(): void {
		// Сначала отменяем отложенную отправку: иначе таймер дёрнет панель после закрытия.
		this.stateThrottle.cancel();
		this.disposables.forEach(d => d.dispose());
	}

	/** Идемпотентный запуск локального LLM-прокси (loopback, случайный порт). */
	private async ensureProxy(): Promise<void> {
		try {
			await this.proxy.start();
		} catch (err) {
			logWarn(`llm proxy start failed: ${err instanceof Error ? err.message : err}`);
		}
	}

	// ---- RPC со сайдкаром ----

	private attachRpc(rpc: RpcClient): void {
		this.rpc = rpc;
		rpc.onRequest((method, params, reply) => {
			this.handleSidecarRequest(rpc, method, params)
				.then(result => reply(true, result))
				.catch(err => reply(false, err));
		});
		rpc.onNotification((method, params) => this.handleSidecarNotification(method, params));
	}

	private async handleSidecarRequest(rpc: RpcClient, method: string, params: unknown): Promise<unknown> {
		if (method === 'chat.complete') {
			const request = params as ChatRequest & { requestId: number };
			const started = Date.now();
			const result = this.priceResult(await this.router.complete(request, {
				onToken: token => rpc.writeRaw({ kind: 'evt', id: request.requestId, event: 'token', data: token }),
			}, new vscode.CancellationTokenSource().token));
			logInfo(`chat.complete role=${request.role} tier=${result.usedTier} key=${result.usedKeyName} in ${Date.now() - started}ms`);
			return result;
		}
		if (method === 'tool.invoke') {
			const { name, input, nodeId } = params as { name: string; input: Record<string, unknown>; nodeId?: string };
			// cwd узла (его worktree) — часть входа: fs/terminal исполняются в изоляции.
			const cwd = input && typeof input.cwd === 'string' ? input.cwd : undefined;
			return this.tools.run({ name, input, nodeId, cwd });
		}
		throw new Error(`unknown sidecar request: ${method}`);
	}

	private handleSidecarNotification(method: string, params: unknown): void {
		switch (method) {
			case 'graph.event': {
				const event = params as {
					type: string;
					node?: GraphNodeState;
					message?: string;
					run?: { round?: number; maxRounds?: number; planned?: number; summary?: string };
					interrupt?: { node?: string; role?: string; title?: string };
				};
				if (event.node) {
					const idx = this.nodes.findIndex(n => n.id === event.node!.id);
					if (idx >= 0) {
						this.nodes[idx] = { ...this.nodes[idx], ...event.node };
					} else {
						this.nodes.push(event.node);
					}
				}
				if (event.interrupt) {
					this.run = { ...this.run, status: 'running', awaitingInterrupt: true, interrupt: event.interrupt };
				} else if (event.run) {
					this.run = { ...this.run, ...event.run, awaitingInterrupt: this.run.awaitingInterrupt && event.type !== 'graph.finished' };
				}
				if (event.message) {
					this.appendLog(event.message, eventLevel(event.type, event.message), event.node?.id);
				}
				if (event.type === 'graph.started') {
					this.run = { ...this.run, status: 'running', startedAt: this.run.startedAt ?? Date.now(), summary: undefined };
				}
				if (event.type === 'patch.ready') {
					this.patchReady = (params as { patch?: RunPatch }).patch;
				}
				if (event.type === 'graph.finished' || event.type === 'graph.error' || event.type === 'graph.cancelled') {
					this.finishRun(event.type, event.message);
				}
				this.pushState();
				break;
			}
			case 'checkpoint':
				void this.writeCheckpoint(params).catch(err => logWarn(`checkpoint write failed: ${err}`));
				this.lastGraphCheckpoint = params as GraphCheckpoint | undefined;
				break;
			case 'trace.span':
				this.recordSpan(params as TraceSpan);
				break;
			case 'log':
				this.appendLog(String((params as { message?: string })?.message ?? ''));
				this.pushState();
				break;
		}
	}

	/**
	 * Закрытие запуска: снимаем висящие подтверждения и карточки, которые остались
	 * «в работе» после отмены или ошибки — иначе доска вечно показывает занятых агентов.
	 */
	private finishRun(type: string, message?: string): void {
		this.running = false;
		this.lastRunStatus = type === 'graph.finished' ? 'done' : type === 'graph.error' ? 'error' : 'cancelled';
		this.run = {
			...this.run,
			status: this.lastRunStatus === 'done' ? 'done' : this.lastRunStatus === 'error' ? 'error' : 'cancelled',
			// При ошибке и отмене итог — это причина: сводка прошлого раунда здесь врёт.
			summary: type === 'graph.finished' ? this.run.summary : (message ?? this.run.summary),
			finishedAt: Date.now(),
		};
		void this.updateContextKeys();
		// Решать больше нечего: снятые подтверждения не должны висеть в панели и в модалке.
		for (const id of [...this.approvals.keys()]) {
			this.resolveApproval(id, false);
		}
		// Interrupt тоже снимается: граф уже не ждёт.
		this.run = { ...this.run, awaitingInterrupt: false, interrupt: undefined };
		// Отменённый запуск оставляет агентов «в работе» — доска должна показать правду.
		for (const node of this.nodes) {
			if (node.status === 'running' || node.status === 'waiting-approval') {
				node.status = 'skipped';
				node.note = 'запуск завершён до ответа агента';
				node.finishedAt = node.finishedAt ?? Date.now();
			}
		}
		const resolve = this.activeRun;
		this.activeRun = undefined;
		resolve?.();
		// Освободился оркестратор — автозабор может взять следующую задачу [agent].
		void this.maybeAutoGrab();
	}

	// ---- аппрувы ----

	private requestApproval(tool: ToolDef, _input: Record<string, unknown>, preview: string, nodeId?: string): Promise<boolean> {
		const id = this.nextApprovalId++;
		return new Promise<boolean>(resolve => {
			this.approvals.set(id, { id, toolName: tool.name, preview, nodeId, resolve });
			// Карточка агента, который упёрся в подтверждение, видна на доске сразу:
			// «ждёт подтверждения» в колонке вместо молчащего «работает».
			const node = nodeId ? this.nodes.find(n => n.id === nodeId) : undefined;
			if (node) {
				node.status = 'waiting-approval';
				node.note = `${tool.name}: ждёт подтверждения`;
			}
			this.pushState();
			// Фолбэк, если панель закрыта — модалка.
			vscode.window.showWarningMessage(
				`Оркестратор: разрешить ${tool.name}?`,
				{ modal: false, detail: preview.slice(0, 500) },
				'Разрешить', 'Запретить',
			).then(choice => {
				if (this.approvals.has(id)) {
					this.resolveApproval(id, choice === 'Разрешить');
				}
			});
		});
	}

	private resolveApproval(id: number, approved: boolean): void {
		const approval = this.approvals.get(id);
		if (!approval) {
			return;
		}
		this.approvals.delete(id);
		this.appendLog(`approval #${id} ${approval.toolName}: ${approved ? 'разрешено' : 'запрещено'}`);
		// Подтверждение получено — агент снова работает, карточка возвращается в «В работе».
		const node = approval.nodeId ? this.nodes.find(n => n.id === approval.nodeId) : undefined;
		if (node && node.status === 'waiting-approval' && this.running) {
			node.status = 'running';
			node.note = undefined;
		}
		approval.resolve(approved);
		this.pushState();
	}

	// ---- чекпоинты ----

	private checkpointUri(): vscode.Uri | undefined {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		return root ? vscode.Uri.joinPath(root, CHECKPOINT_DIR, 'latest.json') : undefined;
	}

	/** JSONL трейса: .aura/orchestrator/traces/spans.jsonl (каталог уже в .gitignore). */
	private traceFileUri(): vscode.Uri | undefined {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		return root ? vscode.Uri.joinPath(root, CHECKPOINT_DIR, '..', 'traces', 'spans.jsonl') : undefined;
	}

	private async writeCheckpoint(data: unknown): Promise<void> {
		const uri = this.checkpointUri();
		if (!uri) {
			return;
		}
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
		await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
	}

	/** JSON-хранилище чекпоинтов сайдкара: живёт рядом со снапшотом для панели. */
	private checkpointStoreUri(): vscode.Uri | undefined {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		return root ? vscode.Uri.joinPath(root, CHECKPOINT_DIR, 'graph-store.json') : undefined;
	}

	private async readCheckpoint(): Promise<unknown | undefined> {
		const uri = this.checkpointUri();
		if (!uri) {
			return undefined;
		}
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			return JSON.parse(Buffer.from(bytes).toString('utf8'));
		} catch {
			return undefined;
		}
	}

	private async clearCheckpoint(): Promise<void> {
		const uri = this.checkpointUri();
		if (uri) {
			await vscode.workspace.fs.delete(uri, { useTrash: false }).then(() => undefined, () => undefined);
		}
		const store = this.checkpointStoreUri();
		if (store) {
			await vscode.workspace.fs.delete(store, { useTrash: false }).then(() => undefined, () => undefined);
		}
		this.pushState();
	}

	// ---- служебное ----

	private appendLog(message: string, level: LogEntry['level'] = 'info', node?: string): void {
		if (!message) {
			return;
		}
		const ts = Date.now();
		this.logLines.push(`[${new Date(ts).toLocaleTimeString()}] ${message}`);
		if (this.logLines.length > LOG_LIMIT) {
			this.logLines.splice(0, this.logLines.length - LOG_LIMIT);
		}
		this.logEntries.push({ ts, level, node, message });
		if (this.logEntries.length > LOG_LIMIT) {
			this.logEntries.splice(0, this.logEntries.length - LOG_LIMIT);
		}
	}

	/**
	 * Состояние панели летит на каждое событие графа, спан и строку лога, а собирается
	 * целиком (доски, ключи, бюджет, 400 спанов, 300 строк лога) и клонируется в webview.
	 * Схлопываем пачку в одну отправку: после тишины — мгновенно, в гуще событий —
	 * не чаще `STATE_PUSH_INTERVAL_MS`.
	 */
	private readonly stateThrottle = createThrottle(STATE_PUSH_INTERVAL_MS, () => this.onStateEmitter.fire(this.panelState()));

	private pushState(): void {
		this.stateThrottle.schedule();
	}

	private async updateContextKeys(): Promise<void> {
		await vscode.commands.executeCommand('setContext', 'auraOrchestrator.running', this.running);
		await vscode.commands.executeCommand('setContext', 'auraOrchestrator.paused', this.paused);
		// Ключ для доски тимы: кнопка «Отдать агентам» видна только при этом ключе.
		await vscode.commands.executeCommand('setContext', 'aura.orchestratorAvailable', this.bridge.available);
	}

	// ---- мост с доской Aura Team ----

	/** Обновить кэш доски тимы (вкладка Board и автозабор). Без плагина — пусто. */
	private async refreshTeamBoard(): Promise<void> {
		if (!this.bridge.available) {
			this.teamTasks = [];
			this.pushState();
			return;
		}
		const board = await this.bridge.getBoard();
		this.teamTasks = Array.isArray(board?.tasks) ? board.tasks : [];
		this.pushState();
		void this.refreshTeamUsage();
		void this.maybeAutoGrab();
	}

	/** Командные траты (Этап 5.1): только если Team отдаёт usage, иначе — пусто. */
	private async refreshTeamUsage(): Promise<void> {
		const usage = await this.bridge.getUsage();
		if (!usage) {
			this.teamUsage = { available: false, perUser: [], totalRequests: 0 };
			this.pushState();
			return;
		}
		const perUser = Array.isArray(usage.perUser)
			? usage.perUser.map(item => ({ userId: String(item?.userId ?? ''), name: String(item?.name ?? ''), requests: Number(item?.requests) || 0 }))
			: [];
		this.teamUsage = {
			available: true,
			perUser,
			totalRequests: perUser.reduce((sum, item) => sum + item.requests, 0),
		};
		this.pushState();
	}

	private teamThreadMap(): Record<string, string> {
		return this.context.globalState.get<Record<string, string>>(TEAM_TASK_THREAD_KEY, {});
	}

	private async saveTeamThreadMap(map: Record<string, string>): Promise<void> {
		await this.context.globalState.update(TEAM_TASK_THREAD_KEY, map);
	}

	/**
	 * Своя задача из канбана панели: создаём её на доске Team и перечитываем доску.
	 * Причина отказа — машинный код, а не текст: подпись выбирает панель по своему языку.
	 */
	private async createTeamTask(title: string, status: string): Promise<{ ok: boolean; reason?: 'unavailable' | 'rejected' }> {
		if (!this.bridge.available) {
			return { ok: false, reason: 'unavailable' };
		}
		const clean = normalizeTaskTitle(title);
		if (!clean) {
			return { ok: false, reason: 'rejected' };
		}
		const columns: TeamTaskStatus[] = ['todo', 'doing', 'review', 'done'];
		const column = columns.includes(status as TeamTaskStatus) ? status as TeamTaskStatus : 'todo';
		const id = await this.bridge.createTask(clean, column);
		if (!id) {
			return { ok: false, reason: 'rejected' };
		}
		await this.refreshTeamBoard();
		return { ok: true };
	}

	/**
	 * Взять задачу доски в работу. Повторный клик (или автозабор) не создаёт второй запуск:
	 * поток графа детерминирован по taskId, а при уже идущем запуске панель просто открывается.
	 */
	async runTeamTaskById(taskId: string): Promise<void> {
		const id = String(taskId ?? '').trim();
		if (!id) {
			return;
		}
		if (!this.bridge.available) {
			throw new Error('Aura Team недоступен: установите плагин Team.');
		}
		// Флаг ставится СИНХРОННО (до первого await): два быстрых клика не создадут два запуска.
		if (this.running || this.teamRunPending) {
			await vscode.commands.executeCommand('auraOrchestrator.open');
			return;
		}
		this.teamRunPending = true;
		try {
			let task = this.teamTasks.find(item => item.id === id);
			if (!task) {
				await this.refreshTeamBoard();
				task = this.teamTasks.find(item => item.id === id);
			}
			if (!task) {
				throw new Error(`Задача ${id} не найдена на доске команды.`);
			}
			const threadId = this.teamThreadMap()[id] ?? threadIdForTask(id);
			await this.saveTeamThreadMap(withThreadMapping(this.teamThreadMap(), id, threadId));
			// Задача взята: статус и заметка видны всей команде сразу (assignee — человек,
			// поэтому «назначение Orchestrator» — это заметка в описании).
			await this.bridge.updateTask(id, { status: 'doing', description: withOrchestratorNote(task.description, { text: 'взял в работу', at: Date.now() }) });

			const finished = new Promise<void>(resolve => { this.activeRun = resolve; });
			const started = await this.beginTask(taskTextForGraph(task), undefined, threadId);
			if (!started.ok) {
				this.activeRun = undefined;
				await this.bridge.updateTask(id, { status: 'doing', description: withOrchestratorNote(task.description, outcomeNote('error', started.error)) });
				throw new Error(started.error);
			}
			await finished;
			// Итог фиксируем сразу: автозабор уже мог запустить следующий заход и перезаписать state.
			await this.syncTeamOutcome(id, task.description, this.lastRunStatus, this.run.summary);
		} finally {
			this.teamRunPending = false;
		}
	}

	/** Итог запуска → статус и заметка задачи: готовый патч уходит на ревью, остальное — в работу. */
	private async syncTeamOutcome(taskId: string, originalDescription: string, outcome: RunStatus, summary?: string): Promise<void> {
		if (!this.bridge.available) {
			return;
		}
		await this.bridge.updateTask(taskId, {
			status: statusForOutcome(outcome),
			description: withOrchestratorNote(originalDescription, outcomeNote(outcome, summary)),
		});
	}

	/** Автозабор: задачи из todo с меткой [agent]. Оркестратор идёт по одной за раз. */
	private async maybeAutoGrab(): Promise<void> {
		if (!this.config.teamAutoGrab || !this.bridge.available || this.running || this.teamRunPending) {
			return;
		}
		const [next] = pickAgentTasks(this.teamTasks, Math.max(1, this.config.teamAutoGrabLimit), [...this.autoGrabAttempted]);
		if (!next) {
			return;
		}
		this.autoGrabAttempted.add(next.id);
		this.appendLog(`автозабор: беру задачу «${next.title}»`);
		this.pushState();
		void this.runTeamTaskById(next.id).catch(err => logWarn(`auto-grab failed: ${err instanceof Error ? err.message : err}`));
	}
}

export function checkpointDirFor(rootPath: string): string {
	return path.join(rootPath, CHECKPOINT_DIR);
}

/**
 * Общий переключатель языка Aura (настройка ядра IDE aura.language).
 * Читается напрямую, а не через конфиг расширения: панель обязана слушаться
 * того же переключателя, что и маркет, иначе «один выбор на всю IDE» не работает.
 * Незнакомое/пустое значение — 'auto'.
 */
function auraLanguageSetting(): UiLanguage {
	const value = vscode.workspace.getConfiguration('aura').get<string>('language', 'auto');
	return value === 'ru' || value === 'en' ? value : 'auto';
}

/** Уровень строки журнала по типу события и тексту: ошибки и предупреждения видны сразу. */
function eventLevel(type: string, message: string): 'info' | 'warn' | 'error' {
	if (type === 'node.error' || type === 'graph.error') {
		return 'error';
	}
	if (/не удал|не выполн|ошиб|не доступ|failed|error/i.test(message)) {
		return 'warn';
	}
	return 'info';
}
