/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — обобщённый LSP-клиент без внешних зависимостей.
 *  Один и тот же транспорт/провайдеры обслуживают Kotlin Language Server и Java (jdtls):
 *  различия описываются в LspClientOptions (язык, capabilities, initializationOptions,
 *  поиск и установка сервера).
 *
 *  Возможности, которых не было в первой версии клиента:
 *   • ответы на серверные запросы (workspace/configuration и прочие) — без этого jdtls
 *     не получает настройки и молчит;
 *   • code actions получают НАСТОЯЩИЕ диагностики диапазона (раньше всегда []), поэтому
 *     quick fix «Import 'Foo'» и source.organizeImports наконец приходят;
 *   • автоимпорт при принятии автодополнения: additionalTextEdits сервера применяются
 *     командой, а textEdit превращается в range/insertText;
 *   • resolve для отложенных code actions.
 *-------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'node:child_process';

/** Способ запуска найденного/установленного сервера. */
export interface ServerLaunch {
	/** java (или полный путь) либо команда сервера из PATH/настройки. */
	command: string;
	args: string[];
	/** Откуда взят сервер — для лога и статус-бара. */
	source: 'setting' | 'bundled' | 'downloaded' | 'path';
	/** Рабочий каталог процесса сервера. */
	cwd?: string;
}

export type LspState = 'stopped' | 'starting' | 'running' | 'crashed' | 'not-installed';

export interface LspClientOptions {
	/** Идентификатор языка для textDocument/didOpen. */
	languageId: string;
	/** Имя сервера в сообщениях и логах. */
	serverName: string;
	/** Название канала вывода. */
	outputName: string;
	/** Источник диагностик в панели Problems. */
	diagnosticSource: string;
	/** Относится ли документ к этому языку. */
	matches(document: vscode.TextDocument): boolean;
	/** Дополнительные триггеры автодополнения (например '.' для Java). */
	completionTriggers?: string[];
	/** initializationOptions для сервера (например classpath). */
	initializationOptions?(): Record<string, unknown>;
	/** Дополнительные client capabilities. */
	extraCapabilities?(): Record<string, unknown>;
	/**
	 * Корень воркспейса для initialize. У Java это shadow-проект Eclipse (в globalStorage),
	 * а не папка пользователя: так classpath и связанные исходники не попадают в его репозиторий.
	 */
	workspaceRootUri?(): string | undefined;
	/** Поиск сервера; undefined — сервера нет. */
	resolveLaunch(): Promise<ServerLaunch | undefined>;
	/** Предложение установить сервер, если его нет на месте. */
	offerInstall?(): Promise<ServerLaunch | undefined>;
	/** Сервер поднялся и прошёл handshake — можно заниматься фоновой работой (догрузка исходников). */
	onDidStart?(): void;
	/** Таймаут запроса (jdtls на импорте проекта отвечает долго). */
	requestTimeoutMs?: number;
}

interface PendingRequest { resolve: (value: unknown) => void; reject: (error: Error) => void; }

interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }
interface LspTextEdit { range: LspRange; newText: string }
interface LspDiagnostic { range: LspRange; message: string; severity?: number; source?: string; code?: unknown; data?: unknown }
interface LspLocation { uri: string; range: LspRange }
interface LspCompletionItem { label: string; kind?: number; detail?: string; documentation?: string | { value?: string }; insertText?: string; insertTextFormat?: number; filterText?: string; sortText?: string; textEdit?: { newText: string; range?: LspRange; insert?: LspRange; replace?: LspRange }; additionalTextEdits?: LspTextEdit[]; data?: unknown }
interface LspSignatureInformation { label: string; documentation?: string | { value?: string }; parameters?: Array<{ label: string | [number, number]; documentation?: string | { value?: string } }> }
interface LspSignatureHelp { signatures: LspSignatureInformation[]; activeSignature?: number; activeParameter?: number }
interface LspDocumentSymbol { name: string; kind?: number; range?: LspRange; selectionRange?: LspRange; children?: LspDocumentSymbol[] }
interface LspCodeAction { title: string; kind?: string; edit?: { changes?: Record<string, LspTextEdit[]> }; command?: { command: string; arguments?: unknown[] }; data?: unknown }

const DEFAULT_TIMEOUT_MS = 15_000;

