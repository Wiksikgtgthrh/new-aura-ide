import * as vscode from 'vscode';
import { OrchestratorHost } from './host';
import { ORCHESTRATOR_VIEW_TYPE, OrchestratorPanelProvider } from './panel/panelProvider';
import { OrchestratorLauncherProvider } from './panel/launcherProvider';
import { registerTeamTool } from './team/tool';
import { initLog, logInfo } from './util/log';

let host: OrchestratorHost | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	initLog();
	logInfo('activating langgraph-orchestrator');

	host = new OrchestratorHost(context);
	context.subscriptions.push(host);
	await host.init();

	context.subscriptions.push(...OrchestratorPanelProvider.register(context, host));

	// Иконка в activity bar — часть плагина: вью гейтится флагом
	// `auraPlugin.langgraph-orchestrator.enabled`, который выставляет Aura Market.
	context.subscriptions.push(OrchestratorLauncherProvider.register(host));

	// Инструмент чата: из диалога можно поручить задачу команде агентов,
	// прогресс по агентам виден в виджете инструмента.
	registerTeamTool(context, host);

	const openPanel = () => vscode.commands.executeCommand(
		'vscode.openWith',
		OrchestratorPanelProvider.panelUri(),
		ORCHESTRATOR_VIEW_TYPE,
		{ preview: false },
	);

	// Открыть панель и переключить её на нужную вкладку (пункты палитры).
	const showTab = (tab: string) => async (): Promise<void> => {
		await openPanel();
		host?.requestTab(tab);
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('auraOrchestrator.open', openPanel),
		vscode.commands.registerCommand('auraOrchestrator.startTask', async (task?: string) => {
			await openPanel();
			await host?.startTask(typeof task === 'string' ? task : undefined);
		}),
		vscode.commands.registerCommand('auraOrchestrator.pause', () => host?.pause()),
		vscode.commands.registerCommand('auraOrchestrator.resume', () => host?.resume()),
		vscode.commands.registerCommand('auraOrchestrator.cancel', () => host?.cancel()),
		vscode.commands.registerCommand('auraOrchestrator.interrupt.resolve', async (approved?: boolean) => {
			await host?.resolveInterruptPublic(approved !== false);
		}),
		vscode.commands.registerCommand('auraOrchestrator.tab.run', showTab('run')),
		vscode.commands.registerCommand('auraOrchestrator.tab.board', showTab('board')),
		vscode.commands.registerCommand('auraOrchestrator.tab.models', showTab('models')),
		vscode.commands.registerCommand('auraOrchestrator.tab.trace', showTab('trace')),
		vscode.commands.registerCommand('auraOrchestrator.tab.log', showTab('log')),
		// Публичная команда моста: доска тимы отдаёт задачу оркестратору по taskId.
		vscode.commands.registerCommand('orchestrator.runTeamTask', async (taskId?: string) => {
			await openPanel();
			await host?.runTeamTaskById(String(taskId ?? ''));
		}),
	);

	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
	statusBar.command = 'auraOrchestrator.open';
	statusBar.text = '$(symbol-misc) Оркестратор';
	statusBar.tooltip = 'LangGraph Оркестратор — открыть панель';
	statusBar.show();
	context.subscriptions.push(statusBar);
	context.subscriptions.push(host.onDidChangeState(state => {
		statusBar.text = state.running
			? (state.paused ? '$(debug-pause) Оркестратор' : '$(sync~spin) Оркестратор')
			: '$(symbol-misc) Оркестратор';
	}));

	logInfo('langgraph-orchestrator activated');
}

export function deactivate(): void {
	host?.dispose();
	host = undefined;
}
