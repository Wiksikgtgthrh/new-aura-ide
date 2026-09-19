/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — минимальный LSP-клиент без внешних зависимостей.
 *  Запускает Kotlin Language Server (например, fwcd/kotlin-language-server) при открытии
 *  .kt/.kts и отдаёт в редактор диагностику, hover, автодополнение и переход к определению.
 *  Зависимость vscode-languageclient не используется, чтобы сервер оставался в дистрибутиве.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'node:child_process';

const SERVER_SETTING = 'auraKotlin.kotlinLspPath';

/** Провайдер classpath (Gradle/Maven зависимости, Этап 3). */
export interface ClasspathProvider { readonly classpath: { jars: string[] } }

interface PendingRequest { resolve: (value: unknown) => void; reject: (error: Error) => void; }class KotlinLspClient implements vscode.Disposable {
	private process?: ChildProcess;
	private stdoutBuffer = Buffer.alloc(0);
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly diagnostics = vscode.languages.createDiagnosticCollection('kotlin-lsp');
	private started = false;
	private starting: Promise<boolean> | undefined;
	private readonly output = vscode.window.createOutputChannel('Kotlin Language Server');

	constructor(private readonly classpathProvider?: ClasspathProvider) { }

	dispose(): void {
		this.stop();
		this.diagnostics.dispose();
		this.output.dispose();
	}

	get available(): boolean { return this.started && !!this.process && !this.process.killed; }

	private serverCommand(): string {
		return vscode.workspace.getConfiguration('auraKotlin').get<string>(SERVER_SETTING, 'kotlin-language-server');
	}

	/** Запускает сервер и делает handshake. Возвращает true, если сервер готов. */
	async ensureStarted(): Promise<boolean> {
		if (this.available) { return true; }
		this.starting ??= this.start();
		return this.starting;
	}

	private async start(): Promise<boolean> {
		const command = this.serverCommand();
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		try {
			this.process = spawn(command, [], { cwd: workspaceRoot, stdio: ['pipe', 'pipe', 'pipe'] });
		} catch (error) {
			this.output.appendLine(`[lsp] failed to spawn "${command}": ${errorMessage(error)}`);
			return false;
		}
		const proc = this.process;
		this.started = true;
		proc.on('error', (error) => {
			this.output.appendLine(`[lsp] ${errorMessage(error)} — установите kotlin-language-server или укажите auraKotlin.kotlinLspPath`);
			this.started = false;
		});
		proc.stderr?.on('data', (chunk: Buffer) => this.output.append(`[server] ${chunk.toString()}`));
		proc.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
		proc.on('exit', (code) => {
			this.output.appendLine(`[lsp] server exited with code ${code}`);
			this.started = false;
			this.process = undefined;
		});

		const rootUri = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
		// Этап 3: jar-файлы из Gradle/Maven передаются серверу при старте.
		const jars = this.classpathProvider?.classpath.jars ?? [];
		const result = await this.request('initialize', {
			processId: process.pid,
			rootUri,
			initializationOptions: { classpath: jars },
			capabilities: {
				textDocument: {
					hover: { contentFormat: ['markdown', 'plaintext'] },
					completion: { completionItem: { documentationFormat: ['markdown', 'plaintext'] } },
					definition: {},
				},
			},
		}).catch((error) => {
			this.output.appendLine(`[lsp] initialize failed: ${errorMessage(error)}`);
			return null;
		});
		if (!result) { return false; }
		this.notify('initialized', {});
		this.output.appendLine('[lsp] initialized');
		// Открыть уже открытые .kt-документы, если расширение активировалось позже.
		for (const document of vscode.workspace.textDocuments) {
			if (isKotlin(document)) { this.didOpen(document); }
		}
		return true;
	}

	private stop(): void {
		if (this.process) {
			try { this.notify('shutdown', null); } catch { /* сервер мог уйти */ }
			this.process.kill();
			this.process = undefined;
		}
		this.started = false;
		this.starting = undefined;
	}

	restart(): void {
		this.stop();
		void this.ensureStarted();
	}

	// ---------- JSON-RPC over stdio ----------

