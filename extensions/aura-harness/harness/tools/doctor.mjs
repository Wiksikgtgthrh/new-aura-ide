#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HARNESS_ROOT, homeDir, parseArgs, readJsonc, readJson, sha256 } from './lib.mjs';
import { loadManifest, validateSkillsDir, parity } from './skills.mjs';
import { scanFiles } from './policy.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const FRONTEND_MCP = ['playwright', 'chrome-devtools', 'context7'];
const home = homeDir();
const results = [];
const add = (level, area, message) => results.push({ level, area, message });

function bin(name, args = ['--version']) {
  const res = spawnSync(name, args, { encoding: 'utf8', shell: process.platform === 'win32', timeout: 15000 });
  if (res.error || res.status !== 0) return null;
  return (res.stdout || res.stderr).trim().split('\n')[0];
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
add(nodeMajor >= 20 ? 'ok' : 'error', 'node', `v${process.versions.node}${nodeMajor >= 20 ? '' : ' (need >= 20)'}`);

for (const [name, level, why] of [
  ['git', 'error', 'worktrees, review diff, release gate'],
  ['ssh', 'warn', 'VPS tasks'],
  ['npx', 'warn', 'MCP servers (searxng, playwright)'],
  ['uvx', 'warn', 'mcp-server-fetch'],
  ['pi', 'warn', 'Pi agent'],
  ['opencode', 'warn', 'OpenCode agent'],
]) {
  const version = bin(name, name === 'ssh' ? ['-V'] : ['--version']);
  add(version ? 'ok' : level, name, version ?? `not found (${why})`);
}
const pms = ['pnpm', 'npm', 'yarn', 'bun'].filter((pm) => bin(pm));
add(pms.length ? 'ok' : 'error', 'package-managers', pms.join(', ') || 'none found');

const manifest = loadManifest();
const skillIssues = [
  ...validateSkillsDir(path.join(HARNESS_ROOT, manifest.paths.piSkills)),
  ...validateSkillsDir(path.join(HARNESS_ROOT, manifest.paths.opencodeSkills)),
  ...parity(manifest),
];
for (const i of skillIssues) add(i.level, 'skills', `${i.where}: ${i.message}`);
if (!skillIssues.some((i) => i.level === 'error')) add('ok', 'skills', 'frontmatter + Pi/OpenCode parity');

const installed = readJson(path.join(home, '.agent-harness', 'installed.json'), null);
if (!installed) add('warn', 'install', 'harness not installed in home (node tools/install.mjs)');
else {
  const drift = installed.files.filter((f) => !fs.existsSync(f.path) || sha256(f.path) !== f.sha256);
  add(drift.length ? 'warn' : 'ok', 'install', drift.length ? `${drift.length} installed file(s) changed since install: ${drift.slice(0, 3).map((d) => d.path).join(', ')}` : `v${installed.version}, ${installed.files.length} files intact`);
  if (installed.version !== manifest.version) add('warn', 'install', `installed ${installed.version}, harness is ${manifest.version}: reinstall`);
}

add(fs.existsSync(path.join(home, 'AGENTS.md')) ? 'ok' : 'warn', 'memory', fs.existsSync(path.join(home, 'AGENTS.md')) ? '~/AGENTS.md present' : '~/AGENTS.md missing');
if (fs.existsSync(path.join(home, 'AGENTS.md.harness-new'))) add('warn', 'memory', '~/AGENTS.md.harness-new waits for a manual merge');

const ocConfig = ['opencode.jsonc', 'opencode.json'].map((f) => path.join(home, '.config', 'opencode', f)).find((f) => fs.existsSync(f));
if (!ocConfig) add('warn', 'opencode-config', 'no ~/.config/opencode/opencode.json(c)');
else {
  try {
    const cfg = readJsonc(ocConfig);
    const mcp = cfg.mcp ?? {};
    if (mcp.servers) add('warn', 'opencode-config', 'uses "mcp.servers": the official schema expects mcp.<name> directly. Confirm with `opencode mcp list` on your build.');
    const entries = Object.entries(mcp.servers ?? mcp);
    for (const [name, server] of entries) {
      if (server.disabled !== undefined) add('warn', 'opencode-config', `mcp ${name}: "disabled" is not in the official schema, use "enabled": false`);
      const cmd = Array.isArray(server.command) ? server.command : [];
      const viaShell = /^(bash|sh|zsh|cmd|powershell|pwsh)(\.exe)?$/i.test(String(cmd[0] ?? '')) && cmd.some((a) => /^-\w*c$/.test(String(a)));
      const substFields = [server.environment ?? {}, ...(viaShell ? [] : cmd.slice(1))];
      if (JSON.stringify(substFields).includes('${')) add('warn', 'opencode-config', `mcp ${name}: "\${VAR}" is not expanded by OpenCode, use "{env:VAR}"`);
    }
    add('ok', 'opencode-config', `${path.basename(ocConfig)} parsed, ${entries.length} MCP server(s)`);
    const names = entries.map(([n]) => n);
    const lacking = FRONTEND_MCP.filter((n) => !names.includes(n));
    if (lacking.length) add('warn', 'opencode-config', `frontend MCP missing: ${lacking.join(', ')} (see opencode/opencode.jsonc.example)`);
    if (!cfg.permission) add('warn', 'opencode-config', 'no "permission" block: dangerous commands run without approval (node tools/policy.mjs opencode-permission)');
  } catch (error) {
    add('error', 'opencode-config', `${ocConfig}: ${error.message}`);
  }
  const leaks = scanFiles([ocConfig]);
  if (leaks.length) add('error', 'secrets', `${ocConfig} contains ${leaks.length} plaintext secret(s); move them to env and reference {env:VAR}`);
}

const piSettings = path.join(home, '.pi', 'agent', 'settings.json');
if (fs.existsSync(piSettings)) {
  try {
    const s = readJson(piSettings);
    const missing = ['npm:pi-subagents', 'npm:pi-mcp-adapter', 'npm:pi-web-access'].filter((p) => !(s.packages ?? []).includes(p));
    add(missing.length ? 'warn' : 'ok', 'pi-config', missing.length ? `missing packages: ${missing.join(', ')}` : 'required packages listed');
    const piMcp = path.join(home, '.config', 'mcp', 'mcp.json');
    const piServers = Object.keys(readJson(piMcp, {}).mcpServers ?? {});
    const piMissing = FRONTEND_MCP.filter((n) => !piServers.includes(n));
    add(piMissing.length ? 'warn' : 'ok', 'pi-mcp', fs.existsSync(piMcp) ? (piMissing.length ? `~/.config/mcp/mcp.json lacks: ${piMissing.join(', ')}` : `${piServers.length} server(s) incl. frontend set`) : 'no ~/.config/mcp/mcp.json (pi-mcp-adapter has no servers)');
  } catch (error) {
    add('error', 'pi-config', error.message);
  }
} else add('warn', 'pi-config', 'no ~/.pi/agent/settings.json');

for (const [name, why] of [['TAVILY_API_KEY', 'tavily MCP stays off'], ['CONTEXT7_API_KEY', 'context7 works with lower rate limits']]) add(process.env[name] ? 'ok' : 'warn', 'env', `${name} ${process.env[name] ? 'set' : `not set (${why})`}`);

const templatesDir = path.join(HARNESS_ROOT, 'templates', 'frontend');
add(fs.existsSync(path.join(templatesDir, 'playwright.config.ts')) ? 'ok' : 'error', 'templates', fs.existsSync(templatesDir) ? 'frontend templates present' : `missing ${templatesDir}`);
const chrome = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map((b) => bin(b)).find(Boolean);
add(chrome ? 'ok' : 'warn', 'chrome', chrome ?? 'no Chrome/Chromium in PATH (chrome-devtools MCP, lhci need one; playwright installs its own)');

const sshConfig = path.join(home, '.ssh', 'config');
if (fs.existsSync(sshConfig)) {
  const hosts = fs.readFileSync(sshConfig, 'utf8').split('\n').filter((l) => /^\s*Host\s+(?!\*)/.test(l)).length;
  add(hosts ? 'ok' : 'warn', 'ssh', `${hosts} host alias(es) in ~/.ssh/config`);
} else add('warn', 'ssh', 'no ~/.ssh/config (VPS work needs host aliases + keys)');

async function probe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return res.status;
  } catch {
    return null;
  }
}
const searx = flags.searxng && flags.searxng !== true ? flags.searxng : 'http://127.0.0.1:8080';
const status = await probe(`${searx}/search?q=ping&format=json`);
add(status === 200 ? 'ok' : 'warn', 'searxng', status === 200 ? `${searx} answers JSON` : `${searx} ${status ? `HTTP ${status} (enable json format in settings.yml?)` : 'unreachable'}`);

if (flags.mcp) {
  const out = spawnSync('opencode', ['mcp', 'list'], { encoding: 'utf8', timeout: 60000, shell: process.platform === 'win32' });
  if (out.error || out.status !== 0) add('warn', 'mcp-live', `opencode mcp list failed: ${(out.stderr || out.error?.message || '').trim().split('\n')[0]}`);
  else for (const line of out.stdout.split('\n').filter((l) => l.trim())) add(/✗|fail|error/i.test(line) ? 'error' : 'ok', 'mcp-live', line.trim());
}

if (flags.json) console.log(JSON.stringify(results, null, 2));
else {
  const icon = { ok: 'OK  ', warn: 'WARN', error: 'FAIL' };
  for (const r of results) console.log(`${icon[r.level]}  ${r.area.padEnd(16)} ${r.message}`);
  const errors = results.filter((r) => r.level === 'error').length;
  const warns = results.filter((r) => r.level === 'warn').length;
  console.log(`\n${errors} error(s), ${warns} warning(s).${flags.mcp ? '' : ' Add --mcp for a live MCP check.'}`);
}
process.exit(results.some((r) => r.level === 'error') ? 1 : 0);
