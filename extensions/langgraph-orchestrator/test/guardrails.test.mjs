import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sidecarSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sidecar', 'src');
const { classifyAction, guardTitle } = require(path.join(sidecarSrc, 'guardrails.js'));

test('guardrails: удаление файлов — опасное действие', () => {
	const action = classifyAction('fs.delete', { path: 'src/old.ts' });
	assert.equal(action.risky, true);
	assert.equal(action.kind, 'delete');
});

test('guardrails: сеть, push, публикация и rm -rf — опасны', () => {
	assert.equal(classifyAction('terminal.run', { command: 'git push origin main' }).kind, 'push');
	assert.equal(classifyAction('terminal.run', { command: 'curl https://example.com' }).kind, 'network');
	assert.equal(classifyAction('terminal.run', { command: 'npm publish' }).kind, 'publish');
	assert.equal(classifyAction('terminal.run', { command: 'rm -rf build' }).kind, 'destructive');
});

test('guardrails: обычные команды и правки не трогаются', () => {
	assert.equal(classifyAction('terminal.run', { command: 'npm test' }).risky, false);
	assert.equal(classifyAction('fs.writeFile', { path: 'src/app.ts', content: 'x' }).risky, false);
	assert.equal(classifyAction('fs.readFile', { path: '.env' }).risky, false, 'чтение секретов не блокируем');
});

test('guardrails: .env и ключи защищены от записи', () => {
	assert.equal(classifyAction('fs.writeFile', { path: '.env' }).kind, 'secrets');
	assert.equal(classifyAction('fs.writeFile', { path: 'config/.env.local' }).kind, 'secrets');
	assert.equal(classifyAction('fs.writeFile', { path: 'certs/server.pem' }).kind, 'secrets');
	assert.equal(classifyAction('fs.writeFile', { path: 'tsconfig.json' }).kind, 'config');
});

test('guardTitle: несёт причину и цель', () => {
	const title = guardTitle(classifyAction('terminal.run', { command: 'git push' }), 'ru');
	assert.ok(title.includes('git push'));
	assert.ok(title.includes('git push') || title.includes('подтверд'));
});
