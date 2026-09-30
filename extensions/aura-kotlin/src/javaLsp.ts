/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — Java Language Server (Eclipse JDT LS) на обобщённом клиенте.
 *  Даёт то, чего не было для .java в Android-проектах: автодополнение, диагностику,
 *  автоимпорт (quick fix «Import …», «Add all missing imports», organize imports,
 *  а также импорт при принятии подсказки через additionalTextEdits).
 *
 *  Classpath серверу не отдаётся напрямую (такого параметра у jdtls нет): вместо этого
 *  собирается shadow-проект Eclipse с linked-исходниками и полным classpath Gradle
 *  (android.jar + развёрнутые classes.jar из .aar) — см. javaProject.ts.
 *-------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { tr } from './l10n';
import { LspClient, LspClientOptions, LspState, registerLspCommandExecutor, registerLspProviders } from './lspClient';
import { ClasspathSync, sdkRoot } from './classpath';
import { prepareJavaProject, JavaProjectResult } from './javaProject';
import { planSources, downloadSources, sourcesCacheDir, PLATFORM_SOURCES_SIZE, SourcesPlan } from './javaSources';
import { registerJdtContentProvider } from './javaUris';
import {
	dataDirFor, installJavaServer, offerJavaServerInstall, resolveJavaServer, serverDirForDiagnostics,
	javaRequirementFromLogs, pickServerJava, JAVA_SERVER_SIZE, MIN_JAVA_MAJOR,
} from './javaInstall';

export const JAVA_LSP_COMMAND = 'auraKotlin.java.restartLsp';
export const JAVA_SOURCES_COMMAND = 'auraKotlin.java.downloadSources';
/** Пользователь отменил фоновую загрузку исходников — больше не предлагаем сами. */
const SOURCES_DECLINED_KEY = 'auraKotlin.java.sourcesDeclined';

export function isJavaDocument(document: vscode.TextDocument): boolean {
	// Виртуальные документы (jdt:// в исходниках библиотек) серверу отправлять нельзя:
	// это не файлы проекта, jdtls на них ругается.
	if (document.uri.scheme !== 'file') { return false; }
	return document.languageId === 'java' || document.uri.fsPath.endsWith('.java');
}

/**
 * Настройки jdtls. Импорт Gradle выключен намеренно: classpath мы уже получили от Gradle
 * (включая android.jar) и передали через shadow-проект, а Buildship в AGP-проекте тянет
 * метаданные Eclipse прямо в репозиторий пользователя.
 */
export function jdtlsSettings(): Record<string, unknown> {
	return {
		settings: {
			java: {
				import: { gradle: { enabled: false }, maven: { enabled: false } },
				configuration: { updateBuildConfiguration: 'automatic' },
				completion: { guessMethodArguments: true, maxResults: 200 },
				signatureHelp: { enabled: true },
				referencesCodeLens: { enabled: false },
				implementationsCodeLens: { enabled: false },
				format: { enabled: true },
				saveActions: { organizeImports: true },
				errors: { incompleteClasspath: { severity: 'warning' } },
			},
		},
		extendedClientCapabilities: { progressReportProvider: false, classFileContentsSupport: true },
	};
}

export class JavaLspClient implements vscode.Disposable {

	readonly lsp: LspClient;
	private prepared?: JavaProjectResult;
	private preparing?: Promise<JavaProjectResult>;
	/** classpath-запись → исходники (архив или каталог); переживает пересборки shadow-проекта. */
	private readonly sources = new Map<string, string>();
	private planned?: SourcesPlan;
	private sourcesTask?: Promise<void>;

	constructor(private readonly context: vscode.ExtensionContext, private readonly classpathSync: ClasspathSync) {
		this.lsp = new LspClient(this.options());
	}

