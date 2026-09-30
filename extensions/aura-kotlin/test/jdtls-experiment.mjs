/*---------------------------------------------------------------------------------------------
 *  Эксперимент: может ли jdtls дать диагностику/автодополнение/автоимпорт для Java-файла
 *  Android-проекта, если исходники подключены linked-папкой, а classpath собран из
 *  android.jar и classes.jar, извлечённых из .aar.
 *
 *  Запуск: node test/jdtls-experiment.mjs
 *--------------------------------------------------------------------------------------------*/
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TMP = os.tmpdir().replace(/\\/g, '/');
const JDTLS = `${TMP}/jdtls`;
const EXP = `${TMP}/aura-java-exp`;
const LIBS = `${EXP}/libs`;
const PROJ = `${EXP}/proj`;
const DATA = `${EXP}/data`;
const PROJECT = `${TMP}/aura-e2e/AuraTestApp`;
const JAVA = process.env.JDTLS_JAVA ?? 'C:/Users/Wiks/.jdks/openjdk-25.0.2/bin/java.exe';
const ANDROID_JAR = 'C:/android-sdk/platforms/android-35/android.jar';
const SRC_DIR = `${PROJECT}/app/src/main/java`;

const launcher = fs.readdirSync(`${JDTLS}/plugins`).find(name => /^org\.eclipse\.equinox\.launcher_/.test(name) && name.endsWith('.jar'));
if (!launcher) { throw new Error('launcher jar not found'); }

// --- shadow-проект: linked-исходники + jar-ы ---
fs.mkdirSync(PROJ, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(`${PROJ}/.project`, `<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
	<name>AuraTestApp</name>
	<comment></comment>
	<projects></projects>
	<buildSpec>
		<buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments></arguments></buildCommand>
	</buildSpec>
	<natures><nature>org.eclipse.jdt.core.javanature</nature></natures>
	<linkedResources>
		<link><name>src-main</name><type>2</type><location>${SRC_DIR}</location></link>
	</linkedResources>
</projectDescription>
`);
const libEntries = [ANDROID_JAR, ...fs.readdirSync(LIBS).map(name => `${LIBS}/${name}`)]
	.map(file => `\t<classpathentry kind="lib" path="${file}"/>`).join('\n');
fs.writeFileSync(`${PROJ}/.classpath`, `<?xml version="1.0" encoding="UTF-8"?>
<classpath>
	<classpathentry kind="src" path="src-main"/>
	<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>
${libEntries}
	<classpathentry kind="output" path="bin"/>
</classpath>
`);

// --- LSP-транспорт ---
const child = spawn(JAVA, [
	'-Declipse.application=org.eclipse.jdt.ls.core.id1',
	'-Dosgi.bundles.defaultStartLevel=4',
	'-Declipse.product=org.eclipse.jdt.ls.core.product',
	'-Dlog.level=ERROR',
	'-Xmx1G',
	'--add-modules=ALL-SYSTEM',
	'--add-opens', 'java.base/java.util=ALL-UNNAMED',
	'--add-opens', 'java.base/java.lang=ALL-UNNAMED',
	'-jar', `${JDTLS}/plugins/${launcher}`,
	'-configuration', `${JDTLS}/config_win`,
	'-data', DATA,
], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = Buffer.alloc(0);
const pending = new Map();
let nextId = 1;
const diagnostics = new Map();
const serverLogs = [];

const send = payload => {
	const body = Buffer.from(JSON.stringify(payload), 'utf8');
	child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
	child.stdin.write(body);
};
const request = (method, params, timeoutMs = 240_000) => new Promise((resolve, reject) => {
	const id = nextId++;
	pending.set(id, { resolve, reject });
	send({ jsonrpc: '2.0', id, method, params });
	setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method}: timeout`)); } }, timeoutMs);
});
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

child.stderr.on('data', chunk => serverLogs.push(`[err] ${chunk.toString().trim()}`));
child.stdout.on('data', chunk => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const end = buffer.indexOf('\r\n\r\n');
		if (end < 0) { return; }
		const header = buffer.slice(0, end).toString('utf8');
		const match = /Content-Length:\s*(\d+)/i.exec(header);
		if (!match) { buffer = buffer.slice(end + 4); continue; }
		const length = Number(match[1]);
		if (buffer.length < end + 4 + length) { return; }
		const text = buffer.slice(end + 4, end + 4 + length).toString('utf8');
		buffer = buffer.slice(end + 4 + length);
		let message;
		try { message = JSON.parse(text); } catch { continue; }
		handle(message);
	}
});

const handle = message => {
	if (message.method === 'textDocument/publishDiagnostics') {
		diagnostics.set(message.params.uri, message.params.diagnostics);
		return;
	}
	if (message.id !== undefined && message.method) {
		// Серверный запрос к клиенту: отвечаем минимально.
		const result = message.method === 'workspace/configuration'
			? message.params.items.map(() => ({}))
			: null;
		send({ jsonrpc: '2.0', id: message.id, result });
		return;
	}
	if (message.id !== undefined && pending.has(Number(message.id))) {
		const entry = pending.get(Number(message.id));
		pending.delete(Number(message.id));
		if (message.error) { entry.reject(new Error(message.error.message)); } else { entry.resolve(message.result); }
	}
};

const fileUri = file => `file:///${file.replace(/^\/+/, '')}`;
const javaActivity = `${PROJECT}/app/src/main/java/com/aura/testapp/JavaActivity.java`;
const probe = `${PROJECT}/app/src/main/java/com/aura/testapp/CompletionProbe.java`;

console.log('jdtls:', launcher);
const t0 = Date.now();
const init = await request('initialize', {
	processId: process.pid,
	rootUri: fileUri(PROJ),
	workspaceFolders: [{ uri: fileUri(PROJ), name: 'AuraTestApp' }],
	capabilities: {
		workspace: { applyEdit: true, configuration: true, workspaceFolders: true },
		textDocument: {
			synchronization: { didSave: true },
			completion: { completionItem: { snippetSupport: true, resolveSupport: { properties: ['additionalTextEdits', 'documentation', 'detail'] } } },
			codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'source.organizeImports'] } } },
			publishDiagnostics: { relatedInformation: true },
			hover: { contentFormat: ['markdown', 'plaintext'] },
		},
	},
	initializationOptions: {
		settings: { java: { import: { gradle: { enabled: false } }, configuration: { updateBuildConfiguration: 'automatic' } } },
	},
});
console.log(`initialize: ${((Date.now() - t0) / 1000).toFixed(1)}s, jdtls версия: ${init?.serverInfo?.version ?? '?'}`);
notify('initialized', {});

