/*---------------------------------------------------------------------------------------------
 *  Сквозная проверка кнопок: каждая команда, которую зовёт интерфейс (вкладка плагина
 *  и вебвью сайдбара), должна быть зарегистрирована в расширении.
 *  Жалоба «кнопки вроде не все работают» ловится здесь статически, без запуска IDE:
 *  вызов несуществующей команды в вебвью гасится в catch, поэтому глазами такой
 *  разрыв не видно — кнопка просто ничего не делает.
 *--------------------------------------------------------------------------------------------*/
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = (relative) => readFileSync(join(here, '..', relative), 'utf8');

const template = source('src/webview/template.html');
const extension = source('src/extension.ts');

let failures = 0;
const check = (name, ok, detail) => {
	console.log((ok ? '  ok   ' : '  FAIL ') + name);
	if (!ok) { failures++; if (detail?.length) { console.log('       ' + detail.join(', ')); } }
};

const collect = (text, pattern) => {
	const found = new Set();
	for (const match of text.matchAll(pattern)) { found.add(match[1]); }
	return found;
};

const invokedTemplate = collect(template, /svc\('(auraTeam\.[A-Za-z0-9_]+)'/g);
const invokedSidebar = collect(extension, /command: '(auraTeam\.[A-Za-z0-9_]+)'/g);
const invokedAll = new Set([...invokedTemplate, ...invokedSidebar]);

const registered = new Set([
	...collect(extension, /register\('(auraTeam\.[A-Za-z0-9_]+)'/g),
	...collect(extension, /registerCommand\('(auraTeam\.[A-Za-z0-9_]+)'/g),
]);

/* ---------- 1. Вкладка плагина ---------- */
const missingTemplate = [...invokedTemplate].filter(id => !registered.has(id)).sort();
check(`все команды вкладки зарегистрированы (${invokedTemplate.size})`, missingTemplate.length === 0, missingTemplate);

/* ---------- 2. Сайдбар ---------- */
const missingSidebar = [...invokedSidebar].filter(id => !registered.has(id)).sort();
check(`все команды сайдбара зарегистрированы (${invokedSidebar.size})`, missingSidebar.length === 0, missingSidebar);

/* ---------- 3. Демо-ветка не может быть единственным местом, где команда живёт ---------- */
const demoOnly = [...collect(extension, /id === '(auraTeam\.[A-Za-z0-9_]+)'/g)].filter(id => !registered.has(id)).sort();
check('демо-ветка не подменяет реальные команды', demoOnly.length === 0, demoOnly);

/* ---------- 4. Команда не регистрируется дважды ---------- */
const registrationLines = [...extension.matchAll(/register\('(auraTeam\.[A-Za-z0-9_]+)'/g)].map(match => match[1]);
const duplicates = [...new Set(registrationLines.filter((id, index) => registrationLines.indexOf(id) !== index))].sort();
check(`нет повторной регистрации команд (${registrationLines.length} вызовов register)`, duplicates.length === 0, duplicates);

/* ---------- 5. Именование ---------- */
const badlyNamed = [...invokedAll].filter(id => !/^auraTeam\.[a-z][A-Za-z0-9]*$/.test(id)).sort();
check('идентификаторы команд в едином стиле (auraTeam.camelCase)', badlyNamed.length === 0, badlyNamed);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
if (failures) { process.exit(1); }
