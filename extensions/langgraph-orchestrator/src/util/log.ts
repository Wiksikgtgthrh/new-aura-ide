import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLog(): vscode.OutputChannel {
	if (!channel) {
		channel = vscode.window.createOutputChannel('LangGraph Orchestrator');
	}
	return channel;
}

export function logInfo(message: string): void {
	channel?.appendLine(`[info ${new Date().toISOString()}] ${message}`);
}

export function logWarn(message: string): void {
	channel?.appendLine(`[warn ${new Date().toISOString()}] ${message}`);
}

export function logError(message: string, err?: unknown): void {
	const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err ?? '');
	channel?.appendLine(`[error ${new Date().toISOString()}] ${message}${detail ? ` — ${detail}` : ''}`);
}
