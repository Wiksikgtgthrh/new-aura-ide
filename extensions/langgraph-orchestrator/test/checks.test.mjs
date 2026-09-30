import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sidecarSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sidecar', 'src');
const { parseFailures, checkFailed, fixInstruction, SCREEN_LINES } = require(path.join(sidecarSrc, 'checks.js'));

test('parseFailures: первые 40 строк и имена упавших тестов', () => {
	const output = ['PASS a', ...Array.from({ length: 50 }, (_, i) => `line ${i}`), 'FAIL src/x.test.ts', '  ✗ делает штуку', '  ✕ ещё тест'].join('\n');
	const parsed = parseFailures(output);
	assert.equal(parsed.excerpt.split('\n').length, SCREEN_LINES, 'выжимка ограничена 40 строками');
	assert.ok(parsed.truncated);
	assert.deepEqual(parsed.tests, ['src/x.test.ts', 'делает штуку', 'ещё тест']);
});

test('parseFailures: go/pytest-стиль', () => {
	const parsed = parseFailures('--- FAIL: TestFoo\nFAILED tests/test_bar.py::test_baz\n');
	assert.deepEqual(parsed.tests, ['TestFoo', 'tests/test_bar.py::test_baz']);
});

test('checkFailed: только ненулевой exit code — провал', () => {
	assert.equal(checkFailed('all good'), false);
	assert.equal(checkFailed('boom\n(exit code 1)'), true);
	assert.equal(checkFailed('warn\n(exit code 0)'), false);
});

test('fixInstruction: несёт выжимку, имена тестов и лимит', () => {
	const text = fixInstruction('цель', { command: 'npm test', excerpt: 'FAIL x', tests: ['t1'] }, 2, 3);
	assert.ok(text.includes('цель'));
	assert.ok(text.includes('2/3'));
	assert.ok(text.includes('npm test'));
	assert.ok(text.includes('t1'));
	assert.ok(text.includes('FAIL x'));
});