/** Соответствие триггеров VS Code и LSP (у них разные числовые значения). */
function toLspCompletionContext(context?: { triggerKind?: number; triggerCharacter?: string }): { triggerKind: number; triggerCharacter?: string } {
	if (context?.triggerKind === 1 && context.triggerCharacter) {
		return { triggerKind: 2, triggerCharacter: context.triggerCharacter };
	}
	if (context?.triggerKind === 2) {
		return { triggerKind: 3 };
	}
	return { triggerKind: 1 };
}

/** Сырые подсказки сервера: нужны для completionItem/resolve перед вставкой. */
const rawCompletionItems = new WeakMap<vscode.CompletionItem, { item: LspCompletionItem; uri: string }>();

/** Счётчик клиентов: у каждого сервера своя команда выполнения серверных правок. */
let clientCounter = 1;

export class LspClient implements vscode.Disposable {

	private process?: ChildProcess;
	private stdoutBuffer = Buffer.alloc(0);
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly diagnostics: vscode.DiagnosticCollection;
	/** Сырые диагностики сервера: нужны как контекст для codeAction (иначе quick fix не приходит). */
	private readonly rawDiagnostics = new Map<string, LspDiagnostic[]>();
	private readonly output: vscode.OutputChannel;
	private started = false;
	private starting: Promise<boolean> | undefined;
	private state: LspState = 'stopped';
	private readonly stateListeners = new Set<(state: LspState) => void>();

	/** Уникальная команда выполнения серверных правок этого клиента. */
	readonly executeCommandId = `auraKotlin.lsp${clientCounter++}.executeCommand`;

	constructor(private readonly options: LspClientOptions) {
		this.diagnostics = vscode.languages.createDiagnosticCollection(options.diagnosticSource);
		this.output = vscode.window.createOutputChannel(options.outputName);
	}

	dispose(): void {
		this.stop();
		this.diagnostics.dispose();
		this.output.dispose();
	}

	/** Показать канал вывода сервера (для кнопки в сообщении об ошибке). */
	showOutput(): void { this.output.show(true); }

	/** Дозапись в канал вывода (сводка по shadow-проекту Java и подобное). */
	appendOutput(text: string): void { this.output.appendLine(text); }

	get available(): boolean { return this.started && !!this.process && !this.process.killed; }

	get serverState(): LspState { return this.state; }

	get serverName(): string { return this.options.serverName; }

	onDidChangeState(listener: (state: LspState) => void): vscode.Disposable {
		this.stateListeners.add(listener);
		return { dispose: () => this.stateListeners.delete(listener) };
	}

	private setState(state: LspState): void {
		if (this.state === state) { return; }
		this.state = state;
		for (const listener of this.stateListeners) { listener(state); }
	}

	/** Запускает сервер и делает handshake. Возвращает true, если сервер готов. */
	async ensureStarted(): Promise<boolean> {
		if (this.available) { return true; }
		this.starting ??= this.start();
		return this.starting;
	}

