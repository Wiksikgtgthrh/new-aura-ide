#!/usr/bin/env node
// Architecture gate: module graph, layer boundaries, cycles, complexity budgets.
// Config: architecture.json | .agent-arch.json | ~/.agent-harness/architecture.json
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, list, readJson, readJsonc, writeJsonAtomic, wildcardToRegExp, stateDir, appendEvent, fail, homeDir } from './lib.mjs';

const SOURCE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**', '**/.git/**', '**/.agent-state/**', '**/coverage/**'];
const DEFAULT_FAIL_ON = ['layer-violation', 'forbidden-import', 'cycle'];

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function walk(dir, skip) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

function loadConfig(cwd, explicit) {
  if (explicit && explicit !== true) {
    if (!fs.existsSync(explicit)) fail(`Config not found: ${explicit}`);
    return { path: path.resolve(explicit), config: readJsonc(explicit) };
  }
  const candidates = [
    path.join(cwd, 'architecture.json'),
    path.join(cwd, '.agent-arch.json'),
    path.join(cwd, 'architecture.jsonc'),
    path.join(homeDir(), '.agent-harness', 'architecture.json'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  return found ? { path: found, config: readJsonc(found) } : null;
}

// Replace comments and string contents with spaces, preserving offsets and newlines,
// so brace matching and function detection are not confused by literals.
function sanitize(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  let state = 'code';
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        while (i < n && src[i] !== '\n') { out[i] = ' '; i += 1; }
        continue;
      }
      if (ch === '/' && next === '*') {
        out[i] = ' '; out[i + 1] = ' '; i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] !== '\n') out[i] = ' '; i += 1; }
        if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { state = ch; out[i] = ' '; i += 1; continue; }
      i += 1;
      continue;
    }
    // inside a string
    if (ch === '\\') { out[i] = ' '; if (i + 1 < n) out[i + 1] = ' '; i += 2; continue; }
    if (ch === state) { out[i] = ' '; state = 'code'; i += 1; continue; }
    if (ch !== '\n') out[i] = ' ';
    i += 1;
  }
  return out.join('');
}

const IMPORT_PATTERNS = [
  /\bimport\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?:[\s\S]*?\s+from\s+)['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function extractSpecifiers(src) {
  const clean = sanitize(src);
  // sanitize blanks string contents, so re-scan the original with literal positions
  const specs = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(src)) !== null) {
      // a real statement keeps its keyword in the sanitized text; commented or stringified ones are blanked
      if (clean[match.index] === ' ') continue;
      specs.push(match[1]);
    }
  }
  return [...new Set(specs)];
}

function packageName(spec) {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec.split('/')[0];
}

function compileMatcher(pattern) {
  const norm = toPosix(pattern).replace(/\/+$/, '');
  const re = wildcardToRegExp(norm);
  const reDeep = wildcardToRegExp(`${norm}/**`);
  return (rel) => re.test(rel) || reDeep.test(rel) || rel === norm;
}

function createResolver(cwd, aliases) {
  const extCandidates = ['', ...SOURCE_EXT, ...SOURCE_EXT.map((e) => `/index${e}`)];
  return (fromRel, spec) => {
    let base = null;
    if (spec.startsWith('.')) {
      base = path.resolve(path.dirname(path.join(cwd, fromRel)), spec);
    } else {
      for (const alias of aliases) {
        const prefix = alias.prefix ?? '';
        if (prefix && spec.startsWith(prefix)) {
          base = path.resolve(cwd, alias.target ?? '', spec.slice(prefix.length));
          break;
        }
      }
    }
    if (!base) return { kind: 'external', name: packageName(spec) };
    for (const ext of extCandidates) {
      const candidate = `${base}${ext}`;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return { kind: 'internal', file: toPosix(path.relative(cwd, candidate)) };
      }
    }
    const looksLikeAsset = /\.(css|scss|sass|less|json|svg|png|jpe?g|webp|gif|md|vue|svelte|astro|html)$/i.test(spec);
    if (looksLikeAsset) return { kind: 'external', name: packageName(spec) };
    // The target may not exist yet (being written in this change): keep the intended path
    // so layer and forbidden-import rules still apply to it.
    return { kind: 'unresolved', spec, guess: toPosix(path.relative(cwd, base)).replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '') };
  };
}

function findCycles(graph) {
  let counter = 0;
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  const visit = (v) => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const scc = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      const selfLoop = scc.length === 1 && (graph.get(scc[0]) ?? new Set()).has(scc[0]);
      if (scc.length > 1 || selfLoop) sccs.push(scc.reverse());
    }
  };
  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return sccs;
}

function lineStartsOf(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function countTopLevelCommas(params) {
  let depth = 0;
  let count = 0;
  let hasContent = false;
  for (const ch of params) {
    if ('([{<'.includes(ch)) depth += 1;
    else if (')]}>'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) count += 1;
    if (!/\s/.test(ch)) hasContent = true;
  }
  return hasContent ? count + 1 : 0;
}

const FN_PATTERNS = [
  /(?:^|[^.\w$])(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(([^()]*)\)/g,
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+?)?=\s*(?:async\s*)?(?:\(([^()]*)\)|([A-Za-z_$][\w$]*))\s*(?::[^={]+?)?=>\s*\{/g,
];

function scanFunctions(rel, src, budgets) {
  const clean = sanitize(src);
  const starts = lineStartsOf(src);
  const issues = [];
  const seen = new Set();
  for (const pattern of FN_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(clean)) !== null) {
      const name = match[1] ?? '<anonymous>';
      const open = clean.indexOf('{', match.index + match[0].length - 1);
      if (open === -1) continue;
      let depth = 0;
      let end = -1;
      let maxDepth = 0;
      for (let i = open; i < clean.length; i += 1) {
        if (clean[i] === '{') { depth += 1; maxDepth = Math.max(maxDepth, depth); }
        else if (clean[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
      }
      if (end === -1) continue;
      const startLine = lineAt(starts, match.index);
      const endLine = lineAt(starts, end);
      const key = `${startLine}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const length = endLine - startLine + 1;
      const paramsRaw = match[2] ?? (match[3] ? match[3] : '');
      const paramCount = match[3] ? 1 : countTopLevelCommas(paramsRaw);
      const where = `${rel}:${startLine}`;
      if (budgets.maxFunctionLines && length > budgets.maxFunctionLines) {
        issues.push({ rule: 'function-too-long', file: rel, line: startLine, message: `${where} ${name} is ${length} lines (budget ${budgets.maxFunctionLines})` });
      }
      if (budgets.maxParams && paramCount > budgets.maxParams) {
        issues.push({ rule: 'too-many-params', file: rel, line: startLine, message: `${where} ${name} takes ${paramCount} parameters (budget ${budgets.maxParams})` });
      }
      if (budgets.maxNesting && maxDepth - 1 > budgets.maxNesting) {
        issues.push({ rule: 'deep-nesting', file: rel, line: startLine, message: `${where} ${name} nests ${maxDepth - 1} levels (budget ${budgets.maxNesting})` });
      }
    }
  }
  return issues;
}

function analyze(cwd, config) {
  const extensions = config.extensions ?? SOURCE_EXT;
  const excludeMatchers = (config.exclude ?? DEFAULT_EXCLUDE).map(compileMatcher);
  const skipDirs = new Set(['node_modules', '.git', '.agent-state', 'dist', 'build', '.next', 'coverage']);
  const files = walk(cwd, skipDirs)
    .map((f) => toPosix(path.relative(cwd, f)))
    .filter((rel) => extensions.includes(path.extname(rel)) && !excludeMatchers.some((m) => m(rel)));

  const layers = (config.layers ?? []).map((layer) => ({ ...layer, match: compileMatcher(layer.path) }));
  const layerOf = (rel) => {
    let best = null;
    for (const layer of layers) {
      if (layer.match(rel) && (!best || layer.path.length > best.path.length)) best = layer;
    }
    return best;
  };
  const forbidden = (config.forbidden ?? []).map((rule) => ({
    ...rule,
    fromMatch: compileMatcher(rule.from),
    toMatch: compileMatcher(rule.to),
  }));
  const forbiddenPackages = config.forbiddenPackages ?? [];
  const resolver = createResolver(cwd, config.aliases ?? []);
  const graph = new Map();
  const externalDeps = new Map();
  const issues = [];
  const budgets = config.budgets ?? {};
  const stats = { files: files.length, edges: 0, external: 0 };

  const boundaryIssues = (rel, targetRel) => {
    const hitForbidden = forbidden.find((r) => r.fromMatch(rel) && r.toMatch(targetRel));
    if (hitForbidden) {
      return [{ rule: 'forbidden-import', severity: 'error', file: rel, line: 0, message: `${rel} -> ${targetRel}${hitForbidden.reason ? ` — ${hitForbidden.reason}` : ''}` }];
    }
    const fromLayer = layerOf(rel);
    const toLayer = layerOf(targetRel);
    if (fromLayer && toLayer && fromLayer.name !== toLayer.name) {
      const allowed = fromLayer.mayImport ?? [];
      if (!allowed.includes(toLayer.name)) {
        return [{ rule: 'layer-violation', severity: 'error', file: rel, line: 0, message: `${fromLayer.name} (${rel}) -> ${toLayer.name} (${targetRel}); allowed: ${allowed.length ? allowed.join(', ') : 'none'}` }];
      }
    }
    return [];
  };

  for (const rel of files) {
    const src = fs.readFileSync(path.join(cwd, rel), 'utf8');
    if (budgets.maxFileLines) {
      const lines = src.split('\n').length;
      if (lines > budgets.maxFileLines) {
        issues.push({ rule: 'file-too-long', severity: 'warning', file: rel, line: 1, message: `${rel} is ${lines} lines (budget ${budgets.maxFileLines})` });
      }
    }
    issues.push(...scanFunctions(rel, src, budgets).map((i) => ({ ...i, severity: 'warning' })));

    const targets = new Set();
    for (const spec of extractSpecifiers(src)) {
      for (const rule of forbiddenPackages) {
        if (wildcardToRegExp(rule.pattern ?? rule).test(spec) || wildcardToRegExp(rule.pattern ?? rule).test(packageName(spec))) {
          issues.push({ rule: 'forbidden-package', severity: 'error', file: rel, line: 0, message: `${rel} imports "${spec}"${rule.reason ? ` — ${rule.reason}` : ''}` });
        }
      }
      const resolved = resolver(rel, spec);
      if (resolved.kind === 'internal') {
        targets.add(resolved.file);
        stats.edges += 1;
        issues.push(...boundaryIssues(rel, resolved.file));
      } else if (resolved.kind === 'external') {
        const normalized = resolved.name.replace(/^node:/, '');
        const bucket = externalDeps.get(normalized) ?? new Set();
        bucket.add(rel);
        externalDeps.set(normalized, bucket);
      } else if (resolved.kind === 'unresolved') {
        issues.push({ rule: 'unresolved-import', severity: 'warning', file: rel, line: 0, message: `${rel} imports "${resolved.spec}" which does not resolve to a project file` });
        issues.push(...boundaryIssues(rel, resolved.guess));
      }
    }
    graph.set(rel, targets);
  }

  stats.external = externalDeps.size;
  if (config.cycles !== false) {
    for (const scc of findCycles(graph)) {
      if (config.cycles?.maxLength && scc.length <= config.cycles.maxLength) continue;
      issues.push({ rule: 'cycle', severity: 'error', file: scc[0], line: 0, message: `import cycle (${scc.length}): ${scc.join(' -> ')} -> ${scc[0]}` });
    }
  }
  return { files, graph, issues, externalDeps, stats, layers: layers.map((l) => ({ name: l.name, path: l.path, mayImport: l.mayImport ?? [] })) };
}

function summarize(result, config) {
  const failOn = config.failOn ?? DEFAULT_FAIL_ON;
  const errors = result.issues.filter((i) => i.severity === 'error' || failOn.includes(i.rule));
  const warnings = result.issues.filter((i) => !errors.includes(i));
  const byRule = {};
  for (const issue of errors) byRule[issue.rule] = (byRule[issue.rule] ?? 0) + 1;
  return { errors, warnings, byRule };
}

function printIssues(issues, label) {
  if (!issues.length) return;
  console.log(`\n${label}:`);
  for (const issue of issues) {
    console.log(`  [${issue.rule}] ${issue.message}`);
  }
}

function printMap(result, cwd) {
  console.log(`Modules: ${result.stats.files}  imports: ${result.stats.edges}  external packages: ${result.stats.external}`);
  for (const layer of result.layers) {
    const count = result.files.filter((f) => compileMatcher(layer.path)(f)).length;
    console.log(`  ${layer.name.padEnd(16)} ${layer.path.padEnd(28)} files=${count}  mayImport=[${layer.mayImport.join(', ')}]`);
  }
  if (result.externalDeps.size) {
    console.log('\nExternal dependencies:');
    for (const [name, users] of [...result.externalDeps.entries()].sort((a, b) => b[1].size - a[1].size)) {
      console.log(`  ${name.padEnd(28)} used by ${users.size}`);
    }
  }
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0] ?? 'check';
  const cwd = path.resolve(flags.cwd && flags.cwd !== true ? flags.cwd : process.cwd());
  const loaded = loadConfig(cwd, flags.config);

  if (command === 'init') {
    const target = path.resolve(cwd, (flags.out && flags.out !== true ? flags.out : 'architecture.json'));
    if (fs.existsSync(target) && !flags.force) fail(`${target} exists; pass --force to overwrite`);
    const srcDir = ['src', 'app', 'lib'].find((d) => fs.existsSync(path.join(cwd, d))) ?? 'src';
    const template = {
      layers: [
        { name: 'domain', path: `${srcDir}/domain`, mayImport: ['domain'] },
        { name: 'application', path: `${srcDir}/application`, mayImport: ['domain', 'application'] },
        { name: 'infrastructure', path: `${srcDir}/infrastructure`, mayImport: ['domain', 'application', 'infrastructure'] },
        { name: 'ui', path: `${srcDir}/ui`, mayImport: ['application', 'domain', 'ui'] },
      ],
      forbidden: [
        { from: `${srcDir}/ui/**`, to: `${srcDir}/infrastructure/**`, reason: 'UI must not reach persistence directly' },
        { from: `${srcDir}/domain/**`, to: `${srcDir}/ui/**`, reason: 'domain must not know about UI' },
      ],
      budgets: { maxFileLines: 400, maxFunctionLines: 60, maxParams: 5, maxNesting: 4 },
      cycles: true,
      failOn: DEFAULT_FAIL_ON,
    };
    if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) template.aliases = [{ prefix: '@/', target: `${srcDir}/` }];
    writeJsonAtomic(target, template);
    console.log(`Wrote ${path.relative(cwd, target)} — adjust layer paths, then run: node ~/.agent-harness/tools/arch.mjs check`);
    return 0;
  }

  if (!loaded) {
    console.error('error: no architecture config (architecture.json / .agent-arch.json)');
    console.error('Run: node ~/.agent-harness/tools/arch.mjs init');
    return 2;
  }

  const result = analyze(cwd, loaded.config);
  const { errors, warnings, byRule } = summarize(result, loaded.config);

  if (!result.files.length) {
    printMap(result, cwd);
    console.error(`error: no source files matched ${loaded.config.extensions?.join(', ') ?? SOURCE_EXT.join(', ')} under ${cwd}`);
    console.error('Architecture is unverified (empty map proves nothing), not passed.');
    return 2;
  }

  if (command === 'map') {
    printMap(result, cwd);
    printIssues(warnings, 'Warnings');
    printIssues(errors, 'Errors');
    return errors.length ? 1 : 0;
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactDir = path.join(stateDir(cwd), 'artifacts');
  const summary = {
    runId,
    cwd,
    config: loaded.path,
    verdict: errors.length ? 'failed' : 'passed',
    stats: result.stats,
    byRule,
    errors,
    warnings,
    finishedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(artifactDir, `arch-${runId}.json`), summary);
  writeJsonAtomic(path.join(artifactDir, 'arch-latest.json'), summary);
  appendEvent(cwd, { type: 'arch.checked', runId, verdict: summary.verdict, errors: errors.length });

  if (flags.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printMap(result, cwd);
    printIssues(errors, 'Errors');
    printIssues(warnings, 'Warnings (non-blocking)');
    console.log(`\nVerdict: ${summary.verdict.toUpperCase()}  artifacts: ${toPosix(path.relative(cwd, path.join(artifactDir, 'arch-latest.json')))}`);
  }
  return errors.length ? 1 : 0;
}

process.exitCode = main();