	private onData(chunk: Buffer): void {
		this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
		for (;;) {
			const headerEnd = this.stdoutBuffer.indexOf('\r\n\r\n');
			if (headerEnd < 0) { return; }
			const header = this.stdoutBuffer.slice(0, headerEnd).toString('utf8');
			const match = /Content-Length:\s*(\d+)/i.exec(header);
			if (!match) { this.stdoutBuffer = this.stdoutBuffer.slice(headerEnd + 4); continue; }
			const length = Number(match[1]);
			if (this.stdoutBuffer.length < headerEnd + 4 + length) { return; }
			const body = this.stdoutBuffer.slice(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
			this.stdoutBuffer = this.stdoutBuffer.slice(headerEnd + 4 + length);
			try { this.onMessage(JSON.parse(body)); } catch (error) { this.output.appendLine(`[lsp] bad message: ${errorMessage(error)}`); }
		}
	}

	private onMessage(message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message: string } }): void {
		if (message.id !== undefined && (message.result !== undefined || message.error)) {
			const pending = this.pending.get(Number(message.id));
			if (!pending) { return; }
			this.pending.delete(Number(message.id));
			if (message.error) { pending.reject(new Error(message.error.message)); } else { pending.resolve(message.result); }
			return;
		}
		if (message.method === 'textDocument/publishDiagnostics' && message.params) {
			const params = message.params as { uri: string; diagnostics: LspDiagnostic[] };
			this.diagnostics.set(vscode.Uri.parse(params.uri), params.diagnostics.map(toVscodeDiagnostic));
		}
	}

	private send(payload: unknown): void {
		if (!this.process?.stdin) { throw new Error('Kotlin Language Server is not running'); }
		const body = Buffer.from(JSON.stringify(payload), 'utf8');
		this.process.stdin.write(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
		this.process.stdin.write(body);
	}

	private request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.send({ jsonrpc: '2.0', id, method, params });
			setTimeout(() => {
				if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method}: timeout`)); }
			}, 15_000);
		});
	}

	private notify(method: string, params: unknown): void {
		this.send({ jsonrpc: '2.0', method, params });
	}

	// ---------- Документы ----------

	didOpen(document: vscode.TextDocument): void {
		if (!this.available) { return; }
		this.notify('textDocument/didOpen', {
			textDocument: { uri: document.uri.toString(), languageId: 'kotlin', version: document.version, text: document.getText() },
		});
	}

	didChange(document: vscode.TextDocument): void {
		if (!this.available) { return; }
		this.notify('textDocument/didChange', {
			textDocument: { uri: document.uri.toString(), version: document.version },
			contentChanges: [{ text: document.getText() }],
		});
	}

	didClose(document: vscode.TextDocument): void {
		if (!this.available) { return; }
		this.notify('textDocument/didClose', { textDocument: { uri: document.uri.toString() } });
	}

	async hover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
		if (!this.available) { return undefined; }
		const result = await this.request('textDocument/hover', {
			textDocument: { uri: document.uri.toString() },
			position: toLspPosition(position),
		}).catch(() => undefined) as { contents?: { value?: string; kind?: string } } | undefined;
		const value = result?.contents?.value;
		if (!value) { return undefined; }
		return new vscode.Hover(result?.contents?.kind === 'plaintext' ? new vscode.MarkdownString().appendText(value) : new vscode.MarkdownString(value));
	}

	async definition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Definition | undefined> {
		if (!this.available) { return undefined; }
		const result = await this.request('textDocument/definition', {
			textDocument: { uri: document.uri.toString() },
			position: toLspPosition(position),
		}).catch(() => undefined) as LspLocation | LspLocation[] | undefined;
		if (!result) { return undefined; }
		const locations = Array.isArray(result) ? result : [result];
		return locations.map(location => new vscode.Location(vscode.Uri.parse(location.uri), toVscodeRange(location.range)));
	}

	async completion(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionList | undefined> {
		if (!this.available) { return undefined; }
		const result = await this.request('textDocument/completion', {
			textDocument: { uri: document.uri.toString() },
			position: toLspPosition(position),
		}).catch(() => undefined) as { items?: LspCompletionItem[] } | LspCompletionItem[] | undefined;
		if (!result) { return undefined; }
		const items = Array.isArray(result) ? result : result.items ?? [];
		return new vscode.CompletionList(items.map(toVscodeCompletionItem), true);
	}
}

interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }
interface LspDiagnostic { range: LspRange; message: string; severity?: number; source?: string }
interface LspLocation { uri: string; range: LspRange }
interface LspCompletionItem { label: string; kind?: number; detail?: string; documentation?: string | { value?: string }; insertText?: string }

function isKotlin(document: vscode.TextDocument): boolean {
	return document.languageId === 'kotlin' || document.uri.fsPath.endsWith('.kt') || document.uri.fsPath.endsWith('.kts');
}

function toLspPosition(position: vscode.Position): LspPosition {
	return { line: position.line, character: position.character };
}

function toVscodeRange(range: LspRange): vscode.Range {
	return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

function toVscodeDiagnostic(diagnostic: LspDiagnostic): vscode.Diagnostic {
	const severity = diagnostic.severity === 1 ? vscode.DiagnosticSeverity.Error
		: diagnostic.severity === 2 ? vscode.DiagnosticSeverity.Warning
		: diagnostic.severity === 3 ? vscode.DiagnosticSeverity.Information
		: vscode.DiagnosticSeverity.Hint;
	const result = new vscode.Diagnostic(toVscodeRange(diagnostic.range), diagnostic.message, severity);
	result.source = diagnostic.source ?? 'kotlin-lsp';
	return result;
}

const COMPLETION_KINDS: Record<number, vscode.CompletionItemKind> = {
	1: vscode.CompletionItemKind.Text, 2: vscode.CompletionItemKind.Method, 3: vscode.CompletionItemKind.Function,
	4: vscode.CompletionItemKind.Constructor, 5: vscode.CompletionItemKind.Field, 6: vscode.CompletionItemKind.Variable,
	7: vscode.CompletionItemKind.Class, 8: vscode.CompletionItemKind.Interface, 9: vscode.CompletionItemKind.Module,
	10: vscode.CompletionItemKind.Property, 14: vscode.CompletionItemKind.Keyword, 21: vscode.CompletionItemKind.File,
};

function toVscodeCompletionItem(item: LspCompletionItem): vscode.CompletionItem {
	const result = new vscode.CompletionItem(item.label, COMPLETION_KINDS[item.kind ?? 1] ?? vscode.CompletionItemKind.Text);
	if (item.detail) { result.detail = item.detail; }
	if (typeof item.documentation === 'string') { result.documentation = new vscode.MarkdownString(item.documentation); }
	else if (item.documentation?.value) { result.documentation = new vscode.MarkdownString(item.documentation.value); }
	if (item.insertText) { result.insertText = item.insertText; }
	return result;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

// ---------- Регистрация в workbench ----------

export function registerKotlinLsp(context: vscode.ExtensionContext, classpathProvider?: ClasspathProvider): KotlinLspClient {
	const client = new KotlinLspClient(classpathProvider);

	context.subscriptions.push(
		client,
		vscode.workspace.onDidOpenTextDocument(async (document) => {
			if (!isKotlin(document)) { return; }
			// Автозапуск сервера при первом .kt (Этап 1); тихо, если сервер не установлен.
			if (await client.ensureStarted()) { client.didOpen(document); }
		}),
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (isKotlin(event.document)) { client.didChange(event.document); }
		}),
		vscode.workspace.onDidCloseTextDocument((document) => {
			if (isKotlin(document)) { client.didClose(document); }
		}),
		vscode.languages.registerHoverProvider({ language: 'kotlin' }, {
			provideHover: (document, position) => client.hover(document, position),
		}),
		vscode.languages.registerDefinitionProvider({ language: 'kotlin' }, {
			provideDefinition: (document, position) => client.definition(document, position),
		}),
		vscode.languages.registerCompletionItemProvider({ language: 'kotlin' }, {
			provideCompletionItems: (document, position) => client.completion(document, position),
		}, '.', ':'),
		vscode.commands.registerCommand('auraKotlin.restartLsp', async () => {
			client.restart();
			void vscode.window.showInformationMessage(vscode.l10n.t('Kotlin Language Server restarted.'));
		}),
	);

	// Если сервер появился после старта — подхватываем открытые документы.
	void client.ensureStarted().then(started => {
		if (!started) { return; }
		for (const document of vscode.workspace.textDocuments) {
			if (isKotlin(document)) { client.didOpen(document); }
		}
	});

	return client;
}
