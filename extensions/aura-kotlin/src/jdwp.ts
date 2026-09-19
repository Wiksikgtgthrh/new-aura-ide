/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — Этап 2: отладка через Java Debug Wire Protocol (JDWP).
 *  Минимальный JDWP-клиент поверх net.Socket: handshake, пакетный протокол,
 *  VirtualMachine/EventRequest/StackFrame/ReferenceType команды, события брейкпоинтов.
 *  Используется встроенным DAP-адаптером (debugAdapter.ts).
 *--------------------------------------------------------------------------------------------*/

import { Socket } from 'node:net';

// ---------- Константы JDWP ----------

export const Handshake = 'JDWP-Handshake';

export const CommandSet = {
	VirtualMachine: 1,
	ReferenceType: 2,
	EventRequest: 15,
	StackFrame: 16,
	ThreadReference: 11,
} as const;

export const Command = {
	// VirtualMachine
	IDSizes: 7,
	Resume: 9,
	Suspend: 8,
	Exit: 10,
	ClassesBySignature: 2,
	// ReferenceType
	Methods: 4,
	Fields: 4,
	LineTable: 1,
	// EventRequest
	Set: 1,
	Clear: 2,
	ClearAllBreakpoints: 3,
	// StackFrame
	GetValues: 1,
	// ThreadReference
	Frames: 6,
	ThreadName: 1,
	ThreadSuspend: 2,
	ThreadResume: 3,
} as const;

export const EventKind = {
	Breakpoint: 2,
	Step: 1,
	ClassPrepare: 8,
	VMDeath: 10,
	VMDisconnect: 11,
	Exception: 4,
} as const;

export const SuspendPolicy = { None: 0, EventThread: 1, All: 2 } as const;

export const Tag = {
	Array: 91, Byte: 66, Char: 67, Object: 76, Float: 70, Double: 68,
	Int: 73, Long: 74, Short: 83, Void: 86, Boolean: 90, String: 115,
} as const;

// ---------- Типы ----------

export interface JdwpLocation { typeTag: number; classId: number; methodId: number; index: number }
export interface JdwpBreakpointEvent { requestId: number; threadId: number; location: JdwpLocation }
export interface JdwpFrame { id: number; location: JdwpLocation }
export interface JdwpMethod { methodId: number; name: string; signature: string }
export interface JdwpValue { tag: number; value: number | string | boolean | null; /** для строк: stringId */ id?: number }
export interface JdwpVariable { slot: number; name: string; signature: string; tag: number }
export interface JdwpClassInfo { classId: number; signature: string }

interface PendingRequest { resolve: (data: JdwpReader) => void; reject: (error: Error) => void }

/** Построчное чтение буфера JDWP-ответа. */
export class JdwpReader {
	private offset = 0;
	constructor(private readonly buffer: Buffer) { }

	u1(): number { return this.buffer.readUInt8(this.offset++); }
	u4(): number { const value = this.buffer.readUInt32BE(this.offset); this.offset += 4; return value; }
	i4(): number { const value = this.buffer.readInt32BE(this.offset); this.offset += 4; return value; }
	i8(): bigint { const value = this.buffer.readBigInt64BE(this.offset); this.offset += 8; return value; }
	/** ID (4 байта в наших IDSizes). */
	id(): number { return this.u4(); }
	string(): string {
		const length = this.u4();
		const value = this.buffer.toString('utf8', this.offset, this.offset + length);
		this.offset += length;
		return value;
	}
	value(tag: number): JdwpValue {
		switch (tag) {
			case Tag.String: {
				const id = this.id();
				return { tag, value: null, id }; // значение читается отдельно через String()
			}
			case Tag.Boolean: return { tag, value: this.u1() !== 0 };
			case Tag.Byte: return { tag, value: this.u1() };
			case Tag.Char: return { tag, value: String.fromCharCode(this.u1()) };
			case Tag.Int: case Tag.Float: return { tag, value: this.i4() };
			case Tag.Long: case Tag.Double: return { tag, value: Number(this.i8()) };
			case Tag.Object: case Tag.Array: return { tag, value: null, id: this.id() };
			case Tag.Void: default: return { tag, value: null };
		}
	}
}

