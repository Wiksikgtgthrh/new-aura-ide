/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — живой smoke-тест Java LSP ЧЕРЕЗ КОД РАСШИРЕНИЯ.
 *
 *  Гоняем не ручной запуск jdtls, а настоящие модули расширения:
 *    • ClasspathSync  — реальный резолв classpath через Gradle;
 *    • registerJavaLsp — ту же регистрацию, что делает extension.ts (провайдеры + команды);
 *    • JavaLspClient.prepare() — сборку shadow-проекта Eclipse (linked-исходники + android.jar
 *      + classes.jar, развёрнутые из .aar);
 *    • JavaLspClient.ensureSources() — приложение исходников (platform sources + sources-jar),
 *      без которых переход к определению и hover по android.jar и androidx не работают.
 *  Затем проверяем то, ради чего всё делалось: диагностику, автодополнение, автоимпорт
 *  и переходы в исходники Android/AndroidX для .java в Android-проекте.
 *
 *  Запуск: node test/java.lsp.smoke.mjs [путь-к-Android-проекту]
 *  Требует: скачанный jdtls (JDTLS_DIR, по умолчанию <tmp>/jdtls) и JDK 17+.
 *--------------------------------------------------------------------------------------------*/
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const PROJECT = process.argv[2] ?? path.join(os.tmpdir(), 'aura-e2e', 'AuraTestApp');
const JDTLS_DIR = process.env.JDTLS_DIR ?? path.join(os.tmpdir(), 'jdtls');
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-java-storage-'));

if (!fs.existsSync(path.join(PROJECT, 'settings.gradle')) && !fs.existsSync(path.join(PROJECT, 'settings.gradle.kts'))) {
	console.log(`SKIP: нет gradle-проекта по пути ${PROJECT}`);
	process.exit(0);
}
if (!fs.existsSync(path.join(JDTLS_DIR, 'plugins'))) {
	console.log(`SKIP: jdtls не найден в ${JDTLS_DIR} (JDTLS_DIR=… чтобы указать свой)`);
	process.exit(0);
}

