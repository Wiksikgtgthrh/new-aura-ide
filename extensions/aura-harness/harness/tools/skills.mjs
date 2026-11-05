#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { HARNESS_ROOT, parseArgs, readJson, copyDir, walkFiles, sha256 } from './lib.mjs';

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function parseFrontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return null;
  const end = text.indexOf('\n---', 4);
  if (end === -1) return null;
  const lines = text.slice(text.indexOf('\n') + 1, end).split(/\r?\n/);
  const data = {};
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (/^[>|][-+]?$/.test(raw)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[(i += 1)].trim());
      data[key] = raw.startsWith('>') ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
    } else {
      data[key] = raw.replace(/^["']|["']$/g, '').trim();
    }
  }
  return { data, body: text.slice(end + 4) };
}

function skillDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

export function validateSkillsDir(root) {
  const issues = [];
  for (const dir of skillDirs(root)) {
    const file = path.join(root, dir, 'SKILL.md');
    const where = path.relative(HARNESS_ROOT, file) || file;
    if (!fs.existsSync(file)) {
      issues.push({ level: 'error', where, message: 'missing SKILL.md' });
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    const fm = parseFrontmatter(text);
    if (!fm) {
      issues.push({ level: 'error', where, message: 'missing YAML frontmatter (agent will never discover this skill)' });
      continue;
    }
    const { name, description } = fm.data;
    if (!name) issues.push({ level: 'error', where, message: 'frontmatter.name is required' });
    else if (!NAME_RE.test(name) || name.length > 64) issues.push({ level: 'error', where, message: `invalid name "${name}"` });
    else if (name !== dir) issues.push({ level: 'error', where, message: `name "${name}" must match directory "${dir}" (OpenCode requirement)` });
    if (!description) issues.push({ level: 'error', where, message: 'frontmatter.description is required' });
    else if (description.length > 1024) issues.push({ level: 'error', where, message: `description is ${description.length} chars (max 1024)` });
    else if (description.length < 40) issues.push({ level: 'warn', where, message: 'description is too short for reliable routing' });
    const bodyLines = fm.body.split('\n').filter((l) => l.trim()).length;
    if (bodyLines < 12) issues.push({ level: 'warn', where, message: `body has only ${bodyLines} non-empty lines` });
    const linkable = fm.body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    for (const ref of linkable.matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+\.md)\)/g)) {
      if (!fs.existsSync(path.join(root, dir, ref[1]))) issues.push({ level: 'error', where, message: `broken link ${ref[1]}` });
    }
  }
  return issues;
}

export function parity(manifest) {
  const pi = path.join(HARNESS_ROOT, manifest.paths.piSkills);
  const oc = path.join(HARNESS_ROOT, manifest.paths.opencodeSkills);
  const issues = [];
  const a = skillDirs(pi);
  const b = skillDirs(oc);
  for (const name of a.filter((n) => !b.includes(n))) issues.push({ level: 'error', where: name, message: 'present in Pi, missing in OpenCode (run: node tools/skills.mjs sync)' });
  for (const name of b.filter((n) => !a.includes(n))) issues.push({ level: 'error', where: name, message: 'present in OpenCode, missing in Pi' });
  for (const name of a.filter((n) => b.includes(n) && !manifest.platformSpecificSkills.includes(n))) {
    const fa = walkFiles(path.join(pi, name), { skip: [] }).map((f) => path.relative(path.join(pi, name), f));
    const fb = walkFiles(path.join(oc, name), { skip: [] }).map((f) => path.relative(path.join(oc, name), f));
    const differs = fa.length !== fb.length || fa.some((rel) => !fb.includes(rel) || sha256(path.join(pi, name, rel)) !== sha256(path.join(oc, name, rel)));
    if (differs) issues.push({ level: 'error', where: name, message: 'Pi and OpenCode copies differ (run: node tools/skills.mjs sync)' });
  }
  return issues;
}

function sync(manifest) {
  const pi = path.join(HARNESS_ROOT, manifest.paths.piSkills);
  const oc = path.join(HARNESS_ROOT, manifest.paths.opencodeSkills);
  const synced = [];
  for (const name of skillDirs(pi)) {
    if (manifest.platformSpecificSkills.includes(name) && fs.existsSync(path.join(oc, name))) continue;
    fs.rmSync(path.join(oc, name), { recursive: true, force: true });
    copyDir(path.join(pi, name), path.join(oc, name));
    synced.push(name);
  }
  return synced;
}

export function loadManifest() {
  return readJson(path.join(HARNESS_ROOT, 'harness.json'));
}

if (process.argv[1]?.endsWith('skills.mjs')) {
  const { positional } = parseArgs(process.argv.slice(2));
  const manifest = loadManifest();
  if (positional[0] === 'sync') {
    console.log(`Synced to OpenCode: ${sync(manifest).join(', ')}`);
    console.log(`Kept platform-specific: ${manifest.platformSpecificSkills.join(', ')}`);
  } else if (positional[0] === 'validate' || !positional[0]) {
    const issues = [
      ...validateSkillsDir(path.join(HARNESS_ROOT, manifest.paths.piSkills)),
      ...validateSkillsDir(path.join(HARNESS_ROOT, manifest.paths.opencodeSkills)),
      ...parity(manifest),
    ];
    for (const i of issues) console.log(`${i.level.toUpperCase().padEnd(5)} ${i.where}: ${i.message}`);
    const errors = issues.filter((i) => i.level === 'error').length;
    console.log(errors ? `\n${errors} error(s).` : `\nSkills OK (${issues.length} warning(s)).`);
    process.exit(errors ? 1 : 0);
  } else {
    console.log('Usage: node skills.mjs [validate|sync]');
    process.exit(1);
  }
}
