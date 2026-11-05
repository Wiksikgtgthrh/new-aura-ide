// journeys/fixtures/storage.mjs — storage как контракт, а не свалка.

export async function cleanStorage(context) {
  // Чистим один раз: маркер в sessionStorage переживает reload, иначе init-скрипт
  // стирал бы сессию на каждой навигации (поймано на auth journey).
  await context.addInitScript(() => {
    try {
      if (!sessionStorage.getItem("__journey_cleaned")) {
        localStorage.clear();
        sessionStorage.clear();
        sessionStorage.setItem("__journey_cleaned", "1");
      }
    } catch { /* ignore */ }
  });
}

export async function snapshotStorage(page) {
  return page.evaluate(() => ({ ...localStorage }));
}

export async function restoreStorage(page, snapshot) {
  await page.evaluate((snap) => {
    localStorage.clear();
    for (const [k, v] of Object.entries(snap)) localStorage.setItem(k, v);
  }, snapshot);
}
