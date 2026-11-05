// journeys/frontend/theme.journey.mjs
// Theme journey: dark ↔ light, persistence после refresh, axe-контраст в обеих темах,
// storage-контракт (тема — допустимое исключение persistence).
import { textMatches, storageWithinContract, assertChartAlive } from '../lib/assert.mjs';

export default {
  id: 'theme',
  title: 'Theme journey: переключение, persistence, контраст в обеих темах',
  preconditions: ['есть переключатель темы', 'тема хранится по storage-контракту'],
  completion: [
    'обе темы проходят axe color-contrast',
    'тема переживает refresh',
    'график читаем в обеих темах',
    'localStorage не растёт мимо контракта',
  ],
  fixtures: { seed: 42, cleanStorage: true },

  steps: (cfg) => {
    const s = {
      toggle: '#btn-theme',
      chart: '#chart',
      ...cfg.selectors?.theme,
    };
    const themeOf = (page) => page.evaluate(() => document.documentElement.dataset.theme || 'dark');
    return [
      {
        name: 'dark: axe + график читаем',
        screenshot: 'theme-dark',
        a11y: true,
        run: async (page) => {
          if ((await themeOf(page)) !== 'dark') await page.locator(s.toggle).click();
          await assertChartAlive(page, s.chart);
        },
      },
      {
        name: 'переключение в light: axe + график перекрасился',
        screenshot: 'theme-light',
        a11y: true,
        run: async (page) => {
          await page.locator(s.toggle).click();
          await page.waitForTimeout(400);
          if ((await themeOf(page)) !== 'light') throw new Error('тема не переключилась в light');
          await assertChartAlive(page, s.chart);
        },
      },
      {
        name: 'refresh → тема сохранилась; storage в контракте',
        run: async (page, ctx) => {
          await page.reload({ waitUntil: 'networkidle' });
          await page.waitForTimeout(400);
          if ((await themeOf(page)) !== 'light') throw new Error('тема не пережила refresh');
          await storageWithinContract(page, ctx.config.storageContract?.allowed ?? []);
        },
      },
      {
        name: 'обратно в dark + refresh',
        run: async (page) => {
          await page.locator(s.toggle).click();
          await page.reload({ waitUntil: 'networkidle' });
          await page.waitForTimeout(400);
          if ((await themeOf(page)) !== 'dark') throw new Error('тема не вернулась в dark после refresh');
        },
      },
    ];
  },
};
