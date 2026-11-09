// journeys/frontend/data-state.journey.mjs
// Data-state journey: pause/resume realtime, stale-индикатор, детерминизм по seed,
// fallback при падении CDN-зависимости.
// Шаги, для которых у приложения нет контракта (stale-индикатор, CDN-fallback), честно падают —
// это и есть материал для правил.
import { freeze, resume, isFrozen } from '../fixtures/deterministic.mjs';
import { visible } from '../lib/assert.mjs';

export default {
  id: 'data-state',
  title: 'Data-state journey: realtime pause/resume, stale, детерминизм, CDN-fallback',
  preconditions: ['realtime-движок работает', 'есть канвас/DOM, зависящий от тиков'],
  completion: [
    'freeze останавливает обновления, resume возобновляет',
    'при паузе приложение либо показывает stale-индикатор, либо это зафиксировано как отсутствующее требование',
    'одинаковый seed даёт одинаковую первую цену',
    'падение CDN графика не даёт молча пустой экран',
  ],
  fixtures: { seed: 42, freezeOnLoad: true },

  steps: (cfg) => {
    const s = {
      price: '#pair-price',
      staleIndicator: '[data-stale], .stale-indicator',
      chart: '#chart',
      ...cfg.selectors?.dataState,
    };
    const readPrice = (page) => page.locator(s.price).first().textContent();
    return [
      {
        name: 'детерминизм: seed фиксирует первое значение',
        run: async (page) => {
          await freeze(page); // до чтения, чтобы тик не вклинился
          const first = await readPrice(page);
          await page.reload({ waitUntil: 'networkidle' });
          await freeze(page);
          const second = await readPrice(page);
          if (first !== second) {
            throw new Error(`seed не детерминирует рынок: «${first}» vs «${second}» после reload`);
          }
          await resume(page);
        },
      },
      {
        name: 'pause: цена замирает; resume: цена движется',
        run: async (page) => {
          await freeze(page);
          const a = await readPrice(page);
          await page.waitForTimeout(2500);
          const b = await readPrice(page);
          if (a !== b) {throw new Error('при замороженных таймерах цена изменилась');}
          if (!(await isFrozen(page))) {throw new Error('фикстура не в состоянии pause');}
          await resume(page);
          await page.waitForTimeout(2500);
          const c = await readPrice(page);
          if (b === c) {throw new Error('после resume цена не ожила');}
        },
      },
      {
        name: 'stale-индикатор при паузе (контракт realtime-UI)',
        optional: true, // отсутствие — known gap, не валит весь прогон
        run: async (page) => {
          await freeze(page);
          await page.waitForTimeout(3000);
          await visible(page, s.staleIndicator, 'stale-индикатор');
          await resume(page);
        },
      },
      {
        name: 'CDN графика недоступен → приложение показывает fallback, а не пустоту',
        optional: true,
        screenshot: 'cdn-down',
        run: async (page, ctx) => {
          await page.route('**unpkg.com**', (route) => route.abort());
          await page.reload({ waitUntil: 'load' });
          await page.waitForTimeout(1200);
          const hasFallback = await page.evaluate((sel) => {
            const host = document.querySelector(sel);
            if (!host) {return false;}
            return host.textContent.trim().length > 0 || host.querySelector('[role="alert"], .chart-fallback');
          }, s.chart);
          if (!hasFallback) {
            throw new Error('CDN недоступен, а область графика молча пустая — нет fallback-состояния');
          }
        },
      },
    ];
  },
};
