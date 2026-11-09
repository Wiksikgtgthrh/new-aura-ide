#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, readJson, writeJsonAtomic, walkFiles, stateDir, appendEvent } from './lib.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const cwd = path.resolve(flags.cwd && flags.cwd !== true ? flags.cwd : process.cwd());
const rel = (f) => path.relative(cwd, f).split(path.sep).join('/');

const pkg = readJson(path.join(cwd, 'package.json'), {});
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const has = (name) => (name in deps ? deps[name] : null);
const pick = (names) => names.filter((n) => has(n)).map((n) => `${n}@${deps[n]}`);

const stack = {
  framework: pick(['next', 'nuxt', '@sveltejs/kit', 'astro', '@remix-run/react', 'react-router', 'vite']),
  ui: pick(['react', 'vue', 'svelte', 'solid-js', 'preact']),
  styling: pick(['tailwindcss', '@tailwindcss/postcss', 'styled-components', '@emotion/react', 'sass', '@vanilla-extract/css']),
  primitives: pick(['@radix-ui/react-dialog', 'radix-ui', '@headlessui/react', '@ark-ui/react', 'react-aria-components', '@base-ui-components/react']),
  icons: pick(['lucide-react', '@heroicons/react', 'react-icons', '@tabler/icons-react', '@phosphor-icons/react', '@radix-ui/react-icons']),
  data: pick(['swr', '@tanstack/react-query', 'zustand', 'jotai', '@reduxjs/toolkit']),
  forms: pick(['react-hook-form', 'zod', 'valibot', '@conform-to/react']),
  motion: pick(['framer-motion', 'motion', 'gsap']),
  i18n: pick(['next-intl', 'i18next', 'react-i18next', '@lingui/core']),
  tests: pick(['vitest', 'jest', '@testing-library/react', '@playwright/test', '@axe-core/playwright', '@lhci/cli', '@storybook/react']),
};

const files = walkFiles(cwd).filter((f) => !rel(f).startsWith('.agent-'));
const shadcn = readJson(path.join(cwd, 'components.json'), null);

const uiDirs = ['components/ui', 'src/components/ui', 'app/components/ui'].map((d) => path.join(cwd, d)).filter((d) => fs.existsSync(d));
const uiComponents = uiDirs.flatMap((d) => fs.readdirSync(d).filter((f) => /\.(tsx|jsx|vue|svelte)$/.test(f)).map((f) => f.replace(/\.\w+$/, '')));
const componentFiles = files.filter((f) => /\/components\//.test(rel(f)) && !/\/components\/ui\//.test(rel(f)) && /\.(tsx|jsx|vue|svelte)$/.test(f));

const cssFiles = files.filter((f) => f.endsWith('.css'));
const tokens = { root: {}, dark: {}, theme: {} };
let tailwindMode = fs.readdirSync(cwd).some((f) => /^tailwind\.config\./.test(f)) ? 'v3 (tailwind.config)' : null;
for (const file of cssFiles) {
  const css = fs.readFileSync(file, 'utf8');
  if (/@import\s+["']tailwindcss["']/.test(css)) {tailwindMode = 'v4 (@import "tailwindcss" + @theme)';}
  for (const [scope, re] of [
    ['root', /:root\s*\{([^}]*)\}/g],
    ['dark', /\.dark\s*\{([^}]*)\}/g],
    ['theme', /@theme(?:\s+inline)?\s*\{([^}]*)\}/g],
  ]) {
    for (const block of css.matchAll(re)) {
      for (const decl of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {tokens[scope][decl[1]] = decl[2].trim();}
    }
  }
}

const fonts = new Set();
for (const f of files.filter((x) => /\.(tsx|jsx|ts|js)$/.test(x) && /layout|_app|root/.test(path.basename(x)))) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']next\/font\/(google|local)["']/g)) {for (const n of m[1].split(',')) {fonts.add(`${n.trim()} (${m[2]})`);}}
}

