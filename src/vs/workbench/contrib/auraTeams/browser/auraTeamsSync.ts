/*---------------------------------------------------------------------------------------------
 *  Aura Teams — синхронизация доски с Supabase: локальные правки уходят на сервер,
 *  серверные события применяются к доске. Включается настройками auraTeams.supabase.*.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStatusbarService, StatusbarAlignment, IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';
import { IAuraTeamsService } from '../common/auraTeamsService.js';
import { ISupabaseConfig, mergeTasks } from '../common/auraTeamsSupabase.js';
import { AuraTeamsSupabaseClient, SupabaseConnectionState } from './auraTeamsSupabaseClient.js';

export const AURA_TEAMS_SUPABASE_URL_SETTING = 'auraTeams.supabase.url';
export const AURA_TEAMS_SUPABASE_KEY_SETTING = 'auraTeams.supabase.anonKey';
export const AURA_TEAMS_SUPABASE_PROJECT_SETTING = 'auraTeams.supabase.project';

const STATUS_ID = 'auraTeams.sync';

export class AuraTeamsSyncContribution extends Disposable {

	static readonly ID = 'workbench.contrib.auraTeamsSync';

	private readonly session = this._register(new MutableDisposable<DisposableStore>());
	private readonly status = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IAuraTeamsService private readonly teams: IAuraTeamsService,
	) {
		super();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('auraTeams.supabase')) {
				this.restart();
			}
		}));
		this.restart();
	}

	private config(): ISupabaseConfig | undefined {
		const url = (this.configurationService.getValue<string>(AURA_TEAMS_SUPABASE_URL_SETTING) ?? '').trim();
		const anonKey = (this.configurationService.getValue<string>(AURA_TEAMS_SUPABASE_KEY_SETTING) ?? '').trim();
		if (!url || !anonKey) {
			return undefined;
		}
		const explicit = (this.configurationService.getValue<string>(AURA_TEAMS_SUPABASE_PROJECT_SETTING) ?? '').trim();
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		const project = explicit || folder?.name || 'default';
		return { url, anonKey, project };
	}

	private restart(): void {
		this.session.clear();
		this.status.clear();
		const config = this.config();
		if (!config) {
			return;
		}
		const store = new DisposableStore();
		this.session.value = store;
		const client = store.add(new AuraTeamsSupabaseClient(config));

		store.add(client.onDidChangeState(state => this.updateStatus(state, config.project)));
		this.updateStatus('connecting', config.project);

		store.add(client.onDidReceive(event => {
			if (event.type === 'upsert') {
				this.teams.applyRemoteUpsert(event.task);
			} else {
				this.teams.applyRemoteRemove(event.id);
			}
		}));

		store.add(this.teams.onDidChangeLocally(change => {
			const op = change.kind === 'upsert' ? client.upsert(change.tasks) : client.remove(change.id);
			op.catch(e => this.logService.warn('[AuraTeams] sync push failed', e));
		}));

		void this.initialSync(client);
		client.connect();
	}

	/** Первичное слияние: сервер + локальное, побеждает поздний updatedAt; локальные новые уходят наверх. */
	private async initialSync(client: AuraTeamsSupabaseClient): Promise<void> {
		try {
			const remote = await client.fetchAll();
			const local = this.teams.getTasks();
			const remoteIds = new Set(remote.map(t => t.id));
			const merged = mergeTasks(local, remote, remoteIds);
			this.teams.applyRemote(merged);
			// всё, чего на сервере нет или что у нас свежее — отправляем
			const toPush = merged.filter(t => {
				const r = remote.find(x => x.id === t.id);
				return !r || t.updatedAt > r.updatedAt;
			});
			await client.upsert(toPush);
		} catch (e) {
			this.logService.warn('[AuraTeams] initial sync failed', e);
			this.notificationService.warn(`Aura Teams: не удалось синхронизироваться с Supabase — ${e instanceof Error ? e.message : String(e)}. Работаю локально, повторю при переподключении.`);
		}
	}

	private updateStatus(state: SupabaseConnectionState, project: string): void {
		const icon = state === 'online' ? '$(cloud)' : state === 'connecting' ? '$(sync~spin)' : '$(cloud-offline)';
		const label = state === 'online' ? 'синхронизация включена' : state === 'connecting' ? 'подключение…' : 'офлайн, повтор через 5 с';
		const entry = {
			name: 'Aura Teams',
			text: `${icon} Teams`,
			ariaLabel: `Aura Teams: ${label}`,
			tooltip: `Aura Teams · проект «${project}» · ${label}`,
			command: 'auraTeams.openBoard',
		};
		if (this.status.value) {
			this.status.value.update(entry);
		} else {
			this.status.value = this.statusbarService.addEntry(entry, STATUS_ID, StatusbarAlignment.RIGHT, 50);
		}
	}
}
