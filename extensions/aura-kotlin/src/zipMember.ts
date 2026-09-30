/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — чтение одного файла из zip-архива (нужно для .aar: оттуда достаётся classes.jar).
 *  Своя реализация вместо внешних утилит: `tar` в Git-Bash — это GNU tar (zip не читает),
 *  PowerShell Expand-Archive отказывается от расширения .aar, unzip есть не на всех машинах.
 *  Поддерживается обычный zip (deflate/stored); zip64 — нет, про это сообщаем честно.
 *-------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

interface ZipEntry {
	name: string;
	method: number;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const ZIP64_MARKER = 0xffffffff;
/** Архивы больше этого размера не кэшируем в памяти (sources-jar обычно 0.1–2 МБ). */
const CACHE_LIMIT_BYTES = 16 * 1024 * 1024;

/** Кэш прочитанных архивов: sourcepath открывается многократно при переходах по коду. */
const archiveCache = new Map<string, { mtimeMs: number; buffer: Buffer }>();

function readArchive(zipPath: string): Buffer | undefined {
	let stats: fs.Stats;
	try {
		stats = fs.statSync(zipPath);
	} catch {
		return undefined;
	}
	if (stats.size > CACHE_LIMIT_BYTES) {
		try { return fs.readFileSync(zipPath); } catch { return undefined; }
	}
	const cached = archiveCache.get(zipPath);
	if (cached && cached.mtimeMs === stats.mtimeMs) { return cached.buffer; }
	try {
		const buffer = fs.readFileSync(zipPath);
		archiveCache.set(zipPath, { mtimeMs: stats.mtimeMs, buffer });
		return buffer;
	} catch {
		return undefined;
	}
}

/** Тело участника архива с учётом локального заголовка. */
function entryContent(buffer: Buffer, entry: ZipEntry): Buffer | undefined {
	const nameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
	const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
	const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
	if (dataStart + entry.compressedSize > buffer.length) { return undefined; }
	const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
	try {
		return entry.method === 0 ? raw : zlib.inflateRawSync(raw);
	} catch {
		return undefined;
	}
}

/**
 * Читает участника архива в память. Нужно для исходников внутри sources-jar:
 * их показывает редактор через content provider (см. javaUris.ts).
 */
export function readZipEntry(zipPath: string, memberName: string): Buffer | undefined {
	const buffer = readArchive(zipPath);
	if (!buffer) { return undefined; }
	const entry = readCentralDirectory(buffer)?.find(candidate => candidate.name === memberName);
	return entry ? entryContent(buffer, entry) : undefined;
}

/** Ищет End Of Central Directory: подпись в конце файла (комментарий архива ≤ 64 КБ). */
function findEndOfCentralDirectory(buffer: Buffer): number {
	const minOffset = Math.max(0, buffer.length - 65_557);
	for (let offset = buffer.length - 22; offset >= minOffset; offset--) {
		if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) { return offset; }
	}
	return -1;
}

/** Разбирает центральный каталог. Возвращает undefined, если архив zip64 или битый. */
function readCentralDirectory(buffer: Buffer): ZipEntry[] | undefined {
	const eocd = findEndOfCentralDirectory(buffer);
	if (eocd < 0) { return undefined; }
	const totalEntries = buffer.readUInt16LE(eocd + 10);
	const cdOffset = buffer.readUInt32LE(eocd + 16);
	if (cdOffset === ZIP64_MARKER || totalEntries === 0xffff) { return undefined; }

	const entries: ZipEntry[] = [];
	let offset = cdOffset;
	for (let index = 0; index < totalEntries; index++) {
		if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) { return undefined; }
		const method = buffer.readUInt16LE(offset + 10);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const uncompressedSize = buffer.readUInt32LE(offset + 24);
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const localHeaderOffset = buffer.readUInt32LE(offset + 42);
		const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
		if (compressedSize === ZIP64_MARKER || localHeaderOffset === ZIP64_MARKER) { return undefined; }
		entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
		offset += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

/** Имя участника безопасно для записи на диск (без «..» и абсолютных путей). */
function safeRelativePath(name: string): string | undefined {
	const normalized = name.replace(/\\/g, '/');
	if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) { return undefined; }
	const parts = normalized.split('/').filter(part => part.length > 0);
	if (!parts.length || parts.some(part => part === '..')) { return undefined; }
	return parts.join('/');
}

/**
 * Распаковывает zip целиком в destDir (нужно для исходников Android SDK, ~45 МБ).
 * Возвращает число записанных файлов; 0 и false — если архив не поддерживается (zip64).
 */
export function extractZipAll(zipPath: string, destDir: string, filter?: (name: string) => boolean): { files: number; ok: boolean } {
	let buffer: Buffer;
	try {
		buffer = fs.readFileSync(zipPath);
	} catch {
		return { files: 0, ok: false };
	}
	const entries = readCentralDirectory(buffer);
	if (!entries) { return { files: 0, ok: false }; }

	let files = 0;
	try {
		for (const entry of entries) {
			if (entry.name.endsWith('/')) { continue; }
			const relative = safeRelativePath(entry.name);
			if (!relative || (filter && !filter(relative))) { continue; }
			const nameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
			const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
			const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
			if (dataStart + entry.compressedSize > buffer.length) { return { files, ok: false }; }
			const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
			const content = entry.method === 0 ? raw : zlib.inflateRawSync(raw);
			const target = path.join(destDir, relative);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, content);
			files++;
		}
	} catch {
		return { files, ok: false };
	}
	return { files, ok: true };
}

/**
 * Извлекает участника zip в destPath. Возвращает false, если участника нет
 * или архив не поддерживается (zip64) — вызывающий код решает, что делать.
 */
export function extractZipMember(zipPath: string, memberName: string, destPath: string): boolean {
	const content = readZipEntry(zipPath, memberName);
	if (!content) { return false; }
	try {
		fs.mkdirSync(path.dirname(destPath), { recursive: true });
		fs.writeFileSync(destPath, content);
		return true;
	} catch {
		return false;
	}
}
