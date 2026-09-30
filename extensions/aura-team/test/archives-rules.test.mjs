/* Тесты правил архивов и разбора имени файла из заголовка сервера.
 * Обе функции вынесены в модули без зависимостей от vscode, поэтому грузятся напрямую. */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let checks = 0;
let failures = 0;
function check(name, fn) {
	checks++;
	try { fn(); } catch (error) { failures++; console.error('FAIL ' + name + '\n  ' + error.message); }
}
function ok(value, message) { assert.ok(value, message); }
function eq(actual, expected, message) { assert.equal(actual, expected, message ?? `expected ${expected}, got ${actual}`); }

/** Компилируем TS-модуль в CJS и выполняем в песочнице (как в других тестах набора). */
function loadModule(relativePath) {
	const source = readFileSync(join(root, relativePath), 'utf8');
	const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
	const sandbox = { module: { exports: {} }, exports: {}, require: () => { throw new Error('unexpected require'); } };
	sandbox.exports = sandbox.module.exports;
	vm.runInNewContext(out, sandbox, { filename: relativePath });
	return sandbox.module.exports;
}

const rules = loadModule('src/archives/rules.ts');
const disposition = loadModule('src/api/disposition.ts');

check('принимаем .zip и .rar в любом регистре', () => {
	for (const name of ['project.zip', 'PROJECT.RAR', 'a.b.zip', 'архив.zip']) { ok(rules.isArchiveName(name), `не принято: ${name}`); }
});

check('не принимаем прочие файлы', () => {
	for (const name of ['project.tar.gz', 'notes.txt', 'zip', 'project.zip.exe', '', undefined, null]) { ok(!rules.isArchiveName(name), `принято зря: ${String(name)}`); }
});

check('лимит печатается в человеческих единицах', () => {
	eq(rules.humanBytes(1024 * 1024 * 1024), '1 GiB');
	eq(rules.humanBytes(512 * 1024 * 1024), '512 MiB');
	eq(rules.humanBytes(2048), '2 KiB');
	eq(rules.humanBytes(0), '0 B');
});

check('имя для диалога сохраняет расширение из серверного имени', () => {
	eq(rules.suggestedArchiveName('Соцсети', 'архив.rar'), 'Соцсети.rar');
	eq(rules.suggestedArchiveName('Social services application', 'проект.zip'), 'Social services application.zip');
});

check('имя для диалога санитизирует запрещённые в путях символы', () => {
	eq(rules.suggestedArchiveName('a/b:c*d?e"f<g>h|i', 'x.zip'), 'a_b_c_d_e_f_g_h_i.zip');
	eq(rules.suggestedArchiveName('', 'fallback.rar'), 'fallback.rar');
	eq(rules.suggestedArchiveName(undefined, undefined), 'archive.zip');
});

check('RFC 5987: читаем filename* с кириллицей', () => {
	const header = `attachment; filename="proekt.zip"; filename*=UTF-8''${encodeURIComponent('Проект команды.zip')}`;
	eq(disposition.fileNameFromDisposition(header), 'Проект команды.zip');
});

check('RFC 5987: язык в filename* игнорируется', () => {
	const header = `attachment; filename*=UTF-8'en'${encodeURIComponent('report final.zip')}`;
	eq(disposition.fileNameFromDisposition(header), 'report final.zip');
});

check('фолбэк на простой filename', () => {
	eq(disposition.fileNameFromDisposition('attachment; filename="release.zip"'), 'release.zip');
	eq(disposition.fileNameFromDisposition('attachment; filename=release.zip'), 'release.zip');
});

check('без заголовка — фолбэк по умолчанию', () => {
	eq(disposition.fileNameFromDisposition(undefined), 'archive');
	eq(disposition.fileNameFromDisposition('', 'archive.zip'), 'archive.zip');
	eq(disposition.fileNameFromDisposition('attachment'), 'archive');
});

check('битый percent-encoding не роняет скачивание', () => {
	eq(disposition.fileNameFromDisposition(`attachment; filename*=UTF-8''%E0%A4%A`), 'archive');
});

check('имя не может съехать в путь', () => {
	eq(disposition.fileNameFromDisposition('attachment; filename="../../etc/passwd.zip"'), '.._.._etc_passwd.zip');
	eq(disposition.fileNameFromDisposition('attachment; filename="a\\b.zip"'), 'a_b.zip');
});

check('управляющие символы вырезаются', () => {
	eq(disposition.fileNameFromDisposition('attachment; filename="a\u0000b.zip"'), 'ab.zip');
});

check('очень длинное имя обрезается', () => {
	ok(disposition.fileNameFromDisposition('attachment; filename="' + 'x'.repeat(400) + '.zip"').length <= 180, 'имя не обрезано');
});

console.log(`${checks - failures}/${checks} проверок архивных правил`);
if (failures) { process.exit(1); }