const DRIFT_RULES = [
  { id: 'hex-color', re: /#[0-9a-fA-F]{3,8}\b/g, why: 'raw hex instead of a token' },
  { id: 'palette-class', re: /\b(?:bg|text|border|ring|fill|stroke|from|to|via)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g, why: 'palette color instead of semantic token' },
  { id: 'arbitrary-value', re: /\b[a-z-]+-\[[^\]\s]+\]/g, why: 'arbitrary Tailwind value' },
  { id: 'inline-style', re: /style=\{\{/g, why: 'inline style object' },
  { id: 'white-black', re: /\b(?:bg|text|border)-(?:white|black)\b/g, why: 'white/black instead of background/foreground' },
];
const drift = Object.fromEntries(DRIFT_RULES.map((r) => [r.id, { count: 0, why: r.why, files: {} }]));
for (const f of files.filter((x) => /\.(tsx|jsx|vue|svelte)$/.test(x))) {
  const src = fs.readFileSync(f, 'utf8');
  for (const r of DRIFT_RULES) {
    const n = (src.match(r.re) ?? []).length;
    if (!n) {continue;}
    drift[r.id].count += n;
    drift[r.id].files[rel(f)] = n;
  }
}
const topFiles = (files) => Object.entries(files).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([f, n]) => `${f} (${n})`).join(', ');

const map = {
  generatedAt: new Date().toISOString(),
  cwd,
  stack,
  tailwind: tailwindMode,
  shadcn: shadcn ? { style: shadcn.style ?? null, baseColor: shadcn.tailwind?.baseColor ?? null, aliases: shadcn.aliases ?? null } : null,
  uiComponents,
  featureComponents: componentFiles.map(rel),
  tokens,
  fonts: [...fonts],
  drift: Object.fromEntries(Object.entries(drift).map(([k, v]) => [k, { count: v.count, why: v.why, top: topFiles(v.files) }])),
};

const line = (label, values) => `- **${label}:** ${values.length ? values.join(', ') : '—'}`;
const tokenList = (obj) => Object.keys(obj).length ? Object.keys(obj).join(' ') : '—';
const md = `# Design map

Generated ${map.generatedAt} by design-map.mjs. Read before writing UI. Reuse what is here; add a token or primitive only when nothing fits, and say so in the handoff.

## Stack
${Object.entries(stack).map(([k, v]) => line(k, v)).join('\n')}
- **tailwind:** ${tailwindMode ?? '—'}
- **shadcn:** ${shadcn ? `style=${map.shadcn.style}, baseColor=${map.shadcn.baseColor}` : '—'}
- **fonts:** ${map.fonts.join(', ') || '—'}

## Primitives (reuse, do not duplicate)
${uiComponents.length ? uiComponents.map((c) => `\`${c}\``).join(' ') : '— (no components/ui)'}

## Feature components
${map.featureComponents.length ? map.featureComponents.slice(0, 60).map((c) => `- ${c}`).join('\n') : '—'}${map.featureComponents.length > 60 ? `\n- … ${map.featureComponents.length - 60} more` : ''}

## Tokens
- **:root** ${tokenList(tokens.root)}
- **.dark** ${tokenList(tokens.dark)}
- **@theme** ${tokenList(tokens.theme)}

## Drift (lower is better; a diff must not raise these)
| rule | count | why | top files |
|---|---|---|---|
${Object.entries(map.drift).map(([k, v]) => `| ${k} | ${v.count} | ${v.why} | ${v.top || '—'} |`).join('\n')}
`;

const outDir = stateDir(cwd);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'design-map.md'), md);
writeJsonAtomic(path.join(outDir, 'design-map.json'), map);
appendEvent(cwd, { type: 'design-map.generated', primitives: uiComponents.length, drift: Object.fromEntries(Object.entries(map.drift).map(([k, v]) => [k, v.count])) });

if (flags.compare && flags.compare !== true) {
  const before = readJson(path.resolve(flags.compare), null);
  if (!before) {
    console.error(`Cannot read ${flags.compare}`);
    process.exit(1);
  }
  const worse = Object.entries(map.drift).filter(([k, v]) => v.count > (before.drift?.[k]?.count ?? 0));
  for (const [k, v] of Object.entries(map.drift)) {console.log(`${k.padEnd(16)} ${String(before.drift?.[k]?.count ?? 0).padStart(5)} -> ${String(v.count).padStart(5)}`);}
  console.log(worse.length ? `\nDrift increased: ${worse.map(([k]) => k).join(', ')}` : '\nNo drift increase.');
  process.exit(worse.length ? 1 : 0);
}

if (flags.json) {console.log(JSON.stringify(map, null, 2));}
else {console.log(`${md}\nSaved: ${rel(path.join(outDir, 'design-map.md'))}`);}