/** Клиент JDWP: соединение, пакетный обмен, подписка на события. */
export class JdwpConnection {
	private socket?: Socket;
	private buffer = Buffer.alloc(0);
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private sizes = { fieldIdSize: 4, methodIdSize: 4, objectIdSize: 4, referenceTypeIdSize: 4, frameIdSize: 4 };
	private readonly eventHandlers = new Set<(commandSet: number, command: number, data: Buffer) => void>();
	private logHandler: (line: string) => void = () => { };
	onLog(handler: (line: string) => void): void { this.logHandler = handler; }
	private log(line: string): void { this.logHandler(line); }

	async connect(host: string, port: number, timeoutMs = 10_000): Promise<void> {
		return new Promise((resolve, reject) => {
			const socket = new Socket();
			const timer = setTimeout(() => { socket.destroy(); reject(new Error(`JDWP connect timeout (${host}:${port})`)); }, timeoutMs);
			socket.connect(port, host, () => {
				// Handshake: отправляем строку, ждём её же в ответ.
				socket.write(Handshake);
			});
			let handshakeBuffer = Buffer.alloc(0);
			const handshake = Buffer.from(Handshake, 'ascii');
			const onData = (chunk: Buffer): void => {
				if (handshakeBuffer.length < handshake.length) {
					handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
					if (handshakeBuffer.length >= handshake.length) {
						if (!handshakeBuffer.subarray(0, handshake.length).equals(handshake)) {
							clearTimeout(timer);
							socket.destroy();
							reject(new Error('JDWP handshake failed'));
							return;
						}
						socket.removeListener('data', onData);
						socket.on('data', chunk2 => this.onData(chunk2));
						clearTimeout(timer);
						this.socket = socket;
						socket.on('error', error => this.log(`[jdwp] socket error: ${error.message}`));
						socket.on('close', () => { this.socket = undefined; });
						resolve();
					} else if (chunk.length > handshake.length || !handshake.subarray(0, chunk.length).equals(handshakeBuffer)) {
						clearTimeout(timer);
						socket.destroy();
						reject(new Error('JDWP handshake failed'));
					}
				}
			};
			socket.on('data', onData);
			socket.on('error', error => { clearTimeout(timer); reject(error); });
		});
	}

	dispose(): void {
		for (const pending of this.pending.values()) { pending.reject(new Error('JDWP connection closed')); }
		this.pending.clear();
		this.eventHandlers.clear();
		this.socket?.destroy();
		this.socket = undefined;
	}

