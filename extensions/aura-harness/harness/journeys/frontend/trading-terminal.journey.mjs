// journeys/frontend/trading-terminal.journey.mjs
// Длинный сценарий терминала: смена пары → таймфрейм → тип графика → стакан → ордер → отмена → история.
import { visible, textMatches, countAtLeast, assertChartAlive, hidden } from '../lib/assert.mjs';
import { freeze, resume } from '../fixtures/deterministic.mjs';

export default {
  id: 'trading-terminal',
  title: 'Trading terminal journey: пара → таймфрейм → стакан → ордер → отмена → история',
  preconditions: ['приложение загружено', 'есть ≥2 торговые пары', 'есть форма ордера и нижние вкладки'],
  completion: [
    'смена пары обновляет заголовок и график',
    'клик по цене из стакана заполняет форму',
    'валидация показывает ошибку до отправки',
    'лимитный ордер виден в «Открытые», после отмены — пусто, сделки — в «Истории»',
  ],
  fixtures: { seed: 42 },

  steps: (cfg) => {
    const s = {
      watchRow: '[data-pair]',
      tf: (tf) => `[data-tf="${tf}"]`,
      chartMode: (m) => `[data-chart-mode="${m}"]`,
      bookRow: '.book-row.bid',
      bookTab: '[data-book-tab="trades"]',
      pairTitle: '#pair-title',
      priceInput: '#order-price',
      qtyInput: '#order-qty',
      submit: '#order-submit',
      error: '#order-error',
      panelTab: (t) => `[data-panel-tab="${t}"]`,
      orderRow: '#view-orders .data-table tbody tr',
      cancelBtn: '[data-cancel]',
      chart: '#chart',
      ...cfg.selectors?.trading,
    };
    return [
      {
        name: 'терминал загружен: график живой, пары на месте',
        screenshot: 'loaded',
        run: async (page) => {
          await visible(page, s.chart, 'график');
          await assertChartAlive(page, s.chart);
          await countAtLeast(page, s.watchRow, 2, 'пары в watchlist');
        },
      },
      {
        name: 'смена пары меняет заголовок',
        run: async (page) => {
          const before = await page.locator(s.pairTitle).textContent();
          const rows = page.locator(s.watchRow);
          const second = rows.nth(1);
          await second.click();
          await page.waitForTimeout(300);
          const after = await page.locator(s.pairTitle).textContent();
          if (before === after) throw new Error(`заголовок пары не сменился: «${before}»`);
        },
      },
      {
        name: 'переключение таймфрейма 15м → 1ч',
        run: async (page) => {
          await page.locator(s.tf('1H')).click();
          const pressed = await page.locator(s.tf('1H')).getAttribute('aria-pressed');
          if (pressed !== 'true') throw new Error('таймфрейм 1ч не стал активным');
        },
      },
      {
        name: 'тип графика: свечи → линия → область → свечи',
        screenshot: 'chart-modes',
        run: async (page) => {
          for (const m of ['line', 'area', 'candles']) {
            await page.locator(s.chartMode(m)).click();
            await page.waitForTimeout(200);
            const pressed = await page.locator(s.chartMode(m)).getAttribute('aria-pressed');
            if (pressed !== 'true') throw new Error(`режим ${m} не активировался`);
          }
        },
      },
      {
        name: 'вкладка «Сделки» показывает ленту',
        run: async (page) => {
          await page.locator(s.bookTab).click();
          await page.waitForTimeout(1600); // дождаться пары сделок в ленте
          await countAtLeast(page, '.trade-row', 1, 'сделки в ленте');
          await page.locator('[data-book-tab="book"]').click();
        },
      },
      {
        name: 'клик по цене из стакана заполняет форму',
        run: async (page) => {
          await page.locator(s.bookRow).first().click();
          const val = await page.locator(s.priceInput).inputValue();
          if (!val || val === 'Рыночная') throw new Error('цена из стакана не попала в форму');
        },
      },
      {
        name: 'валидация: пустое количество → ошибка',
        run: async (page) => {
          await page.locator(s.qtyInput).fill('');
          await page.locator(s.submit).click();
          await page.waitForTimeout(500);
          await textMatches(page, s.error, /\S/, 'сообщение об ошибке');
        },
      },
      {
        name: 'размещение лимитного ордера → виден в «Открытые»',
        screenshot: 'order-placed',
        run: async (page) => {
          await page.locator(s.qtyInput).fill('0.01');
          // цена далеко от рынка, чтобы ордер не исполнился мгновенно
          await page.locator(s.priceInput).fill('1');
          await page.locator(s.submit).click();
          await page.waitForTimeout(700);
          // продукт с auth-гейтом: модалка входа открылась → регистрируемся и повторяем
          const authModal = page.locator('#auth-modal');
          if (await authModal.isVisible().catch(() => false)) {
            const user = cfg.authUser ?? { name: 'Тестовый Пилот', email: 'pilot@test.dev', password: 'journey-2026' };
            await page.locator('#auth-switch-btn').click();
            await page.locator('#reg-name').fill(user.name);
            await page.locator('#reg-email').fill(user.email);
            await page.locator('#reg-password').fill(user.password);
            await page.locator('#reg-confirm').fill(user.password);
            await page.locator('#reg-consent').check();
            await page.locator('#auth-submit').click();
            await page.waitForTimeout(500);
            // email мог быть зарегистрирован предыдущим journey — тогда логинимся
            if (await authModal.isVisible().catch(() => false)) {
              await page.locator('#auth-switch-btn').click();
              await page.locator('#login-email').fill(user.email);
              await page.locator('#login-password').fill(user.password);
              await page.locator('#auth-submit').click();
              await page.waitForTimeout(500);
            }
            await page.locator(s.qtyInput).fill('0.01');
            await page.locator(s.priceInput).fill('1');
            await page.locator(s.submit).click();
            await page.waitForTimeout(700);
          }
          await page.locator(s.panelTab('orders')).click();
          await countAtLeast(page, s.orderRow, 1, 'открытые ордера');
        },
      },
      {
        name: 'отмена ордера → пустое состояние',
        run: async (page) => {
          await freeze(page); // рынок стоит — ордер не успеет исполниться
          await page.locator(s.cancelBtn).first().click();
          await page.waitForTimeout(300);
          await countAtLeast(page, s.orderRow, 0, 'открытые ордера после отмены');
          await visible(page, '#view-orders .empty-state', 'пустое состояние ордеров');
          await resume(page);
        },
      },
      {
        name: 'вкладки позиций/балансов/истории открываются',
        run: async (page) => {
          for (const tab of ['positions', 'balances', 'history']) {
            await page.locator(s.panelTab(tab)).click();
            await page.waitForTimeout(150);
            const view = page.locator(`#view-${tab}`);
            if (await view.isHidden()) throw new Error(`вкладка ${tab} не открылась`);
          }
        },
      },
    ];
  },
};