	private workspaceRoot(): string | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	private options(): LspClientOptions {
		const dataDir = dataDirFor(this.context, this.workspaceRoot());
		return {
			languageId: 'java',
			serverName: 'Java Language Server',
			outputName: 'Java Language Server',
			diagnosticSource: 'java',
			matches: isJavaDocument,
			completionTriggers: ['.', '@'],
			// Колбэк клиента: серверные запросы конфигурации получают те же настройки.
			initializationOptions: jdtlsSettings,
			requestTimeoutMs: 120_000,
			workspaceRootUri: () => this.prepared?.projectDir,
			resolveLaunch: async () => {
				await this.prepare();
				return resolveJavaServer(this.context, dataDir);
			},
			offerInstall: async () => offerJavaServerInstall(this.context, dataDir),
			onDidStart: () => { void this.ensureSources('auto'); },
		};
	}

	/** Готовит shadow-проект: без него jdtls не увидит ни исходников, ни classpath. */
	async prepare(): Promise<JavaProjectResult> {
		this.preparing ??= Promise.resolve().then(() => {
			const root = this.workspaceRoot();
			const classpath = this.classpathSync.classpath;
			// Исходники: то, что уже лежит на диске (пакеты SDK и кэш Gradle), подключаем сразу;
			// чего нет — догрузит ensureSources(), не задерживая старт сервера.
			const plan = this.plan(classpath.jars);
			for (const [file, source] of plan.attached) { this.sources.set(file, source); }
			const result = prepareJavaProject(this.context, {
				jars: classpath.jars,
				moduleDirs: classpath.modules.map(module => module.dir),
				workspaceRoot: root ?? process.cwd(),
				sources: this.sources,
			});
			this.outputInfo(`[java] shadow-проект: ${result.sourceDirs.length} каталогов исходников, ` +
				`${result.jars.length} jar (из них развёрнуто .aar: ${result.exploded})${result.skipped.length ? `, не удалось: ${result.skipped.length}` : ''}`);
			this.outputInfo(`[java] исходники подключены к ${result.sourced} из ${result.jars.length} jar` +
				`${plan.downloadable.length ? `, можно скачать ещё ${plan.downloadable.length}` : ''}` +
				`${plan.platform.length ? `, исходники Android ${plan.platform.map(item => item.api).join(', ')} не установлены (${PLATFORM_SOURCES_SIZE})` : ''}`);
			this.prepared = result;
			return result;
		}).finally(() => { this.preparing = undefined; });
		return this.preparing;
	}

	private plan(jars: string[]): SourcesPlan {
		this.planned = planSources(jars, { sdkRoot: sdkRoot(), storageRoot: this.context.globalStorageUri.fsPath });
		return this.planned;
	}

	/**
	 * Догружает исходники, которых нет на диске, и подключает их перезапуском сервера.
	 * Первый проход — фоновый (настройка auraKotlin.java.downloadSources), команда
	 * auraKotlin.java.downloadSources гоняет то же самое с видимым прогрессом и по запросу.
	 */
	async ensureSources(mode: 'auto' | 'manual' = 'auto'): Promise<void> {
		if (mode === 'auto' && !vscode.workspace.getConfiguration('auraKotlin').get<boolean>('java.downloadSources', true)) { return; }
		if (mode === 'auto' && this.context.globalState.get<boolean>(SOURCES_DECLINED_KEY)) { return; }
		if (mode === 'manual') { await this.context.globalState.update(SOURCES_DECLINED_KEY, undefined); }
		if (this.sourcesTask) { return this.sourcesTask; }
		this.sourcesTask = this.downloadMissingSources()
			.catch(error => { this.outputInfo(`[java] исходники: ${error instanceof Error ? error.message : String(error)}`); })
			.finally(() => { this.sourcesTask = undefined; });
		return this.sourcesTask;
	}

