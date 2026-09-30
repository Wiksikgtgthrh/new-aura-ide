/*---------------------------------------------------------------------------------------------
 *  Один прогон «зелёной сборки» расширения Aura Team.
 *
 *  Порядок важен: часть проверок читает собранный `out/` (сайдбар рендерится из
 *  скомпилированного extension.js), поэтому сначала компиляция, потом тесты.
 *  Запуск: `npm test` внутри extensions/aura-team.
 *--------------------------------------------------------------------------------------------*/
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const tsc = join(root, '..', '..', 'node_modules', 'typescript', 'lib', 'tsc.js');

const step = (title, command, args) => {
	process.stdout.write(`\n=== ${title} ===\n`);
	const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
	if (result.status !== 0) {
		process.stdout.write(`\n${title}: FAILED (${result.status ?? 'spawn error'})\n`);
		process.exit(result.status ?? 1);
	}
};

// Компиляция: она же типизация. out/ читают тесты сайдбара.
step('tsc (сборка out/)', process.execPath, [tsc, '-p', 'tsconfig.json']);

const tests = readdirSync(here).filter(name => name.endsWith('.test.mjs')).sort();
for (const test of tests) {
	step(test, process.execPath, [join(here, test)]);
}

process.stdout.write(`\nALL ${tests.length + 1} STEPS PASSED\n`);
