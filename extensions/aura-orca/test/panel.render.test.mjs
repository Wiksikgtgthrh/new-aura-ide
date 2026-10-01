/* Orca: вкладка — выбор CLI, запуск, карточки агентов, настройки ключей. jsdom, без IDE. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'media', 'panel.html'), 'utf8').split('__NONCE__').join('n').split('__CSP__').join('vscode-resource:');
const posted = [];
const dom = new JSDOM(html, {
	runScripts: 'outside-only', url: 'https://localhost/', pretendToBeVisual: true,
	beforeParse(window) { window.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m), getState: () => ({}), setState() { } }); }
});
const { window } = dom;
const { document } = window;
let failures = 0;
const check = (name, ok) => { console.log((ok ? '  ok   ' : '  FAIL ') + name); if (!ok) { failures++; } };
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const send = (data) => window.dispatchEvent(new window.MessageEvent('message', { data }));
const answer = (command, result) => {
	const req = [...posted].reverse().find((m) => m.type === 'invoke' && m.command === command && !m.done);
	if (!req) { return undefined; }
	req.done = true;
	send({ type: 'response', id: req.id, ok: true, result });
	return req;
};
const cli = (id, name, extra = {}) => ({ id, name, vendor: '', color: '#123456', glyph: id.slice(0, 2).toUpperCase(), install: 'npm i -g ' + id, docsUrl: 'https://example.com', binary: id, defaultBinary: id, keyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL', modelEnv: '', modelFlag: '--model', path: undefined, settings: {}, keyMask: '', hasKey: false, ...extra });
const baseState = {
	language: 'ru', workspace: '/repo',
	clis: [cli('claude', 'Claude Code', { path: '/usr/bin/claude', keyEnv: 'ANTHROPIC_API_KEY', baseUrlEnv: 'ANTHROPIC_BASE_URL', hasKey: true, keyMask: '••••1234' }), cli('codex', 'Codex CLI'), cli('gemini', 'Gemini CLI'), cli('qwen', 'Qwen Code'), cli('opencode', 'opencode', { baseUrlEnv: '' }), cli('aider', 'Aider'), cli('custom', 'Своя команда', { install: '', defaultBinary: '' })],
	sessions: [
		{ id: 's1', cli: 'claude', title: 'Починить вход', mode: 'interactive', cwd: '/repo', status: 'running', startedAt: Date.now() - 65000, hasTerminal: true, output: '' },
		{ id: 's2', cli: 'codex', title: 'Тесты #1', mode: 'headless', cwd: '/repo/.orca/worktrees/x', task: 'write tests', worktree: { branch: 'orca/codex-tests-ab12', path: '/repo/.orca/worktrees/x' }, status: 'exited', exitCode: 0, startedAt: Date.now() - 300000, endedAt: Date.now() - 100000, hasTerminal: true, output: 'done <b>ok</b>' }
	]
};

const script = document.querySelector('script').textContent;
window.eval(script);
check('панель просит состояние после загрузки', posted.some((m) => m.type === 'ready'));
send({ type: 'state', state: baseState });
await tick();

check('7 CLI на выбор, установленный отмечен', document.querySelectorAll('[data-cli]').length === 7 && document.querySelector('[data-cli="claude"] .dot.ok') && document.querySelector('[data-cli="codex"] .dot.off'));
check('вкладки «Агенты/Настройки CLI» и счётчик работающих', /1\/2/.test(document.querySelector('[data-view="agents"]').textContent) && Boolean(document.querySelector('[data-view="settings"]')));
check('карточки сессий со статусами', document.querySelector('[data-session="s1"] .pill.running') && /код 0/.test(document.querySelector('[data-session="s2"] .pill.exited').textContent));
check('ветка worktree видна и есть «Слить»/«Изменения»', /orca\/codex-tests-ab12/.test(document.querySelector('[data-session="s2"]').textContent) && document.querySelector('[data-session="s2"] [data-act="merge"]') && !document.querySelector('[data-session="s1"] [data-act="merge"]'));
check('вывод агента экранирован', !document.querySelector('.s-out b') && /<b>ok<\/b>/.test(document.querySelector('.s-out').textContent));

document.querySelector('[data-cli="codex"]').click();
await tick();
check('не установленный CLI предлагает установку', Boolean(document.querySelector('.launch [data-install="codex"]')));
document.querySelector('[data-mode="headless"]').click();
await tick();
check('режим «без участия» без задачи — кнопка запуска выключена', document.getElementById('btnLaunch').disabled);
const task = document.getElementById('task');
task.value = 'Покрыть тестами модуль ключей';
task.dispatchEvent(new window.Event('input'));
await tick();
check('с задачей кнопка включается', !document.getElementById('btnLaunch').disabled);
document.getElementById('optCount').value = '3';
document.getElementById('optCount').dispatchEvent(new window.Event('change'));
await tick();
check('параллельный ×3: worktree включён принудительно и подписан', document.getElementById('optWorktree').checked && document.getElementById('optWorktree').disabled && /×3/.test(document.getElementById('btnLaunch').textContent));
document.getElementById('btnLaunch').click();
await tick();
const launch = posted.find((m) => m.command === 'auraOrca.newAgent');
check('запуск уходит с CLI, задачей, режимом и числом', launch?.args?.[0]?.cli === 'codex' && launch.args[0].mode === 'headless' && launch.args[0].count === 3 && /ключей/.test(launch.args[0].task));
answer('auraOrca.newAgent', [{ title: 'a #1' }, { title: 'a #2' }, { title: 'a #3' }]);
await tick(20);
check('после запуска тост со списком', [...document.querySelectorAll('.toast')].some((t) => /a #3/.test(t.textContent)));

document.querySelector('[data-session="s2"] [data-act="merge"]').click();
await tick();
check('«Слить» зовёт расширение с id сессии', posted.some((m) => m.command === 'auraOrca.merge' && m.args[0] === 's2'));
answer('auraOrca.merge', { merged: true });
document.querySelector('[data-session="s1"]').click();
await tick();
check('клик по карточке фокусирует терминал агента', posted.some((m) => m.command === 'auraOrca.focus' && m.args[0] === 's1'));

/* ---------- Настройки CLI ---------- */
document.querySelector('[data-view="settings"]').click();
await tick();
check('открытие настроек подтягивает ключи плагина API Keys', posted.some((m) => m.command === 'auraOrca.apiPluginKeys'));
answer('auraOrca.apiPluginKeys', [{ id: 'k1', name: 'OpenRouter', model: 'gpt' }]);
await tick();
const claude = document.querySelector('[data-settings="claude"]');
check('карточка на каждый CLI', document.querySelectorAll('[data-settings]').length === 7);
check('сохранённый ключ замаскирован, поле — password', claude.querySelector('[data-f="apiKey"]').type === 'password' && /••••1234/.test(claude.querySelector('[data-f="apiKey"]').placeholder));
check('переменные ключа и base URL подписаны', /ANTHROPIC_API_KEY/.test(claude.textContent) && /ANTHROPIC_BASE_URL/.test(claude.textContent));
check('у CLI без base URL поле выключено', document.querySelector('[data-settings="opencode"] [data-f="baseUrl"]').disabled);
claude.querySelector('[data-f="apiKey"]').value = 'sk-new';
claude.querySelector('[data-f="baseUrl"]').value = 'https://proxy.example';
claude.querySelector('[data-f="model"]').value = 'claude-sonnet-4-5';
claude.querySelector('[data-save]').click();
await tick();
const saveReq = posted.find((m) => m.command === 'auraOrca.saveCliSettings');
check('сохранение отправляет ключ, base URL и модель', saveReq?.args?.[0] === 'claude' && saveReq.args[1].apiKey === 'sk-new' && saveReq.args[1].baseUrl === 'https://proxy.example' && saveReq.args[1].model === 'claude-sonnet-4-5');
answer('auraOrca.saveCliSettings', undefined);
const src = claude.querySelector('[data-f="keySource"]');
src.value = 'api-plugin';
src.dispatchEvent(new window.Event('change'));
await tick();
const srcReq = [...posted].reverse().find((m) => m.command === 'auraOrca.saveCliSettings');
check('источник «API Keys» сохраняется сразу с первым ключом и без ручного ключа', srcReq.args[1].keySource === 'api-plugin' && srcReq.args[1].apiKeyId === 'k1' && !('apiKey' in srcReq.args[1]));
answer('auraOrca.saveCliSettings', undefined);
send({ type: 'state', state: { ...baseState, clis: baseState.clis.map((c) => c.id === 'claude' ? { ...c, settings: { keySource: 'api-plugin', apiKeyId: 'k1' } } : c) } });
await tick();
check('при источнике API Keys — выбор ключа вместо поля', Boolean(document.querySelector('[data-settings="claude"] select[data-f="apiKeyId"]')) && !document.querySelector('[data-settings="claude"] [data-f="apiKey"]'));

/* ---------- Язык ---------- */
send({ type: 'state', state: { ...baseState, language: 'en' } });
await tick();
const visible = (document.querySelector('.wrap').textContent + [...document.querySelectorAll('[placeholder]')].map((e) => e.placeholder).join(' ')).replace(/Починить вход|Тесты #1|Своя команда/g, '');
check('английский интерфейс без кириллицы (кроме пользовательских данных)', !/[А-Яа-яЁё]/.test(visible));

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
