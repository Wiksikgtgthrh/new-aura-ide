/**
 * Все node-тесты aura-kotlin одним прогоном: парсеры classpath, локализация,
 * logcat, эмулятор. Живые e2e (gradle-проект, jdtls, устройство) запускаются
 * отдельно — им нужны внешние условия, поэтому в общий набор не входят.
 * Запуск: npm test
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = ['classpath.test.mjs', 'l10n.test.mjs', 'emulator.state.test.mjs', 'logcat.smoke.mjs', 'emulator.smoke.mjs'];

let failed = 0;
for (const suite of suites) {
	console.log(`\n=== ${suite} ===`);
	const result = spawnSync(process.execPath, [path.join(here, suite)], { stdio: 'inherit', cwd: path.join(here, '..') });
	if (result.status !== 0) { failed++; console.log(`FAILED: ${suite} (exit ${result.status})`); }
}
console.log(failed ? `\n${failed} набор(ов) с ошибками` : '\nВСЕ НАБОРЫ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
