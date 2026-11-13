#!/usr/bin/env node
// Repeatable evidence for the architecture circuit. Run: node tools/selftest.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ARCH = path.join(TOOLS, 'arch.mjs');
const SCOPE = path.join(TOOLS, 'scope.mjs');
const GATES = path.join(TOOLS, 'gates.mjs');
const FIXTURES = path.join(TOOLS, 'fixtures', 'arch');

function run(script, args, cwd) {
  const res = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${detail}`}`);
}

// 1. clean project passes
{
  const r = run(ARCH, ['check', '--cwd', path.join(FIXTURES, 'clean')]);
  check('clean project: architecture passed', r.code === 0, `exit=${r.code}\n${r.out}`);
}

// 2. violating project fails and names each rule
{
  const r = run(ARCH, ['check', '--cwd', path.join(FIXTURES, 'dirty')]);
  const rules = ['forbidden-import', 'cycle', 'function-too-long', 'deep-nesting'];
  const missing = rules.filter((rule) => !r.out.includes(rule));
  check('dirty project: exit 1 and reports all rule classes', r.code === 1 && missing.length === 0, `exit=${r.code} missing=[${missing.join(', ')}]`);
}

// 3. no config means unverified, never passed
{
  const dir = tempDir('arch-noconfig-');
  const r = run(ARCH, ['check', '--cwd', dir]);
  fs.rmSync(dir, { recursive: true, force: true });
  check('no architecture config: exit 2 (unverified)', r.code === 2, `exit=${r.code}\n${r.out}`);
}

// 4. empty map is unverified, not a pass
{
  const dir = tempDir('arch-empty-');
  fs.writeFileSync(path.join(dir, 'architecture.json'), JSON.stringify({ layers: [{ name: 'app', path: 'src', mayImport: ['app'] }] }));
  fs.mkdirSync(path.join(dir, 'src'));
  const r = run(ARCH, ['check', '--cwd', dir]);
  fs.rmSync(dir, { recursive: true, force: true });
  check('empty module map: exit 2 (unverified)', r.code === 2, `exit=${r.code}\n${r.out}`);
}

// 5. init writes a usable config
{
  const dir = tempDir('arch-init-');
  fs.mkdirSync(path.join(dir, 'src', 'ui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'ui', 'App.ts'), 'export const app = 1;\n');
  const init = run(ARCH, ['init', '--cwd', dir]);
  const checkRun = run(ARCH, ['check', '--cwd', dir]);
  const written = fs.existsSync(path.join(dir, 'architecture.json'));
  fs.rmSync(dir, { recursive: true, force: true });
  check('init writes config and check runs', init.code === 0 && written && checkRun.code !== 2, `init=${init.code} check=${checkRun.code}`);
}

// 6. scope gate: forbidden change rejected, allowed change accepted
{
  const dir = tempDir('scope-repo-');
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'selftest@local'], dir);
  git(['config', 'user.name', 'selftest'], dir);
  fs.mkdirSync(path.join(dir, 'src', 'orders'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'auth'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'orders', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'src', 'auth', 'b.ts'), 'export const b = 1;\n');
  fs.writeFileSync(path.join(dir, 'architecture.json'), JSON.stringify({ scope: { allowed: ['src/orders/**'], forbidden: ['src/auth/**'] } }));
  git(['add', '-A'], dir);
  const committed = git(['commit', '-qm', 'init'], dir).status === 0;

  fs.writeFileSync(path.join(dir, 'src', 'orders', 'a.ts'), 'export const a = 2;\n');
  const allowedRun = run(SCOPE, ['--cwd', dir]);

  fs.writeFileSync(path.join(dir, 'src', 'auth', 'b.ts'), 'export const b = 2;\n');
  const forbiddenRun = run(SCOPE, ['--cwd', dir]);
  fs.rmSync(dir, { recursive: true, force: true });

  check('scope: allowed change passes, forbidden change fails', committed && allowedRun.code === 0 && forbiddenRun.code === 1 && forbiddenRun.out.includes('src/auth/b.ts'), `commit=${committed} allowed=${allowedRun.code} forbidden=${forbiddenRun.code}\n${forbiddenRun.out}`);
}

// 7. scope without declaration is unverified
{
  const dir = tempDir('scope-empty-');
  git(['init', '-q'], dir);
  const r = run(SCOPE, ['--cwd', dir]);
  fs.rmSync(dir, { recursive: true, force: true });
  check('scope without declaration: exit 2 (unverified)', r.code === 2, `exit=${r.code}\n${r.out}`);
}

// 8. gates.mjs runs command gates and fails the verdict on violations
{
  const r = run(GATES, ['--cwd', path.join(FIXTURES, 'dirty'), '--only', 'architecture']);
  check('gates: architecture command gate fails the verdict', r.code === 1 && /architecture:.*\n\s+failed/s.test(r.out), `exit=${r.code}\n${r.out}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
