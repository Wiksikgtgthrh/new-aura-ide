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
			const modes = ['off', 'ask', 'auto'];
			const current = cfg.get<string>('sync.mode', 'off');
			const next = modes[(modes.indexOf(current) + 1) % modes.length];
			void cfg.update('sync.mode', next, vscode.ConfigurationTarget.Global);
			void cfg.update('sync.autoPush', next === 'auto', vscode.ConfigurationTarget.Global);
			void vscode.window.showInformationMessage(vscode.l10n.t('Team sync mode: {0}', next));
		}));

		this.disposables.push(vscode.window.onDidChangeWindowState(state => {
			if (state.focused) { void this.autoPull(); }
		}));

		this.disposables.push(vscode.workspace.onDidSaveTextDocument(() => {
			const mode = vscode.workspace.getConfiguration('auraTeam').get<string>('sync.mode', 'off');
			if (mode !== 'ask' && !vscode.workspace.getConfiguration('auraTeam').get<boolean>('sync.autoPush')) { return; }
			if (this.pushTimer) { clearTimeout(this.pushTimer); }
			this.pushTimer = setTimeout(() => void (mode === 'ask' ? this.askPush() : this.autoPush()), 5_000);
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

	/** Режим «спросить»: по дебаунсу всплывает поле ввода сообщения (с шаблоном), Enter — коммит+пуш. */
	private async askPush(): Promise<void> {
		if (this.busy || !(await this.hasRepository())) { return; }
		try {
			const changed = await this.git.changedFiles();
			if (changed.length === 0) { return; }
			const template = vscode.workspace.getConfiguration('auraTeam').get<string>('sync.commitTemplate', 'wip: {files}');
			const files = changed.slice(0, 3).join(', ') + (changed.length > 3 ? `, +${changed.length - 3}` : '');
			const suggested = template.replace('{files}', files).replace('{date}', new Date().toISOString().slice(0, 16).replace('T', ' '));
			const message = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Commit and push {0} changed file(s)?', changed.length),
				value: suggested,
				ignoreFocusOut: false
			});
			if (message === undefined) { return; } // Esc — отложили
			const trimmed = message.trim();
			if (!trimmed) { return; }
			this.busy = true;
			this.render('busy');
			await this.git.commitAll(trimmed);
			this.log.appendLine(`[teamSync] ask-push: ${trimmed}`);
			this.render('ok');
		} catch (error) {
			this.log.appendLine(`[teamSync] ask-push failed: ${String(error)}`);
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
