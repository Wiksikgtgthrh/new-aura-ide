// journeys/frontend/a11y.journey.mjs
// Accessibility journey: keyboard-only, focus trap модалки, Escape, tab-семантика, axe по состояниям.
import { visible, assertFocusTrap, assertEscapeCloses } from '../lib/assert.mjs';

export default {
  id: 'a11y',
  title: 'Accessibility journey: клавиатура, фокус, модалки, axe по состояниям',
  preconditions: ['приложение загружено'],
  completion: [
    'axe без нарушений на главной и в открытой модалке',
    'Tab-цикл модалки замкнут, Escape закрывает',
    'вкладки имеют tab/tabpanel-семантику',
  ],
  fixtures: { seed: 42 },

  steps: (cfg) => {
    const s = {
      modal: '#auth-modal',
      openAuth: '#btn-login',
      tabs: '[role="tab"]',
      ...cfg.selectors?.a11y,
    };
    return [
      {
        name: 'axe на основном экране',
        a11y: true,
        screenshot: 'a11y-main',
        run: async () => {},
      },
      {
        name: 'keyboard-only: Tab достаёт до основных контролов',
        run: async (page) => {
          await page.keyboard.press('Tab');
          const tags = new Set();
          for (let i = 0; i < 12; i++) {
            const tag = await page.evaluate(() => document.activeElement?.tagName);
            tags.add(tag);
            await page.keyboard.press('Tab');
          }
          if (![...tags].some((t) => ['BUTTON', 'A', 'INPUT'].includes(t))) {
            throw new Error('за 12 Tab ни один интерактивный элемент не получил фокус');
          }
        },
      },
      {
        name: 'модалка: focus trap + axe + Escape',
        a11y: true,
        screenshot: 'a11y-modal',
        run: async (page) => {
          await page.locator(s.openAuth).click();
          await visible(page, s.modal, 'модалка');
          await assertFocusTrap(page, s.modal);
        },
      },
      {
        name: 'Escape закрывает модалку',
        run: async (page) => {
          await assertEscapeCloses(page, s.modal);
        },
      },
      {
        name: 'tab/tabpanel-семантика у вкладок',
        run: async (page) => {
          const tabs = await page.locator(s.tabs).count();
          if (tabs === 0) {throw new Error('вкладок с role=tab не найдено');}
          const withSelected = await page.locator(`${s.tabs}[aria-selected]`).count();
          if (withSelected !== tabs) {
            throw new Error(`aria-selected есть не у всех вкладок: ${withSelected}/${tabs}`);
          }
        },
      },
    ];
  },
};