const results = [];
const check = (name, ok, detail = '') => {
	results.push({ name, ok });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------- Минимальный vscode: только то, что трогает JavaLspClient ----------

class Position {
	constructor(line, character) { this.line = line; this.character = character; }
}
class Range {
	constructor(a, b, c, d) { this.start = new Position(a, b); this.end = new Position(c, d); }
}
class Uri {
	constructor(fsPath) { this.fsPath = fsPath; this.scheme = 'file'; this.path = String(fsPath).replace(/\\/g, '/'); }
	toString() { return `file:///${String(this.path).replace(/\\/g, '/').replace(/^\/+/, '')}`; }
	static file(value) { return new Uri(value); }
	/** Разбирает и file-, и виртуальные URI (jdt://…): так же, как это делает сам VS Code. */
	static parse(value) {
		const text = String(value);
		const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/)?(.*)$/.exec(text);
		if (!match || match[1] === 'file') { return new Uri(decodeURIComponent(text.replace(/^file:\/\/\/?/, ''))); }
		const [beforeQuery, ...rest] = match[2].split('?');
		const uri = new Uri(beforeQuery);
		uri.scheme = match[1];
		uri.path = beforeQuery;
		uri.query = rest.join('?');
		return uri;
	}
	static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath ?? base, ...parts)); }
}
class MarkdownString {
	constructor(value = '') { this.value = value; }
	appendText(value) { this.value += value; return this; }
	appendMarkdown(value) { this.value += value; return this; }
	appendCodeblock(value, language = '') { this.value += `
\`\`\`${language}
${value}
\`\`\`
`; return this; }
}
class Hover { constructor(contents) { this.contents = contents; } }
class Location { constructor(uri, range) { this.uri = uri; this.range = range; } }
class Diagnostic { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } }
class CompletionItem {
	constructor(label, kind) { this.label = label; this.kind = kind; }
}
class CompletionList { constructor(items, isIncomplete) { this.items = items; this.isIncomplete = isIncomplete; } }
class SnippetString { constructor(value) { this.value = value; } }
class SignatureHelp { constructor() { this.signatures = []; this.activeSignature = 0; this.activeParameter = 0; } }
class SignatureInformation { constructor(label, documentation) { this.label = label; this.documentation = documentation; this.parameters = []; } }
class ParameterInformation { constructor(label, documentation) { this.label = label; this.documentation = documentation; } }
class DocumentSymbol { constructor(name, detail, kind, range, selectionRange) { this.name = name; this.detail = detail; this.kind = kind; this.range = range; this.selectionRange = selectionRange; this.children = []; } }
class CodeAction { constructor(title, kind) { this.title = title; this.kind = kind; } }
class WorkspaceEdit {
	constructor() { this.replacements = []; }
	replace(uri, range, newText) { this.replacements.push({ uri, range, newText }); }
}
class EventEmitter {
	constructor() { this.listeners = new Set(); this.event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
	fire(value) { for (const listener of this.listeners) { listener(value); } }
	dispose() { this.listeners.clear(); }
}

const enumOf = names => Object.fromEntries(names.map((name, index) => [name, index + 1]));
const channels = [];
const collectionDiagnostics = new Map();
const commands = [];
const notifications = [];
/** Зарегистрированные content providers: ключ — схема URI (VS Code так же отдаёт их редактору). */
const contentProviders = new Map();

const vscodeStub = {
	Position, Range, Uri, MarkdownString, Hover, Location, Diagnostic, CompletionItem, CompletionList,
	SignatureHelp, SignatureInformation, ParameterInformation, DocumentSymbol, CodeAction, WorkspaceEdit, EventEmitter, SnippetString,
	ThemeIcon: class { constructor(id) { this.id = id; } },
	DiagnosticSeverity: enumOf(['Error', 'Warning', 'Information', 'Hint']),
	CompletionItemKind: enumOf(['Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter']),
	SymbolKind: enumOf(['File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event', 'Operator', 'TypeParameter']),
	StatusBarAlignment: { Left: 1, Right: 2 },
	ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
	ViewColumn: { Active: -1, One: 1 },
	CodeActionKind: { QuickFix: { value: 'quickfix' }, Source: { value: 'source' }, SourceOrganizeImports: { value: 'source.organizeImports' } },
	Disposable: { from: (...items) => ({ dispose: () => items.forEach(item => item?.dispose?.()) }) },
	l10n: { t: (text, ...args) => String(text).replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)] ?? '')) },
	workspace: {
		workspaceFolders: [{ uri: new Uri(PROJECT), name: path.basename(PROJECT), index: 0 }],
		textDocuments: [],
		applyEdit: async (edit) => { notifications.push(`applyEdit: ${edit?.replacements?.length ?? 0} правок`); return true; },
		getConfiguration: (section) => ({
			get: (key, fallback) => {
				if (section !== 'auraKotlin') { return fallback; }
				if (key === 'javaLspPath') { return JDTLS_DIR; }
				if (key === 'javaPath') { return process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : 'java'; }
				if (key === 'androidSdkPath') { return process.env.ANDROID_HOME ?? fallback; }
				return fallback;
			},
			update: async () => undefined,
		}),
		createFileSystemWatcher: () => ({ dispose() { }, onDidChange: () => ({ dispose() { } }), onDidCreate: () => ({ dispose() { } }), onDidDelete: () => ({ dispose() { } }) }),
		registerTextDocumentContentProvider: (scheme, provider) => { contentProviders.set(scheme, provider); return { dispose() { } }; },
		onDidOpenTextDocument: () => ({ dispose() { } }),
		onDidChangeTextDocument: () => ({ dispose() { } }),
		onDidSaveTextDocument: () => ({ dispose() { } }),
		onDidCloseTextDocument: () => ({ dispose() { } }),
	},
	window: {
		createOutputChannel: (name) => {
			const channel = { name, lines: [], appendLine: (text) => channel.lines.push(String(text)), append: (text) => channel.lines.push(String(text)), show() { }, dispose() { } };
			channels.push(channel);
			return channel;
		},
		createStatusBarItem: () => ({ show() { }, hide() { }, dispose() { } }),
		showInformationMessage: async (...args) => { notifications.push(`info: ${args[0]}`); return undefined; },
		showWarningMessage: async (...args) => { notifications.push(`warn: ${args[0]}`); return undefined; },
		showErrorMessage: async (...args) => { notifications.push(`error: ${args[0]}`); return undefined; },
		// VS Code всегда отдаёт задаче прогресс И токен отмены — стаб обязан делать то же,
		// иначе код, который подписывается на отмену, падал бы только в тестах.
		withProgress: async (_options, task) => task(
			{ report() { } },
			{ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() { } }) },
		),
	},
	commands: {
		registerCommand: (id) => { commands.push(id); return { dispose() { } }; },
		executeCommand: async () => undefined,
	},
	languages: {
		createDiagnosticCollection: (name) => ({
			name,
			set: (uri, diagnostics) => collectionDiagnostics.set(uri.toString(), diagnostics),
			get: (uri) => collectionDiagnostics.get(uri.toString()),
			delete: (uri) => collectionDiagnostics.delete(uri.toString()),
			clear: () => collectionDiagnostics.clear(),
			dispose() { },
		}),
		registerHoverProvider: () => ({ dispose() { } }),
		registerDefinitionProvider: () => ({ dispose() { } }),
		registerCompletionItemProvider: () => ({ dispose() { } }),
		registerSignatureHelpProvider: () => ({ dispose() { } }),
		registerDocumentSymbolProvider: () => ({ dispose() { } }),
		registerReferenceProvider: () => ({ dispose() { } }),
		registerRenameProvider: () => ({ dispose() { } }),
		registerCodeActionsProvider: () => ({ dispose() { } }),
	},
};

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') { return vscodeStub; }
	return originalLoad.call(this, request, parent, isMain);
};

