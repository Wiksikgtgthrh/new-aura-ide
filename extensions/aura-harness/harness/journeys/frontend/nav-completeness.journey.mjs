// journeys/frontend/nav-completeness.journey.mjs
// Навигация доведена до конца: ни одного мёртвого пункта меню.
// Ловит: href="#", aria-disabled, и ссылки, после клика на которые
// ничего не меняется (ни URL, ни видимый контент).

export default {
  id: 'nav-completeness',
  title: 'Nav completeness: каждый пункт навигации ведёт на реальный раздел',
  preconditions: ['приложение загружено', 'есть шапка с навигацией'],
  completion: ['в шапке/футере нет ссылок-заглушек; каждый пункт меняет URL или контент'],
  fixtures: { seed: 42 },

  steps: (cfg) => {
    const s = {
      // типичные места навигации; проект может переопределить через config
      navLinks: 'header a, nav a, footer a',
      ...cfg.selectors?.nav,
    };
    return [
      {
        name: 'нет ссылок-заглушек (href="#", aria-disabled, пустой href)',
        run: async (page) => {
          const dead = await page.$$eval(s.navLinks, (links) =>
            links
              .filter((a) => {
                // ссылка на текущую страницу (aria-current) — не заглушка
                if (a.getAttribute('aria-current')) {return false;}
                const href = (a.getAttribute('href') || '').trim();
                return (
                  href === '' ||
                  href === '#' ||
                  a.getAttribute('aria-disabled') === 'true' ||
                  a.hasAttribute('disabled')
                );
              })
              .map((a) => (a.textContent || '').trim().slice(0, 40) || '(без текста)')
          );
          if (dead.length) {
            throw new Error(`мёртвые пункты навигации: ${dead.join(', ')}. Заявил раздел — построй раздел, либо убери из меню.`);
          }
        },
      },
      {
        name: 'клик по каждому пункту меняет URL или видимый контент',
        run: async (page) => {
          const links = await page.$$(s.navLinks);
          const baseUrl = page.url();
          for (const link of links) {
            const label = ((await link.textContent()) || '').trim().slice(0, 40);
            const visibleLink = await link.isVisible().catch(() => false);
            if (!visibleLink) {continue;}

            const snapshot = await page.evaluate(() => document.body.innerText.length);
            await link.click();
            await page.waitForTimeout(450);

            const urlChanged = page.url() !== baseUrl;
            const contentChanged = await page.evaluate(
              (prev) => Math.abs(document.body.innerText.length - prev) > 30,
              snapshot
            );
            const overlayOpened = await page.evaluate(() =>
              Boolean(document.querySelector('[role="dialog"]:not([hidden]), .modal-overlay:not([hidden])'))
            );
            if (!urlChanged && !contentChanged && !overlayOpened) {
              throw new Error(`пункт «${label}» ничего не открывает — мёртвая навигация`);
            }
            // вернуться в исходное состояние
            if (overlayOpened) {await page.keyboard.press('Escape');}
            else if (urlChanged) {await page.goBack().catch(() => {});}
            await page.waitForTimeout(200);
          }
        },
      },
    ];
  },
};
