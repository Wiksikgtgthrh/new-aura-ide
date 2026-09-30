/**
 * Живой LSP-сеанс на реальном Android-проекте: completion по классам из
 * android.jar и androidx (например, Activity.onCreate, TextView.setText).
 * Запуск: node test/lsp-android.smoke.mjs <projectRoot> <file.kt> <line> <col>
 */
const Module = (await import('node:module')).default;
const path = (await import('node:path')).default;
const fs = (await import('node:fs')).default;
const os = (await import('node:os')).default;
const { spawn } = await import('node:child_process');
const { fileURLToPath } = await import('node:url');
const here = path.dirname(fileURLToPath(import.meta.url));

const root = path.resolve(process.argv[2] ?? '.');
const serverDir = path.join(here, '..', 'server');
if (!fs.existsSync(serverDir)) { console.error('KLS not bundled — run npm run fetch-server'); process.exit(2); }
const javaExe = 'C:/Users/Wiks/.jdks/ms-17.0.18/bin/java.exe';

// classpath: jars из кэша Gradle + android.jar
const { execFileSync } = await import('node:child_process');
// Собираем classpath напрямую из кэша Gradle + android.jar
const jars = [];
const walkCache = (dir) => {
	try {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) { walkCache(p); } else if (/\.(jar|aar)$/.test(e.name)) { jars.push(p); }
		}
	} catch { }
};
walkCache(path.join(os.homedir(), '.gradle', 'caches', 'modules-2', 'files-2.1'));
jars.push('C:/android-sdk/platforms/android-35/android.jar');
console.log(`classpath: ${jars.length} entries`);

// Стартуем KLS с initializationOptions (как из расширения)
const args = ['-cp', 'server/lib/*', 'org.javacs.kt.MainKt'];
const proc = spawn(javaExe, args, { cwd: path.join(here, '..'), stdio: ['pipe', 'pipe', 'pipe'] });

let buf = Buffer.alloc(0);
const pending = new Map();
const logs = [];
let nextId = 1;

proc.stdout.on('data', (d) => {
	buf = Buffer.concat([buf, d]);
	while (true) {
		const idx = buf.indexOf('\r\n\r\n');
		if (idx < 0) { break; }
		const header = buf.slice(0, idx).toString();
		const m = /Content-Length: (\d+)/.exec(header);
		if (!m) { break; }
		const len = Number(m[1]);
		if (buf.length < idx + 4 + len) { break; }
		const body = buf.slice(idx + 4, idx + 4 + len).toString();
		buf = buf.slice(idx + 4 + len);
		const msg = JSON.parse(body);
		if (msg.id !== undefined && (msg.result !== undefined || msg.error)) { pending.get(msg.id)?.(msg); pending.delete(msg.id); }
		else if (msg.method === 'window/logMessage') { logs.push(msg.params.message); }
	}
});

const send = (obj) => {
	const body = Buffer.from(JSON.stringify(obj));
	proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n${body}`);
};
const request = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); send({ jsonrpc: '2.0', id, method, params }); });
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Класс Java для LSP-клиента
class LspClient { }
void LspClient;

const fileUri = 'file:///C:/Users/Wiks/AppData/Local/Temp/aura-e2e/AuraTestApp/app/src/main/java/com/aura/testapp/MainActivity.kt';

// Инициализация с фокусом на проект
const init = await request('initialize', {
	processId: process.pid,
	rootUri: `file:///${root.replace(/\\/g, '/')}`,
	capabilities: { textDocument: { completion: { completionItem: { resolveSupport: { properties: ['documentation'] } } } } },
	initializationOptions: { classpath: jars.slice(0, 5).concat(jars.filter(j => j.includes('android.jar') || j.includes('kotlin-stdlib'))) },
});
console.log('server:', init.result?.serverInfo?.name, init.result?.serverInfo?.version);
notify('initialized', {});

const source = fs.readFileSync('C:/Users/Wiks/AppData/Local/Temp/aura-e2e/AuraTestApp/app/src/main/java/com/aura/testapp/MainActivity.kt', 'utf8');
notify('textDocument/didOpen', {
	textDocument: { uri: fileUri, languageId: 'kotlin', version: 1, text: source },
});

// Ждём диагностику
let diagnostics = null;
proc.stdout.removeAllListeners('data');
proc.stdout.on('data', (d) => {
	buf = Buffer.concat([buf, d]);
	while (true) {
		const idx = buf.indexOf('\r\n\r\n');
		if (idx < 0) { break; }
		const header = buf.slice(0, idx).toString();
		const m = /Content-Length: (\d+)/.exec(header);
		if (!m) { break; }
		const len = Number(m[1]);
		if (buf.length < idx + 4 + len) { break; }
		const body = buf.slice(idx + 4, idx + 4 + len).toString();
		buf = buf.slice(idx + 4 + len);
		const msg = JSON.parse(body);
		if (msg.method === 'textDocument/publishDiagnostics') { diagnostics = msg.params; }
		if (msg.id !== undefined && msg.result !== undefined) { pending.get(msg.id)?.(msg); pending.delete(msg.id); }
		if (msg.method === 'window/logMessage') { logs.push(msg.params.message); }
	}
});

for (let i = 0; i < 30 && diagnostics === null; i++) { await sleep(1000); }
console.log('diagnostics:', diagnostics ? diagnostics.diagnostics.length : 'none (timeout)');
if (diagnostics) { for (const d of diagnostics.diagnostics) { console.log(`  [${d.severity}] ${d.message.slice(0, 100)}`); } }

// Completion: text.( -> setText, setTextColor... (класс TextView из android.jar)
const lines = source.split('\n');
let compLine = -1, compChar = -1, prefix = '';
for (let i = 0; i < lines.length; i++) {
	const idx = lines[i].indexOf('text.text');
	if (idx >= 0) { compLine = i; compChar = idx + 'text.text'.length; prefix = 'text'; break; }
}
if (compLine < 0) { console.error('no completion anchor found'); proc.kill(); process.exit(1); }
console.log(`completion at L${compLine + 1}:C${compChar + 1} (anchor "text.text")`);

const comp = await request('textDocument/completion', {
	textDocument: { uri: fileUri },
	position: { line: compLine, character: compChar },
});
const items = Array.isArray(comp.result) ? comp.result : comp.result?.items ?? [];
console.log(`completion items: ${items.length}`);
const interesting = items.filter(i => /setText|textColor|textSize|gravity|visibility/.test(i.label)).map(i => i.label);
console.log('TextView members found:', interesting.slice(0, 8));
if (items.length <= 10) { console.log('NOTE: keyword-only completion (member resolution degraded)'); }
else { console.log('LSP-ANDROID PASS'); }

const hover = await request('textDocument/hover', { textDocument: { uri: fileUri }, position: { line: compLine, character: compChar } });
console.log('hover:', hover.result ? 'OK' : 'empty');

// Shutdown
await request('shutdown', {});
notify('exit', {});
proc.kill();
process.exit(items.length > 10 ? 0 : 1);
