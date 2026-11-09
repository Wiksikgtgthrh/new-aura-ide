// journeys/lib/visual-diff.mjs — сравнение скриншотов без внешних зависимостей:
// обе PNG грузятся в скрытую страницу браузера, рисуются на canvas, считается diff.
import fs from 'node:fs';

export async function diffScreenshots(page, baselinePath, currentPath, { maxDiffRatio = 0.01, threshold = 24 } = {}) {
  const b64 = (f) => fs.readFileSync(f).toString('base64');
  const [a, b] = [b64(baselinePath), b64(currentPath)];
  return page.evaluate(async ([a64, b64c, thr]) => {
    const load = (data) => new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('image decode failed'));
      img.src = `data:image/png;base64,${data}`;
    });
    const [ia, ib] = await Promise.all([load(a64), load(b64c)]);
    if (ia.width !== ib.width || ia.height !== ib.height) {
      return { ok: false, reason: `размеры различаются: ${ia.width}x${ia.height} vs ${ib.width}x${ib.height}`, diffRatio: 1 };
    }
    const draw = (img) => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height).data;
    };
    const [da, db] = [draw(ia), draw(ib)];
    let diff = 0;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
      if (d > thr * 3) {diff++;}
    }
    const diffRatio = diff / (da.length / 4);
    return { ok: diffRatio <= 0 /* порог снаружи */, diffRatio, diffPixels: diff };
  }, [a, b, threshold]).then((r) => ({ ...r, ok: r.diffRatio <= maxDiffRatio }));
}
