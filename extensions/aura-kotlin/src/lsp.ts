/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — Kotlin Language Server на обобщённом LSP-клиенте (lspClient.ts).
 *  Здесь только «котельная» конкретного языка: поиск сервера, classpath в initializationOptions
 *  и регистрация провайдеров. Транспорт, диагностика, code actions и автоимпорт — общие.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { tr } from './l10n';
import { LspClient, LspClientOptions, LspState, registerLspCommandExecutor, registerLspProviders } from './lspClient';
import { resolveServer, offerServerInstall, installServer } from './lspInstall';

export type { LspState } from './lspClient';

/** Провайдер classpath (Gradle/Maven зависимости, этап 1 ТЗ). */
export interface ClasspathProvider { readonly classpath: { jars: string[] } }

export const KOTLIN_SERVER_VERSION = '1.3.13';

function isKotlin(document: vscode.TextDocument): boolean {
	return document.languageId === 'kotlin' || document.uri.fsPath.endsWith('.kt') || document.uri.fsPath.endsWith('.kts');
}

function kotlinOptions(context: vscode.ExtensionContext, classpathProvider?: ClasspathProvider): LspClientOptions {
	return {
		languageId: 'kotlin',
		serverName: 'Kotlin Language Server',
		outputName: 'Kotlin Language Server',
		diagnosticSource: 'kotlin-lsp',
		matches: isKotlin,
		completionTriggers: ['.', ':'],
		// jar-файлы из Gradle/Maven передаются серверу при старте.
		initializationOptions: () => ({ classpath: classpathProvider?.classpath.jars ?? [] }),
		resolveLaunch: () => resolveServer(context),
		offerInstall: () => offerServerInstall(context),
	};
}

/** Обёртка над общим клиентом: сохранён прежний публичный API (available/serverState/restart). */
export class KotlinLspClient implements vscode.Disposable {

	readonly lsp: LspClient;

	constructor(context: vscode.ExtensionContext, classpathProvider?: ClasspathProvider) {
		this.lsp = new LspClient(kotlinOptions(context, classpathProvider));
	}

	get available(): boolean { return this.lsp.available; }

	get serverState(): LspState { return this.lsp.serverState; }

	onDidChangeState(listener: (state: LspState) => void): vscode.Disposable { return this.lsp.onDidChangeState(listener); }

	ensureStarted(): Promise<boolean> { return this.lsp.ensureStarted(); }

	restart(): void { this.lsp.restart(); }

	dispose(): void { this.lsp.dispose(); }

	didOpen(document: vscode.TextDocument): void { this.lsp.didOpen(document); }

	didChange(document: vscode.TextDocument, event?: vscode.TextDocumentChangeEvent): void { this.lsp.didChange(document, event); }

	didSave(document: vscode.TextDocument): void { this.lsp.didSave(document); }

	didClose(document: vscode.TextDocument): void { this.lsp.didClose(document); }
}

export function registerKotlinLsp(context: vscode.ExtensionContext, classpathProvider?: ClasspathProvider): KotlinLspClient {
	const client = new KotlinLspClient(context, classpathProvider);

	context.subscriptions.push(
		client,
		vscode.workspace.onDidOpenTextDocument(async (document) => {
			if (!isKotlin(document)) { return; }
			// Автозапуск сервера при первом .kt; тихо, если сервер не установлен.
			if (await client.ensureStarted()) { client.didOpen(document); }
		}),
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (isKotlin(event.document)) { client.didChange(event.document, event); }
		}),
		vscode.workspace.onDidSaveTextDocument((document) => {
			if (isKotlin(document)) { client.didSave(document); }
		}),
		vscode.workspace.onDidCloseTextDocument((document) => {
			if (isKotlin(document)) { client.didClose(document); }
		}),
		vscode.commands.registerCommand('auraKotlin.restartLsp', async () => {
			client.restart();
			void vscode.window.showInformationMessage(tr('Kotlin Language Server restarted.'));
		}),
		vscode.commands.registerCommand('auraKotlin.installLsp', async () => {
			const lib = await installServer(context);
			if (lib) {
				void vscode.window.showInformationMessage(tr('Kotlin Language Server {0} installed.', KOTLIN_SERVER_VERSION));
				client.restart();
			}
		}),
	);

	registerLspProviders(context, client.lsp, { languageId: 'kotlin', completionTriggers: ['.', ':'] });
	registerLspCommandExecutor(context, client.lsp);

	// Если сервер появился после старта — подхватываем открытые документы.
	void client.ensureStarted().then(started => {
		if (!started) { return; }
		for (const document of vscode.workspace.textDocuments) {
			if (isKotlin(document)) { client.didOpen(document); }
		}
	});

	return client;
}
