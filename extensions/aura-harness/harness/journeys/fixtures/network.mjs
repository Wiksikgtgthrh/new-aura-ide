// journeys/fixtures/network.mjs — сетевые сбои как фикстура.

// Заблокировать хост (напр. CDN графика) — приложение обязано показать fallback.
export async function blockHost(page, hostGlob) {
  await page.route(`**${hostGlob}**`, (route) => route.abort());
}

export async function unblockAll(page) {
  await page.unrouteAll();
}

export async function goOffline(context) {
  await context.setOffline(true);
}
export async function goOnline(context) {
  await context.setOffline(false);
}

// Список заблокированных внешних хостов для последующего ассерта в отчёт
export function blockedHostsLog() {
  const log = [];
  return {
    track: (host) => log.push(host),
    entries: () => [...log],
  };
}
