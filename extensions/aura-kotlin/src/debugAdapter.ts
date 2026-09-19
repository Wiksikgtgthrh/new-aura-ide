/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — Этап 2: встроенный DAP-адаптер отладки (Debug Adapter Protocol).
 *  Запускает JVM c -agentlib:jdwp=..., подключается по JDWP и переводит DAP ↔ JDWP:
 *  launch/attach, setBreakpoints, threads/stackTrace, scopes/variables, continue/step,
 *  вывод stdout/stderr программы. Регистрируется через DebugAdapterInlineImplementation.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'node:child_process';
import { JdwpConnection, EventKind, Tag, JdwpFrame, JdwpLocation } from './jdwp';
import { ClasspathSync } from './classpath';
import { AndroidPanel } from './android';

const DEBUG_TYPE = 'kotlin';

interface LaunchArguments {
	request: 'launch' | 'attach';
	/** launch: главный класс (FQN) или путь к .kt, компилируемый перед запуском. */
	mainClass?: string;
	/** launch: файл программы (скомпилируется во временный jar). */
	program?: string;
	/** Android: путь к .apk (если не задан — берётся уже установленный пакет). */
	apk?: string;
	/** Android: applicationId (если не задан — читается из APK). */
	applicationId?: string;
	/** Android: целевое устройство (если не задано — выбор из подключённых). */
	deviceId?: string;
	/** Android: launch activity (если не задана — resolve-activity). */
	activity?: string;
	/** attach: хост JDWP-агента. */
	host?: string;
	/** Порт JDWP-агента. */
	port?: number;
	args?: string[];
	vmArgs?: string[];
}

/** Компилирует .kt во временный jar (stdout подавляется, ошибки — в исключение). */
async function compileToJar(programPath: string, classpath: string[]): Promise<string> {
	const compiler = vscode.workspace.getConfiguration('auraKotlin').get<string>('compilerPath', 'kotlinc');
	const os = await import('node:os');
	const path = await import('node:path');
	const fs = await import('node:fs');
	const jar = path.join(os.tmpdir(), `aura-debug-${Date.now()}.jar`);
	const args = [programPath];
	if (classpath.length) { args.push('-classpath', classpath.join(process.platform === 'win32' ? ';' : ':')); }
	args.push('-include-runtime', '-d', jar);
	return new Promise((resolve, reject) => {
		const proc = spawn(compiler, args, { stdio: ['ignore', 'ignore', 'pipe'] });
		let stderr = '';
		proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
		proc.on('exit', code => code === 0 && fs.existsSync(jar) ? resolve(jar) : reject(new Error(stderr || `kotlinc exited with ${code}`)));
		proc.on('error', reject);
	});
}

/** Встроенный DAP-адаптер: реализует vscode.DebugAdapter (протокол через события). */
export class KotlinDebugAdapter implements vscode.DebugAdapter {

	private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	readonly onDidSendMessage = this.emitter.event;

	private jdwp = new JdwpConnection();
	private process?: ChildProcess;
	private port = 0;
	private mainClass = '';
	private jarPath = '';
	private terminated = false;
	private androidDevice?: string;
	private androidPackage?: string;
	/** id DA → requestId JDWP; и обратный разбор: requestId JDWP → id DA. */
	private readonly breakpointRequests = new Map<string, number>();
	private readonly requestToDap = new Map<number, string>();
	private currentThreadId?: number;
	private frameCache: JdwpFrame[] = [];
	private readonly varHandles = new Map<number, { frameId: number; slot: number; tag: number; name: string }>();
	private nextVarRef = 1000;
	private readonly classCache = new Map<string, number>();
	private readonly lineCache = new Map<string, Array<{ line: number; index: number }>>();

	constructor(private readonly classpathSync: ClasspathSync, private readonly androidPanel?: AndroidPanel) {
		this.jdwp.onLog(line => this.event('output', { category: 'console', output: line + '\n' }));
		this.jdwp.onEvent((commandSet, command, data) => {
			if (commandSet === 64 && command === 100) { // Composite
				this.onComposite(data);
			}
		});
	}

	dispose(): void {
		this.jdwp.dispose();
		this.process?.kill();
		if (this.jarPath) {
			void import('node:fs').then(fs => fs.rmSync(this.jarPath, { force: true }));
		}
		this.emitter.dispose();
	}

