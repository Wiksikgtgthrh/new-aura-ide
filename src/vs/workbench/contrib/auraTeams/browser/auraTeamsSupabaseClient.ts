/*---------------------------------------------------------------------------------------------
 *  Aura Teams — сетевой клиент Supabase: REST для чтения/записи, WebSocket Realtime для событий.
 *  Без SDK: два эндпоинта, чтобы не тянуть зависимость в ядро.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IAuraTask } from '../common/auraTeamsModel.js';
import {
	ISupabaseConfig, ISupabaseTaskRow, SupabaseRealtimeEvent, parseRealtimeMessage, realtimeHeartbeat, realtimeJoinMessage,
	realtimeUrl, restHeaders, restTasksUrl, rowToTask, taskToRow,
} from '../common/auraTeamsSupabase.js';

const HEARTBEAT_MS = 25_000;
const RECONNECT_MS = 5_000;

export type SupabaseConnectionState = 'connecting' | 'online' | 'offline';

export class AuraTeamsSupabaseClient extends Disposable {

	private readonly _onDidReceive = this._register(new Emitter<SupabaseRealtimeEvent>());
	readonly onDidReceive: Event<SupabaseRealtimeEvent> = this._onDidReceive.event;

	private readonly _onDidChangeState = this._register(new Emitter<SupabaseConnectionState>());
	readonly onDidChangeState: Event<SupabaseConnectionState> = this._onDidChangeState.event;

	private _state: SupabaseConnectionState = 'offline';
	get state(): SupabaseConnectionState { return this._state; }

	private socket: WebSocket | undefined;
	private ref = 0;
	private disposed = false;

	constructor(private readonly config: ISupabaseConfig) {
		super();
		this._register(toDisposable(() => {
			this.disposed = true;
			this.socket?.close();
		}));
	}

	private setState(state: SupabaseConnectionState): void {
		if (this._state !== state) {
			this._state = state;
			this._onDidChangeState.fire(state);
		}
	}

	async fetchAll(): Promise<IAuraTask[]> {
		const res = await fetch(restTasksUrl(this.config), { headers: restHeaders(this.config) });
		if (!res.ok) {
			throw new Error(`Supabase ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
		}
		const rows = await res.json() as Partial<ISupabaseTaskRow>[];
		return rows.map(rowToTask).filter((t): t is IAuraTask => !!t);
	}

	async upsert(tasks: readonly IAuraTask[]): Promise<void> {
		if (tasks.length === 0) {
			return;
		}
		const res = await fetch(`${this.config.url.replace(/\/+$/, '')}/rest/v1/aura_tasks?on_conflict=id`, {
			method: 'POST',
			headers: restHeaders(this.config),
			body: JSON.stringify(tasks.map(t => taskToRow(t, this.config.project))),
		});
		if (!res.ok) {
			throw new Error(`Supabase upsert ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
		}
	}

	async remove(id: string): Promise<void> {
		const res = await fetch(`${this.config.url.replace(/\/+$/, '')}/rest/v1/aura_tasks?id=eq.${encodeURIComponent(id)}&project=eq.${encodeURIComponent(this.config.project)}`, {
			method: 'DELETE',
			headers: restHeaders(this.config),
		});
		if (!res.ok) {
			throw new Error(`Supabase delete ${res.status}`);
		}
	}

	/** Подписка на изменения таблицы; переподключается сама, пока клиент не disposed. */
	connect(): void {
		if (this.disposed || this.socket) {
			return;
		}
		this.setState('connecting');
		let socket: WebSocket;
		try {
			socket = new WebSocket(realtimeUrl(this.config));
		} catch {
			this.scheduleReconnect();
			return;
		}
		this.socket = socket;
		let heartbeat: number | undefined;

		socket.onopen = () => {
			socket.send(realtimeJoinMessage(this.config.project, ++this.ref));
			heartbeat = mainWindow.setInterval(() => socket.send(realtimeHeartbeat(++this.ref)), HEARTBEAT_MS);
			this.setState('online');
		};
		socket.onmessage = e => {
			const event = parseRealtimeMessage(typeof e.data === 'string' ? e.data : '');
			if (event) {
				this._onDidReceive.fire(event);
			}
		};
		const onDown = () => {
			if (heartbeat) {
				mainWindow.clearInterval(heartbeat);
			}
			if (this.socket === socket) {
				this.socket = undefined;
			}
			this.setState('offline');
			this.scheduleReconnect();
		};
		socket.onerror = onDown;
		socket.onclose = onDown;
	}

	private scheduleReconnect(): void {
		if (this.disposed) {
			return;
		}
		const handle = setTimeout(() => this.connect(), RECONNECT_MS);
		this._register(toDisposable(() => clearTimeout(handle)));
	}
}
