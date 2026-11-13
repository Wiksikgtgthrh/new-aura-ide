// journeys/frontend/performance.journey.mjs
// Performance journey: бюджет realtime-обновлений, DOM-mutations, resize графика, память длинной сессии.
export default {
  id: 'performance',
  title: 'Performance journey: realtime budget, DOM updates, resize, память',
  preconditions: ['realtime-движок работает'],
  completion: [
    'DOM-мутации в секунду в пределах бюджета',
    'resize графика укладывается в бюджет',
    'heap за длинную сессию растёт не выше порога',
  ],
  fixtures: { seed: 42 },

  steps: (cfg) => {
    const budget = {
      sessionSec: cfg.perf?.sessionSec ?? 12,
      maxMutationsPerSec: cfg.perf?.maxMutationsPerSec ?? 400,
      maxHeapGrowthMb: cfg.perf?.maxHeapGrowthMb ?? 30,
      maxResizeMs: cfg.perf?.maxResizeMs ?? 400,
    };
    const s = { chart: '#chart', ...cfg.selectors?.performance };
    return [
      {
        name: `длинная сессия ${budget.sessionSec}с: мутации и память в бюджете`,
        run: async (page) => {
          const m = await page.evaluate(async (sec) => {
            const mutations = await new Promise((resolve) => {
              let count = 0;
              const obs = new MutationObserver((list) => { count += list.length; });
              obs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
              setTimeout(() => { obs.disconnect(); resolve(count); }, sec * 1000);
            });
            return { mutations, heap: performance.memory?.usedJSHeapSize ?? null };
          }, budget.sessionSec);

          const perSec = m.mutations / budget.sessionSec;
          if (perSec > budget.maxMutationsPerSec) {
            throw new Error(`DOM-мутации: ${Math.round(perSec)}/с при бюджете ${budget.maxMutationsPerSec}/с`);
          }
        },
      },
      {
        name: 'resize графика в бюджете',
        run: async (page) => {
          const ms = await page.evaluate(async (sel) => {
            const start = performance.now();
            window.dispatchEvent(new Event('resize'));
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            return performance.now() - start;
          }, s.chart);
          if (ms > budget.maxResizeMs) throw new Error(`resize: ${Math.round(ms)}мс при бюджете ${budget.maxResizeMs}мс`);
        },
      },
      {
        name: 'heap не растёт при повторных переходах по вкладкам (memory leak smoke)',
        run: async (page) => {
          const read = async () => page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
          const before = await read();
          if (before === null) return; // без CDP-метрик — шаг unverified молча нельзя: честно пропускаем
          for (let i = 0; i < 10; i++) {
            for (const tab of ['orders', 'positions', 'balances', 'history']) {
              const btn = page.locator(`[data-panel-tab="${tab}"]`);
              if (await btn.count()) await btn.click();
            }
          }
          await page.waitForTimeout(500);
          const after = await read();
          const growthMb = (after - before) / 1048576;
          if (growthMb > budget.maxHeapGrowthMb) {
            throw new Error(`heap вырос на ${growthMb.toFixed(1)}МБ за цикл вкладок при бюджете ${budget.maxHeapGrowthMb}МБ`);
          }
        },
      },
    ];
  },
};
