/*---------------------------------------------------------------------------------------------
 *  Aura ServerKit — панель управления сервером (ServerKit) во вкладке IDE.
 *  Иконка в activity bar регистрируется ядром (auraServerkit.contribution.ts) и появляется
 *  только после установки плагина через Aura Market. Клик по иконке открывает вкладку-редактор
 *  с приложением ServerKit (iframe), состояние соединения проверяется через /api/health.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DashboardPanel } from './dashboardPanel';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const panel = new DashboardPanel(context.extensionUri);

	context.subscriptions.push(
		vscode.commands.registerCommand('auraServerkit.openDashboard', () => openDashboard()),
		vscode.commands.registerCommand('auraServerkit.checkStatus', () => checkStatus())
	);

	async function openDashboard(): Promise<void> {
		await panel.show();
	}

	async function checkStatus(): Promise<void> {
		const url = serverUrl();
		vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Checking ServerKit at {0}…', url) }, async () => {
			try {
				const response = await fetch(`${url.replace(/\/$/, '')}/api/v1/system/health`, { signal: AbortSignal.timeout(5000) });
				if (response.ok) {
					const body = await response.text().catch(() => '');
					void vscode.window.showInformationMessage(vscode.l10n.t('ServerKit is up: {0} {1}', String(response.status), body.slice(0, 100)));
				} else {
					void vscode.window.showWarningMessage(vscode.l10n.t('ServerKit responded with HTTP {0}.', String(response.status)));
				}
			} catch (error) {
				void vscode.window.showErrorMessage(vscode.l10n.t('ServerKit is unreachable at {0}: {1}', url, error instanceof Error ? error.message : String(error)));
			}
		});
	}
}

function serverUrl(): string {
	return vscode.workspace.getConfiguration('auraServerkit').get<string>('serverUrl', 'https://serverkit.auraide.xyz').replace(/\/$/, '');
}
