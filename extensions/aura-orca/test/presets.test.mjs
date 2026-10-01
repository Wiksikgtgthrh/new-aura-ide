/* Orca: пресеты CLI, аргументы, env и квотинг команды для разных шеллов. */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'src/presets.ts'), 'utf8');
const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
vm.runInNewContext(out, { module, exports: module.exports });
const p = module.exports;
const json = (value) => JSON.parse(JSON.stringify(value));

let failures = 0;
let checks = 0;
const check = (name, fn) => { checks++; try { fn(); console.log('  ok   ' + name); } catch (error) { failures++; console.log('  FAIL ' + name + '\n       ' + error.message); } };

check('все заявленные CLI есть: Claude Code, Codex, Gemini, Qwen, opencode, Aider, своя', () => {
	assert.deepEqual(json(p.PRESETS.map((x) => x.id)), ['claude', 'codex', 'gemini', 'qwen', 'opencode', 'aider', 'custom']);
	for (const preset of p.PRESETS) { assert.ok(preset.keyEnv, preset.id + ' без переменной ключа'); assert.ok(preset.glyph && preset.color); }
});

check('headless-аргументы каждого CLI ставят задачу и неинтерактивный режим', () => {
	const args = (id) => json(p.buildArgs(p.presetById(id), {}, 'fix bug', 'headless'));
	assert.deepEqual(args('claude'), ['-p', 'fix bug', '--permission-mode', 'acceptEdits', '--output-format', 'text']);
	assert.deepEqual(args('codex'), ['exec', '--full-auto', 'fix bug']);
	assert.deepEqual(args('gemini'), ['-p', 'fix bug', '--yolo']);
	assert.deepEqual(args('qwen'), ['-p', 'fix bug', '--yolo']);
	assert.deepEqual(args('opencode'), ['run', 'fix bug']);
	assert.deepEqual(args('aider'), ['--message', 'fix bug', '--yes-always', '--no-pretty']);
});

check('интерактивный режим: стартовая задача там, где CLI умеет; модель и доп. аргументы впереди', () => {
	assert.deepEqual(json(p.buildArgs(p.presetById('gemini'), { model: 'gemini-2.5-pro', extraArgs: '--debug "a b"' }, 'hi', 'interactive')), ['--model', 'gemini-2.5-pro', '--debug', 'a b', '-i', 'hi']);
	assert.deepEqual(json(p.buildArgs(p.presetById('aider'), {}, 'hi', 'interactive')), []);
	assert.deepEqual(json(p.buildArgs(p.presetById('claude'), {}, undefined, 'interactive')), []);
});

check('env: ключ в переменную CLI, base URL и модель, свои переменные, своё имя переменной', () => {
	const claude = p.presetById('claude');
	assert.deepEqual(json(p.buildEnv(claude, { baseUrl: 'https://proxy.local', model: 'opus' }, 'sk-1')), { ANTHROPIC_API_KEY: 'sk-1', ANTHROPIC_BASE_URL: 'https://proxy.local', ANTHROPIC_MODEL: 'opus' });
	const opencode = p.presetById('opencode');
	assert.deepEqual(json(p.buildEnv(opencode, { keyEnv: 'OPENROUTER_API_KEY', baseUrl: 'https://x', extraEnv: '# c\nFOO=bar\nBAD KEY=1\nQ="quoted"' }, 'k')), { FOO: 'bar', Q: 'quoted', OPENROUTER_API_KEY: 'k' });
	assert.deepEqual(json(p.buildEnv(p.presetById('aider'), { baseUrl: 'https://api.deepseek.com' }, 'k')), { OPENAI_API_KEY: 'k', OPENAI_API_BASE: 'https://api.deepseek.com' });
	assert.deepEqual(json(p.buildEnv(claude, {}, undefined)), {});
});

check('разбор аргументов с кавычками', () => {
	assert.deepEqual(json(p.splitArgs(`--a 1 "two words" 'x y' ""`)), ['--a', '1', 'two words', 'x y', '']);
	assert.deepEqual(json(p.splitArgs('')), []);
});

check('квотинг: POSIX, PowerShell, cmd', () => {
	assert.equal(p.commandLine('claude', ['-p', "it's done", '--x'], 'posix'), `claude -p 'it'\\''s done' --x`);
	assert.equal(p.commandLine('C:\\Program Files\\x\\agent.exe', ['a b'], 'powershell'), `& 'C:\\Program Files\\x\\agent.exe' 'a b'`);
	assert.equal(p.commandLine('codex', ['say "hi"\nnow', '100%'], 'cmd'), 'codex "say ""hi"" now" "100%%"');
});

check('тип шелла по пути', () => {
	assert.equal(p.shellKindOf('/bin/zsh', 'darwin'), 'posix');
	assert.equal(p.shellKindOf('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'win32'), 'powershell');
	assert.equal(p.shellKindOf('C:\\Windows\\System32\\cmd.exe', 'win32'), 'cmd');
	assert.equal(p.shellKindOf(undefined, 'win32'), 'powershell');
});

check('слаг, маска ключа, очистка ANSI и хвост', () => {
	assert.equal(p.slug('Починить вход в GitHub!'), 'pochinit-vhod-v-github');
	assert.equal(p.slug('***'), 'agent');
	assert.equal(p.maskSecret('sk-ant-1234567890'), '••••7890');
	assert.equal(p.maskSecret('short'), '••••');
	assert.equal(p.stripAnsi('\u001b[32mok\u001b[0m\rline'), 'ok\nline');
	assert.equal(p.tail('abcdef', 4), '…def');
});

console.log(failures ? `\n${failures} CHECK(S) FAILED` : `\nALL ${checks} CHECKS PASSED`);
if (failures) { process.exit(1); }
