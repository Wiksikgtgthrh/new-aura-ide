import * as vscode from 'vscode';
import { KeyTier, OrchestratorConfig } from '../util/config';
import { defaultTierForModel, ModelSource, TierStore } from '../llm/tierStore';
import { logInfo, logWarn } from '../util/log';
import { keyIdsFromModelIds } from './modelId';
import {
	AuraHealthStatus,
	CoreKeyStatus,
	KeyRuntimeState,
	KeyStatus,
	TeamKeyStatus,
	resolveKeyState,
	runtimeFromError,
} from './status';

export type KeySource = 'local' | 'team';
export type { KeyStatus };

export interface KeyEntry {
	id: string;
	source: KeySource;
	name: string;
	model: string;
	baseUrl: string;
	tier: KeyTier;
	status: KeyStatus;
	/**
	 * Ключ можно выбрать для вызова модели: у него есть модель вендора API Keys.
	 * Строка командного банка без локального прокси — только сведения, не кандидат.
	 */
	selectable: boolean;
	/** Пинг проверки ключа (мс) из ядра или из командного банка. */
	pingMs?: number;
	/** Полное время последнего успешного вызова модели — это не пинг, отдельная колонка. */
	lastCallMs?: number;
	cooldownUntil?: number;
	lastError?: string;
	/** Командный приоритет 0-1000, если известен */
	teamPriority?: number;
	/** Сколько вызовов модели идёт через ключ прямо сейчас. */
	activeCalls: number;
	health?: AuraHealthStatus;
	latencyMs?: number;
	authenticityPct?: number | null;
	securityPct?: number | null;
	lastChecked?: number;
	checking?: boolean;
	excludedReason?: 'ping' | 'latency';
	/** Локальное состояние (ручное исключение, cooldown, отказ) — переживает refresh(). */
	runtime: KeyRuntimeState;
}

interface ExportedKey {
	id: string;
	name?: string;
	baseUrl?: string;
	model?: string;
	priority?: string;
}

interface TeamKeyInfo extends TeamKeyStatus {
	id: string;
	label: string;
	provider: string;
	priority: number;
}

/** Сырые источники по ключу: нужны, чтобы пересчитать статус между refresh(). */
interface KeySources {
	core?: CoreKeyStatus;
	team?: TeamKeyInfo;
	modelUsable: boolean;
}

const TEAM_PROXY_PREFIX = 'Team · ';
const TEAM_ROW_PREFIX = 'team:';

/**
 * Реестр ключей: объединяет локальный банк плагина Aura API (команды
 * apiKeys.exportKeysList + apiKeys.exportStatuses) и командный банк
 * (auraTeam.getState), назначает тиры, отдаёт статусы и пинг и следит за тем,
 * сколько агентов сидит на каждом ключе. Секретов здесь нет — только метаданные.
 */