const { ClasspathSync, sdkRoot } = require('../out/classpath.js');
const { registerJavaLsp, JAVA_LSP_INFO } = require('../out/javaLsp.js');
const { planSources, installedPlatformSources } = require('../out/javaSources.js');
const { parseJdtUri, jdtSourceDocument } = require('../out/javaUris.js');

const context = {
	extensionPath: path.join(process.cwd(), '..'),
	extensionUri: Uri.file(path.join(process.cwd(), '..')),
	globalStorageUri: Uri.file(STORAGE),
	subscriptions: [],
	globalState: { get: () => undefined, update: async () => undefined },
	workspaceState: { get: () => undefined, update: async () => undefined },
	asAbsolutePath: (value) => path.join(process.cwd(), '..', value),
};

const source = (file) => fs.readFileSync(file, 'utf8');
const fileUri = (file) => Uri.file(file).toString();
const document = (file) => ({
	uri: Uri.file(file),
	fileName: file,
	languageId: 'java',
	version: 1,
	lineCount: source(file).split(/\r?\n/).length,
	getText: () => source(file),
	positionAt: (offset) => {
		const lines = source(file).slice(0, offset).split(/\r?\n/);
		return new Position(lines.length - 1, lines[lines.length - 1].length);
	},
});

const t0 = Date.now();
const seconds = () => ((Date.now() - t0) / 1000).toFixed(1);

// ---------- 1. Classpath (как в extension.ts) ----------
const sync = new ClasspathSync();
await sync.sync('java-lsp-smoke');
const classpath = sync.classpath;
const androidJar = classpath.jars.filter(jar => jar.endsWith('android.jar')).length;
const aar = classpath.jars.filter(jar => jar.endsWith('.aar')).length;
console.log(`\nclasspath: source=${classpath.source}, jar=${classpath.jars.length}, android.jar=${androidJar}, .aar=${aar}, модулей=${classpath.modules.length} (${seconds()}s)`);
check('classpath получен от Gradle', classpath.source === 'gradle', `source=${classpath.source}`);
check('в classpath есть android.jar', androidJar > 0);
check('в classpath есть .aar (будут развёрнуты в classes.jar)', aar > 0, `${aar} шт.`);

