#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, readJson, writeJsonAtomic, resolveConfig, wildcardToRegExp, walkFiles, stateDir, appendEvent, fail } from './lib.mjs';

const RANK = { allow: 0, ask: 1, deny: 2 };

export const SECRET_RULES = [
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { id: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/ },
  { id: 'tavily-key', re: /\btvly-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    id: 'generic-assignment',
    re: /(?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i,
    placeholder: /ВСТАВЬ|INSERT|YOUR_|your-|xxx|changeme|example|placeholder|\$\{|\{env:|<[^>]+>/i,
  },
];

export function loadPolicy(cwd = process.cwd()) {
  const file = resolveConfig('.release-policy.json', cwd);
  if (!file) {fail('No .release-policy.json found');}
  return { file, policy: readJson(file) };
}

const SECRET_FILE_RE = /(?:^|[\s/'"=<>:@])(?:\.env(?:\.[\w-]+)*|[\w.-]*\.pem|[\w.-]*\.key|id_rsa[\w.-]*|id_ed25519[\w.-]*|id_ecdsa[\w.-]*|\.npmrc|\.netrc|\.pgpass|credentials(?:\.json)?|auth\.json)(?=$|[\s'"|;&)<>])/;
const SECRET_FILE_ALLOW_RE = /\.env\.(?:example|sample|template|dist|defaults)\b|auth\.json\.example\b/;

export function touchesSecretFile(text) {
  const cleaned = text.replace(new RegExp(SECRET_FILE_ALLOW_RE.source, 'g'), ' ');
  return SECRET_FILE_RE.test(cleaned);
}

function unwrapShell(command) {
  const nested = [];
  const re = /\b(?:bash|sh|zsh|dash)\s+(?:-\w+\s+)*-c\s+(['"])([\s\S]*?)\1/g;
  for (const m of command.matchAll(re)) {nested.push(m[2]);}
  for (const m of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {nested.push(m[1] ?? m[2]);}
  return nested;
}

function splitSegments(command) {
  const parts = [command, ...unwrapShell(command)];
  return parts
    .flatMap((part) => part.split(/\s*(?:&&|\|\||;|\||\n)\s*/))
    .map((s) => s.trim().replace(/^(?:sudo\s+(?:-\S+\s+)*|env\s+(?:\S+=\S+\s+)*|command\s+|exec\s+|nohup\s+|time\s+)/, ''))
    .filter(Boolean);
}

function matchList(patterns, text) {
  return (patterns ?? []).find((p) => wildcardToRegExp(p).test(text)) ?? null;
}

export function classify(command, policy) {
  const rules = policy.commands ?? {};
  if (rules.denySecretFiles !== false && touchesSecretFile(command)) {
    return { decision: 'deny', rule: '(secret-file)', segment: command.trim() };
  }
  const checks = [command.trim(), ...splitSegments(command)];
  let decision = { decision: 'allow', rule: null, segment: null };
  let anyAllowed = false;
  for (const text of checks) {
    const deny = matchList(rules.deny, text);
    const ask = matchList(rules.ask, text);
    const allow = matchList(rules.allow, text);
    let current;
    if (deny) {current = { decision: 'deny', rule: deny, segment: text };}
    else if (ask) {current = { decision: 'ask', rule: ask, segment: text };}
    else if (allow) {
      anyAllowed = true;
      continue;
    } else if (text === command.trim()) {continue;}
    else {current = { decision: rules.default ?? 'ask', rule: '(default)', segment: text };}
    if (RANK[current.decision] > RANK[decision.decision]) {decision = current;}
  }
  if (!anyAllowed && decision.decision === 'allow') {decision = { decision: rules.default ?? 'ask', rule: '(default)', segment: command.trim() };}
  return decision;
}

function scanText(text) {
  const findings = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    for (const rule of SECRET_RULES) {
      const match = line.match(rule.re);
      if (!match) {continue;}
      if (rule.placeholder && rule.placeholder.test(match[0])) {continue;}
      const value = match[1] ?? match[0];
      findings.push({ line: index + 1, rule: rule.id, preview: `${value.slice(0, 4)}…${'*'.repeat(6)}` });
    }
  });
  return findings;
}

export function scanFiles(files) {
  const results = [];
  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > 1_000_000) {continue;}
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) {continue;}
    for (const f of scanText(buf.toString('utf8'))) {results.push({ file, ...f });}
  }
  return results;
}

function gitFiles(cwd, staged) {
  const args = staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACM'] : ['ls-files', '--cached', '--others', '--exclude-standard'];
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {return null;}
  return res.stdout.split('\n').filter(Boolean).map((f) => path.join(cwd, f));
}

function opencodePermission(policy) {
  const rules = policy.commands ?? {};
  const bash = { '*': rules.default ?? 'ask' };
  for (const p of rules.allow ?? []) {bash[p] = 'allow';}
  for (const p of rules.ask ?? []) {bash[p] = 'ask';}
  for (const p of rules.deny ?? []) {bash[p] = 'deny';}
  return {
    permission: {
      bash,
      edit: 'allow',
      read: {
        '*': 'allow',
        '*.env': 'deny',
        '*.env.*': 'deny',
        '*.env.example': 'allow',
        '*.env.sample': 'allow',
        '*.env.template': 'allow',
        '*.pem': 'deny',
        '*.key': 'deny',
        '*id_rsa*': 'deny',
        '*id_ed25519*': 'deny',
        '*id_ecdsa*': 'deny',
        '*.npmrc': 'deny',
        '*.netrc': 'deny',
        '*.pgpass': 'deny',
      },
      external_directory: 'ask',
      doom_loop: 'ask',
    },
  };
}

const cwd = process.cwd();
const commands = {
  check([command]) {
    if (!command) {fail('Usage: policy.mjs check "<command>"');}
    const { policy } = loadPolicy(cwd);
    const result = classify(command, policy);
    console.log(JSON.stringify(result));
    process.exit(result.decision === 'allow' ? 0 : result.decision === 'ask' ? 2 : 3);
  },

  scan(paths, flags) {
    let files;
    if (paths.length) {files = paths.flatMap((p) => (fs.statSync(p).isDirectory() ? walkFiles(p) : [path.resolve(p)]));}
    else {files = gitFiles(cwd, Boolean(flags.staged)) ?? walkFiles(cwd);}
    const findings = scanFiles(files);
    for (const f of findings) {console.log(`${path.relative(cwd, f.file)}:${f.line}  ${f.rule}  ${f.preview}`);}
    console.log(findings.length ? `\n${findings.length} potential secret(s). Remove them and rotate the keys.` : `No secrets found in ${files.length} file(s).`);
    process.exit(findings.length ? 1 : 0);
  },

  'approve-release'(_, flags) {
    if (!flags.by || flags.by === true) {fail('--by <human> is required');}
    if (!flags.rollback || flags.rollback === true || !fs.existsSync(flags.rollback)) {fail('--rollback <file> must point to an existing rollback plan');}
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim() || null;
    const record = { by: flags.by, rollback: flags.rollback, target: flags.target ?? null, head, at: new Date().toISOString() };
    writeJsonAtomic(path.join(stateDir(cwd), 'approvals', 'release.json'), record);
    appendEvent(cwd, { type: 'release.approved', by: flags.by, head });
    console.log(`Release approved by ${flags.by} for ${head ?? 'non-git workspace'}`);
  },

  release() {
    const { policy } = loadPolicy(cwd);
    const rules = policy.release ?? {};
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok, detail });

    const status = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
    if (rules.requireCleanTree) {add('clean-tree', status.status === 0 && !status.stdout.trim(), status.status === 0 ? `${status.stdout.split('\n').filter(Boolean).length} changed file(s)` : 'not a git repo');}

    if (rules.requireGatesPassed) {
      const gates = readJson(path.join(stateDir(cwd), 'artifacts', 'gates-latest.json'), null);
      const ageMin = gates ? (Date.now() - Date.parse(gates.finishedAt)) / 60000 : Infinity;
      add('gates-passed', gates?.verdict === 'passed' && ageMin <= (rules.gatesMaxAgeMinutes ?? 60), gates ? `${gates.verdict}, ${Math.round(ageMin)} min ago` : 'no gates run');
    }

    const secrets = scanFiles(gitFiles(cwd, false) ?? walkFiles(cwd));
    add('no-secrets', secrets.length === 0, `${secrets.length} finding(s)`);

    if (rules.requireApproval || rules.requireRollbackPlan) {
      const approval = readJson(path.join(stateDir(cwd), 'approvals', 'release.json'), null);
      if (rules.requireApproval) {add('approval', Boolean(approval) && (!approval.head || approval.head === head), approval ? `by ${approval.by} for ${approval.head?.slice(0, 10)}` : 'missing');}
      if (rules.requireRollbackPlan) {add('rollback-plan', Boolean(approval?.rollback && fs.existsSync(path.resolve(cwd, approval.rollback))), approval?.rollback ?? 'missing');}
    }

    for (const c of checks) {console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(14)} ${c.detail}`);}
    const ok = checks.every((c) => c.ok);
    console.log(`\nRelease gate: ${ok ? 'OPEN' : 'BLOCKED'}`);
    process.exit(ok ? 0 : 1);
  },

  'opencode-permission'() {
    const { policy } = loadPolicy(cwd);
    console.log(JSON.stringify(opencodePermission(policy), null, 2));
  },
};

const HELP = `Usage: node policy.mjs <command>

  check "<shell command>"        exit 0 allow, 2 ask (needs human approval), 3 deny
  scan [paths...] [--staged]     secret scan of git files (or given paths); exit 1 on findings
  approve-release --by <human> --rollback <file> [--target prod]
  release                        verify clean tree, fresh passing gates, no secrets, approval, rollback
  opencode-permission            print an OpenCode "permission" block generated from the policy

Policy file: ./.release-policy.json, else ~/.agent-harness/.release-policy.json`;

const isMain = process.argv[1]?.endsWith('policy.mjs');
if (isMain) {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = commands[positional[0]];
  if (!command) {
    console.log(HELP);
    process.exit(positional[0] ? 1 : 0);
  }
  command(positional.slice(1), flags);
}
