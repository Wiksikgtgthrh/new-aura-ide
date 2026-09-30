/*---------------------------------------------------------------------------------------------
 *  Контракты панели оркестратора — там, где раньше не проверялось ничего.
 *
 *  Два разрыва, оба тихие:
 *
 *  1) Вебвью ↔ host. Панель зовёт invoke('team.createTask'), host ловит это в своём switch,
 *     а на неизвестную команду бросает «unknown invoke». В панели вызов идёт под
 *     .catch(() => undefined) — то есть кнопка просто ничего не делает, без ошибки в UI.
 *
 *  2) Оркестратор ↔ Aura Team. Мост объявляет чужой публичный API структурно и зовёт
 *     методы в рантайме; если Team такого метода не отдаёт, получается `undefined`
 *     вместо функции. Здесь обе стороны сверяются по исходникам — без сборки обоих
 *     расширений и без запуска IDE.
 *--------------------------------------------------------------------------------------------*/
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');                                   // extensions/langgraph-orchestrator
const teamRoot = join(root, '..', 'aura-team');                  // extensions/aura-team
const read = path => readFileSync(path, 'utf8');
const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let failures = 0;
const check = (name, ok, detail) => {
	console.log((ok ? '  ok   ' : '  FAIL ') + name);
	if (!ok) { failures++; if (detail?.length) { console.log('       ' + detail.join(', ')); } }
};
const note = message => console.log('  --   ' + message);

/* ================= 1. Панель ↔ host: invoke ↔ case ================= */
const template = read(join(root, 'src', 'panel', 'template.html'));
const host = read(join(root, 'src', 'host.ts'));

