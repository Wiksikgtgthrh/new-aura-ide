/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — открытие исходников, на которые указывает Java Language Server.
 *
 *  jdtls принципиально не отдаёт обычные file-URI для классов из библиотек: переход к определению
 *  приходит как виртуальный URI вида
 *    jdt://contents/android.jar/android.widget/TextView.java?=aura-java/C:/…/android.jar<android.widget(TextView.class
 *  где в query зашит сам jar, а в path — путь исходника относительно прикреплённых исходников
 *  (именно поэтому важно, что sourcepath из javaSources.ts реально попал в .classpath).
 *
 *  VS Code не умеет открывать такие URI сам, поэтому расширение регистрирует для схемы `jdt`
 *  content provider: он читает исходник из каталога (platform sources) или прямо из sources-jar
 *  (своим zip-читателем) и отдаёт текст в редактор — переход, peek и navigation работают
 *  так же, как для обычных файлов.
 *-------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { tr } from './l10n';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readZipEntry } from './zipMember';
import { installedPlatformSources, platformApiOf } from './javaSources';
import { sdkRoot } from './classpath';

export const JDT_SCHEME = 'jdt';

export interface JdtTarget {
	/** Путь к jar (android.jar или развёрнутый classes.jar), на который ссылается URI. */
	jarPath: string;
	/** Путь исходника внутри прикреплённых исходников (`android/widget/TextView.java`). */
	sourceRelative: string;
}

/**
 * Разбор jdt-URI. Путь начинается с `contents/<имя-jar>/<пакет через точки>/<Файл>.java`,
 * jar — в query после `<проект>/`, до `<пакет(`.
 */
export function parseJdtUri(uri: vscode.Uri): JdtTarget | undefined {
	if (uri.scheme !== JDT_SCHEME) { return undefined; }
	const segments = uri.path.replace(/^\/+/, '').split('/').filter(segment => segment.length > 0);
	if (segments.length < 3 || segments[0] !== 'contents') { return undefined; }
	const jarPath = jarPathFromQuery(uri.query);
	if (!jarPath) { return undefined; }

	// Последний сегмент — имя файла, предыдущие — пакет, записанный через точки.
	const parts = segments.slice(2).map(segment => decodeSegment(segment));
	const file = parts.pop();
	if (!file) { return undefined; }
	const packagePath = parts.join('/').replace(/\./g, '/');
	return { jarPath, sourceRelative: [...(packagePath ? [packagePath] : []), file].join('/') };
}

function decodeSegment(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * Из query `=aura-java/C:/…/android.jar<android.widget(TextView.class` достаём путь к jar.
 * jdt процентно кодирует разделители Windows (`%5C`), поэтому query нужно декодировать.
 */
function jarPathFromQuery(query: string): string | undefined {
	if (!query) { return undefined; }
	const raw = query.startsWith('=') ? query.slice(1) : query;
	let body = raw;
	try {
		body = decodeURIComponent(raw);
	} catch { /* в пути есть недопустимая последовательность — используем как есть */ }
	const end = body.lastIndexOf('<');
	const trimmed = end >= 0 ? body.slice(0, end) : body;
	// Первый сегмент — имя Eclipse-проекта (наш shadow-проект), дальше абсолютный путь.
	const slash = trimmed.indexOf('/');
	const jarPath = slash < 0 ? '' : trimmed.slice(slash + 1);
	return jarPath ? path.normalize(jarPath) : undefined;
}

interface ClasspathAttachment { jar: string; source?: string }

const attachmentCache = new Map<string, { mtimeMs: number; entries: ClasspathAttachment[] }>();

/** Пары «jar → sourcepath» из .classpath shadow-проекта (кэш по mtime файла). */
export function classpathAttachments(projectDir: string): ClasspathAttachment[] {
	const file = path.join(projectDir, '.classpath');
	let mtimeMs = 0;
	try {
		mtimeMs = fs.statSync(file).mtimeMs;
	} catch {
		return [];
	}
	const cached = attachmentCache.get(file);
	if (cached && cached.mtimeMs === mtimeMs) { return cached.entries; }

	let text = '';
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		return [];
	}
	const entries: ClasspathAttachment[] = [];
	for (const match of text.matchAll(/<classpathentry\b([^>]*)\/?>/g)) {
		const attributes = match[1];
		const jar = /path="([^"]+)"/.exec(attributes)?.[1];
		if (!jar) { continue; }
		entries.push({ jar: path.normalize(jar), source: /sourcepath="([^"]+)"/.exec(attributes)?.[1] });
	}
	attachmentCache.set(file, { mtimeMs, entries });
	return entries;
}

function normalizeKey(value: string): string {
	const normalized = path.normalize(value);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Исходники для jar: сначала из .classpath (то, что мы прикрепили), затем — из установленного SDK. */
export function sourceAttachmentFor(projectDir: string | undefined, jarPath: string): string | undefined {
	if (projectDir) {
		const entries = classpathAttachments(projectDir);
		const wanted = normalizeKey(jarPath);
		const exact = entries.find(entry => normalizeKey(entry.jar) === wanted && entry.source);
		if (exact?.source) { return exact.source; }
		// Имя jar уникально среди записей — можно сопоставить по нему (пути jdt могут отличаться
		// разделителями или регистром диска).
		const sameName = entries.filter(entry => path.basename(entry.jar).toLowerCase() === path.basename(jarPath).toLowerCase() && entry.source);
		if (sameName.length === 1) { return sameName[0].source; }
	}
	const api = platformApiOf(jarPath);
	if (api !== undefined) { return installedPlatformSources(sdkRoot()).get(api); }
	return undefined;
}

/** Текст исходника, на который указывает jdt-URI. undefined — исходников нет. */
export function sourceContentFor(target: JdtTarget, attachment: string | undefined): string | undefined {
	if (!attachment) { return undefined; }
	// Исходники из каталога (platform sources): обычный файл на диске.
	const fromDisk = path.join(attachment, ...target.sourceRelative.split('/'));
	try {
		if (fs.statSync(fromDisk).isFile()) { return fs.readFileSync(fromDisk, 'utf8'); }
	} catch { /* не каталог или файла нет */ }
	// Исходники внутри sources-jar: читаем участника архива.
	const member = readZipEntry(attachment, target.sourceRelative);
	return member ? member.toString('utf8') : undefined;
}

/** Готовый текст для content provider (с понятным сообщением, если исходников нет). */
export function jdtSourceDocument(projectDir: string | undefined, uri: vscode.Uri): string | undefined {
	const target = parseJdtUri(uri);
	if (!target) { return undefined; }
	const attachment = sourceAttachmentFor(projectDir, target.jarPath);
	const content = sourceContentFor(target, attachment);
	if (content) { return content; }
	return `// ${tr('Sources for {0} are not attached. Run the command “Download sources for android.jar and libraries”.', target.sourceRelative)}\n`;
}

/** Регистрирует открытие jdt-URI: без этого переходы в android.jar и androidx не показывались бы. */
export function registerJdtContentProvider(context: vscode.ExtensionContext, projectDir: () => string | undefined): void {
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(JDT_SCHEME, {
		provideTextDocumentContent: (uri: vscode.Uri) => jdtSourceDocument(projectDir(), uri) ?? '',
	}));
}
