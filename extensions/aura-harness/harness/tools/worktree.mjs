#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, readJson, writeJsonAtomic, withLock, appendEvent, stateDir, fail } from './lib.mjs';

const NAME = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

function git(args, cwd, { allowFail = false } = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.error) {fail(`git not available: ${res.error.message}`);}
  if (res.status !== 0 && !allowFail) {fail(`git ${args.join(' ')}\n${res.stderr.trim()}`);}
  return { ok: res.status === 0, out: res.stdout.trim(), err: res.stderr.trim() };
}

const cwd = process.cwd();
const root = git(['rev-parse', '--show-toplevel'], cwd).out;
const registryFile = path.join(stateDir(root), 'worktrees.json');
const registryLock = path.join(stateDir(root), 'worktrees.lock');
const baseDir = path.join(root, '.agent-worktrees');

function registry(fn) {
  return withLock(registryLock, () => {
    const data = readJson(registryFile, { worktrees: {} });
    const result = fn(data);
    writeJsonAtomic(registryFile, data);
    return result;
  });
}

function ensureExcluded() {
  const gitDir = git(['rev-parse', '--git-common-dir'], root).out;
  const exclude = path.resolve(root, gitDir, 'info', 'exclude');
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  const wanted = ['.agent-worktrees/', '.agent-state/'].filter((line) => !current.split('\n').includes(line));
  if (wanted.length) {fs.appendFileSync(exclude, `${current.endsWith('\n') || !current ? '' : '\n'}${wanted.join('\n')}\n`);}
}

function requireName(name) {
  if (!name || !NAME.test(name)) {fail('Name must match [a-z0-9] with - or _ separators');}
  return name;
}

const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb'];

function lockfileChanged(target, baseSha) {
  const changed = git(['diff', '--name-only', `${baseSha}...HEAD`, '--', ...LOCKFILES, 'package.json'], target, { allowFail: true }).out;
  return changed.split('\n').filter(Boolean);
}

function linkDeps(target) {
  const src = path.join(root, 'node_modules');
  const dest = path.join(target, 'node_modules');
  if (!fs.existsSync(src)) {return 'no root node_modules to link';}
  if (fs.existsSync(dest)) {return 'node_modules already present';}
  fs.symlinkSync(src, dest, process.platform === 'win32' ? 'junction' : 'dir');
  return `linked ${path.relative(root, dest)} -> node_modules`;
}

function lookup(name) {
  const wt = readJson(registryFile, { worktrees: {} }).worktrees[requireName(name)];
  if (!wt) {fail(`Unknown worktree ${name}`);}
  return wt;
}

