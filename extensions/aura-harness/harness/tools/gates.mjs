#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs, list, readJson, writeJsonAtomic, resolveConfig, stateDir, appendEvent, fail } from './lib.mjs';

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];

export function detectPackageManager(cwd) {
  const pkg = readJson(path.join(cwd, 'package.json'), null);
  if (pkg?.packageManager) return pkg.packageManager.split('@')[0];
  for (const [lockfile, pm] of LOCKFILES) if (fs.existsSync(path.join(cwd, lockfile))) return pm;
  return pkg ? 'npm' : null;
}

const FRONTEND_DEPS = ['next', 'react', 'vue', 'nuxt', 'svelte', '@sveltejs/kit', 'astro', 'solid-js', '@angular/core', 'preact', '@remix-run/react', 'react-router'];

export function detectFrontend(cwd) {
  const pkg = readJson(path.join(cwd, 'package.json'), null);
  if (!pkg) return false;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return FRONTEND_DEPS.some((d) => d in deps);
}

function isRequired(gate, ctx) {
  if (gate.requiredWhen === 'frontend') return ctx.frontend;
  if (gate.requiredWhen === 'typescript') return ctx.typescript;
  return gate.required !== false;
}

function runScript(pm, script, cwd, timeoutSec, logFile) {
  return new Promise((resolve) => {
    const started = Date.now();
    const out = fs.createWriteStream(logFile);
    const child = spawn(pm, ['run', script], { cwd, shell: process.platform === 'win32', env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutSec * 1000);
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on('error', (error) => {
      clearTimeout(timer);
      out.end(`\n[spawn error] ${error.message}\n`);
      resolve({ status: 'failed', exitCode: null, durationMs: Date.now() - started, error: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      out.end();
      const status = timedOut ? 'timeout' : code === 0 ? 'passed' : 'failed';
      resolve({ status, exitCode: code, durationMs: Date.now() - started });
    });
  });
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const cwd = path.resolve(flags.cwd && flags.cwd !== true ? flags.cwd : process.cwd());
  const configPath = flags.config && flags.config !== true ? flags.config : resolveConfig('.agent-gates.json', cwd);
  if (!configPath) fail('No .agent-gates.json found in project, ~/.agent-harness or harness root');
  const config = readJson(configPath);
  const only = list(flags.only);
  const gates = config.gates.filter((g) => !only.length || only.includes(g.name));

  const pm = detectPackageManager(cwd);
  const scripts = readJson(path.join(cwd, 'package.json'), {}).scripts ?? {};
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactDir = path.join(stateDir(cwd), 'artifacts', `gates-${runId}`);
  fs.mkdirSync(artifactDir, { recursive: true });

  const ctx = { frontend: detectFrontend(cwd), typescript: fs.existsSync(path.join(cwd, 'tsconfig.json')) };
  const results = [];
  for (const gate of gates) {
    const required = isRequired(gate, ctx);
    const script = (gate.scripts ?? [gate.name]).find((s) => scripts[s]);
    if (!pm || !script) {
      results.push({ name: gate.name, status: 'skipped', reason: pm ? `no script among ${(gate.scripts ?? [gate.name]).join('|')}` : 'no package.json', required, hint: gate.hint ?? null });
      console.log(`- ${gate.name}: skipped${required ? ' (REQUIRED)' : ''}${required && gate.hint ? `  -> ${gate.hint}` : ''}`);
      continue;
    }
    const logFile = path.join(artifactDir, `${gate.name}.log`);
    console.log(`> ${gate.name}: ${pm} run ${script}`);
    const res = await runScript(pm, script, cwd, gate.timeoutSec ?? config.defaultTimeoutSec ?? 900, logFile);
    results.push({ name: gate.name, script, required, log: path.relative(cwd, logFile), ...res });
    console.log(`  ${res.status} (${Math.round(res.durationMs / 1000)}s)`);
    if (res.status !== 'passed' && required && config.failFast) break;
  }

  const requiredBroken = results.filter((r) => r.required && (r.status === 'failed' || r.status === 'timeout'));
  const requiredSkipped = results.filter((r) => r.required && r.status === 'skipped');
  const ran = results.filter((r) => r.status !== 'skipped');
  const verdict = requiredBroken.length ? 'failed' : ran.length === 0 || requiredSkipped.length ? 'unverified' : 'passed';
  const summary = { runId, cwd, packageManager: pm, frontend: ctx.frontend, config: configPath, verdict, missingRequired: requiredSkipped.map((r) => r.name), finishedAt: new Date().toISOString(), results };

  writeJsonAtomic(path.join(artifactDir, 'summary.json'), summary);
  writeJsonAtomic(path.join(stateDir(cwd), 'artifacts', 'gates-latest.json'), summary);
  appendEvent(cwd, { type: 'gates.finished', runId, verdict });

  console.log(`\nVerdict: ${verdict.toUpperCase()}  artifacts: ${path.relative(cwd, artifactDir)}`);
  if (verdict === 'unverified') {
    console.log(ran.length === 0 ? 'No gate actually ran.' : `Required gate(s) have no script: ${requiredSkipped.map((r) => r.name).join(', ')}.`);
    console.log('Report the result as unverified, not passed.');
  }
  process.exit(verdict === 'passed' ? 0 : verdict === 'unverified' ? 2 : 1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('gates.mjs')) {
  main().catch((error) => fail(error.message));
}
