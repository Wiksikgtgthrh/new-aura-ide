/*---------------------------------------------------------------------------------------------
 *  Обновление состояния идёт залпом, а не по очереди.
 *
 *  Регрессия, которую держим: doRefresh() делал шесть последовательных round-trip'ов
 *  (сессия → доска → ключи → группы ключей → лента → сводка). На локальном сервере это
 *  незаметно, на удалённом при RTT 40 мс — 270 мс на каждое обновление, а обновление
 *  дёргается после каждой команды интерфейса. Пять чтений независимы, и последовательным
 *  должен оставаться только первый шаг: teamId из сессии.
 *
 *  Тест статический: doRefresh — замыкание внутри activate(), снаружи не вызывается.
 *--------------------------------------------------------------------------------------------*/
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extension = readFileSync(join(here, '..', 'src', 'extension.ts'), 'utf8');

let failures = 0;
const check = (name, ok, detail) => {
	console.log((ok ? '  ok   ' : '  FAIL ') + name);
	if (!ok) { failures++; if (detail) { console.log('       ' + detail); } }
};

const start = extension.indexOf('const doRefresh = async ()');
const end = extension.indexOf('\n\t};', start);
const body = start < 0 ? '' : extension.slice(start, end < 0 ? undefined : end);

check('тело doRefresh найдено', body.length > 0, `start=${start} end=${end}`);

/* ---------- 1. Ровно один залп на все независимые чтения ---------- */
const batches = [...body.matchAll(/await Promise\.all\(\[([\s\S]*?)\]\)/g)];
check('независимые чтения идут одним Promise.all', batches.length === 1, `найдено залпов: ${batches.length}`);

const batched = batches[0]?.[1] ?? '';
const reads = ['getBoard', 'listApiKeys', 'listKeyGroups', 'getActivity', 'getSummary'];
const missing = reads.filter(name => !batched.includes(`api.${name}(`));
check(`в залпе все пять командных чтений (${reads.length})`, missing.length === 0, missing.map(name => `${name} — вне залпа`));

/* ---------- 2. Ни одно из них не осталось вне залпа ---------- */
const outside = reads.filter(name => {
	const calls = [...body.matchAll(new RegExp(`await api\\.${name}\\(`, 'g'))].length;
	const inBatch = typeof batched === 'string' && batched.includes(`api.${name}(`);
	return calls > (inBatch ? 0 : 1);
});
check('ни одно командное чтение не дублируется вне залпа', outside.length === 0, outside);

/* ---------- 3. Последовательным остаётся только шаг за teamId ---------- */
const sessionIndex = body.indexOf('await api.getSession()');
const batchIndex = body.indexOf('await Promise.all([');
check('сессия читается до залпа (из неё берётся teamId)', sessionIndex >= 0 && sessionIndex < batchIndex, `session=${sessionIndex} batch=${batchIndex}`);

const awaitedBefore = [...body.slice(0, batchIndex).matchAll(/await api\.([A-Za-z]+)\(/g)].map(match => match[1]);
check('до залпа ждут только сессию', awaitedBefore.length === 1 && awaitedBefore[0] === 'getSession', awaitedBefore);

/* ---------- 4. Результаты залпа раскладываются по состоянию ---------- */
for (const field of ['board', 'keys', 'keyGroups', 'activity', 'summary']) {
	check(`состояние получает ${field} из залпа`, new RegExp(`state\\.${field} = `).test(body));
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
