/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — shadow-проект для Java Language Server.
 *
 *  jdtls (Eclipse JDT) работает по модели Eclipse-проекта: ему нужны .project/.classpath рядом
 *  с исходниками. Чтобы НЕ мусорить в репозитории пользователя (в отличие от redhat.java,
 *  который пишет .classpath прямо в проект), метаданные создаются в globalStorage, а исходники
 *  подключаются linked-папками: Eclipse разрешает их по реальному пути, поэтому диагностика и
 *  переходы указывают на настоящие файлы.
 *
 *  Classpath берём из уже посчитанного резолва Gradle (этап 1 ТЗ). Особенность Android:
 *  большинство зависимостей — это .aar, который Eclipse не понимает, поэтому из каждого .aar
 *  достаётся classes.jar (своим zip-читателем, без внешних утилит).
 *-------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractZipMember } from './zipMember';

export interface JavaProjectSource { readonly dir: string; }

export interface JavaProjectResult {
	/** Каталог shadow-проекта: внутри .project и .classpath. */
	projectDir: string;
	/** Файлы, попавшие в classpath (jar + развёрнутые classes.jar). */
	jars: string[];
	/** Каталоги исходников, подключённые linked-папками. */
	sourceDirs: string[];
	/** Развёрнуто .aar (classes.jar). */
	exploded: number;
	/** Пропущенные .aar: zips, которые наш читатель не осилил. */
	skipped: string[];
	/** Сколько jar-ов получило исходники (sourcepath). */
	sourced: number;
}

/** Каталоги исходников внутри модуля Gradle (только те, что реально есть). */
const MODULE_SOURCE_DIRS = [
	'src/main/java',
	'src/debug/java',
	'src/release/java',
	'src/test/java',
	'src/androidTest/java',
];

/** Генерируемые AGP файлы, на которые ссылается Java-код. */
const GENERATED_MARKERS = ['R.java', 'BuildConfig.java'];

function exists(value: string): boolean {
	try {
		return fs.existsSync(value);
	} catch {
		return false;
	}
}

function hashString(value: string): string {
	let hash = 0;
	for (let index = 0; index < value.length; index++) {
		hash = (hash * 31 + value.charCodeAt(index)) | 0;
	}
	return (hash >>> 0).toString(36);
}

/**
 * Ищет каталоги сгенерированных исходников (R.java / BuildConfig.java), которые создаёт AGP.
 * Глубина ограничена, `build/intermediates` пропускается — там десятки тысяч файлов.
 */
function generatedSourceDirs(moduleDir: string, limit = 6): string[] {
	const found: string[] = [];
	const pending: Array<{ dir: string; depth: number }> = [{ dir: path.join(moduleDir, 'build', 'generated'), depth: 0 }];
	while (pending.length && found.length < limit) {
		const current = pending.shift()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current.dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(current.dir, entry.name);
			if (entry.isDirectory()) {
				if (current.depth < 6 && entry.name !== 'intermediates' && entry.name !== 'tmp') {
					pending.push({ dir: full, depth: current.depth + 1 });
				}
				continue;
			}
			if (GENERATED_MARKERS.includes(entry.name) && !found.includes(current.dir)) {
				found.push(current.dir);
			}
		}
	}
	return found;
}

/** Разворачивает classes.jar из .aar в кэш. Повторный вызов использует готовый файл. */
function explodeAar(aarPath: string, cacheDir: string): string | undefined {
	let mtime = 0;
	try {
		mtime = fs.statSync(aarPath).mtimeMs;
	} catch {
		return undefined;
	}
	const target = path.join(cacheDir, `${path.basename(aarPath, '.aar')}-${hashString(`${aarPath}:${mtime}`)}`, 'classes.jar');
	if (exists(target)) { return target; }
	return extractZipMember(aarPath, 'classes.jar', target) ? target : undefined;
}

export interface PrepareJavaProjectOptions {
	/** Резолвнутый classpath проекта (из Gradle). */
	jars: string[];
	/** Каталоги модулей Gradle. */
	moduleDirs: string[];
	/** Корень воркспейса (для ключа каталога). */
	workspaceRoot: string;
	/** Исходники библиотек: запись classpath → каталог дерева исходников или sources-jar. */
	sources?: Map<string, string>;
}

/**
 * Готовит shadow-проект и возвращает его описание. Повторные вызовы с тем же classpath
 * не перезаписывают .project/.classpath, чтобы Eclipse не переимпортировал проект зря.
 */
