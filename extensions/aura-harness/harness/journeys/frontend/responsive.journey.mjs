// journeys/frontend/responsive.journey.mjs
// Responsive journey: desktop/tablet/mobile — перелив, порядок панелей, живой график, модалка.
import { assertNoHorizontalOverflow, assertChartAlive, visible } from '../lib/assert.mjs';
import { VIEWPORTS } from '../fixtures/viewports.mjs';

export default {
  id: 'responsive',
  title: 'Responsive journey: desktop / tablet / mobile',
  preconditions: ['приложение загружено на каждом вьюпорте'],
  completion: [
    'ни на одном вьюпорте нет горизонтального перелива',
    'график живой на всех размерах',
    'модалка доступна на mobile',
  ],
  fixtures: { seed: 42 },

  // Особый journey: шаги сами пересоздают страницу под вьюпорты через ctx.setViewport
  steps: (cfg) => {
    const s = {
      chart: '#chart',
      openAuth: '#btn-login',
      modal: '#auth-modal',
      ...cfg.selectors?.responsive,
    };
    const names = cfg.viewports ?? Object.keys(VIEWPORTS);
    const steps = [];
    for (const name of names) {
      steps.push({
        name: `${name}: нет перелива, график живой`,
        screenshot: `viewport-${name}`,
        run: async (page, ctx) => {
          await ctx.setViewport(name);
          await page.waitForTimeout(600);
          await assertNoHorizontalOverflow(page);
          await assertChartAlive(page, s.chart);
        },
      });
    }
    steps.push({
      name: 'mobile: auth-модалка открывается и влезает в экран',
      screenshot: 'mobile-modal',
      a11y: true,
      run: async (page, ctx) => {
        await ctx.setViewport('mobile');
        await page.locator(s.openAuth).click();
        await visible(page, s.modal, 'модалка на mobile');
        await assertNoHorizontalOverflow(page);
        await page.keyboard.press('Escape');
      },
    });
    return steps;
  },
};