const commands = {
  create([name], flags) {
    requireName(name);
    const base = flags.base && flags.base !== true ? flags.base : 'HEAD';
    const baseSha = git(['rev-parse', base], root).out;
    const target = path.join(baseDir, name);
    const branch = `agent/${name}`;
    if (fs.existsSync(target)) {fail(`Worktree ${name} already exists at ${target}`);}
    ensureExcluded();
    git(['worktree', 'add', '-b', branch, target, baseSha], root);
    registry((data) => {
      data.worktrees[name] = { path: target, branch, base, baseSha, createdAt: new Date().toISOString() };
    });
    const deps = flags['link-deps'] ? linkDeps(target) : null;
    appendEvent(root, { type: 'worktree.created', name, branch, baseSha });
    console.log(JSON.stringify({ name, path: target, branch, baseSha, deps }, null, 2));
  },

  integrate(names, flags) {
    if (!names.length) {fail('Usage: worktree.mjs integrate <name> [<name>...] [--base <ref>] [--deps link|none] [--no-gates]');}
    const sources = names.map((n) => ({ name: n, ...lookup(n) }));
    for (const s of sources) {
      const dirty = fs.existsSync(s.path) ? git(['status', '--porcelain'], s.path).out : '';
      if (dirty) {fail(`Worktree ${s.name} has uncommitted changes; builder must commit before integration.`);}
    }
    const base = flags.base && flags.base !== true ? flags.base : 'HEAD';
    const baseSha = git(['rev-parse', base], root).out;
    const name = flags.name && flags.name !== true ? requireName(flags.name) : `integration-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
    const target = path.join(baseDir, name);
    const branch = `agent/${name}`;
    if (fs.existsSync(target)) {fail(`Worktree ${name} already exists`);}
    ensureExcluded();
    git(['worktree', 'add', '-b', branch, target, baseSha], root);

    const merged = [];
    let conflict = null;
    for (const s of sources) {
      const res = git(['merge', '--no-ff', '--no-edit', '-m', `integrate ${s.branch}`, s.branch], target, { allowFail: true });
      if (res.ok) {
        merged.push(s.name);
        console.log(`merged  ${s.branch}`);
        continue;
      }
      const files = git(['diff', '--name-only', '--diff-filter=U'], target, { allowFail: true }).out.split('\n').filter(Boolean);
      git(['merge', '--abort'], target, { allowFail: true });
      conflict = { with: s.name, branch: s.branch, files, mergedBefore: [...merged] };
      console.log(`CONFLICT ${s.branch}: ${files.join(', ') || res.err}`);
      break;
    }

    let deps = 'none';
    const lockChanges = lockfileChanged(target, baseSha);
    if (!conflict && (flags.deps ?? 'link') === 'link') {
      deps = lockChanges.length ? `NOT linked: ${lockChanges.join(', ')} changed, install deps in ${target} (needs approval)` : linkDeps(target);
    }

    let gates = null;
    if (!conflict && !flags['no-gates'] && !/NOT linked/.test(deps)) {
      console.log(`\nRunning gates in ${path.relative(root, target)}`);
      const res = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'gates.mjs'), '--cwd', target], { stdio: 'inherit' });
      gates = res.status === 0 ? 'passed' : res.status === 2 ? 'unverified' : 'failed';
    }

    const verdict = conflict ? 'conflict' : gates ?? 'unverified';
    const record = { name, path: target, branch, baseSha, sources: names, merged, conflict, deps, gates, verdict, at: new Date().toISOString() };
    registry((data) => {
      data.worktrees[name] = { path: target, branch, base, baseSha, integration: true, sources: names, createdAt: record.at };
    });
    writeJsonAtomic(path.join(stateDir(root), 'artifacts', 'integration-latest.json'), record);
    appendEvent(root, { type: 'worktree.integrated', name, merged, conflict: conflict?.with ?? null, verdict });
    console.log(`\nIntegration ${name}: ${verdict.toUpperCase()}  deps: ${deps}`);
    if (conflict) {console.log(`Return ${conflict.with} to its builder with the conflicting files, or rebase it on ${merged.length ? branch : 'base'}.`);}
    else {console.log(`Human merges ${branch} into the main branch after review; agents never do.`);}
    process.exit(verdict === 'passed' ? 0 : verdict === 'unverified' ? 2 : 1);
  },

  list() {
    const data = readJson(registryFile, { worktrees: {} });
    const live = git(['worktree', 'list', '--porcelain'], root).out;
    const entries = Object.entries(data.worktrees);
    if (!entries.length) {
      console.log('No agent worktrees.');
      return;
    }
    for (const [name, wt] of entries) {
      const exists = live.includes(`worktree ${wt.path}`) || live.includes(`worktree ${wt.path.replace(/\\/g, '/')}`);
      const dirty = exists ? git(['status', '--porcelain'], wt.path, { allowFail: true }).out.split('\n').filter(Boolean).length : 0;
      const ahead = exists ? git(['rev-list', '--count', `${wt.baseSha}..HEAD`], wt.path, { allowFail: true }).out : '?';
      console.log(`${name.padEnd(24)} ${exists ? 'live ' : 'GONE '} branch=${wt.branch} commits=${ahead} dirty=${dirty}  ${wt.path}`);
    }
  },

  diff([name]) {
    requireName(name);
    const wt = readJson(registryFile, { worktrees: {} }).worktrees[name];
    if (!wt) {fail(`Unknown worktree ${name}`);}
    console.log(`# ${name}: committed changes since ${wt.baseSha.slice(0, 10)}`);
    console.log(git(['diff', '--stat', `${wt.baseSha}...HEAD`], wt.path).out || '(none)');
    const dirty = git(['status', '--short'], wt.path).out;
    console.log(`\n# uncommitted\n${dirty || '(clean)'}`);
  },

  remove([name], flags) {
    requireName(name);
    const wt = readJson(registryFile, { worktrees: {} }).worktrees[name];
    if (!wt) {fail(`Unknown worktree ${name}`);}
    if (fs.existsSync(wt.path)) {
      const dirty = git(['status', '--porcelain'], wt.path).out;
      if (dirty && !flags.force) {fail(`Worktree ${name} has uncommitted changes. Commit/stash them or pass --force (approval required).`);}
      git(['worktree', 'remove', ...(flags.force ? ['--force'] : []), wt.path], root);
    }
    if (flags['delete-branch']) {
      const res = git(['branch', '-d', wt.branch], root, { allowFail: true });
      console.log(res.ok ? `Deleted merged branch ${wt.branch}` : `Kept branch ${wt.branch}: not merged (${res.err})`);
    }
    registry((data) => {
      delete data.worktrees[name];
    });
    appendEvent(root, { type: 'worktree.removed', name, force: Boolean(flags.force) });
    console.log(`Removed worktree ${name}`);
  },

  prune() {
    git(['worktree', 'prune'], root);
    const pruned = registry((data) => {
      const gone = Object.keys(data.worktrees).filter((n) => !fs.existsSync(data.worktrees[n].path));
      for (const n of gone) {delete data.worktrees[n];}
      return gone;
    });
    console.log(pruned.length ? `Pruned: ${pruned.join(', ')}` : 'Nothing to prune.');
  },
};

const HELP = `Usage: node worktree.mjs <command>

  create <name> [--base <ref>] [--link-deps]
                                        new branch agent/<name> in .agent-worktrees/<name>;
                                        --link-deps symlinks the root node_modules
  integrate <name>... [--base <ref>] [--deps link|none] [--no-gates] [--name <slug>]
                                        merge agent branches into a fresh integration worktree,
                                        stop on first conflict, then run gates there
  list                                  status of every agent worktree
  diff <name>                           committed + uncommitted changes vs base
  remove <name> [--force] [--delete-branch]
                                        refuses dirty trees without --force; deletes branch only if merged
  prune                                 drop registry entries for vanished worktrees

Merging stays a human/reviewer decision: review "diff", then merge the branch with git.`;

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = commands[positional[0]];
if (!command) {
  console.log(HELP);
  process.exit(positional[0] ? 1 : 0);
}
command(positional.slice(1), flags);