	get connected(): boolean { return !!this.socket && !this.socket.destroyed; }

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			if (this.buffer.length < 11) { return; }
			const length = this.buffer.readUInt32BE(0);
			if (this.buffer.length < length) { return; }
			const id = this.buffer.readUInt32BE(4);
			const flags = this.buffer.readUInt8(8);
			const commandSet = this.buffer.readUInt8(9);
			const command = this.buffer.readUInt8(10);
			const data = this.buffer.subarray(11, length);
			this.buffer = this.buffer.subarray(length);
			if (flags & 0x80) {
				// Событие (команда от VM): уведомляем подписчиков.
				for (const handler of this.eventHandlers) { handler(commandSet, command, data); }
			} else {
				const error = this.buffer.readUInt16BE(11 + 0); // error code внутри data? нет: код ошибки — первые 2 байта data
				const pending = this.pending.get(id);
				if (!pending) { continue; }
				this.pending.delete(id);
				if (error !== 0) { pending.reject(new Error(`JDWP error ${error} (set ${commandSet}, cmd ${command})`)); }
				else { pending.resolve(new JdwpReader(data.subarray(2))); }
			}
		}
	}

	private send(commandSet: number, command: number, data: Buffer): number {
		if (!this.socket) { throw new Error('JDWP not connected'); }
		const id = this.nextId++;
		const header = Buffer.alloc(11);
		header.writeUInt32BE(11 + data.length, 0);
		header.writeUInt32BE(id, 4);
		header.writeUInt8(0, 8); // flags: request
		header.writeUInt8(commandSet, 9);
		header.writeUInt8(command, 10);
		this.socket.write(Buffer.concat([header, data]));
		return id;
	}

	private request(commandSet: number, command: number, data: Buffer = Buffer.alloc(0)): Promise<JdwpReader> {
		const id = this.send(commandSet, command, data);
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			setTimeout(() => {
				if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`JDWP request timeout (set ${commandSet}, cmd ${command})`)); }
			}, 10_000);
		});
	}

	// ---------- VirtualMachine ----------

	async idSizes(): Promise<void> {
		const reader = await this.request(CommandSet.VirtualMachine, Command.IDSizes);
		this.sizes = { fieldIdSize: reader.i4(), methodIdSize: reader.i4(), objectIdSize: reader.i4(), referenceTypeIdSize: reader.i4(), frameIdSize: reader.i4() };
		this.log(`[jdwp] idSizes: ${JSON.stringify(this.sizes)}`);
	}

	suspend(): Promise<JdwpReader> { return this.request(CommandSet.VirtualMachine, Command.Suspend); }
	resume(): Promise<JdwpReader> { return this.request(CommandSet.VirtualMachine, Command.Resume); }
	exit(exitCode = 0): Promise<JdwpReader> {
		const data = Buffer.alloc(4);
		data.writeInt32BE(exitCode, 0);
		return this.request(CommandSet.VirtualMachine, Command.Exit, data);
	}

	/** Классы по сигнатуре, напр. Lcom/example/Main;. */
	async classesBySignature(signature: string): Promise<JdwpClassInfo[]> {
		const sigBuffer = Buffer.alloc(4 + signature.length);
		sigBuffer.writeInt32BE(signature.length, 0);
		sigBuffer.write(signature, 4, 'ascii');
		const reader = await this.request(CommandSet.VirtualMachine, Command.ClassesBySignature, sigBuffer);
		const count = reader.i4();
		const result: JdwpClassInfo[] = [];
		for (let i = 0; i < count; i++) {
			const typeTag = reader.u1();
			const classId = reader.id();
			const status = reader.i4();
			result.push({ classId, signature: reader.string() });
			void typeTag; void status;
		}
		return result;
	}

	// ---------- ReferenceType ----------

	async methods(classId: number): Promise<JdwpMethod[]> {
		const data = Buffer.alloc(4);
		data.writeUInt32BE(classId, 0);
		const reader = await this.request(CommandSet.ReferenceType, Command.Methods, data);
		const count = reader.i4();
		const result: JdwpMethod[] = [];
		for (let i = 0; i < count; i++) {
			result.push({ methodId: reader.id(), name: reader.string(), signature: reader.string() });
		}
		return result;
	}

	/** Таблица строк байткода метода: codeIndex → line. */
	async lineTable(classId: number, methodId: number): Promise<Array<{ line: number; index: number }>> {
		const data = Buffer.alloc(12);
		data.writeUInt32BE(classId, 0);
		data.writeUInt32BE(classId, 4);
		data.writeUInt32BE(methodId, 8);
		const reader = await this.request(CommandSet.ReferenceType, Command.LineTable, data);
		reader.i8(); // start
		reader.i8(); // end
		const count = reader.i4();
		const lines: Array<{ line: number; index: number }> = [];
		for (let i = 0; i < count; i++) {
			lines.push({ index: Number(reader.i8()), line: reader.i4() });
		}
		return lines;
	}

	// ---------- EventRequest ----------

	/** Установить брейкпоинт: kind=Breakpoint, location (classId, methodId, codeIndex). */
	async setBreakpoint(classId: number, location: { methodId: number; index: number }): Promise<number> {
		const data = Buffer.alloc(1 + 1 + 4 + 1 + 4 + 8);
		let offset = 0;
		data.writeUInt8(SuspendPolicy.EventThread, offset); offset += 1;
		data.writeUInt8(EventKind.Breakpoint, offset); offset += 1;
		data.writeUInt32BE(0, offset); offset += 4; // modifiers = 0? нет: modifiers идёт ДО spec
		// Корректный формат: suspendPolicy(1) + eventKind(1) + modifierCount(4) + mod(k) + location
		const packet = Buffer.alloc(1 + 1 + 4 + 1 + 4 + 8);
		packet.writeUInt8(SuspendPolicy.EventThread, 0);
		packet.writeUInt8(EventKind.Breakpoint, 1);
		packet.writeUInt32BE(1, 4); // один модификатор: LocationOnly
		packet.writeUInt8(1, 8); // модификатор LocationOnly
		packet.writeUInt8(1, 9); // typeTag CLASS
		packet.writeUInt32BE(classId, 10);
		packet.writeUInt32BE(location.methodId, 14);
		packet.writeBigUInt64BE(BigInt(location.index), 18);
		void data;
		const reader = await this.request(CommandSet.EventRequest, Command.Set, packet);
		return reader.id();
	}

	clearBreakpoint(requestId: number): Promise<JdwpReader> {
		const data = Buffer.alloc(5);
		data.writeUInt8(EventKind.Breakpoint, 0);
		data.writeUInt32BE(requestId, 1);
		return this.request(CommandSet.EventRequest, Command.Clear, data);
	}

	async clearAllBreakpoints(): Promise<void> {
		const data = Buffer.alloc(1);
		data.writeUInt8(EventKind.Breakpoint, 0);
		await this.request(CommandSet.EventRequest, Command.ClearAllBreakpoints, data);
	}

	// ---------- ThreadReference ----------

	async threadFrames(threadId: number, startFrame = 0, length = 50): Promise<JdwpFrame[]> {
		const data = Buffer.alloc(12);
		data.writeUInt32BE(threadId, 0);
		data.writeInt32BE(startFrame, 4);
		data.writeInt32BE(length, 8);
		const reader = await this.request(CommandSet.ThreadReference, Command.Frames, data);
		const count = reader.i4();
		const frames: JdwpFrame[] = [];
		for (let i = 0; i < count; i++) {
			frames.push({ id: reader.id(), location: { typeTag: reader.u1(), classId: reader.id(), methodId: reader.id(), index: Number(reader.i8()) } });
		}
		return frames;
	}

	// ---------- События ----------

	onEvent(handler: (commandSet: number, command: number, data: Buffer) => void): void {
		this.eventHandlers.add(handler);
	}

	/** Разбор составного события (Composite = set 0x40, cmd 100). */
	parseComposite(data: Buffer): { events: Array<{ kind: number; requestId: number; threadId?: number; location?: JdwpLocation }> } {
		const reader = new JdwpReader(data);
		const suspendPolicy = reader.u1();
		void suspendPolicy;
		const count = reader.i4();
		const events: Array<{ kind: number; requestId: number; threadId?: number; location?: JdwpLocation }> = [];
		for (let i = 0; i < count; i++) {
			const kind = reader.u1();
			const requestId = reader.id();
			if (kind === EventKind.Breakpoint || kind === EventKind.Step || kind === EventKind.Exception) {
				const threadId = reader.id();
				const location = { typeTag: reader.u1(), classId: reader.id(), methodId: reader.id(), index: Number(reader.i8()) };
				events.push({ kind, requestId, threadId, location });
			} else {
				events.push({ kind, requestId });
			}
		}
		return { events };
	}

	/** Значение строки по stringId. */
	async string(stringId: number): Promise<string> {
		// VirtualMachine.String = cmd 1? нет: StringReference.Value = set 10, cmd 1.
		const data = Buffer.alloc(4);
		data.writeUInt32BE(stringId, 0);
		const reader = await this.request(10, 1, data);
		return reader.string();
	}
}