// ---------- 2. Клиент через штатную регистрацию расширения ----------
const client = registerJavaLsp(context, sync);
check('команды расширения зарегистрированы', commands.includes('auraKotlin.java.restartLsp') && commands.includes('auraKotlin.java.organizeImports'), commands.join(', '));
check('команда скачивания исходников зарегистрирована', commands.includes('auraKotlin.java.downloadSources'), commands.join(', '));

// ---------- 2.5 Исходники (android.jar, androidx, платформа) ----------
// Без sourcepath Eclipse JDT знает только сигнатуры: переход уводит в сгенерированный класс,
// hover по членам пустой. Ждём, что планировщик увидит и локальные, и недостающие исходники,
// а затем скачает их штатным путём расширения (то же, что делает команда в IDE).
const sdk = sdkRoot();
const platformBefore = [...installedPlatformSources(sdk).keys()];
const plan = planSources(classpath.jars, { sdkRoot: sdk, storageRoot: STORAGE });
console.log(`\nисходники: локально ${plan.attached.size}, к скачиванию ${plan.downloadable.length}, ` +
	`платформа ${plan.platform.map(item => `Android ${item.api}`).join(', ') || (platformBefore.length ? `Android ${platformBefore.join(', ')} уже стоит` : 'не определена')}, ` +
	`без координат ${plan.unresolved.length} (sdk=${sdk ?? 'нет'})`);
check('исходники платформы есть или запланированы', platformBefore.length > 0 || plan.platform.length > 0, `Android ${platformBefore.join(', ') || plan.platform.map(item => item.api).join(', ') || 'нет'}`);
check('исходники библиотек есть или запланированы', plan.attached.size + plan.downloadable.length > 0, `${plan.attached.size} локально, ${plan.downloadable.length} к скачиванию`);

await client.ensureSources('manual');
const sourcesLog = channels.flatMap(channel => channel.lines).filter(line => line.includes('[java] исходники'));
const downloadedLog = sourcesLog.find(line => line.includes('подключено')) ?? '';
console.log(downloadedLog.trim());

const started = await client.ensureStarted();
check('Java Language Server запущен', started && client.lsp.serverState === 'running', `state=${client.lsp.serverState} (${seconds()}s)`);
if (!started) {
	for (const channel of channels) { console.log(`  ${channel.name}:`); for (const line of channel.lines.slice(0, 20)) { console.log(`    ${line}`); } }
	console.log(`\n${results.filter(r => !r.ok).length} проверок провалено`);
	process.exit(1);
}

const shadowLog = channels.flatMap(channel => channel.lines).find(line => line.includes('shadow-проект'));
check('shadow-проект собран (linked-исходники + classpath)', /shadow-проект: \d+ каталогов исходников, \d+ jar/.test(shadowLog ?? ''), shadowLog ?? 'нет записи в логе');

// Ключевая проверка: sourcepath действительно попал в .classpath (иначе сервер про исходники не знает).
const projectDir = client.projectDir;
const classpathFile = projectDir ? path.join(projectDir, '.classpath') : '';
const classpathText = classpathFile && fs.existsSync(classpathFile) ? fs.readFileSync(classpathFile, 'utf8') : '';
const attachments = [...classpathText.matchAll(/sourcepath="([^"]+)"/g)].map(match => match[1]);
const hasFile = (root, relative) => { try { return fs.existsSync(path.join(root, relative)); } catch { return false; } };
const androidAttachment = attachments.find(value => hasFile(value, path.join('android', 'widget', 'TextView.java')));
const jarAttachment = attachments.find(value => /-sources\.jar$/.test(value));
console.log(`sourcepath в .classpath: ${attachments.length}`);
console.log(`  android.jar → ${androidAttachment ?? 'нет'}`);
console.log(`  пример библиотеки → ${jarAttachment ?? 'нет'}`);
check('в .classpath есть sourcepath для android.jar, и он ведёт в дерево исходников', !!androidAttachment, androidAttachment ?? 'нет');
check('в .classpath есть sourcepath для sources-jar библиотек', !!jarAttachment, `${attachments.length} закреплений`);

