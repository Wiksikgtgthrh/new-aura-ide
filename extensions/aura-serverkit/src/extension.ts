/*---------------------------------------------------------------------------------------------
 *  Aura ServerKit — панель управления сервером (ServerKit) во вкладке IDE.
 *  Иконка в activity bar регистрируется ядром (auraServerkit.contribution.ts) и появляется
 *  только после установки плагина через Aura Market. Клик по иконке открывает вкладку-редактор
 *  с приложением ServerKit (iframe), состояние соединения проверяется через /api/v1/system/health.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DashboardPanel } from './dashboardPanel';
import { probeServer, serverUrl } from './server';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const panel = new DashboardPanel(context.extensionUri);

	context.subscriptions.push(
		vscode.commands.registerCommand('auraServerkit.openDashboard', (url?: unknown) => openDashboard(typeof url === 'string' && url ? url : serverUrl())),
		vscode.commands.registerCommand('auraServerkit.checkStatus', () => checkStatus())
	);

	async function openDashboard(url: string): Promise<void> {
		await panel.show(url);
	}

	async function checkStatus(): Promise<void> {
		const url = serverUrl();
		vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Checking ServerKit at {0}…', url) }, async () => {
			const status = await probeServer(url, 5000);
			if (status.ok) {
				const suffix = status.version ? ` v${status.version}` : '';
				void vscode.window.showInformationMessage(vscode.l10n.t('ServerKit is up: {0}{1}', String(status.code ?? 200), suffix));
			} else if (status.code !== undefined) {
				void vscode.window.showWarningMessage(vscode.l10n.t('ServerKit responded with HTTP {0} at {1}.', String(status.code), url));
			} else {
				void vscode.window.showErrorMessage(vscode.l10n.t('ServerKit is unreachable at {0}: {1}', url, status.error ?? ''));
			}
		});
	}
}

export function deactivate(): void { }
