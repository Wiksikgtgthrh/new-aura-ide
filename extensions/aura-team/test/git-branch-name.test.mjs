/* Тесты правил имён веток и разбора ссылки на задачу в сообщении коммита. */
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
const eq = (actual, expected, message) => assert.equal(actual, expected, message ?? `expected ${expected}, got ${actual}`);
const ok = (value, message) => assert.ok(value, message);

const source = readFileSync(join(root, 'src/git/branchName.ts'), 'utf8');
const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const sandbox = { module: { exports: {} }, exports: {}, require: () => { throw new Error('unexpected require'); } };
sandbox.exports = sandbox.module.exports;
vm.runInNewContext(out, sandbox, { filename: 'branchName.ts' });
const { branchNameForTask, slugifyTaskTitle, taskRefInMessage } = sandbox.module.exports;

check('слаг транслитерирует кириллицу', () => {
	eq(slugifyTaskTitle('Собрать шаги релиза'), 'sobrat-shagi-reliza');
	eq(slugifyTaskTitle('Ёжик и щука'), 'ezhik-i-schuka');
});

check('слаг чистит мусор и не оставляет дефисов по краям', () => {
	eq(slugifyTaskTitle('  Фикс: импорт (ключей)!!  '), 'fiks-import-klyuchey');
	eq(slugifyTaskTitle('---'), '');
	eq(slugifyTaskTitle(''), '');
	eq(slugifyTaskTitle(undefined), '');
});

check('слаг обрезается до 40 символов без хвостового дефиса', () => {
	const slug = slugifyTaskTitle('Очень длинное название задачи которое явно не поместится в имя ветки целиком');
	ok(slug.length <= 40, `длина ${slug.length}`);
	ok(!slug.endsWith('-'), 'хвостовой дефис');
});

check('ветка начинается с task/ и несёт короткий id', () => {
	eq(branchNameForTask('29d49eaf-1111-2222-3333-444455556666', 'Собрать шаги'), 'task/29d49eaf-sobrat-shagi');
});

check('без заголовка ветка — только id', () => {
	eq(branchNameForTask('29d49eaf-1111'), 'task/29d49eaf');
	eq(branchNameForTask('', ''), 'task/task');
});

check('имя ветки проходит проверку git-сервиса', () => {
	for (const name of [
		branchNameForTask('29d49eaf-1111', 'Собрать шаги релиза'),
		branchNameForTask('abcdef01', 'fix: баг (срочно)'),
		branchNameForTask('12345678', 'кириллица без транслита не пройдёт')
	]) {
		ok(/^[\w.\-/]{1,80}$/.test(name), `не прошло проверку: ${name}`);
	}
});

check('две задачи с одинаковым названием дают разные ветки', () => {
	ok(branchNameForTask('aaaaaaaa-1', 'Правка') !== branchNameForTask('bbbbbbbb-1', 'Правка'));
});

check('ссылка на задачу читается из сообщения коммита', () => {
	eq(taskRefInMessage('feat: собрать шаги #29d49eaf'), '29d49eaf');
	eq(taskRefInMessage('#abcdef'), 'abcdef');
});

check('сообщение без ссылки не даёт задачу', () => {
	eq(taskRefInMessage('просто коммит'), undefined);
	eq(taskRefInMessage('много #слов но не hex'), undefined);
	eq(taskRefInMessage(''), undefined);
	eq(taskRefInMessage(undefined), undefined);
});

check('слишком короткий хеш не считается ссылкой', () => {
	eq(taskRefInMessage('#abc'), undefined);
});

console.log(`${checks - failures}/${checks} проверок имён веток`);
if (failures) { process.exit(1); }