const JAVA_ACTIVITY = path.join(PROJECT, 'app', 'src', 'main', 'java', 'com', 'aura', 'testapp', 'JavaActivity.java');
const PROBE = path.join(PROJECT, 'app', 'src', 'main', 'java', 'com', 'aura', 'testapp', 'CompletionProbe.java');
if (!fs.existsSync(JAVA_ACTIVITY) || !fs.existsSync(PROBE)) {
	console.log(`SKIP: нет фикстур JavaActivity.java/CompletionProbe.java в ${PROJECT}`);
	process.exit(0);
}
const activity = document(JAVA_ACTIVITY);
const probe = document(PROBE);

const waitFor = async (predicate, timeoutMs, label) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) { return true; }
		await sleep(1000);
	}
	console.log(`  (ожидание «${label}» истекло)`);
	return false;
};

// ---------- 3. Диагностика ----------
client.lsp.didOpen(activity);
client.lsp.didOpen(probe);
await waitFor(() => (collectionDiagnostics.get(fileUri(JAVA_ACTIVITY)) ?? []).length > 0, 180_000, 'диагностика JavaActivity');

const diagnostics = collectionDiagnostics.get(fileUri(JAVA_ACTIVITY)) ?? [];
const errors = diagnostics.filter(diagnostic => diagnostic.severity === vscodeStub.DiagnosticSeverity.Error);
console.log(`\nдиагностика JavaActivity.java (${diagnostics.length}, ошибок ${errors.length}) за ${seconds()}s:`);
for (const diagnostic of diagnostics) { console.log(`  [sev ${diagnostic.severity}] ${diagnostic.range.start.line + 1}: ${diagnostic.message.split('\n')[0].slice(0, 120)}`); }

const unresolvedAndroid = errors.filter(diagnostic => /(TextView|Bundle|Activity|R\.color)/.test(diagnostic.message));
check('android.jar и импорты androidx/android резолвятся (нет ошибок по TextView/Bundle/Activity)', unresolvedAndroid.length === 0, unresolvedAndroid.map(d => d.message.split('\n')[0]).join(' | ') || 'ок');
const missingImport = errors.find(diagnostic => /ContextCompat/.test(diagnostic.message));
check('неимпортированный ContextCompat отмечен как ошибка (нужен автоимпорт)', !!missingImport, missingImport?.message.split('\n')[0] ?? 'нет');

// ---------- 4. Автодополнение ----------
// Сразу после точки (позиция 7:7 в CompletionProbe) — члены типа view.
const completion = await client.lsp.completion(probe, new Position(7, 7), { triggerKind: 2, triggerCharacter: '.' });
const items = completion?.items ?? [];
console.log(`\nавтодополнение после «view.» — ${items.length} элементов за ${seconds()}s`);
console.log('  ' + items.slice(0, 12).map(item => item.label).join(', '));
check('автодополнение для .java возвращает элементы', items.length > 20, `${items.length} шт.`);

// С набранным префиксом («view.set») сервер фильтрует по членам android.widget.TextView.
const prefixed = await client.lsp.completion(probe, new Position(7, 11), { triggerKind: 1 });
const prefixedLabels = (prefixed?.items ?? []).map(item => item.label);
console.log(`автодополнение после «view.setTe» — ${prefixedLabels.length}: ${prefixedLabels.slice(0, 8).join(', ')}`);
check('члены android.widget.TextView предлагаются по префиксу', prefixedLabels.some(label => /^setText/.test(label)), prefixedLabels.slice(0, 8).join(', ') || 'пусто');