	private async downloadMissingSources(): Promise<void> {
		const plan = this.plan(this.classpathSync.classpath.jars);
		const forLibraries = plan.downloadable.length;
		if (!forLibraries && !plan.platform.length) { return; }
		const platformApi = plan.platform[0]?.api;
		const title = platformApi !== undefined
			? tr('Attaching sources: {0} libraries and Android {1} ({2})…', String(forLibraries), String(platformApi), PLATFORM_SOURCES_SIZE)
			: tr('Attaching library sources ({0})…', String(forLibraries));

		let cancelled = false;
		const result = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title, cancellable: true },
			(progress, token) => {
				token.onCancellationRequested(() => { cancelled = true; });
				return downloadSources(plan, sourcesCacheDir(this.context.globalStorageUri.fsPath), {
					token,
					platform: true,
					onProgress: (_done, total, subject) => progress.report({ message: subject, increment: total ? Math.max(1, 100 / total) : 0 }),
				});
			},
		);
		const everythingFailed = result.failed.length > 0 && result.failed.length === plan.platform.length + plan.downloadable.length;
		if (cancelled || everythingFailed) {
			// Отменили (или не скачалось вообще ничего) — сами к этому больше не возвращаемся:
			// команда скачивания остаётся в палитре и сбрасывает отказ.
			await this.context.globalState.update(SOURCES_DECLINED_KEY, true);
			if (!cancelled) {
				void vscode.window.showWarningMessage(tr('Could not download sources for {0} artifacts. See the “Java Language Server” output.', String(result.failed.length)));
			}
		}

		let added = 0;
		for (const [file, source] of [...result.attached, ...result.platformAttached]) {
			if (this.sources.get(file) !== source) { this.sources.set(file, source); added++; }
		}
		const summary = [`подключено ${added} новых`];
		if (result.downloaded) { summary.push(`скачано ${result.downloaded} sources-jar`); }
		if (result.platformInstalled.length) { summary.push(`исходники платформы: ${result.platformInstalled.join(', ')}`); }
		if (result.failed.length) { summary.push(`не найдены у ${result.failed.length}: ${result.failed.slice(0, 6).join(', ')}`); }
		this.outputInfo(`[java] исходники: ${summary.join(', ')}`);

		if (!added) { return; }
		// Появились новые sourcepath — пересобираем .classpath и перезапускаем сервер,
		// иначе Eclipse JDT продолжит показывать классы без исходников.
		this.prepared = undefined;
		this.lsp.restart();
		void vscode.window.showInformationMessage(tr('Sources attached: {0}. Navigation and hover for android.jar and androidx now work.', String(added)));
	}

	/** Сколько jar-ов получило исходники (для статус-бара и онбординга). */
	get sourcedCount(): number { return this.prepared?.sourced ?? 0; }

	get sourcesPath(): string { return sourcesCacheDir(this.context.globalStorageUri.fsPath); }

	/** Путь для тестов и диагностики: shadow-проект после prepare(). */
	get projectDir(): string | undefined { return this.prepared?.projectDir; }

	/** Каталог исходников нужного API, если пакет уже стоит (нужно онбордингу). */
	get pendingPlatformSources(): number[] { return this.planned?.platform.map(item => item.api) ?? []; }

	get available(): boolean { return this.lsp.available; }

	get serverState(): LspState { return this.lsp.serverState; }

	onDidChangeState(listener: (state: LspState) => void): vscode.Disposable { return this.lsp.onDidChangeState(listener); }

	ensureStarted(): Promise<boolean> { return this.lsp.ensureStarted(); }

	/** Перезапуск с новым classpath (после sync Gradle). */
	async restart(): Promise<void> {
		this.prepared = undefined;
		this.lsp.restart();
	}

	dispose(): void { this.lsp.dispose(); }

	/** Автоимпорт для всего файла: то, что в Android Studio делает Optimize Imports. */
	async organizeImports(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor || !isJavaDocument(editor.document)) {
			void vscode.window.showWarningMessage(tr('Open a Java file first.'));
			return;
		}
		if (!await this.ensureStarted()) { return; }
		const document = editor.document;
		const range = new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0);
		const actions = await this.lsp.codeAction(document, range, ['source.organizeImports']);
		const action = actions?.find(candidate => !!candidate.edit || !!candidate.command);
		if (!action) { return; }
		if (action.edit) {
			await vscode.workspace.applyEdit(action.edit);
			return;
		}
		if (action.command) {
			await vscode.commands.executeCommand(action.command.command, ...(action.command.arguments ?? []));
		}
	}

	/** Внятное объяснение, когда сервер не стартует из-за версии Java. */
	async explainCrash(): Promise<void> {
		const requirement = javaRequirementFromLogs(serverDirForDiagnostics(this.context), this.context.globalStorageUri.fsPath);
		const java = await pickServerJava();
		const openLog = tr('Open log');
		const message = requirement
			? tr('Java Language Server needs Java {0} (found {1}). Install a newer JDK or point auraKotlin.javaLspPath to an older jdtls.', String(requirement), String(java?.version ?? 0))
			: tr('Java Language Server stopped. See the “Java Language Server” output.');
		const pick = await vscode.window.showErrorMessage(message, openLog);
		if (pick === openLog) { this.lsp.showOutput(); }
	}

	private outputInfo(text: string): void { this.lsp.appendOutput(text); }
}

