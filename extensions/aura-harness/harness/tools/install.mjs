#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { HARNESS_ROOT, homeDir, parseArgs, list, walkFiles, sha256, writeJsonAtomic, fail } from './lib.mjs';
import { loadManifest, validateSkillsDir, parity } from './skills.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const dryRun = Boolean(flags['dry-run']);
const home = homeDir();
const manifest = loadManifest();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupRoot = path.join(home, '.agent-harness', 'backups', stamp);
const expand = (p) => p.replace(/^~(?=$|\/)/, home);
const log = { written: [], unchanged: [], backedUp: [], skipped: [] };

const universal = manifest.install.universal ?? {};
const known = ['pi', 'opencode', ...Object.keys(universal)];
const detected = Object.entries(universal)
  .filter(([, cfg]) => !cfg.detect.length || cfg.detect.some((p) => fs.existsSync(expand(p))))
  .map(([name]) => name);
const requested = list(flags.target);
const targets = requested.includes('all')
  ? known
  : requested.length
    ? requested
    : ['pi', 'opencode', ...detected];
const customSkillDirs = list(flags['skills-dir']);

for (const t of targets) {if (!known.includes(t)) {fail(`Unknown target ${t}. Known: ${known.join(', ')}, all`);}}

const preflight = [
  ...validateSkillsDir(path.join(HARNESS_ROOT, manifest.paths.piSkills)),
  ...validateSkillsDir(path.join(HARNESS_ROOT, manifest.paths.opencodeSkills)),
  ...parity(manifest),
].filter((i) => i.level === 'error');
if (preflight.length) {
  for (const i of preflight) {console.error(`ERROR ${i.where}: ${i.message}`);}
  fail('Harness is inconsistent; fix it before installing (node tools/skills.mjs validate).');
}

