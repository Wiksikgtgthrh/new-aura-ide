/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — LSP-клиент без внешних зависимостей.
 *  Запускает Kotlin Language Server (например, fwcd/kotlin-language-server) при открытии
 *  .kt/.kts и отдаёт в редактор диагностику, hover, автодополнение, переход к определению,
 *  signatureHelp, documentSymbol, references, rename и codeAction (quick fixes/автоимпорт).
 *  Изменения пересылаются инкрементально (textDocumentSync=2), а не всем текстом.
 *  Состояние сервера доступно для статус-бара; при отсутствии сервера — понятное сообщение
 *  с кнопкой на инструкцию.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'node:child_process';
import { resolveServer, offerServerInstall, installServer, ServerLaunch } from './lspInstall';

/** Провайдер classpath (Gradle/Maven зависимости, этап 1 ТЗ). */
export interface ClasspathProvider { readonly classpath: { jars: string[] } }

export type LspState = 'stopped' | 'starting' | 'running' | 'crashed' | 'not-installed';

interface PendingRequest { resolve: (value: unknown) => void; reject: (error: Error) => void; }

export class KotlinLspClient implements vscode.Disposable {
	private process?: ChildProcess;
	private stdoutBuffer = Buffer.alloc(0);
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly diagnostics = vscode.languages.createDiagnosticCollection('kotlin-lsp');
	private started = false;
	private starting: Promise<boolean> | undefined;
	private readonly output = vscode.window.createOutputChannel('Kotlin Language Server');
	private state: LspState = 'stopped';
	private readonly stateListeners = new Set<(state: LspState) => void>();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly classpathProvider?: ClasspathProvider,
	) { }

	dispose(): void {
		this.stop();
		this.diagnostics.dispose();
		this.output.dispose();
	}

	get available(): boolean { return this.started && !!this.process && !this.process.killed; }

	get serverState(): LspState { return this.state; }

	onDidChangeState(listener: (state: LspState) => void): vscode.Disposable {
		this.stateListeners.add(listener);
		return { dispose: () => this.stateListeners.delete(listener) };
	}

	private setState(state: LspState): void {
		if (this.state === state) { return; }
		this.state = state;
		for (const listener of this.stateListeners) { listener(state); }
	}

	/** Где взять сервер: настройка → комплект → автоскачивание → PATH. */
	private async resolveLaunch(): Promise<ServerLaunch | undefined> {
		const resolved = await resolveServer(this.context);
		if (resolved) { return resolved; }
		// Сервера нет нигде — предлагаем скачать (один клик, ~83 МБ, запоминаем отказ).
		return offerServerInstall(this.context);
	}

	/** Запускает сервер и делает handshake. Возвращает true, если сервер готов. */
	async ensureStarted(): Promise<boolean> {
		if (this.available) { return true; }
		this.starting ??= this.start();
		return this.starting;
	}

	private async start(): Promise<boolean> {
		const launch = await this.resolveLaunch();
		if (!launch) {
			this.setState('not-installed');
			return false;
		}
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		this.setState('starting');
		try {
			this.process = spawn(launch.command, launch.args, { cwd: workspaceRoot, stdio: ['pipe', 'pipe', 'pipe'] });
		} catch (error) {
			this.output.appendLine(`[lsp] failed to spawn "${launch.command}": ${errorMessage(error)}`);
			this.setState('not-installed');
			return false;
		}
		const proc = this.process;
		this.started = true;
		this.output.appendLine(`[lsp] using server from: ${launch.source} (${launch.command})`);
		proc.on('error', (error) => {
			this.output.appendLine(`[lsp] ${errorMessage(error)} — ${vscode.l10n.t('install kotlin-language-server or set auraKotlin.kotlinLspPath')}`);
			this.started = false;
			this.setState('not-installed');
		});
		proc.stderr?.on('data', (chunk: Buffer) => this.output.append(`[server] ${chunk.toString()}`));
		proc.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
		proc.on('exit', (code) => {
			this.output.appendLine(`[lsp] ${vscode.l10n.t('server exited with code {0}', String(code))}`);
			this.started = false;
			this.process = undefined;
			this.setState(this.state === 'not-installed' ? 'not-installed' : 'crashed');
		});

		const rootUri = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
		// jar-файлы из Gradle/Maven передаются серверу при старте.
		const jars = this.classpathProvider?.classpath.jars ?? [];
		const result = await this.request('initialize', {
			processId: process.pid,
			rootUri,
			initializationOptions: { classpath: jars },
			capabilities: {
				textDocument: {
					// Инкрементальные изменения вместо пересылки всего текста.
					synchronization: { openClose: true, didSave: true, change: 2 },
					hover: { contentFormat: ['markdown', 'plaintext'] },
					completion: { completionItem: { documentationFormat: ['markdown', 'plaintext'] } },
					definition: {},
					signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'] } },
					documentSymbol: { symbolKind: { valueSet: [] } },
					references: {},
					rename: { prepareProvider: false },
					codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'source.organizeImports'] } } },
				},
			},
		}).catch((error) => {
			this.output.appendLine(`[lsp] initialize failed: ${errorMessage(error)}`);
			return null;
		});
		if (!result) { this.setState('crashed'); return false; }
		this.notify('initialized', {});
		this.output.appendLine('[lsp] initialized');
		this.setState('running');
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
		this.setState('stopped');
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

	/** Инкрементальная пересылка изменений (contentChanges с диапазонами). */
	didChange(document: vscode.TextDocument, event?: vscode.TextDocumentChangeEvent): void {
		if (!this.available) { return; }
		const changes = (event?.contentChanges ?? [])
			.filter(change => 'range' in change && change.range)
			.map(change => ({ range: toLspRange(change.range as vscode.Range), text: change.text }));
		this.notify('textDocument/didChange', {
			textDocument: { uri: document.uri.toString(), version: document.version },
			contentChanges: changes.length ? changes : [{ text: document.getText() }],
		});
	}

	didSave(document: vscode.TextDocument): void {
		if (!this.available) { return; }
		this.notify('textDocument/didSave', { textDocument: { uri: document.uri.toString() } });
	}

	didClose(document: vscode.TextDocument): void {
		if (!this.available) { return; }
		this.notify('textDocument/didClose', { textDocument: { uri: document.uri.toString() } });
	}

	// ---------- Запросы ----------

	private async ask(method: string, document: vscode.TextDocument, position: vscode.Position, extra?: Record<string, unknown>): Promise<unknown | undefined> {
		if (!this.available) { return undefined; }
		return this.request(method, {
			textDocument: { uri: document.uri.toString() },
			position: toLspPosition(position),
			...extra,
		}).catch(() => undefined);
	}

	async hover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
		const result = await this.ask('textDocument/hover', document, position) as { contents?: { value?: string; kind?: string } } | undefined;
		const value = result?.contents?.value;
		if (!value) { return undefined; }
		return new vscode.Hover(result?.contents?.kind === 'plaintext' ? new vscode.MarkdownString().appendText(value) : new vscode.MarkdownString(value));
	}

	async definition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Definition | undefined> {
		const result = await this.ask('textDocument/definition', document, position) as LspLocation | LspLocation[] | undefined;
		if (!result) { return undefined; }
		const locations = Array.isArray(result) ? result : [result];
		return locations.map(location => new vscode.Location(vscode.Uri.parse(location.uri), toVscodeRange(location.range)));
	}

	async completion(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionList | undefined> {
		const result = await this.ask('textDocument/completion', document, position) as { items?: LspCompletionItem[] } | LspCompletionItem[] | undefined;
		if (!result) { return undefined; }
		const items = Array.isArray(result) ? result : result.items ?? [];
		return new vscode.CompletionList(items.map(toVscodeCompletionItem), true);
	}

	async signatureHelp(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.SignatureHelp | undefined> {
		const result = await this.ask('textDocument/signatureHelp', document, position) as LspSignatureHelp | undefined;
		if (!result?.signatures?.length) { return undefined; }
		const help = new vscode.SignatureHelp();
		help.signatures = result.signatures.map(signature => {
			const item = new vscode.SignatureInformation(signature.label, signature.documentation ? new vscode.MarkdownString(String(signature.documentation)) : undefined);
			item.parameters = (signature.parameters ?? []).map(parameter => new vscode.ParameterInformation(parameter.label, parameter.documentation ? new vscode.MarkdownString(String(parameter.documentation)) : undefined));
			return item;
		});
		help.activeSignature = result.activeSignature ?? 0;
		help.activeParameter = result.activeParameter ?? 0;
		return help;
	}

	async documentSymbol(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[] | undefined> {
		const result = await this.ask('textDocument/documentSymbol', document, new vscode.Position(0, 0)) as LspDocumentSymbol[] | undefined;
		if (!result?.length) { return undefined; }
		return result.map(toVscodeDocumentSymbol);
	}

	async references(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location[] | undefined> {
		const result = await this.ask('textDocument/references', document, position, { context: { includeDeclaration: true } }) as LspLocation[] | undefined;
		if (!result) { return undefined; }
		return result.map(location => new vscode.Location(vscode.Uri.parse(location.uri), toVscodeRange(location.range)));
	}

	async rename(document: vscode.TextDocument, position: vscode.Position, newName: string): Promise<vscode.WorkspaceEdit | undefined> {
		const result = await this.ask('textDocument/rename', document, position, { newName }) as { changes?: Record<string, LspTextEdit[]> } | undefined;
		if (!result?.changes) { return undefined; }
		const edit = new vscode.WorkspaceEdit();
		for (const [uri, textEdits] of Object.entries(result.changes)) {
			for (const textEdit of textEdits) {
				edit.replace(vscode.Uri.parse(uri), toVscodeRange(textEdit.range), textEdit.newText);
			}
		}
		return edit;
	}

	async codeAction(document: vscode.TextDocument, range: vscode.Range): Promise<vscode.CodeAction[] | undefined> {
		const result = await this.request('textDocument/codeAction', {
			textDocument: { uri: document.uri.toString() },
			range: toLspRange(range),
			context: { diagnostics: [] },
		}).catch(() => undefined) as LspCodeAction[] | undefined;
		if (!result?.length) { return undefined; }
		return result.map(action => {
			const codeAction = new vscode.CodeAction(action.title, vscode.CodeActionKind.QuickFix);
			if (action.edit?.changes) {
				for (const [uri, textEdits] of Object.entries(action.edit.changes)) {
					for (const textEdit of textEdits) {
						codeAction.edit ??= new vscode.WorkspaceEdit();
						codeAction.edit.replace(vscode.Uri.parse(uri), toVscodeRange(textEdit.range), textEdit.newText);
					}
				}
			}
			return codeAction;
		});
	}
}

interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }
interface LspTextEdit { range: LspRange; newText: string }
interface LspDiagnostic { range: LspRange; message: string; severity?: number; source?: string }
interface LspLocation { uri: string; range: LspRange }
interface LspCompletionItem { label: string; kind?: number; detail?: string; documentation?: string | { value?: string }; insertText?: string }
interface LspSignatureInformation { label: string; documentation?: string | { value?: string }; parameters?: Array<{ label: string | [number, number]; documentation?: string | { value?: string } }> }
interface LspSignatureHelp { signatures: LspSignatureInformation[]; activeSignature?: number; activeParameter?: number }
interface LspDocumentSymbol { name: string; kind?: number; range?: LspRange; selectionRange?: LspRange; children?: LspDocumentSymbol[] }
interface LspCodeAction { title: string; kind?: string; edit?: { changes: Record<string, LspTextEdit[]> } }

function toLspRange(range: vscode.Range): LspRange {
	return { start: { line: range.start.line, character: range.start.character }, end: { line: range.end.line, character: range.end.character } };
}

const SYMBOL_KINDS: Record<number, vscode.SymbolKind> = {
	1: vscode.SymbolKind.File, 2: vscode.SymbolKind.Module, 3: vscode.SymbolKind.Namespace,
	4: vscode.SymbolKind.Package, 5: vscode.SymbolKind.Class, 6: vscode.SymbolKind.Method,
	7: vscode.SymbolKind.Property, 8: vscode.SymbolKind.Field, 9: vscode.SymbolKind.Constructor,
	10: vscode.SymbolKind.Enum, 12: vscode.SymbolKind.Variable, 13: vscode.SymbolKind.Constant,
	23: vscode.SymbolKind.Function, 24: vscode.SymbolKind.Function, 11: vscode.SymbolKind.Interface,
};

function toVscodeDocumentSymbol(symbol: LspDocumentSymbol): vscode.DocumentSymbol {
	const result = new vscode.DocumentSymbol(
		symbol.name,
		'',
		SYMBOL_KINDS[symbol.kind ?? 12] ?? vscode.SymbolKind.Variable,
		symbol.range ? toVscodeRange(symbol.range) : new vscode.Range(0, 0, 0, 0),
		symbol.selectionRange ? toVscodeRange(symbol.selectionRange) : new vscode.Range(0, 0, 0, 0),
	);
	if (symbol.children?.length) { result.children = symbol.children.map(toVscodeDocumentSymbol); }
	return result;
}

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
	const client = new KotlinLspClient(context, classpathProvider);
	const selector = { language: 'kotlin' };

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
		vscode.languages.registerHoverProvider(selector, {
			provideHover: (document, position) => client.hover(document, position),
		}),
		vscode.languages.registerDefinitionProvider(selector, {
			provideDefinition: (document, position) => client.definition(document, position),
		}),
		vscode.languages.registerCompletionItemProvider(selector, {
			provideCompletionItems: (document, position) => client.completion(document, position),
		}, '.', ':'),
		vscode.languages.registerSignatureHelpProvider(selector, {
			provideSignatureHelp: (document, position) => client.signatureHelp(document, position),
		}, '(', ','),
		vscode.languages.registerDocumentSymbolProvider(selector, {
			provideDocumentSymbols: (document) => client.documentSymbol(document),
		}),
		vscode.languages.registerReferenceProvider(selector, {
			provideReferences: (document, position) => client.references(document, position),
		}),
		vscode.languages.registerRenameProvider(selector, {
			provideRenameEdits: (document, position, newName) => client.rename(document, position, newName),
		}),
		vscode.languages.registerCodeActionsProvider(selector, {
			provideCodeActions: (document, range) => client.codeAction(document, range),
		}),
		vscode.commands.registerCommand('auraKotlin.restartLsp', async () => {
			client.restart();
			void vscode.window.showInformationMessage(vscode.l10n.t('Kotlin Language Server restarted.'));
		}),
		vscode.commands.registerCommand('auraKotlin.installLsp', async () => {
			const lib = await installServer(context);
			if (lib) {
				void vscode.window.showInformationMessage(vscode.l10n.t('Kotlin Language Server {0} installed.', '1.3.13'));
				client.restart();
			}
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
