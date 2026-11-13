#!/usr/bin/env node
// Scope gate: every changed file must fall inside the declared blast radius.
// Config: architecture.json -> { "scope": { "allowed": [...], "forbidden": [...] } }
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, list, readJsonc, writeJsonAtomic, wildcardToRegExp, stateDir, appendEvent, fail, homeDir } from './lib.mjs';

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function loadScope(cwd, explicit) {
  if (explicit && explicit !== true) {
    if (!fs.existsSync(explicit)) fail(`Config not found: ${explicit}`);
    return { path: path.resolve(explicit), scope: readJsonc(explicit).scope ?? readJsonc(explicit) };
  }
  const candidates = [
    path.join(cwd, 'architecture.json'),
    path.join(cwd, '.agent-arch.json'),
    path.join(homeDir(), '.agent-harness', 'architecture.json'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) return null;
  const config = readJsonc(found);
  if (!config.scope) return null;
  return { path: found, scope: config.scope };
}

function git(cwd, args) {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (res.status !== 0) {
    const message = (res.stderr ?? '').trim() || `git ${args.join(' ')} failed`;
    return { ok: false, message };
  }
  return { ok: true, out: res.stdout ?? '' };
}

const IGNORED = ['.agent-state/', 'node_modules/', 'dist/', 'build/', '.next/', 'coverage/'];

function ignored(rel) {
  return IGNORED.some((prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix));
}

function changedFiles(cwd, base) {
  if (base && base !== true) {
    const diff = git(cwd, ['diff', '--name-only', `${base}...HEAD`]);
    if (!diff.ok) return diff;
    const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard']);
    if (!untracked.ok) return untracked;
    return { ok: true, files: [...diff.out.split('\n'), ...untracked.out.split('\n')].map((s) => s.trim()).filter(Boolean).filter((f) => !ignored(f)) };
  }
  const status = git(cwd, ['status', '--porcelain=v1', '-uall']);
  if (!status.ok) return status;
  const files = [];
  for (const line of status.out.split('\n')) {
    if (!line.trim()) continue;
    let file = line.slice(3).trim();
    if (file.includes(' -> ')) file = file.split(' -> ').pop().trim();
    if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1);
    files.push(toPosix(file).replace(/\\/g, '/'));
  }
  return { ok: true, files: [...new Set(files)].filter((f) => !ignored(f)) };
}

function matchesAny(rel, matchers) {
  return matchers.find((re) => re.test(rel)) ?? null;
}

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const cwd = path.resolve(flags.cwd && flags.cwd !== true ? flags.cwd : process.cwd());
  const loaded = loadScope(cwd, flags.config);
  const allowedGlobs = list(flags.allowed).length ? list(flags.allowed) : loaded?.scope?.allowed ?? [];
  const forbiddenGlobs = list(flags.forbidden).length ? list(flags.forbidden) : loaded?.scope?.forbidden ?? [];

  if (!allowedGlobs.length && !forbiddenGlobs.length) {
    console.error('error: no scope declared — pass --allowed / --forbidden or add "scope" to architecture.json');
    return 2;
  }

  const changes = changedFiles(cwd, flags.base);
  if (!changes.ok) {
    console.error(`error: ${changes.message}`);
    console.error('Scope gate is unverified: report it as unverified, not passed.');
    return 2;
  }
  if (!changes.files.length) {
    console.log('No changed files.');
    return 0;
  }

  const allowed = allowedGlobs.map(wildcardToRegExp);
  const forbidden = forbiddenGlobs.map(wildcardToRegExp);
  const violations = [];
  const inScope = [];
  for (const file of changes.files) {
    if (matchesAny(file, forbidden)) {
      violations.push({ file, reason: 'in forbidden area' });
      continue;
    }
    if (allowed.length && !matchesAny(file, allowed)) {
      violations.push({ file, reason: 'outside allowed scope' });
      continue;
    }
    inScope.push(file);
  }

  const summary = {
    at: new Date().toISOString(),
    verdict: violations.length ? 'failed' : 'passed',
    base: flags.base && flags.base !== true ? flags.base : null,
    allowed: allowedGlobs,
    forbidden: forbiddenGlobs,
    changed: changes.files.length,
    inScope,
    violations,
  };
  const artifactDir = path.join(stateDir(cwd), 'artifacts');
  writeJsonAtomic(path.join(artifactDir, 'scope-latest.json'), summary);
  appendEvent(cwd, { type: 'scope.checked', verdict: summary.verdict, changed: changes.files.length, violations: violations.length });

  if (flags.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Changed: ${changes.files.length}  in scope: ${inScope.length}  violations: ${violations.length}`);
    for (const v of violations) console.log(`  OUT OF SCOPE: ${v.file} (${v.reason})`);
    if (violations.length) console.log('\nRevert out-of-scope changes or declare them explicitly before claiming the task is done.');
    console.log(`\nVerdict: ${summary.verdict.toUpperCase()}`);
  }
  return violations.length ? 1 : 0;
}

process.exitCode = main();