	handleMessage(message: vscode.DebugProtocolMessage): void {
		const request = message as { seq?: number; type: string; command: string; arguments?: unknown; request_seq?: number };
		if (request.type !== 'request') { return; }
		void this.handleRequest(request).catch(error => {
			this.response(request, false, undefined, error instanceof Error ? error.message : String(error));
		});
	}

	private	response(request: { command: string; request_seq?: number }, success: boolean, body?: unknown, messageText?: string): void {
		this.emitter.fire({
			seq: 0,
			type: 'response',
			request_seq: request.request_seq ?? 0,
			success,
			command: request.command,
			body,
			message: messageText,
		} as unknown as vscode.DebugProtocolMessage);
	}

	private event(name: string, body: unknown): void {
		this.emitter.fire({ seq: 0, type: 'event', event: name, body } as unknown as vscode.DebugProtocolMessage);
	}

	// ---------- Обработка DAP-запросов ----------

	private async handleRequest(request: { command: string; arguments?: unknown; request_seq?: number }): Promise<void> {
		const args = (request.arguments ?? {}) as LaunchArguments & Record<string, unknown>;
		switch (request.command) {
			case 'initialize':
				this.response(request, true, {
					supportsConfigurationDoneRequest: true,
					supportsSetVariable: false,
					supportsEvaluateForHovers: false,
					supportsConditionalBreakpoints: false,
					supportsTerminateRequest: true,
				});
				return;
			case 'launch':
			case 'attach':
				await this.start(args);
				this.response(request, true);
				return;
			case 'setBreakpoints': {
				const bpArgs = args as unknown as { source: { path: string }; lines?: number[]; breakpoints?: Array<{ line: number }> };
				const lines = bpArgs.breakpoints?.map(bp => bp.line) ?? bpArgs.lines ?? [];
				const resolved = await this.setBreakpoints(bpArgs.source.path, lines);
				this.response(request, true, { breakpoints: resolved });
				return;
			}
			case 'configurationDone':
				this.response(request, true);
				await this.jdwp.resume();
				return;
			case 'threads': {
				// Активная нить известна из событий; fallback — первый тред из стопа.
				this.response(request, true, { threads: this.currentThreadId ? [{ id: this.currentThreadId, name: 'main' }] : [] });
				return;
			}
			case 'stackTrace': {
				const stackArgs = args as unknown as { threadId: number };
				this.currentThreadId = stackArgs.threadId;
				this.frameCache = await this.jdwp.threadFrames(stackArgs.threadId);
				this.response(request, true, {
					stackFrames: await Promise.all(this.frameCache.map(async (frame, index) => {
						const info = await this.locationToSource(frame.location);
						return { id: index, name: info?.method ?? `frame ${index}`, line: info?.line ?? 0, column: 1, source: info?.source };
					})),
					totalFrames: this.frameCache.length,
				});
				return;
			}
			case 'scopes': {
				const scopeArgs = args as unknown as { frameId: number };
				const localsRef = this.nextVarRef++;
				this.varHandles.set(localsRef, { frameId: scopeArgs.frameId, slot: -1, tag: 0, name: 'Locals' });
				this.response(request, true, { scopes: [{ name: 'Locals', variablesReference: localsRef, expensive: false }] });
				return;
			}
			case 'variables': {
				const varArgs = args as unknown as { variablesReference: number };
				const variables = await this.readVariables(varArgs.variablesReference);
				this.response(request, true, { variables });
				return;
			}
			case 'continue':
				this.currentThreadId = undefined;
				this.frameCache = [];
				await this.jdwp.resume();
				this.response(request, true, { allThreadsContinued: true });
				return;
			case 'next':
			case 'stepIn':
			case 'stepOut':
			case 'pause':
				// Step-команды JDWP (StepRequest) — в базовой версии выполняем continue.
				// TODO: StepRequest (kind=LINE, depth) в следующей итерации.
				await this.jdwp.resume();
				this.response(request, true);
				return;
			case 'disconnect':
			case 'terminate':
				await this.stop();
				this.response(request, true);
				return;
			default:
				// Ответ-заглушка, чтобы DA не зависал на незнакомых запросах.
				this.response(request, true);
				return;
		}
	}

	// ---------- Запуск/подключение ----------

