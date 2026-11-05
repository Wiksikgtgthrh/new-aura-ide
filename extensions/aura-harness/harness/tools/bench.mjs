#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HARNESS_ROOT, parseArgs, list, readJson, writeJsonAtomic, stateDir, fail } from './lib.mjs';

function harnessCommit() {
  const rev = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: HARNESS_ROOT, encoding: 'utf8' });
  if (rev.status !== 0) return null;
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: HARNESS_ROOT, encoding: 'utf8' }).stdout.trim();
  return `${rev.stdout.trim()}${dirty ? '-dirty' : ''}`;
}

const tasksFile = fs.existsSync(path.join(HARNESS_ROOT, 'bench', 'tasks.json')) ? path.join(HARNESS_ROOT, 'bench', 'tasks.json') : fail('bench/tasks.json not found');
const { tasks } = readJson(tasksFile);
const runsDir = path.join(stateDir(), 'bench');
const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, id] = positional;

function task(taskId) {
  return tasks.find((t) => t.id === taskId) ?? fail(`Unknown bench task ${taskId}`);
}

if (command === 'list' || !command) {
  for (const t of tasks) console.log(`${t.id.padEnd(20)} ${t.title}  (${t.checks.length} checks)`);
} else if (command === 'start') {
  const t = task(id);
  if (!flags.agent || !flags.model) fail('--agent pi|opencode and --model <id> are required for comparable runs');
  const run = { task: t.id, agent: flags.agent, model: flags.model, harness: readJson(path.join(HARNESS_ROOT, 'harness.json')).version, harnessCommit: harnessCommit(), node: process.versions.node, platform: process.platform, startedAt: new Date().toISOString(), checks: Object.fromEntries(t.checks.map((c) => [c, null])) };
  const file = path.join(runsDir, `${t.id}-${Date.now()}.json`);
  writeJsonAtomic(file, run);
  console.log(`Run file: ${file}\n${t.setup ? `\nSetup: ${t.setup}\n` : ''}\nPrompt:\n${t.prompt}\n\nChecks:\n${t.checks.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}`);
} else if (command === 'score') {
  const file = flags.run;
  if (!file || file === true) fail('--run <run-file> is required');
  const run = readJson(file);
  const keys = Object.keys(run.checks);
  const pick = (v) => list(v).map((n) => keys[Number(n) - 1] ?? fail(`No check #${n}`));
  for (const k of pick(flags.pass)) run.checks[k] = true;
  for (const k of pick(flags.fail)) run.checks[k] = false;
  run.note = flags.note ?? run.note ?? null;
  run.scoredAt = new Date().toISOString();
  writeJsonAtomic(file, run);
  const passed = Object.values(run.checks).filter((v) => v === true).length;
  console.log(`${run.task}: ${passed}/${keys.length}${Object.values(run.checks).includes(null) ? ' (some checks unscored)' : ''}`);
} else if (command === 'report') {
  if (!fs.existsSync(runsDir)) fail('No runs yet');
  for (const f of fs.readdirSync(runsDir).filter((n) => n.endsWith('.json')).sort()) {
    const r = readJson(path.join(runsDir, f));
    const vals = Object.values(r.checks);
    console.log(`${r.task.padEnd(20)} ${r.agent.padEnd(9)} ${r.model.padEnd(24)} v${r.harness}${r.harnessCommit ? `@${r.harnessCommit}` : ''}  ${vals.filter((v) => v === true).length}/${vals.length}${vals.includes(null) ? '*' : ''}`);
  }
} else {
  console.log('Usage: node bench.mjs list | start <id> --agent pi|opencode --model <id> | score --run <file> --pass 1,2 --fail 3 [--note ""] | report');
  process.exit(1);
}