function place(src, dest) {
  if (fs.existsSync(dest)) {
    if (sha256(src) === sha256(dest)) {
      log.unchanged.push(dest);
      return;
    }
    const backup = path.join(backupRoot, path.relative(home, dest));
    if (!dryRun) {
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(dest, backup);
    }
    log.backedUp.push(dest);
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  log.written.push(dest);
}

function placeTree(srcRel, destTilde) {
  const src = path.join(HARNESS_ROOT, srcRel);
  if (!fs.existsSync(src)) {return;}
  for (const file of walkFiles(src, { skip: [] })) {place(file, path.join(expand(destTilde), path.relative(src, file)));}
}

function placeIfMissing(srcRel, destTilde, alsoBlockedBy = []) {
  const dest = expand(destTilde);
  const blocker = [dest, ...alsoBlockedBy.map(expand)].find((p) => fs.existsSync(p));
  if (blocker) {
    log.skipped.push(`${blocker} (exists, not touched)`);
    return;
  }
  place(path.join(HARNESS_ROOT, srcRel), dest);
}

if (targets.includes('pi')) {
  const cfg = manifest.install.pi;
  placeTree(manifest.paths.piSkills, cfg.skills);
  placeTree(manifest.paths.piAgents, cfg.agents);
  placeTree(manifest.paths.opencodeCommands, cfg.prompts);
  for (const [src, dest] of Object.entries(cfg.configExamples)) {placeIfMissing(src, dest);}
}

if (targets.includes('opencode')) {
  const cfg = manifest.install.opencode;
  placeTree(manifest.paths.opencodeSkills, cfg.skills);
  placeTree(manifest.paths.opencodeAgents, cfg.agents);
  placeTree(manifest.paths.opencodeCommands, cfg.commands);
  for (const [src, dest] of Object.entries(cfg.configExamples)) {placeIfMissing(src, dest, ['~/.config/opencode/opencode.json']);}
}

function writeGenerated(content, dest, { force = false } = {}) {
  if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === content) {
    log.unchanged.push(dest);
    return;
  }
  if (fs.existsSync(dest) && !force) {
    if (!dryRun) {fs.writeFileSync(`${dest}.harness-new`, content);}
    log.skipped.push(`${dest} differs: new version saved as ${path.basename(dest)}.harness-new (merge by hand or rerun with --force-agents)`);
    return;
  }
  if (fs.existsSync(dest)) {
    const backup = path.join(backupRoot, path.relative(home, dest));
    if (!dryRun) {
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(dest, backup);
    }
    log.backedUp.push(dest);
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  log.written.push(dest);
}

function portableAgent(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {return raw;}
  const keep = match[1].split('\n').filter((line) => /^(name|description):/.test(line));
  if (!keep.some((line) => line.startsWith('name:'))) {keep.unshift(`name: ${path.basename(file, '.md')}`);}
  return `---\n${keep.join('\n')}\n---\n${match[2]}`;
}

const instructionsImport = '# Harness\n\n@~/AGENTS.md\n@~/AGENTS-SUMMARY.md\n';

for (const name of targets.filter((t) => universal[t])) {
  const cfg = universal[name];
  placeTree(manifest.paths.opencodeSkills, cfg.skills);
  if (cfg.agents) {
    const src = path.join(HARNESS_ROOT, manifest.paths.opencodeAgents);
    for (const file of walkFiles(src, { skip: [] })) {
      writeGenerated(portableAgent(file), path.join(expand(cfg.agents), path.relative(src, file)));
    }
  }
  if (cfg.commands) {placeTree(manifest.paths.opencodeCommands, cfg.commands);}
  if (cfg.instructions) {
    const dest = expand(cfg.instructions);
    const force = Boolean(flags['force-agents']);
    if (cfg.instructionsMode === 'import') {writeGenerated(instructionsImport, dest, { force });}
    else {writeGenerated(fs.readFileSync(path.join(HARNESS_ROOT, cfg.instructionsSource ?? 'AGENTS.md'), 'utf8'), dest, { force });}
  }
}

for (const dir of customSkillDirs) {placeTree(manifest.paths.opencodeSkills, dir);}

const runtime = expand(manifest.install.runtime);
placeTree(manifest.paths.tools, path.join(runtime, 'tools'));
for (const f of ['harness.json', '.agent-gates.json', '.release-policy.json', 'VERSION.md']) {place(path.join(HARNESS_ROOT, f), path.join(runtime, f));}
placeTree('bench', path.join(runtime, 'bench'));
placeTree(manifest.paths.templates ?? 'templates', path.join(runtime, 'templates'));
place(path.join(HARNESS_ROOT, 'opencode', 'opencode.official.jsonc.example'), path.join(runtime, 'examples', 'opencode.official.jsonc.example'));
place(path.join(HARNESS_ROOT, 'zcode', 'mcp.example.json'), path.join(runtime, 'zcode', 'mcp.example.json'));

const agentsTarget = path.join(home, 'AGENTS.md');
const agentsSrc = path.join(HARNESS_ROOT, 'AGENTS.md');
if (!fs.existsSync(agentsTarget)) {place(agentsSrc, agentsTarget);}
else if (sha256(agentsSrc) === sha256(agentsTarget)) {log.unchanged.push(agentsTarget);}
else if (flags['force-agents']) {place(agentsSrc, agentsTarget);}
else {
  if (!dryRun) {fs.copyFileSync(agentsSrc, `${agentsTarget}.harness-new`);}
  log.skipped.push(`${agentsTarget} differs: new version saved as AGENTS.md.harness-new (merge by hand or rerun with --force-agents)`);
}

if (!dryRun) {
  writeJsonAtomic(path.join(runtime, 'installed.json'), {
    version: manifest.version,
    at: new Date().toISOString(),
    targets,
    files: log.written.concat(log.unchanged).filter((f) => fs.existsSync(f)).map((f) => ({ path: f, sha256: sha256(f) })),
    backups: log.backedUp.length ? backupRoot : null,
  });
}

console.log(`${dryRun ? '[dry-run] ' : ''}aggg-harness ${manifest.version} -> ${targets.join(', ')}`);
console.log(`  written:   ${log.written.length}`);
console.log(`  unchanged: ${log.unchanged.length}`);
if (log.backedUp.length) {console.log(`  backed up: ${log.backedUp.length} -> ${backupRoot}`);}
for (const s of log.skipped) {console.log(`  skipped:   ${s}`);}
console.log(`\nNext: node "${path.join(runtime, 'tools', 'doctor.mjs')}"`);