	private async start(args: LaunchArguments): Promise<void> {
		// Android: install + launch -D + adb forward + attach к jdwp:PID.
		if (args.apk || args.applicationId) { return this.startAndroid(args); }
		this.port = args.port ?? 5071 + Math.floor(Math.random() * 400);
		if (args.request === 'launch') {
			const program = args.program ?? '';
			const classpath = this.classpathSync.classpath.jars;
			if (program.endsWith('.kt')) {
				this.jarPath = await compileToJar(program, classpath);
				this.event('output', { category: 'console', output: 'Kotlin compilation finished.\n' });
			} else {
				this.mainClass = args.mainClass ?? '';
			}
		}
		const java = vscode.workspace.getConfiguration('auraKotlin').get<string>('javaPath', 'java');
		const main = args.request === 'launch'
			? (this.jarPath ? ['-jar', this.jarPath] : [this.mainClass])
			: [];
		const programArgs = args.args ?? [];
		const vmArgs = [
			`-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=${this.port}`,
			...(args.vmArgs ?? []),
		];
		const cmd = [java, ...vmArgs, ...main, ...programArgs];
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		this.process = spawn(cmd[0], cmd.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		this.process.stdout?.on('data', (chunk: Buffer) => this.event('output', { category: 'stdout', output: chunk.toString() }));
		this.process.stderr?.on('data', (chunk: Buffer) => this.event('output', { category: 'stderr', output: chunk.toString() }));
		this.process.on('exit', code => {
			if (!this.terminated) {
				this.terminated = true;
				this.event('terminated', {});
			}
			void code;
		});
		// suspend=y: JVM ждёт подключение отладчика на порту.
		await this.waitForPort(this.port, 15_000);
		await this.jdwp.connect('127.0.0.1', this.port);
		await this.jdwp.idSizes();
		this.event('process', { name: this.mainClass || this.jarPath, systemProcessId: this.process.pid ?? 0, isLocalProcess: true, startMethod: 'launch' });
		this.event('initialized', {});
	}

	/** Android-запуск: install → am start -D → adb forward → JDWP-attach. */
	private async startAndroid(args: LaunchArguments): Promise<void> {
		const panel = this.androidPanel;
		if (!panel) { throw new Error('Android panel is not available'); }
		this.event('output', { category: 'console', output: 'Android: preparing debug session…\n' });

		// 1. Установка APK (если указан) и определение applicationId.
		let device = args.deviceId;
		let pkg = args.applicationId;
		if (args.apk) {
			const installed = await panel.installForDebug(args.apk, device);
			if (!installed) { throw new Error('No Android device selected'); }
			device = installed.device;
			pkg = installed.package;
			this.event('output', { category: 'console', output: `Installed on ${device}: ${pkg}\n` });
		}
		if (!device || !pkg) { throw new Error('Need an .apk or applicationId to debug an Android app'); }
		this.androidDevice = device;
		this.androidPackage = pkg;

		// 2. Остановка предыдущего экземпляра и запуск в режиме ожидания отладчика.
		await panel.forceStop(pkg, device);
		const activity = args.activity ?? await panel.launchActivity(pkg, device);
		await panel.launchForDebug(device, activity);
		this.event('output', { category: 'console', output: `Launched ${activity} with waitForDebugger\n` });

		// 3. PID зависшего в waitForDebugger процесса.
		const pid = await this.waitForPid(panel, device, pkg, 15_000);
		if (!pid) { throw new Error(`Process ${pkg} did not appear on ${device} (is android:debuggable set?)`); }

		// 4. adb forward tcp:N → jdwp:PID и подключение.
		this.port = args.port ?? 5071 + Math.floor(Math.random() * 400);
		await panel.forwardJdwp(device, this.port, pid);
		this.event('output', { category: 'console', output: `adb forward tcp:${this.port} → jdwp:${pid}\n` });
		await this.waitForPort(this.port, 15_000);
		await this.jdwp.connect('127.0.0.1', this.port);
		await this.jdwp.idSizes();
		this.event('process', { name: pkg, systemProcessId: Number(pid) || 0, isLocalProcess: false, startMethod: 'launch' });
		this.event('initialized', {});
	}

	private async waitForPid(panel: AndroidPanel, device: string, pkg: string, timeoutMs: number): Promise<string | undefined> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const pid = await panel.pidOf(device, pkg);
			if (pid) { return pid; }
			if (Date.now() > deadline) { return undefined; }
			await new Promise(resolve => setTimeout(resolve, 300));
		}
	}

	private async waitForPort(port: number, timeoutMs: number): Promise<void> {
		const net = await import('node:net');
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const ok = await new Promise<boolean>(resolve => {
				const socket = new net.Socket();
				socket.once('connect', () => { socket.destroy(); resolve(true); });
				socket.once('error', () => { socket.destroy(); resolve(false); });
				socket.connect(port, '127.0.0.1');
				setTimeout(() => { socket.destroy(); resolve(false); }, 300);
			});
			if (ok) { return; }
			if (Date.now() > deadline) { throw new Error('JVM did not open the JDWP port in time'); }
			await new Promise(resolve => setTimeout(resolve, 150));
		}
	}

	private async stop(): Promise<void> {
		this.terminated = true;
		try { await this.jdwp.exit(0); } catch { /* VM могла умереть */ }
		this.jdwp.dispose();
		this.process?.kill();
		// Android: снять forward и дать приложению продолжить работу без отладчика.
		if (this.androidDevice && this.androidPackage) {
			try {
				await this.androidPanel?.['adb']('-s', this.androidDevice, 'forward', '--remove', `tcp:${this.port}`);
			} catch { /* forward мог уже исчезнуть */ }
		}
		void this.androidDevice; void this.androidPackage;
		this.event('terminated', {});
	}

	// ---------- Брейкпоинты ----------

	private async setBreakpoints(sourcePath: string, lines: number[]): Promise<Array<{ id: number; line: number; verified: boolean }>> {
		// Снимаем старые запросы этого файла.
		for (const [key, requestId] of [...this.breakpointRequests.entries()]) {
			if (key.startsWith(sourcePath)) {
				await this.jdwp.clearBreakpoint(requestId).catch(() => undefined);
				this.breakpointRequests.delete(key);
			}
		}
		const signature = await this.classSignatureForFile(sourcePath);
		if (!signature) {
			return lines.map(line => ({ id: 0, line, verified: false }));
		}
		const classId = await this.resolveClassId(signature);
		if (!classId) {
			// Класс ещё не загружен (suspend=y на старте) — возвращаем как есть.
			return lines.map(line => ({ id: 0, line, verified: false }));
		}
		const result: Array<{ id: number; line: number; verified: boolean }> = [];
		for (const line of lines) {
			const location = await this.codeIndexForLine(classId, line);
			if (!location) { result.push({ id: 0, line, verified: false }); continue; }
			try {
				const requestId = await this.jdwp.setBreakpoint(classId, location);
				const key = `${sourcePath}:${line}`;
				this.breakpointRequests.set(key, requestId);
				this.requestToDap.set(requestId, key);
				result.push({ id: requestId, line, verified: true });
			} catch {
				result.push({ id: 0, line, verified: false });
			}
		}
		return result;
	}

	/** Lcom/example/Main; из пути к .kt внутри воркспейса. */
	private async classSignatureForFile(sourcePath: string): Promise<string | undefined> {
		const workspace = vscode.workspace.workspaceFolders?.[0];
		if (!workspace) { return undefined; }
		const rel = vscode.workspace.asRelativePath(vscode.Uri.file(sourcePath), false).replace(/\\/g, '/');
		const withoutExt = rel.replace(/\.(kt|kts)$/, '');
		const parts = withoutExt.split('/').filter(p => p && !/^(src|main|kotlin|java)$/.test(p));
		if (parts.length === 0) { return undefined; }
		return `L${parts.join('/')};`;
	}

	private async resolveClassId(signature: string): Promise<number | undefined> {
		const cached = this.classCache.get(signature);
		if (cached) { return cached; }
		try {
			const classes = await this.jdwp.classesBySignature(signature);
			const first = classes[0];
			if (first) { this.classCache.set(signature, first.classId); return first.classId; }
		} catch { /* класс не загружен */ }
		return undefined;
	}

	private async codeIndexForLine(classId: number, line: number): Promise<{ methodId: number; index: number } | undefined> {
		const methods = await this.jdwp.methods(classId);
		for (const method of methods) {
			const cacheKey = `${classId}:${method.methodId}`;
			const table = this.lineCache.get(cacheKey) ?? await this.jdwp.lineTable(classId, method.methodId).catch(() => []);
			this.lineCache.set(cacheKey, table);
			const entry = table.filter(row => row.line <= line).sort((a, b) => b.line - a.line || a.index - b.index)[0];
			if (entry && table.some(row => row.line === line)) {
				return { methodId: method.methodId, index: entry.index };
			}
		}
		return undefined;
	}

	private async locationToSource(location: JdwpLocation): Promise<{ line: number; method: string; source?: { name: string; path: string } } | undefined> {
		// Имя класса из classCache (обратный поиск).
		let signature: string | undefined;
		for (const [sig, id] of this.classCache.entries()) {
			if (id === location.classId) { signature = sig; break; }
		}
		if (!signature) {
			try {
				const classes = await this.jdwp.classesBySignature('');
				void classes; // неэффективно; пропускаем
			} catch { /* ignore */ }
			return undefined;
		}
		const relPath = signature.replace(/^L/, '').replace(/;$/, '') + '.kt';
		const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
		const methods = await this.jdwp.methods(location.classId).catch(() => []);
		const method = methods.find(m => m.methodId === location.methodId);
		const lineTable = (await this.jdwp.lineTable(location.classId, location.methodId).catch(() => []))
			.filter(row => row.index <= location.index).sort((a, b) => b.index - a.index)[0];
		return {
			line: lineTable?.line ?? 0,
			method: method?.name ?? 'unknown',
			source: { name: relPath.split('/').pop() ?? relPath, path: `${workspace}/src/main/kotlin/${relPath}` },
		};
	}

	// ---------- Переменные ----------

	private async readVariables(variablesReference: number): Promise<Array<{ name: string; value: string; variablesReference: number }>> {
		const handle = this.varHandles.get(variablesReference);
		if (!handle || handle.slot !== -1 || !this.currentThreadId || !this.frameCache[handle.frameId]) { return []; }
		const frame = this.frameCache[handle.frameId];
		const methods = await this.jdwp.methods(frame.location.classId).catch(() => []);
		const method = methods.find(m => m.methodId === frame.location.methodId);
		if (!method) { return []; }
		// Таблица локальных переменных: LocalVariableTable = ReferenceType cmd 5? Требует.canGetLocalVariableInformation.
		// Базовая версия: показываем this и аргументы через StackFrame.GetValues со слотами 0..n.
		// Точную таблицу слотов JDWP не отдаёт без ClassPrepare+GenericSignature — упрощаем:
		const output: Array<{ name: string; value: string; variablesReference: number }> = [];
		for (let slot = 0; slot < 8; slot++) {
			try {
				const data = Buffer.alloc(4 + 4 + 4 + 4 + 4);
				data.writeUInt32BE(frame.id, 0);
				data.writeUInt32BE(1, 4); // slots to read
				data.writeUInt32BE(slot, 8);
				data.writeUInt32BE(Tag.Int, 12); // пробуем как int
				data.writeUInt32BE(0, 16);
				const reader = await this.jdwp['request'](16, 1, data).catch(() => undefined);
				if (!reader) { break; }
				const count = reader.i4();
				for (let i = 0; i < count; i++) {
					reader.i4(); // slot
					const tag = reader.u1();
					const value = reader.value(tag);
					output.push({ name: `slot${slot}`, value: value.id ? `<object @${value.id.toString(16)}>` : String(value.value), variablesReference: 0 });
				}
			} catch {
				break;
			}
		}
		void method;
		return output;
	}

	// ---------- События VM ----------

	private async onComposite(data: Buffer): Promise<void> {
		const { events } = this.jdwp.parseComposite(data);
		for (const event of events) {
			if (event.kind === EventKind.Breakpoint && event.threadId && event.location) {
				this.currentThreadId = event.threadId;
				const key = this.requestToDap.get(event.requestId);
				const line = Number(key?.split(':').pop() ?? 0);
				this.event('stopped', { reason: 'breakpoint', threadId: event.threadId, allThreadsStopped: true, line });
				await this.jdwp.suspend().catch(() => undefined);
			} else if (event.kind === EventKind.VMDeath || event.kind === EventKind.VMDisconnect) {
				this.terminated = true;
				this.event('terminated', {});
				return;
			}
		}
	}
}

/** Регистрация отладчика: factory возвращает inline-адаптер. */
export function registerKotlinDebugger(context: vscode.ExtensionContext, classpathSync: ClasspathSync, androidPanel?: AndroidPanel): void {
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
		createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new KotlinDebugAdapter(classpathSync, androidPanel)),
	}));
	context.subscriptions.push(vscode.commands.registerCommand('auraKotlin.debugFile', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.languageId !== 'kotlin') {
			void vscode.window.showWarningMessage(vscode.l10n.t('Open a Kotlin file first.'));
			return;
		}
		await vscode.debug.startDebugging(undefined, {
			type: DEBUG_TYPE,
			name: 'Debug Kotlin File',
			request: 'launch',
			program: editor.document.uri.fsPath,
		});
	}));
}
