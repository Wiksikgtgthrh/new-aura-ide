// journeys/lib/assert.mjs — утверждения уровня продукта, а не «элемент существует».
// Каждая функция бросает Error с понятным сообщением — шаг помечается failed.

export async function visible(page, selector, what = selector) {
  const loc = page.locator(selector).first();
  if (!(await loc.isVisible().catch(() => false))) throw new Error(`не видно: ${what}`);
  return loc;
}

export async function hidden(page, selector, what = selector) {
  const loc = page.locator(selector).first();
  if (await loc.isVisible().catch(() => false)) throw new Error(`должно быть скрыто: ${what}`);
}

export async function textMatches(page, selector, re, what = selector) {
  const text = (await page.locator(selector).first().textContent().catch(() => null)) ?? '';
  if (!re.test(text)) throw new Error(`текст ${what} не матчит ${re}: «${text.trim().slice(0, 80)}»`);
}

export async function countAtLeast(page, selector, n, what = selector) {
  const c = await page.locator(selector).count();
  if (c < n) throw new Error(`${what}: ожидалось ≥${n}, найдено ${c}`);
}

// --- State contract: localStorage только по разрешённому списку ---
export async function storageWithinContract(page, allowed, label = 'localStorage') {
  const keys = await page.evaluate(() => Object.keys(localStorage));
  const extra = keys.filter((k) => !allowed.includes(k));
  if (extra.length) {
    throw new Error(`${label}: ключи вне контракта: ${extra.join(', ')} (разрешены: ${allowed.join(', ') || '—'})`);
  }
}

// --- Demo-auth не маскируется под production: при логине ноль внешних запросов ---
export function watchExternalRequests(page) {
  const hits = [];
  const listener = (req) => {
    const host = new URL(req.url()).host;
    const pageHost = new URL(page.url()).host;
    if (host !== pageHost && !/fonts\.|jsdelivr|unpkg|gstatic/.test(host)) hits.push(req.url());
  };
  page.on('request', listener);
  return {
    assertNone(what = 'auth submit') {
      page.off('request', listener);
      if (hits.length) throw new Error(`${what}: внешние запросы при демо-логике: ${hits.join(', ')}`);
    },
  };
}

// --- Focus trap: Tab внутри модалки не уходит наружу, Escape закрывает ---
export async function assertFocusTrap(page, modalSelector) {
  await page.keyboard.press('Tab');
  for (let i = 0; i < 8; i++) {
    const inside = await page.evaluate((sel) => {
      const modal = document.querySelector(sel);
      return modal && modal.contains(document.activeElement);
    }, modalSelector);
    if (!inside) throw new Error('focus trap: фокус ушёл из модалки по Tab');
    await page.keyboard.press('Tab');
  }
}

export async function assertEscapeCloses(page, modalSelector) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  await hidden(page, modalSelector, 'модалка после Escape');
}

// --- Токены/классы: чужеродные inline-стили (исключения — динамические data-viz) ---
export async function assertInlineStyles(page, { except = [] } = {}) {
  const bad = await page.evaluate((exceptSels) => {
    const out = [];
    document.querySelectorAll('[style]').forEach((el) => {
      if (exceptSels.some((sel) => el.matches(sel) || el.closest(sel))) return;
      out.push(`${el.tagName}.${[...el.classList].join('.')} style="${el.getAttribute('style').slice(0, 60)}"`);
    });
    return out;
  }, except);
  if (bad.length) throw new Error(`inline-стили вне исключений (${bad.length}): ${bad.slice(0, 3).join(' | ')}`);
}

// --- Живой график: canvas не пустой (не однотонный) ---
export async function assertChartAlive(page, chartSelector) {
  const blank = await page.evaluate((sel) => {
    const host = document.querySelector(sel);
    const canvas = host?.querySelector('canvas');
    if (!canvas) return 'no canvas';
    const ctx = canvas.getContext('2d');
    if (!ctx) return 'no 2d context';
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    const first = `${data[0]},${data[1]},${data[2]}`;
    let same = 0;
    for (let i = 0; i < data.length; i += 400 * 4) {
      if (`${data[i]},${data[i + 1]},${data[i + 2]}` === first) same++;
    }
    const total = Math.ceil(data.length / (400 * 4));
    return same / total > 0.98 ? `однотонный canvas (${Math.round((same / total) * 100)}%)` : null;
  }, chartSelector);
  if (blank) throw new Error(`график не живой: ${blank}`);
}

// --- Нет горизонтального перелива ---
export async function assertNoHorizontalOverflow(page, tolerance = 1) {
  const w = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (w > tolerance) throw new Error(`горизонтальный перелив: +${w}px`);
}
