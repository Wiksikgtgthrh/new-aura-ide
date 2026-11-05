// journeys/fixtures/deterministic.mjs — детерминизм для realtime-UI:
// seeded Math.random (mulberry32) + реестр таймеров с pause/resume.
// Применяется через context.addInitScript — работает до первого скрипта приложения.

export function deterministicInitScript(seed = 42, clockEpoch = null, { startPaused = false } = {}) {
  return `
    (() => {
      // --- seeded random ---
      let a = ${seed | 0} >>> 0;
      Math.random = () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };

      // --- фиксированные часы для visual-детерминизма (ось времени не плывёт) ---
      ${clockEpoch ? `Date.now = () => ${Number(clockEpoch)};` : ''}

      // --- реестр таймеров: window.__timers.pause() / .resume() ---
      // На паузе setInterval только регистрируется, не стартует — иначе число тиков
      // до freeze зависело бы от тайминга загрузки и детерминизм плыл бы.
      const registry = new Map();
      let paused = ${startPaused ? 'true' : 'false'};
      const origSetInterval = window.setInterval.bind(window);
      const origClearInterval = window.clearInterval.bind(window);
      window.setInterval = (fn, ms, ...args) => {
        if (paused) {
          const id = origSetInterval(() => {}, 86400000); // заглушка-идентификатор
          registry.set(id, { fn, ms, args, active: false });
          return id;
        }
        const id = origSetInterval(fn, ms, ...args);
        registry.set(id, { fn, ms, args, active: true });
        return id;
      };
      window.clearInterval = (id) => {
        registry.delete(id);
        origClearInterval(id);
      };
      window.__timers = {
        pause() {
          if (paused) return;
          paused = true;
          for (const [id, t] of registry) if (t.active) { origClearInterval(id); t.active = false; }
        },
        resume() {
          if (!paused) return;
          paused = false;
          for (const [id, t] of registry) {
            if (!t.active) {
              const nid = origSetInterval(t.fn, t.ms, ...t.args);
              registry.delete(id);
              registry.set(nid, { ...t, active: true });
            }
          }
        },
        get paused() { return paused; },
      };
    })();
  `;
}

export async function freeze(page) {
  await page.evaluate(() => window.__timers?.pause());
}
export async function resume(page) {
  await page.evaluate(() => window.__timers?.resume());
}
export async function isFrozen(page) {
  return page.evaluate(() => Boolean(window.__timers?.paused));
}
