// Иконки оркестратора: node --test test/icons.test.mjs
//
// VS Code не показывает SVG из расширения как картинку: иконку контейнера в активити-баре он
// подставляет в CSS `mask`, то есть непрозрачным остаётся только силуэт, а цвет берётся у темы.
// Из этого следуют жёсткие правила, которые здесь и проверяются:
//   • никакого фона и никаких литеральных цветов — иначе в баре получится цветной квадрат;
//   • силуэт вписан в канву с оптическими отступами и отцентрован (иначе иконка выглядит крупнее
//     или мельче соседних);
//   • у иконки расширения, наоборот, есть своя подложка и не-currentColor цвета: она рисуется как
//     картинка в списке расширений, где currentColor даёт чёрный силуэт по тёмной теме.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const activityPath = join(root, pkg.contributes.viewsContainers.activitybar[0].icon);
const extensionIconPath = join(root, pkg.icon);
const activity = readFileSync(activityPath, 'utf8');
const extensionIcon = readFileSync(extensionIconPath, 'utf8');

/** Прямоугольники и окружности иконки — по ним считаем, что силуэт реально видно. */
const shapes = (svg) => ({
	rects: [...svg.matchAll(/<rect\s+x="([\d.]+)"\s+y="([\d.]+)"\s+width="([\d.]+)"\s+height="([\d.]+)"/g)]
		.map(m => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] })),
	circles: [...svg.matchAll(/<circle\s+cx="([\d.]+)"\s+cy="([\d.]+)"\s+r="([\d.]+)"/g)]
		.map(m => ({ x: +m[1], y: +m[2], r: +m[3] }))
});

test('контейнер активити-бара указывает на иконку-маску, а расширение — на цветную', () => {
	assert.ok(existsSync(activityPath), `нет файла иконки активити-бара: ${activityPath}`);
	assert.ok(existsSync(extensionIconPath), `нет файла иконки расширения: ${extensionIconPath}`);
	assert.notStrictEqual(pkg.contributes.viewsContainers.activitybar[0].icon, pkg.icon,
		'иконка активити-бара и иконка расширения — разные файлы: первая маска, вторая картинка');
});

test('иконка-маска пригодна для активити-бара', () => {
	assert.match(activity, /viewBox="0 0 24 24"/, 'маска должна быть в канве 24×24');
	assert.match(activity, /(fill|stroke)="currentColor"/, 'цвет силуэта обязан приходить из темы');
	assert.ok(!/#|rgb\(|hsl\(/.test(activity), 'в маске не может быть литеральных цветов');
	assert.ok(!/<rect[^>]*width="2[34]"[^>]*height="2[34]"/.test(activity), 'в маске не может быть плашки на всю канву');

	// Силуэт — супервизор плюс три воркера: две фигуры на воркеров не хватит, четыре уже перегруз.
	const { rects, circles } = shapes(activity);
	assert.strictEqual(rects.length + circles.length, 4, 'силуэт — супервизор и три воркера');
	assert.strictEqual(circles.length, 3, 'воркеры — окружности');
});

test('силуэт отцентрован и не прилипает к краям', () => {
	const { rects, circles } = shapes(activity);
	const left = Math.min(...rects.map(r => r.x), ...circles.map(c => c.x - c.r));
	const right = Math.max(...rects.map(r => r.x + r.w), ...circles.map(c => c.x + c.r));
	const top = Math.min(...rects.map(r => r.y), ...circles.map(c => c.y - c.r));
	const bottom = Math.max(...rects.map(r => r.y + r.h), ...circles.map(c => c.y + c.r));
	const margins = { left, top, right: 24 - right, bottom: 24 - bottom };

	for (const [side, value] of Object.entries(margins)) {
		assert.ok(value >= 2 && value <= 7, `${side}: отступ ${value.toFixed(2)}px — иконка прилипает к краю или теряется в пустоте`);
	}
	assert.ok(Math.abs(margins.left - margins.right) <= 1, 'по горизонтали силуэт должен быть отцентрован');
	assert.ok(Math.abs(margins.top - margins.bottom) <= 1, 'по вертикали силуэт должен быть отцентрован');
	// Ниже 16px активити-бар включает компактный режим: слишком мелкие узлы смазываются.
	assert.ok(Math.min(...circles.map(c => c.r)) >= 1.6, 'узлы должны читаться на иконке 16px');
});

test('супервизор стоит выше воркеров: силуэт читается как раздача работы', () => {
	const { rects, circles } = shapes(activity);
	const hub = rects[0];
	assert.ok(hub.y + hub.h < Math.min(...circles.map(c => c.y - c.r)), 'супервизор должен быть над воркерами');
	assert.ok(circles.every(c => Math.abs(c.y - circles[0].y) < 0.5), 'воркеры стоят в один ряд');
});

test('иконка расширения видна в обеих темах', () => {
	assert.match(extensionIcon, /viewBox="0 0 128 128"/, 'иконка расширения — канва 128×128');
	assert.ok(!/currentColor/.test(extensionIcon), 'в картинке нет currentColor: по тёмной теме она станет чёрной');
	assert.match(extensionIcon, /<rect[^>]*fill="#[0-9a-f]{6}"/i, 'нужна непрозрачная подложка своего цвета');
});
