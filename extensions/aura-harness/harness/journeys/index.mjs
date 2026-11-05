// journeys/index.mjs — реестр встроенных journeys.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HARNESS_ROOT } from '../tools/lib.mjs';

export async function discoverJourneys() {
  const dir = path.join(HARNESS_ROOT, 'journeys', 'frontend');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.journey.mjs')).sort();
  const out = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    if (mod.default?.id) out.push(mod.default);
  }
  return out;
}