const invoked = new Set([...template.matchAll(/invoke\('([A-Za-z0-9._]+)'/g)].map(match => match[1]));

const switchStart = host.indexOf('async invoke(command');
if (switchStart < 0) {
	check('в host.ts найден обработчик invoke()', false, 'не найден «async invoke(command»');
} else {
	const switchEnd = host.indexOf('unknown invoke', switchStart);
	const body = host.slice(switchStart, switchEnd < 0 ? undefined : switchEnd);
	const cases = [...body.matchAll(/case '([A-Za-z0-9._]+)':/g)].map(match => match[1]);
	const handled = new Set(cases);

	check(`обработчик invoke() заканчивается понятной ошибкой на неизвестную команду`, switchEnd > 0);
	const duplicated = cases.filter((name, index) => cases.indexOf(name) !== index);
	check(`ветки invoke() не дублируются (${cases.length} веток)`, duplicated.length === 0, [...new Set(duplicated)]);

	const unhandled = [...invoked].filter(name => !handled.has(name)).sort();
	check(`каждый invoke() из панели обработан в host (${invoked.size})`, unhandled.length === 0, unhandled.map(name => `${name} — кнопка молча ничего не сделает`));

	const unused = [...handled].filter(name => !invoked.has(name)).sort();
	if (unused.length > 0) { note(`ветки invoke() без вызова из панели: ${unused.join(', ')}`); }
}

/* ================= 2. Оркестратор ↔ публичный API Team ================= */
const bridge = read(join(root, 'src', 'team', 'bridge.ts'));
const publicApiPath = join(teamRoot, 'src', 'publicApi.ts');
if (!existsSync(publicApiPath)) {
	check('найден публичный API Aura Team', false, publicApiPath);
} else {
	const publicApi = read(publicApiPath);
	const teamExtension = read(join(teamRoot, 'src', 'extension.ts'));

	const versionOf = (text, pattern) => {
		const match = pattern.exec(text);
		return match ? Number(match[1]) : undefined;
	};
	const orchestratorVersion = versionOf(bridge, /TEAM_API_VERSION\s*=\s*(\d+)/);
	const teamVersion = versionOf(publicApi, /PUBLIC_API_VERSION\s*=\s*(\d+)/);
	check(`версия публичного API совпадает у обеих сторон (оркестратор ${orchestratorVersion} / Team ${teamVersion})`, orchestratorVersion !== undefined && orchestratorVersion === teamVersion);

	// Объявленная поверхность: члены интерфейса AuraTeamPublicApi.
	const interfaceBody = (() => {
		const start = publicApi.indexOf('export interface AuraTeamPublicApi');
		if (start < 0) { return ''; }
		const open = publicApi.indexOf('{', start);
		return stripComments(publicApi.slice(open + 1, publicApi.indexOf('\n}', open)));
	})();
	const declared = [...interfaceBody.matchAll(/^\s*(?:readonly\s+)?([A-Za-z][A-Za-z0-9]*)(\??)\s*[:(]/gm)].map(match => ({ name: match[1], optional: match[2] === '?' }));
	const declaredNames = new Set(declared.map(member => member.name));
	const optional = new Set(declared.filter(member => member.optional).map(member => member.name));
	check(`объявленная поверхность публичного API прочитана (${declaredNames.size})`, declaredNames.size >= 7, [...declaredNames]);

	// Фактическая поверхность: ключи объекта, который возвращает activate().
	// Ищем `return {` после комментария «Публичный API», затем собираем ключи верхнего уровня
	// по балансу скобок — тело функции на следующей строке уже даёт глубину 2 и не мешает.
	const returned = (() => {
		const marker = teamExtension.indexOf('// Публичный API: только эти методы');
		const index = teamExtension.indexOf('return {', marker < 0 ? 0 : marker);
		if (index < 0) { return []; }
		const keys = [];
		let depth = 0;
		for (let i = teamExtension.indexOf('{', index); i < teamExtension.length; i++) {
			const character = teamExtension[i];
			if (character === '{') { depth++; continue; }
			if (character === '}') { depth--; if (depth === 0) { break; } continue; }
			if (depth !== 1 || character !== '\n') { continue; }
			const end = teamExtension.indexOf('\n', i + 1);
			const match = /^\s*([A-Za-z][A-Za-z0-9]*)\s*[:(]/.exec(teamExtension.slice(i, end < 0 ? undefined : end));
			if (match) { keys.push(match[1]); }
		}
		return keys;
	})();

	check('activate() отдаёт ровно объявленные методы (ни лишнего, ни забытого)', [...declaredNames].sort().join(',') === [...returned].sort().join(','), [`объявлено: ${[...declaredNames].sort().join(', ')}`, `возвращается: ${[...returned].sort().join(', ')}`]);

	// Что мост реально дёргает на чужом объекте.
	const called = new Set([...bridge.matchAll(/this\.api\??\.([A-Za-z][A-Za-z0-9]*)/g)].map(match => match[1]));
	const guarded = name => new RegExp(`typeof this\\.api\\.${name} !== 'function'`).test(bridge);

	const undeclaredUnguarded = [...called].filter(name => !declaredNames.has(name) && !guarded(name)).sort();
	check(`мост не зовёт методы, которых Team не объявлял (${called.size} методов)`, undeclaredUnguarded.length === 0, undeclaredUnguarded.map(name => `${name} — Team его не отдаёт, а мост зовёт без проверки`));

	const optionalUnguarded = [...called].filter(name => optional.has(name) && !guarded(name)).sort();
	check('необязательные методы Team мост проверяет перед вызовом', optionalUnguarded.length === 0, optionalUnguarded);

	const notDeclared = [...called].filter(name => !declaredNames.has(name)).sort();
	if (notDeclared.length > 0) { note(`мост зовёт то, чего в объявленном API нет (через проверку typeof): ${notDeclared.join(', ')}`); }

	// looksCompatible — единственное, что мост считает обязательным.
	const required = [...bridge.matchAll(/typeof api\.([A-Za-z][A-Za-z0-9]*) === 'function'/g)].map(match => match[1]);
	const requiredMissing = required.filter(name => !declaredNames.has(name));
	check(`обязательные для моста методы есть в объявленном API (${required.join(', ')})`, requiredMissing.length === 0, requiredMissing);
	const requiredOptional = required.filter(name => optional.has(name));
	check('мост не требует необязательных методов', requiredOptional.length === 0, requiredOptional);
	check('мост сверяет apiVersion до проверки методов', /api\.apiVersion === TEAM_API_VERSION/.test(bridge));
	check('событие onDidChangeBoard есть в объявленном API и обязательно для моста', declaredNames.has('onDidChangeBoard') && required.includes('onDidChangeBoard'));
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
