/**
 * Живой e2e-тест classpath: запуск Gradle с init-скриптом расширения на реальном
 * Android-проекте. Запуск: node test/classpath-e2e.mjs <projectRoot> <gradleCmd>
 */
const Module = (await import('node:module')).default;
const path = (await import('node:path')).default;
const { execFileSync } = await import('node:child_process');
const fs = (await import('node:fs')).default;
const { fileURLToPath } = await import('node:url');
const here = path.dirname(fileURLToPath(import.meta.url));
const stubPath = path.join(here, 'node_modules', 'vscode');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'vscode') { request = stubPath; }
	return origResolve.call(this, request, ...args);
};
const cp = (await import(new URL('../out/classpath.js', import.meta.url))).default ?? await import(new URL('../out/classpath.js', import.meta.url));

const root = process.argv[2];
const gradleCmd = process.argv[3];
if (!root || !gradleCmd) { console.error('usage: node classpath-e2e.mjs <projectRoot> <gradleCmd>'); process.exit(2); }

const modules = cp.discoverModules(root);
console.log('modules discovered:', modules.map(m => path.relative(root, m.dir)));
if (modules.length === 0) { throw new Error('no modules discovered'); }

const initScript = cp.writeInitScript();
console.log('init script:', initScript);
const t0 = Date.now();
const stdout = execFileSync(gradleCmd, ['-q', '-I', initScript, 'auraClasspath'], {
	cwd: root, timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
	shell: process.platform === 'win32',
	env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? 'C:/Users/Wiks/.jdks/ms-17.0.18' },
});
console.log(`gradle took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const result = cp.parseGradleClasspathOutput(stdout, modules, root);
console.log(`source=${result.source} modules=${result.modules.length} jars=${result.jars.length} unresolved=${result.unresolved.length}`);
const appMod = result.modules.find(m => path.relative(root, m.dir) === 'app');
console.log('applicationId:', appMod?.applicationId);
const android = result.jars.filter(j => j.includes('android.jar'));
console.log('android.jar entries:', android);
const androidx = result.jars.filter(j => j.toLowerCase().includes('androidx')).length;
console.log(`androidx jars: ${androidx}`);
// Критерий ТЗ ("150+ jar") относится к Compose-проекту; для простого appcompat-проекта
// достаточно >50 jar + android.jar + applicationId.
if (result.jars.length < 50) { throw new Error(`expected >50 jars, got ${result.jars.length}`); }
if (!appMod?.applicationId) { throw new Error('applicationId missing'); }
if (android.length === 0) { throw new Error('android.jar missing'); }
console.log('E2E CLASSPATH PASS');