export function registerJavaLsp(context: vscode.ExtensionContext, classpathSync: ClasspathSync): JavaLspClient {
	const client = new JavaLspClient(context, classpathSync);

	context.subscriptions.push(
		client,
		vscode.workspace.onDidOpenTextDocument(async (document) => {
			if (!isJavaDocument(document)) { return; }
			if (await client.ensureStarted()) { client.lsp.didOpen(document); }
		}),
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (isJavaDocument(event.document)) { client.lsp.didChange(event.document, event); }
		}),
		vscode.workspace.onDidSaveTextDocument((document) => {
			if (isJavaDocument(document)) { client.lsp.didSave(document); }
		}),
		vscode.workspace.onDidCloseTextDocument((document) => {
			if (isJavaDocument(document)) { client.lsp.didClose(document); }
		}),
		vscode.commands.registerCommand(JAVA_LSP_COMMAND, async () => {
			await client.restart();
			void vscode.window.showInformationMessage(tr('Java Language Server restarted.'));
		}),
		vscode.commands.registerCommand('auraKotlin.java.organizeImports', () => client.organizeImports()),
		vscode.commands.registerCommand('auraKotlin.java.installLsp', async () => {
			const dir = await installJavaServer(context);
			if (dir) {
				void vscode.window.showInformationMessage(tr('Java Language Server installed.'));
				await client.restart();
			}
		}),
		vscode.commands.registerCommand(JAVA_SOURCES_COMMAND, () => client.ensureSources('manual')),
	);

	registerLspProviders(context, client.lsp, { languageId: 'java', completionTriggers: ['.', '@'] });
	registerLspCommandExecutor(context, client.lsp);

	// jdtls отдаёт переходы к библиотечным классам как jdt://… — без этого провайдера VS Code
	// не смог бы их открыть, и кнопка «перейти к определению» по android.jar/AndroidX молчала бы.
	registerJdtContentProvider(context, () => client.projectDir);

	// Падение сервера (чаще всего — слишком старая Java) объясняем один раз внятно.
	context.subscriptions.push(client.lsp.onDidChangeState(state => {
		if (state === 'crashed') { void client.explainCrash(); }
	}));

	// Новый classpath (изменился build-файл или прошёл sync) — пересобираем shadow-проект
	// и перезапускаем сервер с дебаунсом, чтобы не дёргать его на каждое сохранение.
	let timer: NodeJS.Timeout | undefined;
	context.subscriptions.push(classpathSync.onDidChange(() => {
		if (!client.available) { return; }
		if (timer) { clearTimeout(timer); }
		timer = setTimeout(() => void client.restart(), 3000);
	}));

	return client;
}

/** Строка настроек/сообщений о сервере — используется в онбординге. */
export const JAVA_LSP_INFO = { size: JAVA_SERVER_SIZE, minJava: MIN_JAVA_MAJOR };
