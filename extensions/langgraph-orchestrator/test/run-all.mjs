// Прогон всех тестов расширения: node test/run-all.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const tests = ['test/sidecar.test.mjs', 'test/worktrees.test.mjs', 'test/checks.test.mjs', 'test/guardrails.test.mjs', 'test/budget.test.mjs', 'test/budget-profiles.test.mjs', 'test/trace.test.mjs', 'test/tool-cache.test.mjs', 'test/panel-budget.test.mjs', 'test/git-integration.test.mjs', 'test/team-tool.test.mjs', 'test/keys.test.mjs', 'test/tierStore.test.mjs', 'test/modelCatalog.test.mjs', 'test/teamSync.test.mjs', 'test/language.test.mjs', 'test/panel-contract.test.mjs', 'test/throttle.test.mjs', 'test/icons.test.mjs'];
let failed = 0;

for (const file of tests) {
	const result = spawnSync(process.execPath, ['--test', path.join(root, file)], { stdio: 'inherit' });
	if (result.status !== 0) {
		failed++;
	}
}

console.log(failed === 0 ? '\nALL TESTS PASSED' : `\n${failed} TEST FILE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
