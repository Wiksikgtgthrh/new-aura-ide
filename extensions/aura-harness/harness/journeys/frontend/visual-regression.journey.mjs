// journeys/frontend/visual-regression.journey.mjs
// Visual journey: детерминированный seed + замороженные таймеры → стабильные кадры ключевых
// состояний; сравнение с baseline после каждой правки. Обновление baseline — только через
// --update-snapshots (policy: отдельное подтверждение).
import fs from 'node:fs';
import path from 'node:path';
import { diffScreenshots } from '../lib/visual-diff.mjs';
import { freeze } from '../fixtures/deterministic.mjs';
import { visible } from '../lib/assert.mjs';

export default {
  id: 'visual-regression',
  title: 'Visual regression journey: ключевые состояния против baseline',
  preconditions: ['seed + freeze фикстуры активны', 'baseline существует или создаётся --update-snapshots'],
  completion: ['каждый checkpoint совпадает с baseline в пределах порога'],
  fixtures: { seed: 42, clock: 1760000000000 },

  steps: (cfg) => {
    const s = {
      openAuth: '#btn-login',
      modal: '#auth-modal',
      ...cfg.selectors?.visual,
    };
    const tolerance = cfg.visual?.maxDiffRatio ?? 0.01;

    const checkpoint = (name, prepare) => ({
      name: `checkpoint: ${name}`,
      run: async (page, ctx) => {
        if (prepare) await prepare(page);
        await freeze(page);
        await page.waitForTimeout(150);
        const shotName = await ctx.shot(`visual-${name}`, { animations: 'disabled' });
        const current = path.join(ctx.artifactsDir, shotName);
        const baseline = path.join(ctx.baselineDir, `visual-${name}.png`);
        if (ctx.updateSnapshots || !fs.existsSync(baseline)) {
          fs.mkdirSync(ctx.baselineDir, { recursive: true });
          fs.copyFileSync(current, baseline);
          if (!ctx.updateSnapshots) {
            throw new Error(`baseline для «${name}» создан — перезапустите journey для сравнения`);
          }
          return;
        }
        const diff = await diffScreenshots(page, baseline, current, { maxDiffRatio: tolerance });
        if (!diff.ok) {
          throw new Error(`«${name}» отличается от baseline: ${(diff.diffRatio * 100).toFixed(2)}% пикселей${diff.reason ? ` (${diff.reason})` : ''}`);
        }
      },
    });

    return [
      checkpoint('terminal-idle'),
      checkpoint('auth-modal', async (page) => {
        await page.locator(s.openAuth).click();
        await visible(page, s.modal);
      }),
    ];
  },
};
