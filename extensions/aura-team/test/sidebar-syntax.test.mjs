/* Проверка, что сайдбарный JS внутри LAUNCHER_HTML — валидная программа.
   tsc проверяет только обёртку-шаблон, поэтому опечатку в webview-коде
   ловим здесь: разворачиваем template literal и прогоняем node --check. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dirname, '..', 'src', 'extension.ts'), 'utf8');
let failed = 0;
const check = (name, ok, extra = '') => {
	if (ok) { console.log('  ok  ', name); } else { failed++; console.log('  FAIL', name, extra); }
};

const start = source.indexOf('const LAUNCHER_HTML = `');
check('LAUNCHER_HTML найден', start > 0);
const bodyStart = start + 'const LAUNCHER_HTML = `'.length;
let end = -1;
for (let i = bodyStart; i < source.length; i++) {
	if (source[i] === '`' && source[i - 1] !== '\\') { end = i; break; }
}
check('LAUNCHER_HTML закрыт', end > bodyStart);

/** Разворачиваем escape-последовательности template literal. */
const decode = (s) => s.replace(/\\([\s\S])/g, (_m, c) => ({ n: '\n', t: '\t', r: '\r' }[c] ?? c));
const html = decode(source.slice(bodyStart, end));

const scriptStart = html.indexOf('>', html.indexOf('<script'));
const scriptEnd = html.lastIndexOf('</script>');
const script = html.slice(scriptStart + 1, scriptEnd);
check('скрипт извлечён', script.length > 2000, `${script.length} символов`);

const tmp = join(import.meta.dirname, '.sidebar-check.js');
writeFileSync(tmp, script);
try {
	execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
	check('сайдбарный скрипт парсится', true);
} catch (error) {
	check('сайдбарный скрипт парсится', false, String(error.stderr ?? error.message).split('\n').slice(0, 6).join('\n'));
} finally {
	rmSync(tmp, { force: true });
}

/* Ключевые контракты фазы 1: удаление сразу, присутствие, события. */
check('удаление уходит на сервер сразу', script.includes("command: 'auraTeam.deleteTask', args: [id]"));
check('нет отложенного commit удаления (5000 внутри undo)', !/pendingDeletes[\s\S]{0,400}deleteTask\", args: \[id\] \}\),?\s*\n\s*\}, 5000\)/.test(script));
check('точка присутствия рисуется', script.includes('function presenceHtml(') && script.includes("'live' : 'off'"));
check('онлайновые сверху', script.includes('Number(Boolean(b.online)) - Number(Boolean(a.online))'));
check('удалённые не воскресают', script.includes('!pendingDeletes.includes(task.id)'));
check('событие: скрытие без сервера и мгновенно', script.includes('evHideKey') && script.includes("dismissBtn.closest('.ev-row')") && script.includes("hideRow.classList.add('removing')"));
check('событие: удаление без модалки, с анимацией и без воскрешения', script.includes("delRow.classList.add('removing')") && script.includes('deletedEv.has(String(ev.id))'));
check('событие: удаление для команды', script.includes("'auraTeam.deleteActivity'"));
check('кнопка «Вернуть скрытые» подключена', script.includes("command: 'auraTeam.undismissAllActivity'") && script.includes("restoreFeedBtn"));
check('событие удаляется только с id', script.includes('canDelete && ev.id'));

console.log(failed ? `\n${failed} проверок упало` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
