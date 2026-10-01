// Прогон всех тестов расширения: node test/run-all.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = ['test/presets.test.mjs', 'test/host.test.mjs', 'test/panel.render.test.mjs'];
let failed = 0;
for (const file of tests) {
	const result = spawnSync(process.execPath, ['--test', path.join(root, file)], { stdio: 'inherit' });
	if (result.status !== 0) {
		failed++;
	}
}
console.log(failed === 0 ? '\nALL TESTS PASSED' : `\n${failed} TEST FILE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
