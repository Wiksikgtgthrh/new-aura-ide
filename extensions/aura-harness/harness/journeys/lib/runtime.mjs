// journeys/lib/runtime.mjs — браузерный ранний слой: playwright, контексты, шаги, скриншоты, axe.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { HARNESS_ROOT, homeDir } from '../../tools/lib.mjs';

// --- playwright / axe разрешение: сначала проект, потом домашний node_modules ---
function resolvePackage(name, cwd) {
  for (const base of [cwd, homeDir(), HARNESS_ROOT]) {
    try {
      const req = createRequire(path.join(base, 'noop.js'));
      return req.resolve(name);
    } catch { /* next */ }
  }
  return null;
}

export async function loadPlaywright(cwd) {
  const entry = resolvePackage('playwright', cwd) ?? resolvePackage('playwright-core', cwd);
  if (!entry) return null;
  const mod = await import(pathToFileURL(entry).href);
  return mod.chromium ? mod : mod.default;
}

export function axeSource(cwd) {
  const entry = resolvePackage('axe-core', cwd) ?? resolvePackage('axe-core/axe.min.js', cwd);
  if (!entry) return null;
  const file = entry.endsWith('.js') && fs.existsSync(entry) ? entry : null;
  if (!file) return null;
  // берём min-сборку рядом, если основная — CJS-обёртка
  const min = path.join(path.dirname(file), 'axe.min.js');
  return fs.existsSync(min) ? fs.readFileSync(min, 'utf8') : fs.readFileSync(file, 'utf8');
}

// --- Запуск шага ---
export async function runStep(step, page, ctx) {
  const started = Date.now();
  const result = { name: step.name, status: 'passed', durationMs: 0 };
  try {
    await step.run(page, ctx);
    if (step.screenshot) result.screenshot = await ctx.shot(step.screenshot === true ? step.name : step.screenshot);
    if (step.a11y) result.a11y = await ctx.axe(page);
  } catch (error) {
    result.status = 'failed';
    result.error = error.message;
    try { result.screenshot = await ctx.shot(`FAILED-${step.name}`); } catch { /* ignore */ }
  }
  result.durationMs = Date.now() - started;
  return result;
}

// --- Контекст путешествия ---
export function makeCtx({ page, journey, config, artifactsDir, axeSrc, updateSnapshots }) {
  const safe = (s) => s.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 80);
  return {
    config,
    journey,
    updateSnapshots,
    async shot(name, opts = {}) {
      const file = path.join(artifactsDir, `${journey.id}--${safe(name)}.png`);
      await page.screenshot({ path: file, ...opts });
      return path.basename(file);
    },
    async axe(pg) {
      if (!axeSrc) return { status: 'unverified', reason: 'axe-core not resolvable (npm i -D axe-core)' };
      await pg.addScriptTag({ content: axeSrc });
      const res = await pg.evaluate(async () => {
        const r = await window.axe.run({ resultTypes: ['violations'] });
        return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help }));
      });
      return { status: res.length ? 'failed' : 'passed', violations: res };
    },
  };
}

export { resolvePackage };
