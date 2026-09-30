/*---------------------------------------------------------------------------------------------
 *  Регрессия демо-режима канбана. Баг: buildState слал `demoMode: false`, когда
 *  демо-сессия уже жила (state.demo === true), — вебвью решал, что мы «вживую»,
 *  и правки канбана (добавить/перетащить/удалить) улетали в недоступный сервер
 *  и молча откатывались. Демо-ветка handlerFor стояла под тем же мёртвым условием.
 *  Тест статический: логика сидит в замыканиях activate(), достать её иначе нельзя.
 *--------------------------------------------------------------------------------------------*/
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = (relative) => readFileSync(join(here, '..', relative), 'utf8');

const extension = source('src/extension.ts');
const template = source('src/webview/template.html');

let failures = 0;
const check = (name, ok) => {
	console.log((ok ? '  ok   ' : '  FAIL ') + name);
	if (!ok) { failures++; }
};

/* ---------- 1. Флаг demoMode учитывает живую демо-сессию ---------- */
const demoModeLine = extension.split('\n').find(line => line.includes('demoMode:')) ?? '';
check('buildState: demoMode включает state.demo (живая демо-сессия)', /demoMode:\s*state\.demo/.test(demoModeLine));

/* ---------- 2. Демо-ветка handlerFor открыта при живой демо-сессии ---------- */
check('handlerFor: демо-ветка срабатывает при state.demo', /if \(state\.demo \|\| \(demoMode\(\) && !state\.session\)\)/.test(extension));

/* ---------- 3. Демо-ветка покрывает мутации канбана ---------- */
// Всё, что канбан шлёт в обход вебвью-перехватчика demo() (или при прямом вызове
// команды), обязано иметь демо-обработчик — иначе команда упадёт в реальный API.
const demoSection = extension.slice(extension.indexOf('if (state.demo ||'), extension.indexOf('const handler = handlers.get'));
for (const command of ['auraTeam.createTask', 'auraTeam.updateTask', 'auraTeam.reorderTasks', 'auraTeam.deleteTask', 'auraTeam.restoreTask', 'auraTeam.listDeletedTasks']) {
	check(`демо-ветка обрабатывает ${command}`, demoSection.includes(`'${command}'`));
}

/* ---------- 4. Вебвью-перехватчик demo() покрывает канбан ---------- */
for (const command of ['auraTeam.createTask', 'auraTeam.updateTask', 'auraTeam.reorderTasks']) {
	check(`webview demo() перехватывает ${command}`, template.includes(`command === '${command}'`));
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