	private async start(): Promise<boolean> {
		let launch = await this.options.resolveLaunch();
		if (!launch && this.options.offerInstall) { launch = await this.options.offerInstall(); }
		if (!launch) {
			this.setState('not-installed');
			this.starting = undefined;
			return false;
		}
		this.setState('starting');
		try {
			this.process = spawn(launch.command, launch.args, { cwd: launch.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
		} catch (error) {
			this.output.appendLine(`[lsp] failed to spawn "${launch.command}": ${errorMessage(error)}`);
			this.setState('not-installed');
			this.starting = undefined;
			return false;
		}
		const proc = this.process;
		this.started = true;
		this.output.appendLine(`[lsp] ${this.options.serverName}: ${launch.source} (${launch.command})`);
		proc.on('error', (error) => {
			this.output.appendLine(`[lsp] ${errorMessage(error)}`);
			this.started = false;
			this.setState('not-installed');
		});
		proc.stderr?.on('data', (chunk: Buffer) => this.output.append(`[server] ${chunk.toString()}`));
		proc.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
		proc.on('exit', (code) => {
			this.output.appendLine(`[lsp] ${this.options.serverName} exited with code ${code}`);
			this.started = false;
			this.process = undefined;
			this.starting = undefined;
			this.setState(this.state === 'not-installed' ? 'not-installed' : 'crashed');
		});

		const customRoot = toUriString(this.options.workspaceRootUri?.());
		const rootUri = customRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.toString();
		const result = await this.request('initialize', {
			processId: process.pid,
			rootUri,
			workspaceFolders: customRoot
				? [{ uri: customRoot, name: 'aura-java' }]
				: vscode.workspace.workspaceFolders?.map(folder => ({ uri: folder.uri.toString(), name: folder.name })),
			initializationOptions: this.options.initializationOptions?.() ?? {},
			capabilities: {
				workspace: { applyEdit: true, configuration: true, workspaceFolders: true, didChangeConfiguration: { dynamicRegistration: false } },
				textDocument: {
					synchronization: { openClose: true, didSave: true, change: 2 },
					hover: { contentFormat: ['markdown', 'plaintext'] },
					completion: {
						contextSupport: true,
						completionItem: {
							snippetSupport: true,
							documentationFormat: ['markdown', 'plaintext'],
							resolveSupport: { properties: ['additionalTextEdits', 'documentation', 'detail'] },
						},
					},
					definition: {},
					signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true } } },
					documentSymbol: { symbolKind: { valueSet: [] } },
					references: {},
					rename: { prepareProvider: false },
					codeAction: {
						codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'source.organizeImports', 'source'] } },
						resolveSupport: { properties: ['edit'] },
					},
					publishDiagnostics: { relatedInformation: true, versionSupport: true },
					...this.options.extraCapabilities?.(),
				},
			},
		}).catch((error) => {
			this.output.appendLine(`[lsp] initialize failed: ${errorMessage(error)}`);
			return null;
		});
		if (!result) { this.setState('crashed'); this.starting = undefined; return false; }
		this.notify('initialized', {});
		this.output.appendLine('[lsp] initialized');
		this.setState('running');
		for (const document of vscode.workspace.textDocuments) {
			if (this.options.matches(document)) { this.didOpen(document); }
		}
		try { this.options.onDidStart?.(); } catch (error) { this.output.appendLine(`[lsp] onDidStart: ${errorMessage(error)}`); }
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
		// Ответ на наш запрос.
		if (message.id !== undefined && message.method === undefined) {
			const pending = this.pending.get(Number(message.id));
			if (!pending) { return; }
			this.pending.delete(Number(message.id));
			if (message.error) { pending.reject(new Error(message.error.message)); } else { pending.resolve(message.result); }
			return;
		}
		// Запрос со стороны сервера: без ответа сервер (jdtls) не продолжит работу.
		if (message.id !== undefined && message.method) {
			let result: unknown = null;
			if (message.method === 'workspace/configuration') {
				const items = (message.params as { items?: unknown[] } | undefined)?.items ?? [];
				result = items.map(() => this.options.initializationOptions?.() ?? {});
			}
			this.send({ jsonrpc: '2.0', id: message.id, result });
			return;
		}
		if (message.method === 'textDocument/publishDiagnostics' && message.params) {
			const params = message.params as { uri: string; diagnostics: LspDiagnostic[] };
			this.rawDiagnostics.set(params.uri, params.diagnostics);
			this.diagnostics.set(vscode.Uri.parse(params.uri), params.diagnostics.map(diagnostic => toVscodeDiagnostic(diagnostic, this.options.diagnosticSource)));
		}
	}

	private send(payload: unknown): void {
		if (!this.process?.stdin) { throw new Error(`${this.options.serverName} is not running`); }
		const body = Buffer.from(JSON.stringify(payload), 'utf8');
		this.process.stdin.write(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
		this.process.stdin.write(body);
	}

	private request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.send({ jsonrpc: '2.0', id, method, params });
			setTimeout(() => {
				if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method}: timeout`)); }
			}, timeoutMs);
		});
	}

	private notify(method: string, params: unknown): void {
		this.send({ jsonrpc: '2.0', method, params });
	}

	// ---------- Документы ----------

	didOpen(document: vscode.TextDocument): void {
		if (!this.available) { return; }
		this.notify('textDocument/didOpen', {
			textDocument: { uri: document.uri.toString(), languageId: this.options.languageId, version: document.version, text: document.getText() },
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
		this.rawDiagnostics.delete(document.uri.toString());
		this.notify('textDocument/didClose', { textDocument: { uri: document.uri.toString() } });
	}

	// ---------- Запросы ----------

	private async ask(method: string, document: vscode.TextDocument, position: vscode.Position, extra?: Record<string, unknown>): Promise<unknown | undefined> {
		if (!this.available) { return undefined; }
		// Виртуальные документы (например, исходники библиотек в jdt://) — не файлы проекта:
		// сервер такие URI не знает, поэтому лучше честно ничего не отвечать, чем шуметь ошибками.
		if (!this.options.matches(document)) { return undefined; }
		return this.request(method, {
			textDocument: { uri: document.uri.toString() },
			position: toLspPosition(position),
			...extra,
		}).catch(() => undefined);
	}

	async hover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
		const result = await this.ask('textDocument/hover', document, position) as { contents?: HoverContents } | undefined;
		const contents = toHoverMarkdown(result?.contents);
		return contents ? new vscode.Hover(contents) : undefined;
	}

	async definition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Definition | undefined> {
		const result = await this.ask('textDocument/definition', document, position) as LspLocation | LspLocation[] | undefined;
		if (!result) { return undefined; }
		const locations = Array.isArray(result) ? result : [result];
		return locations.map(location => new vscode.Location(vscode.Uri.parse(location.uri), toVscodeRange(location.range)));
	}

	async completion(document: vscode.TextDocument, position: vscode.Position, context?: { triggerKind?: number; triggerCharacter?: string }): Promise<vscode.CompletionList | undefined> {
		// Контекст VS Code (набрали точку или вызвали вручную) обязательно уезжает серверу:
		// jdtls меняет по нему набор подсказок, а без него после «.» приходит список типов.
		const result = await this.ask('textDocument/completion', document, position, { context: toLspCompletionContext(context) }) as { items?: LspCompletionItem[] } | LspCompletionItem[] | undefined;
		if (!result) { return undefined; }
		const items = Array.isArray(result) ? result : result.items ?? [];
		const uri = document.uri.toString();
		return new vscode.CompletionList(items.map(item => toVscodeCompletionItem(item, uri)), true);
	}

	/**
	 * Доапрос подсказки перед вставкой. jdtls отдаёт `textEdit` и `additionalTextEdits`
	 * (импорт класса) только здесь — без resolve подсказка вставляла бы своё длинное
	 * описание вместо кода, а автоимпорт не работал бы вовсе.
	 */
	async resolveCompletionItem(item: vscode.CompletionItem): Promise<vscode.CompletionItem> {
		const stored = rawCompletionItems.get(item);
		if (!this.available || !stored || stored.item.data === undefined) { return item; }
		const resolved = await this.request('completionItem/resolve', stored.item).catch(() => undefined) as LspCompletionItem | undefined;
		if (!resolved) { return item; }
		// Поля, которых нет в ответе resolve (insertTextFormat, filterText, sortText), берём из
		// исходной подсказки — иначе формат сниппета теряется и в код попадут его разделителы.
		applyCompletionFields(item, { ...stored.item, ...resolved }, stored.uri);
		return item;
	}

	async signatureHelp(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.SignatureHelp | undefined> {
		const result = await this.ask('textDocument/signatureHelp', document, position) as LspSignatureHelp | undefined;
		if (!result?.signatures?.length) { return undefined; }
		const help = new vscode.SignatureHelp();
		help.signatures = result.signatures.map(signature => {
			const item = new vscode.SignatureInformation(signature.label, signature.documentation ? new vscode.MarkdownString(documentationText(signature.documentation)) : undefined);
			item.parameters = (signature.parameters ?? []).map(parameter => new vscode.ParameterInformation(parameter.label, parameter.documentation ? new vscode.MarkdownString(documentationText(parameter.documentation)) : undefined));
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
		return toWorkspaceEdit({ changes: result.changes });
	}

	/**
	 * Code actions с настоящими диагностиками диапазона: jdtls отдаёт quick fix
	 * «Import 'Foo'» и «Add all missing imports» только когда видит проблему в контексте.
	 */
	async codeAction(document: vscode.TextDocument, range: vscode.Range, only?: string[]): Promise<vscode.CodeAction[] | undefined> {
		if (!this.available) { return undefined; }
		const uri = document.uri.toString();
		const diagnostics = (this.rawDiagnostics.get(uri) ?? []).filter(diagnostic => rangesIntersect(diagnostic.range, toLspRange(range)));
		const result = await this.request('textDocument/codeAction', {
			textDocument: { uri },
			range: toLspRange(range),
			context: { diagnostics, only },
		}).catch(() => undefined) as LspCodeAction[] | undefined;
		if (!result?.length) { return undefined; }
		return result.map(action => toVscodeCodeAction(action, this.executeCommandId));
	}

	/** Отложенные actions: сервер присылает правку только после codeAction/resolve. */
	async resolveCodeAction(action: vscode.CodeAction): Promise<vscode.CodeAction> {
		const data = (action as unknown as { data?: unknown }).data;
		if (!this.available || data === undefined) { return action; }
		const resolved = await this.request('codeAction/resolve', data).catch(() => undefined) as LspCodeAction | undefined;
		if (!resolved) { return action; }
		const mapped = toVscodeCodeAction(resolved, this.executeCommandId);
		action.edit = mapped.edit ?? action.edit;
		action.command = mapped.command ?? action.command;
		return action;
	}

	/** Выполнение серверной команды (например organize imports возвращает WorkspaceEdit). */
	async executeCommand(command: string, args: unknown[]): Promise<void> {
		if (!this.available) { return; }
		const result = await this.request('workspace/executeCommand', { command, arguments: args }).catch(error => {
			this.output.appendLine(`[lsp] executeCommand ${command}: ${errorMessage(error)}`);
			return undefined;
		});
		const changes = (result as { changes?: Record<string, LspTextEdit[]> } | undefined)?.changes;
		if (changes) { await vscode.workspace.applyEdit(toWorkspaceEdit({ changes })); }
	}

	/** Передать серверу изменённые настройки (jdtls читает их из workspace/configuration). */
	didChangeConfiguration(): void {
		if (!this.available) { return; }
		this.notify('workspace/didChangeConfiguration', { settings: this.options.initializationOptions?.() ?? {} });
	}
}

// ---------- Команды, на которые ссылаются элементы UI ----------

/**
 * `auraKotlin.applyLspTextEdits` применяется из автодополнения: так работает автоимпорт
 * при принятии подсказки (additionalTextEdits сервера применяются после вставки).
 */
export function registerLspCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(vscode.commands.registerCommand('auraKotlin.applyLspTextEdits', async (uri: string, edits: LspTextEdit[]) => {
		if (!uri || !Array.isArray(edits) || !edits.length) { return; }
		const edit = new vscode.WorkspaceEdit();
		const parsed = vscode.Uri.parse(uri);
		for (const textEdit of edits) { edit.replace(parsed, toVscodeRange(textEdit.range), textEdit.newText); }
		await vscode.workspace.applyEdit(edit);
	}));
}

/**
 * Регистрирует выполнение серверных команд конкретного клиента. У каждого клиента своя
 * команда: у Kotlin и Java серверы разные, и общая команда приводила к вызову не того сервера.
 */
export function registerLspCommandExecutor(context: vscode.ExtensionContext, client: LspClient): void {
	context.subscriptions.push(vscode.commands.registerCommand(client.executeCommandId, (command: string, args: unknown[] = []) => client.executeCommand(command, args)));
}

// ---------- Провайдеры редактора ----------

export interface LspProviderOptions {
	languageId: string;
	completionTriggers?: string[];
}

/** Регистрирует все провайдеры языка, которые умеет клиент. */
export function registerLspProviders(context: vscode.ExtensionContext, client: LspClient, options: LspProviderOptions): void {
	const selector: vscode.DocumentSelector = { language: options.languageId };
	context.subscriptions.push(
		vscode.languages.registerHoverProvider(selector, {
			provideHover: (document, position) => client.hover(document, position),
		}),
		vscode.languages.registerDefinitionProvider(selector, {
			provideDefinition: (document, position) => client.definition(document, position),
		}),
		vscode.languages.registerCompletionItemProvider(selector, {
			provideCompletionItems: (document, position, _token, completionContext) => client.completion(document, position, completionContext),
			resolveCompletionItem: (item) => client.resolveCompletionItem(item),
		}, ...(options.completionTriggers ?? ['.'])),
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
			provideCodeActions: (document, range, actionContext) => client.codeAction(document, range, actionContext.only ? [actionContext.only.value] : undefined),
			resolveCodeAction: (action) => client.resolveCodeAction(action),
		}, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.SourceOrganizeImports] }),
	);
}

// ---------- Преобразования ----------

function toLspRange(range: vscode.Range): LspRange {
	return { start: { line: range.start.line, character: range.start.character }, end: { line: range.end.line, character: range.end.character } };
}

function toLspPosition(position: vscode.Position): LspPosition {
	return { line: position.line, character: position.character };
}

function toVscodeRange(range: LspRange): vscode.Range {
	return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

function rangesIntersect(a: LspRange, b: LspRange): boolean {
	const startA = a.start.line * 100_000 + a.start.character;
	const endA = a.end.line * 100_000 + a.end.character;
	const startB = b.start.line * 100_000 + b.start.character;
	const endB = b.end.line * 100_000 + b.end.character;
	return startA <= endB && startB <= endA;
}

/**
 * Содержимое hover у LSP бывает трёх видов: строка, MarkupContent и MarkedString[].
 * Последний — самый частый (им пользуется jdtls: сигнатура блоком кода + javadoc + источник),
 * и раньше он не разбирался вовсе: подсказка показывалась пустой.
 */
interface HoverMarkup { value?: string; kind?: string; language?: string }
type HoverContents = string | HoverMarkup | Array<string | HoverMarkup>;

function toHoverMarkdown(contents: HoverContents | undefined): vscode.MarkdownString | undefined {
	if (!contents) { return undefined; }
	if (typeof contents === 'string') { return contents ? new vscode.MarkdownString(contents) : undefined; }
	const parts = Array.isArray(contents) ? contents : [contents];
	const markdown = new vscode.MarkdownString();
	let empty = true;
	for (const part of parts) {
		const value = typeof part === 'string' ? part : part.value;
		if (!value) { continue; }
		if (!empty) { markdown.appendMarkdown('\n\n'); }
		empty = false;
		if (typeof part === 'string' || part.kind === 'plaintext') { markdown.appendText(value); }
		else if (part.language) { markdown.appendCodeblock(value, part.language); }
		else { markdown.appendMarkdown(value); }
	}
	return empty ? undefined : markdown;
}

function documentationText(documentation: string | { value?: string }): string {
	return typeof documentation === 'string' ? documentation : documentation.value ?? '';
}

function toWorkspaceEdit(payload: { changes?: Record<string, LspTextEdit[]> }): vscode.WorkspaceEdit {
	const edit = new vscode.WorkspaceEdit();
	for (const [uri, textEdits] of Object.entries(payload.changes ?? {})) {
		for (const textEdit of textEdits) {
			edit.replace(vscode.Uri.parse(uri), toVscodeRange(textEdit.range), textEdit.newText);
		}
	}
	return edit;
}

const SYMBOL_KINDS: Record<number, vscode.SymbolKind> = {
	1: vscode.SymbolKind.File, 2: vscode.SymbolKind.Module, 3: vscode.SymbolKind.Namespace,
	4: vscode.SymbolKind.Package, 5: vscode.SymbolKind.Class, 6: vscode.SymbolKind.Method,
	7: vscode.SymbolKind.Property, 8: vscode.SymbolKind.Field, 9: vscode.SymbolKind.Constructor,
	10: vscode.SymbolKind.Enum, 11: vscode.SymbolKind.Interface, 12: vscode.SymbolKind.Variable,
	13: vscode.SymbolKind.Constant, 14: vscode.SymbolKind.String, 23: vscode.SymbolKind.Function,
	24: vscode.SymbolKind.Function, 26: vscode.SymbolKind.TypeParameter,
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

function toVscodeDiagnostic(diagnostic: LspDiagnostic, source: string): vscode.Diagnostic {
	const severity = diagnostic.severity === 1 ? vscode.DiagnosticSeverity.Error
		: diagnostic.severity === 2 ? vscode.DiagnosticSeverity.Warning
			: diagnostic.severity === 3 ? vscode.DiagnosticSeverity.Information
				: vscode.DiagnosticSeverity.Hint;
	const result = new vscode.Diagnostic(toVscodeRange(diagnostic.range), diagnostic.message, severity);
	result.source = diagnostic.source ?? source;
	if (typeof diagnostic.code === 'string' || typeof diagnostic.code === 'number') { result.code = diagnostic.code; }
	return result;
}

const COMPLETION_KINDS: Record<number, vscode.CompletionItemKind> = {
	1: vscode.CompletionItemKind.Text, 2: vscode.CompletionItemKind.Method, 3: vscode.CompletionItemKind.Function,
	4: vscode.CompletionItemKind.Constructor, 5: vscode.CompletionItemKind.Field, 6: vscode.CompletionItemKind.Variable,
	7: vscode.CompletionItemKind.Class, 8: vscode.CompletionItemKind.Interface, 9: vscode.CompletionItemKind.Module,
	10: vscode.CompletionItemKind.Property, 11: vscode.CompletionItemKind.Unit, 12: vscode.CompletionItemKind.Value,
	13: vscode.CompletionItemKind.Enum, 14: vscode.CompletionItemKind.Keyword, 15: vscode.CompletionItemKind.Snippet,
	16: vscode.CompletionItemKind.Color, 17: vscode.CompletionItemKind.File, 18: vscode.CompletionItemKind.Reference,
	19: vscode.CompletionItemKind.Folder, 20: vscode.CompletionItemKind.EnumMember, 21: vscode.CompletionItemKind.Constant,
	22: vscode.CompletionItemKind.Struct, 23: vscode.CompletionItemKind.Event, 24: vscode.CompletionItemKind.Operator,
	25: vscode.CompletionItemKind.TypeParameter,
};

/**
 * Автоимпорт при принятии подсказки: если сервер вернул additionalTextEdits (импорт класса),
 * вешаем команду, которая применит эти правки ПОСЛЕ вставки — так работает Java-автоимпорт.
 */
function toVscodeCompletionItem(item: LspCompletionItem, uri: string): vscode.CompletionItem {
	const result = new vscode.CompletionItem(item.label, COMPLETION_KINDS[item.kind ?? 1] ?? vscode.CompletionItemKind.Text);
	applyCompletionFields(result, item, uri);
	rawCompletionItems.set(result, { item, uri });
	return result;
}

/** Переносит поля подсказки сервера в элемент VS Code (используется и при resolve). */
function applyCompletionFields(result: vscode.CompletionItem, item: LspCompletionItem, uri: string): void {
	if (item.detail) { result.detail = item.detail; }
	const documentation = item.documentation ? documentationText(item.documentation) : '';
	if (documentation) { result.documentation = new vscode.MarkdownString(documentation); }
	if (item.filterText) { result.filterText = item.filterText; }
	if (item.sortText) { result.sortText = item.sortText; }
	const textEdit = item.textEdit;
	const range = textEdit?.range ?? textEdit?.replace ?? textEdit?.insert;
	if (range) { result.range = toVscodeRange(range); }
	// Текст вставки у jdtls приходит только в textEdit (в resolve), а label содержит описание
	// («ContextCompat - androidx.core.content») — вставлять его нельзя. Формат 2 — сниппет.
	const insertText = textEdit?.newText ?? item.insertText;
	if (insertText) {
		result.insertText = item.insertTextFormat === 2 ? new vscode.SnippetString(insertText) : insertText;
	}
	if (item.additionalTextEdits?.length) {
		result.command = {
			command: 'auraKotlin.applyLspTextEdits',
			title: 'Apply import',
			arguments: [uri, item.additionalTextEdits],
		};
	}
}

function toVscodeCodeAction(action: LspCodeAction, executeCommandId: string): vscode.CodeAction {
	const kind = action.kind === 'source.organizeImports' ? vscode.CodeActionKind.SourceOrganizeImports
		: action.kind?.startsWith('source') ? vscode.CodeActionKind.Source
			: vscode.CodeActionKind.QuickFix;
	const result = new vscode.CodeAction(action.title, kind);
	if (action.edit?.changes) { result.edit = toWorkspaceEdit(action.edit); }
	if (action.command) {
		result.command = { command: executeCommandId, title: action.title, arguments: [action.command.command, action.command.arguments ?? []] };
	}
	// data сохраняем: по нему отложенные actions дотягиваются через codeAction/resolve.
	if (action.data !== undefined) { (result as unknown as { data?: unknown }).data = action.data; }
	return result;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/**
 * Корень воркспейса уезжает в initialize как URI. Каталог shadow-проекта задаётся путём
 * файловой системы, а сервер ждёт `file:///…`: на `C:\…` jdtls падает с
 * «Illegal character in opaque part» и просто не стартует.
 */
function toUriString(value: string | undefined): string | undefined {
	if (!value) { return undefined; }
	// Путь Windows («C:\…») формально выглядит как URI со схемой «C», поэтому проверяем его первым.
	if (/^[a-zA-Z]:[\\/]/.test(value)) { return vscode.Uri.file(value).toString(); }
	return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : vscode.Uri.file(value).toString();
}
