#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { HARNESS_ROOT, parseArgs, readJson, walkFiles, appendEvent, fail } from './lib.mjs';
import { detectPackageManager, detectFrontend } from './gates.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const cwd = path.resolve(flags.cwd && flags.cwd !== true ? flags.cwd : process.cwd());
const write = Boolean(flags.write);
const withUnit = flags.unit !== 'false' && flags['no-unit'] !== true;

const pkgFile = path.join(cwd, 'package.json');
const pkg = readJson(pkgFile, null);
if (!pkg) fail(`No package.json in ${cwd}`);
if (!detectFrontend(cwd) && !flags.force) fail('No frontend framework detected in package.json (use --force to scaffold anyway)');

const templates = path.join(HARNESS_ROOT, 'templates', 'frontend');
if (!fs.existsSync(templates)) fail(`Templates missing at ${templates}; reinstall the harness`);

const pm = detectPackageManager(cwd) ?? 'npm';
const run = (script) => (pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`);
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const scripts = pkg.scripts ?? {};
const isNext = 'next' in deps;
const devCmd = scripts.dev ? run('dev') : isNext ? `${pm === 'npm' ? 'npx' : `${pm} exec`} next dev` : run('start');
const prodReady = Boolean(scripts.build && scripts.start);
const buildCmd = prodReady ? `${run('build')} && ` : '';
const serveCmd = prodReady ? run('start') : devCmd;
const hasUnitRunner = ['vitest', 'jest'].some((d) => d in deps) || Boolean(scripts.test);

const plan = { files: [], skipped: [], scripts: {}, devDependencies: [], gitignore: [] };

for (const file of walkFiles(templates, { skip: [] })) {
  const relPath = path.relative(templates, file);
  if (!withUnit || hasUnitRunner) if (/^vitest\./.test(relPath)) continue;
  const dest = path.join(cwd, relPath);
  if (fs.existsSync(dest)) {
    plan.skipped.push(relPath);
    continue;
  }
  plan.files.push(relPath);
  if (write) {
    const content = fs.readFileSync(file, 'utf8').replaceAll('__DEV_CMD__', devCmd).replaceAll('__BUILD_CMD__', buildCmd).replaceAll('__SERVE_CMD__', serveCmd);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
}

const wantedScripts = {
  'test:e2e': 'playwright test --grep @e2e',
  'test:a11y': 'playwright test --grep @a11y',
  'test:visual': 'playwright test --grep @visual',
  'test:visual:update': 'playwright test --grep @visual --update-snapshots',
  'test:perf': 'lhci autorun',
  'test:journeys': 'node ~/.agent-harness/tools/journeys.mjs --cwd .',
};
if (!scripts.typecheck && fs.existsSync(path.join(cwd, 'tsconfig.json'))) wantedScripts.typecheck = 'tsc --noEmit';
if (withUnit && !hasUnitRunner) {
  wantedScripts['test:unit'] = 'vitest run';
  wantedScripts.test = 'vitest run';
}
for (const [name, cmd] of Object.entries(wantedScripts)) if (!scripts[name]) plan.scripts[name] = cmd;

const wantedDeps = ['@playwright/test', '@axe-core/playwright', '@lhci/cli'];
if (withUnit && !hasUnitRunner) wantedDeps.push('vitest', '@vitejs/plugin-react', 'jsdom', '@testing-library/react', '@testing-library/jest-dom', '@testing-library/user-event');
if (!('typescript' in deps) && fs.existsSync(path.join(cwd, 'tsconfig.json'))) wantedDeps.push('typescript');
plan.devDependencies = wantedDeps.filter((d) => !(d in deps));

const gitignoreFile = path.join(cwd, '.gitignore');
const gitignore = fs.existsSync(gitignoreFile) ? fs.readFileSync(gitignoreFile, 'utf8').split('\n') : [];
plan.gitignore = ['.agent-state/', '.agent-worktrees/', '.lighthouseci/', 'test-results/', 'playwright-report/'].filter((l) => !gitignore.includes(l));

if (write) {
  if (Object.keys(plan.scripts).length) {
    pkg.scripts = { ...scripts, ...plan.scripts };
    fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  if (plan.gitignore.length) fs.appendFileSync(gitignoreFile, `${gitignore.length && gitignore.at(-1) !== '' ? '\n' : ''}${plan.gitignore.join('\n')}\n`);
  appendEvent(cwd, { type: 'frontend.init', files: plan.files, scripts: Object.keys(plan.scripts), devDependencies: plan.devDependencies });
}

const add = { pnpm: 'pnpm add -D', yarn: 'yarn add -D', bun: 'bun add -d', npm: 'npm i -D' }[pm] ?? 'npm i -D';
const exec = pm === 'npm' ? 'npx' : `${pm} exec`;
console.log(`${write ? 'Applied' : '[dry-run] Would apply'} frontend quality contour in ${cwd} (pm: ${pm})\n`);
console.log(`files:    ${plan.files.join(', ') || '—'}`);
if (plan.skipped.length) console.log(`kept:     ${plan.skipped.join(', ')} (already exist)`);
console.log(`scripts:  ${Object.keys(plan.scripts).join(', ') || '—'}`);
console.log(`ignore:   ${plan.gitignore.join(' ') || '—'}`);
console.log('\nNext steps (installs need human approval):');
if (plan.devDependencies.length) console.log(`  1. ${add} ${plan.devDependencies.join(' ')}`);
console.log(`  2. ${exec} playwright install --with-deps chromium`);
console.log('  3. Add every route to e2e/routes.ts and ROUTES in lighthouserc.cjs; write at least one component test (*.test.tsx).');
if (!prodReady) console.log('     note: no build+start scripts, Lighthouse will measure the dev server (numbers are pessimistic).');
console.log('     Lighthouse needs Chrome: set CHROME_PATH if it is not in PATH.');
console.log(`  4. Baselines on the CI platform, with approval: ${run('test:visual:update')}`);
console.log('  5. node ~/.agent-harness/tools/gates.mjs');
if (!write) console.log('\nRe-run with --write to apply.');