export class KeyRegistry implements vscode.Disposable {
	private entries = new Map<string, KeyEntry>();
	private sources = new Map<string, KeySources>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	constructor(private config: OrchestratorConfig, private tierStore?: TierStore) {
		this.disposables.push(
			vscode.lm.onDidChangeChatModels(() => void this.refresh()),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('langgraphOrchestrator')) {
					void this.refresh();
				}
			}),
		);
	}

	updateConfig(config: OrchestratorConfig): void {
		this.config = config;
		this.tierStore?.setOverrides(config.tierOverrides);
	}

	async refresh(): Promise<KeyEntry[]> {
		const [exported, usableIds, teamKeys, coreStatuses] = await Promise.all([
			this.listLocalKeys(),
			this.listUsableKeyIds(),
			this.listTeamKeys(),
			this.listCoreStatuses(),
		]);

		const now = Date.now();
		const next = new Map<string, KeyEntry>();
		const sources = new Map<string, KeySources>();
		const matchedTeamIds = new Set<string>();

		for (const key of exported) {
			const prev = this.entries.get(key.id);
			const teamInfo = this.matchTeamKey(key, teamKeys);
			if (teamInfo) {
				matchedTeamIds.add(teamInfo.id);
			}
			const entry: KeyEntry = {
				id: key.id,
				source: teamInfo ? 'team' : 'local',
				name: key.name ?? key.id,
				model: key.model ?? '',
				baseUrl: key.baseUrl ?? '',
				tier: this.resolveTier(key.id, key, teamInfo),
				status: 'unknown',
				selectable: true,
				pingMs: prev?.pingMs,
				lastCallMs: prev?.lastCallMs,
				cooldownUntil: prev?.cooldownUntil,
				lastError: prev?.lastError,
				teamPriority: teamInfo?.priority,
				activeCalls: prev?.activeCalls ?? 0,
				lastChecked: prev?.lastChecked,
				runtime: prev?.runtime ?? {},
			};
			const source: KeySources = {
				core: coreStatuses.get(key.id),
				team: teamInfo,
				modelUsable: usableIds.has(key.id),
			};
			this.applyStatus(entry, source, now);
			next.set(entry.id, entry);
			sources.set(entry.id, source);
		}

		// Ключи командного банка, которых нет локально: сам вызвать их нельзя,
		// но их пинг и статус — единственные сведения о них, и они нужны в панели.
		for (const teamKey of teamKeys) {
			if (matchedTeamIds.has(teamKey.id)) {
				continue;
			}
			const id = `${TEAM_ROW_PREFIX}${teamKey.id}`;
			const prev = this.entries.get(id);
			const entry: KeyEntry = {
				id,
				source: 'team',
				name: teamKey.label || teamKey.id,
				model: teamKey.provider || '',
				baseUrl: '',
				tier: this.tierStore?.storedTier('team', teamKey.id) ?? tierFromPriority(teamKey.priority),
				status: 'unknown',
				selectable: false,
				pingMs: prev?.pingMs,
				lastCallMs: prev?.lastCallMs,
				cooldownUntil: prev?.cooldownUntil,
				lastError: prev?.lastError,
				teamPriority: teamKey.priority,
				activeCalls: 0,
				runtime: prev?.runtime ?? {},
			};
			const source: KeySources = { team: teamKey, modelUsable: false };
			this.applyStatus(entry, source, now);
			next.set(entry.id, entry);
			sources.set(entry.id, source);
		}

		this.entries = next;
		this.sources = sources;
		this.onDidChangeEmitter.fire();
		const statuses = [...next.values()].reduce<Record<string, number>>((acc, key) => {
			acc[key.status] = (acc[key.status] ?? 0) + 1;
			return acc;
		}, {});
		logInfo(`keys refreshed: ${next.size} total, usable=${usableIds.size}, ${JSON.stringify(statuses)}`);
		return this.list();
	}

	list(): KeyEntry[] {
		return [...this.entries.values()];
	}

	get(id: string): KeyEntry | undefined {
		return this.entries.get(id);
	}

	/**
	 * Кандидаты тира: живые ключи с моделью, сначала наименее загруженные, затем
	 * самые быстрые. Загрузка (activeCalls) важнее пинга — так один ключ не
	 * собирает все параллельные подзадачи, а лимит maxAgentsPerKey мягкий:
	 * если под него не проходит никто, лучше взять перегруженный ключ, чем упасть.
	 */
	candidates(tier: KeyTier): KeyEntry[] {
		const now = Date.now();
		const eligible = this.list()
			.filter(k => k.tier === tier && k.selectable)
			.filter(k => k.status === 'ok' || k.status === 'unknown')
			.filter(k => !k.cooldownUntil || k.cooldownUntil <= now);
		const cap = this.config.maxAgentsPerKey;
		if (cap > 0) {
			const underCap = eligible.filter(k => k.activeCalls < cap);
			if (underCap.length) {
				return underCap.sort(byLoad);
			}
		}
		return eligible.sort(byLoad);
	}

	hasUsableInTier(tier: KeyTier): boolean {
		return this.candidates(tier).length > 0;
	}

	/** Начало вызова модели: ключ перестаёт быть «свободным» для балансировки. */
	beginCall(keyId: string): void {
		const entry = this.entries.get(keyId);
		if (!entry) {
			return;
		}
		entry.activeCalls += 1;
		this.onDidChangeEmitter.fire();
	}

	endCall(keyId: string): void {
		const entry = this.entries.get(keyId);
		if (!entry) {
			return;
		}
		entry.activeCalls = Math.max(0, entry.activeCalls - 1);
		this.onDidChangeEmitter.fire();
	}

	/** Исход запроса по ключу: ошибки переводят ключ в cooldown или dead. */
	reportOutcome(keyId: string, error: unknown): void {
		const entry = this.entries.get(keyId);
		if (!entry) {
			return;
		}
		const now = Date.now();
		const message = error instanceof Error ? error.message : String(error);
		const patch = runtimeFromError(message, now);
		this.patchRuntime(keyId, { ...patch, excludedManually: false });
		if (patch.dead) {
			logWarn(`key ${keyId} marked dead: ${message}`);
		} else {
			logWarn(`key ${keyId} cooldown ${Math.round(((patch.cooldownUntil ?? 0) - Date.now()) / 1000)}s: ${message}`);
		}
		this.applyStatus(entry, this.sources.get(keyId), Date.now());
		this.onDidChangeEmitter.fire();
	}

	/** Успешный ответ: снимаем локальные ошибки и запоминаем полное время вызова. */
	reportSuccess(keyId: string, lastCallMs?: number): void {
		const entry = this.entries.get(keyId);
		if (!entry) {
			return;
		}
		this.patchRuntime(keyId, { dead: false, cooldownUntil: undefined, lastError: undefined });
		if (lastCallMs !== undefined) {
			entry.lastCallMs = lastCallMs;
		}
		this.applyStatus(entry, this.sources.get(keyId), Date.now());
		this.onDidChangeEmitter.fire();
	}

	/** Ручное управление из панели: вывести ключ из работы или вернуть в строй. */
	setExcluded(keyId: string, excluded: boolean): void {
		const entry = this.entries.get(keyId);
		if (!entry) {
			return;
		}
		this.patchRuntime(keyId, excluded
			? { excludedManually: true, dead: false, cooldownUntil: undefined, lastError: undefined }
			: { excludedManually: false, dead: false, cooldownUntil: undefined, lastError: undefined });
		this.applyStatus(entry, this.sources.get(keyId), Date.now());
		this.onDidChangeEmitter.fire();
	}

	/** Ручное исключение — единственное, что ядро не знает и что надо спрашивать у реестра. */
	isExcluded(keyId: string): boolean {
		return this.entries.get(keyId)?.status === 'excluded';
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.onDidChangeEmitter.dispose();
	}

	// ---- внутреннее ----

	private applyStatus(entry: KeyEntry, source: KeySources | undefined, now: number): void {
		const resolved = resolveKeyState({
			now,
			modelUsable: source?.modelUsable === true,
			runtime: entry.runtime,
			core: source?.core,
			team: source?.team,
		});
		entry.status = resolved.status;
		entry.cooldownUntil = resolved.cooldownUntil;
		entry.pingMs = resolved.pingMs;
		entry.lastError = resolved.lastError;
		entry.health = resolved.health;
		entry.latencyMs = resolved.latencyMs;
		entry.authenticityPct = resolved.authenticityPct;
		entry.securityPct = resolved.securityPct;
		entry.lastChecked = resolved.lastChecked;
		entry.checking = resolved.checking;
		entry.excludedReason = resolved.excludedReason;
	}

	private patchRuntime(keyId: string, patch: Partial<KeyRuntimeState>): void {
		const entry = this.entries.get(keyId);
		if (!entry) {
			return;
		}
		entry.runtime = { ...entry.runtime, ...patch };
	}

	private async listLocalKeys(): Promise<ExportedKey[]> {
		try {
			const result = await vscode.commands.executeCommand<ExportedKey[]>('apiKeys.exportKeysList');
			return Array.isArray(result) ? result : [];
		} catch {
			return [];
		}
	}

	/** Статусы ключей из ядра (метаданные без секретов). */
	private async listCoreStatuses(): Promise<Map<string, CoreKeyStatus>> {
		const map = new Map<string, CoreKeyStatus>();
		try {
			const result = await vscode.commands.executeCommand<Array<CoreKeyStatus & { id?: string }>>('apiKeys.exportStatuses');
			for (const item of Array.isArray(result) ? result : []) {
				if (item && typeof item.id === 'string') {
					map.set(item.id, item);
				}
			}
		} catch {
			// Плагин API Keys может быть отключён — тогда статусов нет, работаем на vscode.lm.
		}
		return map;
	}

	private async listUsableKeyIds(): Promise<Set<string>> {
		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'apiKeys' });
			return keyIdsFromModelIds(models.map(m => m.id));
		} catch {
			return new Set();
		}
	}

	private async listTeamKeys(): Promise<TeamKeyInfo[]> {
		try {
			const state = await vscode.commands.executeCommand<{ keys?: TeamKeyInfo[] }>('auraTeam.getState');
			return Array.isArray(state?.keys) ? state.keys : [];
		} catch {
			return [];
		}
	}

	/** Связь локального ключа с командным банком: по метке, затем по вхождению. */
	private matchTeamKey(key: ExportedKey, teamKeys: TeamKeyInfo[]): TeamKeyInfo | undefined {
		if (teamKeys.length === 0) {
			return undefined;
		}
		const name = key.name ?? '';
		const label = name.startsWith(TEAM_PROXY_PREFIX) ? name.slice(TEAM_PROXY_PREFIX.length) : name;
		return teamKeys.find(t => t.label === label)
			?? teamKeys.find(t => t.label === name)
			?? teamKeys.find(t => label.includes(t.label));
	}

	private resolveTier(keyId: string, key: ExportedKey, teamInfo?: TeamKeyInfo): KeyTier {
		const override = this.config.tierOverrides[keyId];
		if (override) {
			return override;
		}
		// Выбор человека в панели (globalState) важнее правил по имени: он переживает рестарт.
		const source: ModelSource = teamInfo ? 'team' : 'personal';
		const stored = this.tierStore?.storedTier(source, keyId);
		if (stored) {
			return stored;
		}
		const haystack = `${key.name ?? ''} ${key.baseUrl ?? ''} ${key.model ?? ''}`.toLowerCase();
		for (const rule of this.config.tierRules) {
			const matchOk = !rule.match || haystack.includes(rule.match.toLowerCase());
			const priority = teamInfo?.priority;
			const rangeOk = (rule.priorityFrom === undefined && rule.priorityTo === undefined)
				|| (priority !== undefined
					&& (rule.priorityFrom === undefined || priority >= rule.priorityFrom)
					&& (rule.priorityTo === undefined || priority <= rule.priorityTo));
			if (matchOk && rangeOk) {
				return rule.tier;
			}
		}
		// Эвристика по имени модели, затем командный приоритет и метка ключа.
		const heuristic = defaultTierForModel(haystack);
		if (heuristic !== 'mid') {
			return heuristic;
		}
		if (teamInfo) {
			return tierFromPriority(teamInfo.priority);
		}
		switch ((key.priority ?? '').toLowerCase()) {
			case 'high': return 'high';
			case 'low': return 'low';
			default: return 'mid';
		}
	}
}

/** Командный приоритет 0-1000 → тир (та же граница, что в правилах тиров). */
export function tierFromPriority(priority: number | undefined): KeyTier {
	if (priority === undefined) {
		return 'mid';
	}
	if (priority <= 100) {
		return 'high';
	}
	if (priority <= 500) {
		return 'mid';
	}
	return 'low';
}

/** Сортировка кандидатов: свободный ключ важнее быстрого. */
function byLoad(a: KeyEntry, b: KeyEntry): number {
	if (a.activeCalls !== b.activeCalls) {
		return a.activeCalls - b.activeCalls;
	}
	const ping = (a.pingMs ?? Number.MAX_SAFE_INTEGER) - (b.pingMs ?? Number.MAX_SAFE_INTEGER);
	return ping !== 0 ? ping : a.id.localeCompare(b.id);
}

