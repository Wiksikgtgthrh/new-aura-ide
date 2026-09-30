/*---------------------------------------------------------------------------------------------
 *  Манифест расширения против кода.
 *
 *  Зачем отдельный тест. commands-wired.test.mjs проверяет, что всё, что зовёт интерфейс,
 *  зарегистрировано. Но есть обратная сторона: команда, объявленная в package.json и
 *  никем не зарегистрированная, попадает в палитру команд и молча ничего не делает —
 *  ни один тест этого не видел (реально так жила auraTeam.refresh). Плюс манифест — это
 *  единственная точка, где ломается локализация: ключ `%command.x%` без строки в nls
 *  показывается пользователю как литерал.
 *
 *  Тест статический: читает package.json, package.nls*.json и исходники расширения.
 *--------------------------------------------------------------------------------------------*/
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = relative => readFileSync(join(root, relative), 'utf8');

let failures = 0;
const check = (name, ok, detail) => {
	console.log((ok ? '  ok   ' : '  FAIL ') + name);
	if (!ok) { failures++; if (detail?.length) { console.log('       ' + detail.join(', ')); } }
};

const pkg = JSON.parse(read('package.json'));
const en = JSON.parse(read('package.nls.json'));

/* ---------- 1. Локализация: ключи манифеста и nls ---------- */
const usedKeys = new Set();
const walk = value => {
	if (typeof value === 'string') {
		for (const match of value.matchAll(/%([A-Za-z0-9_.]+)%/g)) { usedKeys.add(match[1]); }
	} else if (value && typeof value === 'object') {
		for (const item of Object.values(value)) { walk(item); }
	}
};
walk(pkg);

const missing = [...usedKeys].filter(key => !(key in en)).sort();
check(`все ключи %…% из package.json есть в package.nls.json (${usedKeys.size})`, missing.length === 0, missing);

const unused = Object.keys(en).filter(key => !usedKeys.has(key)).sort();
check(`в package.nls.json нет мёртвых ключей (${Object.keys(en).length})`, unused.length === 0, unused);

// Файл локализации появляется только вместе с переводом: половина ключей в нём — это
// ровно та же поломка, что «%command.x%» без строки, только незаметнее.
if (existsSync(join(root, 'package.nls.ru.json'))) {
	const ru = JSON.parse(read('package.nls.ru.json'));
	const ruMissing = Object.keys(en).filter(key => !(key in ru)).sort();
	const ruExtra = Object.keys(ru).filter(key => !(key in en)).sort();
	check('package.nls.ru.json покрывает те же ключи, что и английский', ruMissing.length === 0 && ruExtra.length === 0, [...ruMissing.map(k => `нет: ${k}`), ...ruExtra.map(k => `лишний: ${k}`)]);
} else {
	console.log('  --   package.nls.ru.json нет: строки манифеста доступны только по-английски');
}

/* ---------- 2. Команды: объявлены, уникальны, названы по стилю ---------- */
const commands = pkg.contributes?.commands ?? [];
const declared = commands.map(command => command.command);
const duplicates = declared.filter((id, index) => declared.indexOf(id) !== index);
check(`идентификаторы команд уникальны (${declared.length})`, duplicates.length === 0, [...new Set(duplicates)]);
// Полный camelCase-стиль проверяет commands-wired.test.mjs для команд, которые зовёт
// интерфейс; здесь достаточно префикса — внутренние вложенные id (auraTeam.invite.open)
// допустимы и зарегистрированы.
const badlyNamed = declared.filter(id => !/^auraTeam\.[a-z]/.test(id));
check('все объявленные команды в пространстве аура-Тим', badlyNamed.length === 0, badlyNamed);
const outsideCategory = commands.filter(command => command.category !== 'Team').map(command => command.command);
check('у всех команд категория Team (иначе палитра перемешает их с чужими)', outsideCategory.length === 0, outsideCategory);
const withoutEnablement = commands.filter(command => !String(command.enablement ?? '').includes('auraPlugin.aura-team.enabled')).map(command => command.command);
check('все команды спрятаны, когда плагин выключен', withoutEnablement.length === 0, withoutEnablement);

/* ---------- 3. Объявлено ⇒ зарегистрировано ---------- */
const sources = [];
const collectSources = directory => {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name === 'out') { continue; }
		const path = join(directory, entry.name);
		if (entry.isDirectory()) { collectSources(path); continue; }
		if (path.endsWith('.ts')) { sources.push(readFileSync(path, 'utf8')); }
	}
};
collectSources(join(root, 'src'));
const code = sources.join('\n');
const registered = new Set([...code.matchAll(/(?:register|registerCommand)\(\s*'(auraTeam\.[A-Za-z0-9.]+)'/g)].map(match => match[1]));

const dead = declared.filter(id => !registered.has(id)).sort();
check('каждая команда из манифеста зарегистрирована в коде', dead.length === 0, dead.map(id => `${id} — есть в палитре, нет в коде`));

/* ---------- 4. События активации и точки входа ---------- */
// onCommand нужен и для команд, спрятанных из палитры (auraTeam.hasEntitlement,
// auraTeam.agggAgent — их дёргают другие расширения): они регистрируются в коде, но
// в contributes.commands их нет. Поэтому событие живо, если id объявлен ИЛИ зарегистрирован;
// всё остальное — опечатка, на которую VS Code никогда не активируется.
const activation = pkg.activationEvents ?? [];
const badActivationEvents = activation.filter(event => event.startsWith('onCommand:') && !declared.includes(event.slice('onCommand:'.length)) && !registered.has(event.slice('onCommand:'.length)));
check(`события onCommand ссылаются на живые команды (${activation.length})`, badActivationEvents.length === 0, badActivationEvents.map(event => `${event} — нет ни в манифесте, ни в коде`));

const main = String(pkg.main ?? '');
check('main указывает на собранный out/', main.startsWith('./out/'), main);
const mainFile = join(root, main.replace(/^\.\//, ''));
check('main: файл существует после сборки (иначе расширение не загрузится)', existsSync(`${mainFile}.js`), `${mainFile}.js`);

/* ---------- 5. Представления ---------- */
const containers = (pkg.contributes?.viewsContainers?.activitybar ?? []).map(container => container.id);
const viewIds = Object.keys(pkg.contributes?.views ?? {});
const orphanViews = viewIds.filter(id => !containers.includes(id));
check('представления привязаны к существующему контейнеру', orphanViews.length === 0, orphanViews);
const home = pkg.contributes?.views?.auraTeam?.[0];
check('представление сайдбара существует и включается по контексту', Boolean(home) && String(home.when).includes('auraPlugin.aura-team.enabled'), JSON.stringify(home));

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
