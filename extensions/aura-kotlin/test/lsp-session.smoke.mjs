/**
 * Живой smoke-тест Kotlin Language Server: запуск ровно тем способом, которым его
 * запускает расширение (src/lspInstall.ts → java -cp "server/lib/*" org.javacs.kt.MainKt),
 * затем полный LSP-сеанс: initialize → didOpen → publishDiagnostics → completion → hover.
 *
 *   node test/lsp-session.smoke.mjs
 *
 * Требует JDK 11+ (проверяется: при Java ниже — SKIP, как в UI расширения).
 * Адрес java можно передать аргументом: node test/lsp-session.smoke.mjs "C:/path/java.exe"
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_LIB = join(here, '..', 'server', 'lib');
const MAIN_CLASS = 'org.javacs.kt.MainKt';

// ---------- Java: версия и команда ----------

function javaCommandFromArgOrSetting() {
	if (process.argv[2]) { return process.argv[2]; }
	// Как расширение: чтение auraKotlin.javaPath из настроек пользователя (Aura IDE).
	try {
		const settingsPath = join(process.env.APPDATA ?? '', 'Aura IDE', 'User', 'settings.json');
		const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
		return settings['auraKotlin.javaPath'] || 'java';
	} catch { return 'java'; }
}

function javaMajor(java) {
	try {
		const result = spawnSync(java, ['-version'], { encoding: 'utf8' });
		const text = `${result.stderr ?? ''}${result.stdout ?? ''}`;
		const match = /"(\d+)(?:\.(\d+))?/.exec(text) ?? /version (\d+)(?:\.(\d+))?/.exec(text);
		if (!match) { return undefined; }
		const major = Number(match[1]);
		return major === 1 && match[2] ? Number(match[2]) : major;
	} catch { return undefined; }
}

// ---------- LSP-клиент поверх stdio ----------

class LspClient {
	constructor(process_) {
		this.proc = process_;
		this.buffer = Buffer.alloc(0);
		this.nextId = 1;
		this.pending = new Map();
		this.diagnostics = [];
		this.gotDiagnostics = false;
		this.proc.stdout.on('data', chunk => this.onData(chunk));
		this.proc.stderr.on('data', chunk => process.env.KLS_VERBOSE && process.stderr.write(`[server] ${chunk}`));
		this.proc.on('exit', code => { this.exited = code; });
	}

	onData(chunk) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const headerEnd = this.buffer.indexOf('\r\n\r\n');
			if (headerEnd < 0) { return; }
			const header = this.buffer.slice(0, headerEnd).toString('utf8');
			const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
			if (!length || this.buffer.length < headerEnd + 4 + length) { return; }
			const body = JSON.parse(this.buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString('utf8'));
			this.buffer = this.buffer.slice(headerEnd + 4 + length);
			if (process.env.KLS_TRACE) {
				if (body.method === 'window/logMessage') { console.log(`[log] ${body.params.message.split('\n')[0].slice(0, 200)}`); }
				else { console.log(`[msg] ${body.method ?? ('response ' + body.id)}${body.method === 'textDocument/publishDiagnostics' ? ' diags=' + body.params.diagnostics.length : ''}`); }
			}
			if (body.id !== undefined && (body.result !== undefined || body.error)) {
				const pending = this.pending.get(body.id);
				if (pending) { this.pending.delete(body.id); body.error ? pending.reject(new Error(body.error.message)) : pending.resolve(body.result); }
		} else if (body.method === 'textDocument/publishDiagnostics') {
			this.diagnostics = body.params.diagnostics;
			this.gotDiagnostics = true;
		}
		}
	}

	send(method, params) {
		const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, params }), 'utf8');
		this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
		this.proc.stdin.write(body);
	}

	request(method, params, timeoutMs = 120_000) {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8');
			this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n${body}`);
			setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method}: timeout ${timeoutMs}ms`)); } }, timeoutMs);
		});
	}
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------- Сценарий ----------

const java = javaCommandFromArgOrSetting();
const major = javaMajor(java);
if (major === undefined) { console.log('SKIP: java not found'); process.exit(0); }
if (major < 11) { console.log(`SKIP: java ${major} < 11 (extension would show the same message)`); process.exit(0); }
if (!existsSync(SERVER_LIB)) { console.log('SKIP: bundled server missing — run npm run fetch-server'); process.exit(0); }
const lib = readdirSync(SERVER_LIB).some(name => name.startsWith('server-') && name.endsWith('.jar'));
if (!lib) { console.log('SKIP: server jar missing in', SERVER_LIB); process.exit(0); }

console.log(`java: ${java} (major ${major})`);
// Maven-структура: с ней KLS резолвит нормальный kotlin-stdlib, а не древний из .m2.
const project = mkdtempSync(join(tmpdir(), 'kls-smoke-'));
const mainKt = join(project, 'src', 'main', 'kotlin', 'Main.kt');
mkdirSync(dirname(mainKt), { recursive: true });
writeFileSync(mainKt, 'fun main() {\n    val s = "hello"\n    s.l\n}\n');
const source = readFileSync(mainKt, 'utf8');
writeFileSync(join(project, 'pom.xml'), [
	'<?xml version="1.0" encoding="utf-8"?>',
	'<project xmlns="http://maven.apache.org/POM/4.0.0">',
	'  <modelVersion>4.0.0</modelVersion>',
	'  <groupId>aura.smoke</groupId><artifactId>kls-smoke</artifactId><version>1.0.0</version>',
	'  <dependencies>',
	'    <dependency><groupId>org.jetbrains.kotlin</groupId><artifactId>kotlin-stdlib</artifactId><version>2.2.20</version></dependency>',
	'  </dependencies>',
	'</project>',
].join('\n'));

const server = spawn(java, ['-cp', join(SERVER_LIB, '*'), MAIN_CLASS], { stdio: ['pipe', 'pipe', 'pipe'] });
const client = new LspClient(server);

let failed = false;
try {
	console.log('initialize…');
	const caps = await client.request('initialize', {
		processId: process.pid,
		rootUri: `file:///${project.replace(/\\/g, '/')}`,
		capabilities: { textDocument: { completion: { completionItem: { documentationFormat: [] } } } },
	}, 180_000);
	client.send('initialized', {});
	const serverCaps = caps.capabilities ?? {};
	console.log('server capabilities: completion =', !!serverCaps.completionProvider, ', hover =', !!serverCaps.hoverProvider, ', rename =', !!serverCaps.renameProvider);

	client.send('textDocument/didOpen', {
		textDocument: { uri: `file:///${mainKt.replace(/\\/g, '/')}`, languageId: 'kotlin', version: 1, text: source },
	});
	await sleep(3000);
	client.send('textDocument/didSave', { textDocument: { uri: `file:///${mainKt.replace(/\\/g, '/')}` } });

	// Сервер прогревает компилятор: ждём первое событие диагностики до 150 секунд.
	console.log('waiting for diagnostics (compiler warm-up)…');
	const deadline = Date.now() + 150_000;
	while (!client.gotDiagnostics && Date.now() < deadline) { await sleep(2000); }
	console.log('diagnostics:', client.diagnostics.length ? JSON.stringify(client.diagnostics.map(d => `${d.range.start.line + 1}:${d.message}`)) : 'none (file compiled clean or empty batch)');

	// Автодополнение на `s.l` (строка 3, символ 7, 0-based) — тип String из classpath (stdlib).
	console.log('completion at `s.l`…');
	let items = null;
	for (let attempt = 0; attempt < 10 && (!items || !items.some(item => item.label === 'bar')); attempt++) {
		for (const character of [6, 7]) { // сразу после точки и после префикса l
			const result = await client.request('textDocument/completion', {
				textDocument: { uri: `file:///${mainKt.replace(/\\/g, '/')}` },
				position: { line: 2, character },
				context: character === 6 ? { triggerKind: 2, triggerCharacter: '.' } : { triggerKind: 1 },
			}, 60_000);
			const batch = Array.isArray(result) ? result : result?.items ?? [];
			if (batch.some(item => item.label === 'length')) { items = batch; break; }
			if (!items || batch.length > items.length) { items = batch; }
		}
		if (items?.some(item => item.label === 'length')) { break; }
		await sleep(4000); // ключевые слова = индекс/компиляция ещё не готовы
	}
	console.log(`completion items: ${items.length}`);
	console.log('sample:', items.slice(0, 6).map(item => item.label).join(', '));
	if (items.length === 0) { throw new Error('no completion items after `f.`'); }
	if (!items.some(item => item.label === 'length')) { throw new Error('property `length` not offered in completion'); }
	// Hover на `l` (строка 3, символ 7).

	// Hover на `bar` (строка 6, символ 7).
	const hover = await client.request('textDocument/hover', {
		textDocument: { uri: `file:///${mainKt.replace(/\\/g, '/')}` },			position: { line: 2, character: 7 },
		}, 60_000).catch(() => null);
	console.log('hover:', hover ? String(hover.contents?.value ?? '').split('\n')[0] : 'none');

	console.log('\nSMOKE TEST PASSED');
} catch (error) {
	failed = true;
	console.error('\nSMOKE TEST FAILED:', error.message ?? error);
} finally {
	try { client.send('shutdown', null); client.send('exit', null); } catch { /* ignore */ }
	server.kill();
	setTimeout(() => { rmSync(project, { recursive: true, force: true }); process.exit(failed ? 1 : 0); }, 1500);
}