const open = file => {
	const text = fs.readFileSync(file, 'utf8');
	notify('textDocument/didOpen', { textDocument: { uri: fileUri(file), languageId: 'java', version: 1, text } });
	return text;
};

open(javaActivity);
open(probe);

// Ждём диагностику по JavaActivity.
const deadline = Date.now() + 180_000;
while (Date.now() < deadline && !diagnostics.has(fileUri(javaActivity))) {
	await new Promise(resolve => setTimeout(resolve, 1000));
}
console.log(`диагностика получена за ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const diags = diagnostics.get(fileUri(javaActivity)) ?? [];
console.log(`\n== Диагностика JavaActivity.java (${diags.length}):`);
for (const diagnostic of diags) {
	console.log(`  [${diagnostic.severity}] ${diagnostic.line ?? diagnostic.range.start.line + 1}: ${diagnostic.message.split('\n')[0].slice(0, 140)}`);
}
const unresolved = diags.find(d => /ContextCompat/.test(d.message));
console.log(unresolved ? 'ContextCompat НЕ резолвится (ожидаемо — проверяем quick fix)' : 'ContextCompat резолвится (автоимпорт не нужен)');

// Автодополнение после `view.`
const completion = await request('textDocument/completion', {
	textDocument: { uri: fileUri(probe) },
	position: { line: 7, character: 7 },
	context: { triggerKind: 2, triggerCharacter: '.' },
}).catch(error => ({ error: error.message }));
const items = Array.isArray(completion) ? completion : completion?.items ?? [];
console.log(`\n== Автодополнение после «view.» (${items.length} элементов):`);
console.log('  ' + items.slice(0, 12).map(item => item.label).join(', '));
const withImport = items.filter(item => (item.additionalTextEdits ?? []).length > 0);
console.log(`  элементов с дополнительными правками (автоимпорт при принятии): ${withImport.length}`);

// Quick fix / organize imports
if (unresolved) {
	const actions = await request('textDocument/codeAction', {
		textDocument: { uri: fileUri(javaActivity) },
		range: unresolved.range,
		context: { diagnostics: [unresolved] },
	}).catch(error => ({ error: error.message }));
	const list = Array.isArray(actions) ? actions : [];
	console.log(`\n== Code actions на ошибке ContextCompat (${list.length}):`);
	for (const action of list.slice(0, 6)) {
		const hasEdit = !!action.edit || !!action.command;
		console.log(`  ${action.kind ?? '?'}: ${action.title}${hasEdit ? ' (с правкой)' : ''}`);
	}
}
const organize = await request('textDocument/codeAction', {
	textDocument: { uri: fileUri(javaActivity) },
	range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
	context: { only: ['source.organizeImports'], diagnostics: [] },
}).catch(error => ({ error: error.message }));
console.log(`\n== source.organizeImports: ${Array.isArray(organize) ? organize.map(a => a.title).join(', ') || 'нет' : JSON.stringify(organize)}`);

console.log(`\nсерверных ошибок в stderr: ${serverLogs.length}`);
for (const line of serverLogs.slice(0, 5)) { console.log('  ' + line.slice(0, 160)); }

try { await request('shutdown', null, 20_000); notify('exit'); } catch { /* ignore */ }
setTimeout(() => { child.kill(); process.exit(0); }, 1500);
