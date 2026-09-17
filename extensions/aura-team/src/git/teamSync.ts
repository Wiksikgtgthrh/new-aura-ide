import * as vscode from 'vscode';
import { GitService } from './service';

/**
 * Фоновый полуавтоматический синк GitHub:
 *  - автопулл: при фокусе окна и по интервалу (auraTeam.sync.intervalSeconds);
 *  - автопуш: по сохранению файла (auraTeam.sync.autoPush), с дебаунсом и авто-коммитом
 *    по шаблону (auraTeam.sync.commitTemplate);
 *  - индикатор состояния в статус-баре.
 */
export class TeamSyncService implements vscode.Disposable {
	private readonly status: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];
	private timer: NodeJS.Timeout | undefined;
	private pushTimer: NodeJS.Timeout | undefined;
	private busy = false;
	private lastPull = 0;

	constructor(
		private readonly git: GitService,
		private readonly log: vscode.OutputChannel,
	) {
		this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
		this.status.name = 'Team Sync';
		this.status.command = 'auraTeam.syncNow';
		this.disposables.push(this.status);
		this.render('idle');

		this.disposables.push(vscode.commands.registerCommand('auraTeam.syncNow', () => this.syncNow()));
		this.disposables.push(vscode.commands.registerCommand('auraTeam.toggleAutoPush', () => {
			const cfg = vscode.workspace.getConfiguration('auraTeam');
			void cfg.update('sync.autoPush', !cfg.get<boolean>('sync.autoPush'), vscode.ConfigurationTarget.Global);
		}));

		this.disposables.push(vscode.window.onDidChangeWindowState(state => {
			if (state.focused) { void this.autoPull(); }
		}));

		this.disposables.push(vscode.workspace.onDidSaveTextDocument(() => {
			if (!vscode.workspace.getConfiguration('auraTeam').get<boolean>('sync.autoPush')) { return; }
			if (this.pushTimer) { clearTimeout(this.pushTimer); }
			this.pushTimer = setTimeout(() => void this.autoPush(), 5_000);
		}));

		this.restartTimer();
		const cfgListener = vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('auraTeam.sync')) { this.restartTimer(); }
		});
		this.disposables.push(cfgListener);

		this.status.show();
	}

	private restartTimer(): void {
		if (this.timer) { clearInterval(this.timer); }
		const seconds = Math.max(15, vscode.workspace.getConfiguration('auraTeam').get<number>('sync.intervalSeconds', 120));
		this.timer = setInterval(() => void this.autoPull(), seconds * 1000);
	}

	private render(state: 'idle' | 'busy' | 'ok' | 'error' | 'offline'): void {
		switch (state) {
			case 'busy': this.status.text = '$(sync~spin) Team'; this.status.tooltip = 'Team sync in progress…'; break;
			case 'ok': this.status.text = '$(check) Team'; this.status.tooltip = 'Team: repository is up to date'; break;
			case 'error': this.status.text = '$(error) Team'; this.status.tooltip = 'Team sync failed — click to retry'; break;
			case 'offline': this.status.text = '$(cloud-offline) Team'; this.status.tooltip = 'Team sync unavailable'; break;
			default: this.status.text = '$(sync) Team';
		}
		setTimeout(() => { if (this.status.text !== '$(sync~spin) Team') { this.render('idle'); } }, 8_000);
	}

	private async hasRepository(): Promise<boolean> {
		try { this.git.requireRepository(); return true; } catch { return false; }
	}

	private async autoPull(): Promise<void> {
		if (this.busy || !(await this.hasRepository())) { return; }
		// Не пуллим чаще, чем раз в 15 секунд.
		if (Date.now() - this.lastPull < 15_000) { return; }
		this.lastPull = Date.now();
		this.busy = true;
		this.render('busy');
		try {
			await this.git.update();
			this.render('ok');
		} catch (error) {
			this.log.appendLine(`[teamSync] pull failed: ${String(error)}`);
			this.render(String(error).includes('ENOTFOUND') || String(error).includes('timeout') ? 'offline' : 'error');
		} finally {
			this.busy = false;
		}
	}

	private async autoPush(): Promise<void> {
		if (this.busy || !(await this.hasRepository())) { return; }
		this.busy = true;
		this.render('busy');
		try {
			const template = vscode.workspace.getConfiguration('auraTeam').get<string>('sync.commitTemplate', 'wip: {files}');
			const changed = await this.git.changedFiles();
			if (changed.length === 0) { this.render('ok'); return; }
			const files = changed.slice(0, 3).join(', ') + (changed.length > 3 ? `, +${changed.length - 3}` : '');
			const message = template.replace('{files}', files).replace('{date}', new Date().toISOString().slice(0, 16).replace('T', ' '));
			await this.git.commitAll(message);
			this.log.appendLine(`[teamSync] auto-push: ${message}`);
			this.render('ok');
		} catch (error) {
			this.log.appendLine(`[teamSync] push failed: ${String(error)}`);
			this.render('error');
		} finally {
			this.busy = false;
		}
	}

	async syncNow(): Promise<void> {
		await this.autoPull();
	}

	dispose(): void {
		if (this.timer) { clearInterval(this.timer); }
		if (this.pushTimer) { clearTimeout(this.pushTimer); }
		for (const d of this.disposables) { d.dispose(); }
		this.status.dispose();
	}
}