export function prepareJavaProject(context: vscode.ExtensionContext, options: PrepareJavaProjectOptions): JavaProjectResult {
	const storage = context.globalStorageUri.fsPath;
	const projectDir = path.join(storage, 'java', 'project', `${path.basename(options.workspaceRoot).replace(/[^\w.-]/g, '_')}-${hashString(options.workspaceRoot)}`);
	const aarCache = path.join(storage, 'java', 'aar');
	fs.mkdirSync(projectDir, { recursive: true });
	fs.mkdirSync(aarCache, { recursive: true });

	// 1. Classpath: jar-ы как есть, из .aar достаём classes.jar. Исходники (sourcepath)
	//    подключаем здесь же: без них JDT не уходит в определение по android.jar и androidx.
	const jars: string[] = [];
	const sourceFor = new Map<string, string>();
	const attach = (jar: string, original: string): void => {
		jars.push(jar);
		const source = options.sources?.get(original);
		if (source && exists(source)) { sourceFor.set(jar, source); }
	};
	const skipped: string[] = [];
	let exploded = 0;
	for (const entry of options.jars) {
		const extension = path.extname(entry).toLowerCase();
		if (extension === '.jar') {
			if (exists(entry)) { attach(entry, entry); }
			continue;
		}
		if (extension === '.aar') {
			const classes = explodeAar(entry, aarCache);
			if (classes) { attach(classes, entry); exploded++; } else { skipped.push(path.basename(entry)); }
			continue;
		}
		// .klib, .so и прочее Eclipse не поймёт — пропускаем.
	}

	// 2. Исходники: явные каталоги модулей + сгенерированные AGP.
	const sourceDirs: string[] = [];
	for (const moduleDir of options.moduleDirs) {
		for (const relative of MODULE_SOURCE_DIRS) {
			const dir = path.join(moduleDir, relative);
			if (exists(dir) && !sourceDirs.includes(dir)) { sourceDirs.push(dir); }
		}
		for (const generated of generatedSourceDirs(moduleDir)) {
			if (!sourceDirs.includes(generated)) { sourceDirs.push(generated); }
		}
	}
	if (!sourceDirs.length) {
		const fallback = path.join(options.workspaceRoot, 'src', 'main', 'java');
		if (exists(fallback)) { sourceDirs.push(fallback); }
	}

	// 3. Метаданные Eclipse: linked-папки дают доступ к реальным файлам, не копируя их.
	const signature = hashString([...jars, ...sourceDirs, ...[...sourceFor].map(([jar, source]) => `${jar}→${source}`)].join('|'));
	const signatureFile = path.join(projectDir, '.aura-signature');
	if (!exists(signatureFile) || fs.readFileSync(signatureFile, 'utf8') !== signature) {
		// Пути внутри metadata Eclipse должны быть URI-подобными («C:/…»), иначе linked-ресурс
		// не разрешается и файлы считаются чужими («non-project file»).
		const links = sourceDirs.map((dir, index) => `\t\t<link><name>src-${index}</name><type>2</type><location>${xmlEscape(slash(dir))}</location></link>`).join('\n');
		fs.writeFileSync(path.join(projectDir, '.project'), `<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
\t<name>aura-java</name>
\t<comment>Aura IDE: shadow-проект для Java Language Server</comment>
\t<projects></projects>
\t<buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments></arguments></buildCommand></buildSpec>
\t<natures><nature>org.eclipse.jdt.core.javanature</nature></natures>
\t<linkedResources>
${links}
\t</linkedResources>
</projectDescription>
`, 'utf8');

		const sourceEntries = sourceDirs.map((_, index) => `\t<classpathentry kind="src" path="src-${index}"/>`).join('\n');
		const libEntries = jars.map(jar => {
			const source = sourceFor.get(jar);
			const attachment = source ? ` sourcepath="${xmlEscape(slash(source))}"` : '';
			return `\t<classpathentry kind="lib" path="${xmlEscape(slash(jar))}"${attachment}/>`;
		}).join('\n');
		fs.writeFileSync(path.join(projectDir, '.classpath'), `<?xml version="1.0" encoding="UTF-8"?>
<classpath>
${sourceEntries}
\t<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>
${libEntries}
\t<classpathentry kind="output" path="bin"/>
</classpath>
`, 'utf8');
		fs.writeFileSync(signatureFile, signature, 'utf8');
	}

	return { projectDir, jars, sourceDirs, exploded, skipped, sourced: sourceFor.size };
}

/** Прямые слэши: Eclipse разбирает эти пути как URI, а не как пути Windows. */
function slash(value: string): string {
	return value.replace(/\\/g, '/');
}

function xmlEscape(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