// Автоимпорт: неимпортированный ContextCompat в позиции идентификатора.
const importItems = await client.lsp.completion(activity, new Position(15, 17), { triggerKind: 1 });
const importCandidate = (importItems?.items ?? []).find(item => /^ContextCompat/.test(item.label));
console.log(`подсказка ContextCompat: ${importCandidate ? `${importCandidate.label} (${importCandidate.detail ?? '-'})` : 'нет'}`);
check('в автодополнении предлагается неимпортированный ContextCompat', !!importCandidate, importCandidate?.label ?? 'нет');
if (importCandidate) {
	// jdtls отдаёт текст вставки и импорт только в completionItem/resolve — этот доапрос
	// клиент теперь делает перед вставкой подсказки.
	let resolved = await client.lsp.resolveCompletionItem(importCandidate);
	for (let attempt = 0; attempt < 3 && !resolved.command; attempt++) {
		await sleep(2000);
		resolved = await client.lsp.resolveCompletionItem(importCandidate);
	}
	const importEdits = resolved.command?.arguments?.[1] ?? [];
	const methodItem = (prefixed?.items ?? []).find(item => /^setText\(/.test(item.label));
	const resolvedMethod = methodItem ? await client.lsp.resolveCompletionItem(methodItem) : undefined;
	const methodText = resolvedMethod?.insertText?.value ?? resolvedMethod?.insertText;
	console.log(`resolve метода: insertText=${JSON.stringify(String(methodText ?? '')).slice(0, 60)}`);
	check('resolve метода даёт текст вставки, а не описание из label', /^setText$/.test(String(methodText ?? '')), String(methodText ?? 'нет'));
	console.log(`resolve: insertText=${JSON.stringify(resolved.insertText)} command=${resolved.command?.command ?? 'нет'}`);
	const importText = resolved.insertText?.value ?? resolved.insertText;
	check('resolve подставляет код вместо описания подсказки', /^ContextCompat$/.test(String(importText)), String(importText));
	check('resolve приносит автоимпорт androidx.core.content.ContextCompat',
		resolved.command?.command === 'auraKotlin.applyLspTextEdits' && importEdits.some(textEdit => /import\s+androidx\.core\.content\.ContextCompat;/.test(textEdit.newText)),
		importEdits.map(textEdit => textEdit.newText.trim()).join(', ') || 'нет правок');
}

// ---------- 5. Автоимпорт: quick fix и organize imports ----------
if (missingImport) {
	const actions = await client.lsp.codeAction(activity, new Range(missingImport.range.start.line, missingImport.range.start.character, missingImport.range.end.line, missingImport.range.end.character));
	const importAction = (actions ?? []).find(action => /import/i.test(action.title));
	console.log(`\nquick fix на ContextCompat (${actions?.length ?? 0} actions): ${(actions ?? []).map(a => a.title).join(' | ') || 'нет'}`);
	check('quick fix «Import …ContextCompat» приходит с правкой', !!importAction && !!importAction.edit && importAction.edit.replacements.length > 0,
		importAction ? `${importAction.title} → ${importAction.edit?.replacements.map(r => r.newText.trim()).join(', ')}` : 'нет');
	if (importAction?.edit) {
		const inserted = importAction.edit.replacements.map(r => r.newText).join('');
		check('правка автоимпорта вставляет import androidx.core.content.ContextCompat', /import\s+androidx\.core\.content\.ContextCompat;/.test(inserted), inserted.trim());
	}
}
const organize = await client.lsp.codeAction(activity, new Range(0, 0, activity.lineCount - 1, 0), ['source.organizeImports']);
console.log(`organize imports: ${(organize ?? []).map(a => a.title).join(' | ') || 'нет'}`);
check('source.organizeImports доступен (автоимпорт всего файла)', (organize ?? []).some(action => /organize/i.test(action.title)), (organize ?? []).map(a => a.title).join(', ') || 'сервер не предложил');

// ---------- 6. Остальные провайдеры, которые включает регистрация ----------
const hover = await client.lsp.hover(probe, new Position(5, 15));
const firstLine = (value) => String(value ?? '').split(String.fromCharCode(10)).map(line => line.trim()).filter(Boolean)[0] ?? '';
check('hover по типу проекта отвечает (MarkedString[] разобран)', !!hover && /CompletionProbe/.test(String(hover.contents?.value ?? '')), firstLine(hover?.contents?.value) || 'нет');
if (hover) { console.log(`hover: ${firstLine(hover.contents?.value).slice(0, 100)}`); }
const definition = await client.lsp.definition(probe, new Position(5, 15));
check('переход к определению работает', !!definition && (Array.isArray(definition) ? definition.length : 1) > 0, '');
const memberHover = await client.lsp.hover(probe, new Position(7, 10));
const memberText = String(memberHover?.contents?.value ?? '');
console.log(`hover по члену android.widget.TextView: ${memberText.split(String.fromCharCode(10)).map(line => line.trim()).filter(Boolean).slice(0, 3).join(' / ').slice(0, 160) || 'пусто'}`);
check('hover по члену android.jar отдаёт javadoc из исходников', /setText\(CharSequence text\)/.test(memberText) && memberText.length > 150, `${memberText.length} символов: ${memberText.replace(/\s+/g, ' ').slice(0, 130)}`);

// ---------- 7. Переходы к определению внутри android.jar и androidx ----------
const locations = (value) => Array.isArray(value) ? value : value ? [value] : [];

// jdtls отдаёт библиотечные цели виртуальным jdt://-URI, а текст исходника редактор берёт
// из content provider’а — проверяем всю цепочку так, как это делает VS Code.
const provider = contentProviders.get('jdt');
check('content provider для jdt:// зарегистрирован', typeof provider?.provideTextDocumentContent === 'function', [...contentProviders.keys()].join(', ') || 'нет');

const jump = async (label, position, expected, anchor) => {
	const location = locations(await client.lsp.definition(activity, position))[0];
	if (!location) {
		check(`переход по ${label}`, false, 'сервер ничего не вернул');
		return;
	}
	const uri = location.uri;
	const target = parseJdtUri(uri);
	const content = target && provider ? await provider.provideTextDocumentContent(uri) : undefined;
	const line = content ? content.split(/\r?\n/)[location.range.start.line] ?? '' : '';
	console.log(`\nпереход по ${label} → ${String(uri).slice(0, 70)}…`);
	console.log(`  исходник: ${target?.sourceRelative ?? 'нет'} (${content ? `${content.split(/\r?\n/).length} строк` : 'не открылся'})`);
	console.log(`  строка ${location.range.start.line + 1}: ${line.trim().slice(0, 80)}`);
	const typeName = expected.split('/').pop().replace(/\.java$/, '');
	check(`переход по ${label} ведёт в прикреплённый исходник`, target?.sourceRelative === expected, target?.sourceRelative ?? 'нет');
	check(`исходник ${expected} открывается через content provider`, !!content && content.includes(`class ${typeName}`), content ? `${content.length} символов` : 'пусто');
	check(`строка ${location.range.start.line + 1} исходника совпадает с целью перехода`, line.includes(anchor), line.trim().slice(0, 70) || 'пусто');
};

await jump('TextView', new Position(11, 4), 'android/widget/TextView.java', 'class TextView');
await jump('setText', new Position(12, 8), 'android/widget/TextView.java', 'setText(CharSequence');
await jump('ContextCompat', new Position(15, 16), 'androidx/core/content/ContextCompat.java', 'class ContextCompat');

// Если исходников нет вовсе, провайдер должен сказать об этом текстом, а не отдать пустое окно.
const orphanUri = Uri.parse('jdt://contents/unknown.jar/com/example/Foo.java?=aura-java/C:/nowhere/unknown.jar<com.example(Foo.class');
const orphan = jdtSourceDocument(undefined, orphanUri);
check('без прикреплённых исходников провайдер объясняет это текстом, а не пустой вкладкой', /Sources for com\/example\/Foo\.java are not attached/.test(orphan ?? ''), String(orphan ?? '').trim().slice(0, 100));
check('jdt-URI разобран в пару «jar + исходник»', (() => { const parsed = parseJdtUri(orphanUri); return parsed?.sourceRelative === 'com/example/Foo.java' && /unknown\.jar$/.test(parsed.jarPath); })(), JSON.stringify(parseJdtUri(orphanUri)));
const symbols = await client.lsp.documentSymbol(probe);
check('documentSymbol отдаёт символы файла', (symbols?.length ?? 0) > 0, (symbols ?? []).map(s => s.name).join(', '));

client.dispose();
try { fs.rmSync(STORAGE, { recursive: true, force: true }); } catch { /* каталог занят сервером */ }

const failed = results.filter(result => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} проверок пройдено (${seconds()}s)`);
process.exit(failed.length ? 1 : 0);
