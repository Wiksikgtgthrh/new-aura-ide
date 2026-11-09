#!/usr/bin/env node
// tools/journeys.mjs — раннер сценарных frontend-journeys.
//
// Использование:
//   node ~/.agent-harness/tools/journeys.mjs --cwd <проект> [--url http://...]
//     [--journey auth,theme] [--list] [--headed] [--seed 42] [--update-snapshots]
//
// Конфиг проекта: journeys.config.json (url, serve, storageContract, selectors, perf, visual).
// Артефакты: .agent-state/artifacts/journeys-<ts>/ (скриншоты, summary.json, report.md).
// Exit codes: 0 — passed, 1 — failed, 2 — unverified (нет playwright/конфига/journeys).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs, list, readJson, writeJsonAtomic, stateDir, appendEvent, fail } from './lib.mjs';
import { discoverJourneys } from '../journeys/index.mjs';
import { loadPlaywright, axeSource, runStep, makeCtx } from '../journeys/lib/runtime.mjs';
import { deterministicInitScript } from '../journeys/fixtures/deterministic.mjs';
import { cleanStorage } from '../journeys/fixtures/storage.mjs';
import { viewport } from '../journeys/fixtures/viewports.mjs';

async function waitForUrl(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) {return true;}
    } catch { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const cwd = path.resolve(flags.cwd && flags.cwd !== true ? flags.cwd : process.cwd());
  const config = readJson(path.join(cwd, 'journeys.config.json'), {});
  const seed = Number(flags.seed ?? config.seed ?? 42);

  const journeys = await discoverJourneys();

  if (flags.list) {
    for (const j of journeys) {
      console.log(`${j.id}\n  ${j.title}\n  предусловия: ${j.preconditions.join('; ')}`);
    }
    return;
  }

  const url = flags.url && flags.url !== true ? flags.url : config.url;
  if (!url) {fail('Не задан URL: --url http://... или "url" в journeys.config.json', 2);}

  const playwright = await loadPlaywright(cwd);
  if (!playwright) {
    console.log('playwright не найден ни в проекте, ни в ~/node_modules.');
    console.log('Verdict: UNVERIFIED — поставьте playwright (npm i -D playwright) и повторите.');
    process.exit(2);
  }

  // --- dev-сервер: поднимаем, если задан и url недоступен ---
  let server = null;
  if (!(await waitForUrl(url, 3000))) {
    if (!config.serve) {fail(`URL ${url} недоступен и "serve" в journeys.config.json не задан`, 2);}
    server = spawn(config.serve, { cwd, shell: true, stdio: 'ignore' });
    if (!(await waitForUrl(url))) {fail(`serve не поднял ${url}: ${config.serve}`, 2);}
  }

  const only = list(flags.journey);
  const selected = journeys.filter((j) => !only.length || only.includes(j.id));
  if (!selected.length) {fail(`Нет journeys под фильтр: ${only.join(', ')}`, 2);}

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactsDir = path.join(stateDir(cwd), 'artifacts', `journeys-${runId}`);
  const baselineDir = path.join(stateDir(cwd), 'journeys-baseline');
  fs.mkdirSync(artifactsDir, { recursive: true });

  const axeSrc = axeSource(cwd);
  const browser = await playwright.chromium.launch({ headless: !flags.headed });

  const results = [];
  try {
    for (const journey of selected) {
      console.log(`\n> ${journey.id}: ${journey.title}`);
      const context = await browser.newContext({ viewport: viewport('desktop') });
      await context.addInitScript(
        deterministicInitScript(seed, journey.fixtures?.clock ?? null, { startPaused: Boolean(journey.fixtures?.freezeOnLoad) })
      );
      if (journey.fixtures?.cleanStorage) {await cleanStorage(context);}

      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));

      const ctx = {
        ...makeCtx({ page, journey, config, artifactsDir, axeSrc, updateSnapshots: Boolean(flags['update-snapshots']) }),
        artifactsDir,
        baselineDir,
        seed,
        async setViewport(name) {
          await page.setViewportSize(viewport(name));
        },
      };

      const jr = { id: journey.id, title: journey.title, status: 'passed', steps: [], pageErrors };
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      } catch {
        await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      }
      await page.waitForTimeout(800);

      let broken = false;
      for (const step of journey.steps(config)) {
        if (broken) {
          jr.steps.push({ name: step.name, status: 'skipped', reason: 'предыдущий шаг упал' });
          continue;
        }
        const res = await runStep(step, page, ctx);
        if (res.status === 'failed' && step.optional) {res.status = 'warning';}
        if (res.a11y && res.a11y.status === 'failed') {
          res.status = step.optional ? 'warning' : 'failed';
          res.error = `axe: ${res.a11y.violations.map((v) => `${v.impact}:${v.id}(${v.nodes})`).join(', ')}`;
        }
        jr.steps.push(res);
        const mark = { passed: 'ok', failed: 'FAIL', warning: 'warn', skipped: 'skip' }[res.status];
        console.log(`  [${mark}] ${step.name}${res.error ? ` — ${res.error}` : ''}`);
        if (res.status === 'failed') { jr.status = 'failed'; broken = true; }
      }
      if (jr.steps.some((s) => s.status === 'warning') && jr.status === 'passed') {jr.status = 'warning';}
      await context.close();
      results.push(jr);
    }
  } finally {
    await browser.close();
    server?.kill();
  }

  const failed = results.filter((r) => r.status === 'failed');
  const warned = results.filter((r) => r.status === 'warning');
  const verdict = failed.length ? 'failed' : 'passed';

  const summary = {
    runId, cwd, url, seed, verdict,
    journeys: results.map(({ id, status, title }) => ({ id, status, title })),
    warnings: warned.map((r) => r.id),
    finishedAt: new Date().toISOString(),
    results,
  };
  writeJsonAtomic(path.join(artifactsDir, 'summary.json'), summary);
  writeJsonAtomic(path.join(stateDir(cwd), 'artifacts', 'journeys-latest.json'), summary);

  const report = [
    `# Journeys report — ${runId}`,
    ``,
    `URL: ${url} · seed: ${seed} · verdict: **${verdict.toUpperCase()}**`,
    ``,
    ...results.map((r) => [
      `## ${r.id} — ${r.status}`,
      ``,
      ...r.steps.map((s) => `- [${s.status}] ${s.name}${s.error ? ` — ${s.error}` : ''}${s.screenshot ? ` (📷 ${s.screenshot})` : ''}`),
      r.pageErrors.length ? `\npage errors: ${r.pageErrors.join(' | ')}` : '',
      ``,
    ].join('\n')),
  ].join('\n');
  fs.writeFileSync(path.join(artifactsDir, 'report.md'), report);

  appendEvent(cwd, { type: 'journeys.finished', runId, verdict });
  console.log(`\nVerdict: ${verdict.toUpperCase()}  artifacts: ${path.relative(cwd, artifactsDir)}`);
  if (warned.length) {console.log(`Warnings (known gaps): ${warned.map((r) => r.id).join(', ')}`);}
  process.exit(verdict === 'passed' ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('journeys.mjs')) {
  main().catch((error) => fail(error.message));
}
