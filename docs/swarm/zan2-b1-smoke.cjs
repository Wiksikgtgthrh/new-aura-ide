#!/usr/bin/env node
/* Зан — смоук b1fix-зоны (extensions/aura-kotlin).
 * Прогон: node docs/swarm/zan2-b1-smoke.cjs  (из корня репо).
 * Тестирует СОБРАННЫЙ артефакт out/deviceScreen.js — то, что реально исполняет расширение.
 * Ничего не пишет в репо; временные файлы уходят в temp. Exit 0 = все проверки зелёные.
 *
 * S1: AU-парсер обязан резать поток на кадры (регрессия ZAN-8: off-by-one в isFirstSlice).
 * S2: isFirstSlice обязан признавать первый слайс кадра (first_mb_in_slice=0 → первый бит slice header '1').
 * S3: повторный fallbackToImages не должен плодить параллельные image-лупы (ZAN-5).
 * S4: start() обязан блокироваться до webviewReady (ZAN-9).
 * S5: webview HTML: CSP nonce, нет avc:-плацебо, l10n через data-атрибуты, inline-скрипт валиден.
 */
'use strict';
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'extensions', 'aura-kotlin', 'out', 'deviceScreen.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zan2-b1-'));

let failed = 0;
const check = (name, ok, detail) => {
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
	if (!ok) { failed++; }
};

// --- vscode-мок ---
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') {
		return {
			window: {
				createWebviewPanel: () => ({ webview: { onDidReceiveMessage: () => { }, postMessage: async () => true }, onDidChangeViewState: () => { }, onDidDispose: () => { }, dispose: () => { } }),
				showErrorMessage: () => { },
			},
			ThemeIcon: class { },
			ViewColumn: { Beside: 1 },
			commands: { registerCommand: () => ({ dispose() { } }) },
		};
	}
	return origLoad.apply(this, arguments);
};

// --- синтетический Annex-B поток: SPS+PPS+IDR, кадр2, многослайсный кадр3, хвост кадра4 ---
const SPS = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f]), Buffer.alloc(12, 0xab)]);
const PPS = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x68, 0xee, 0x3c, 0x80]);
const IDR = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x65, 0x80]), Buffer.alloc(64, 0x11)]); // first_mb=0
const P2 = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x41, 0x80]), Buffer.alloc(64, 0x22)]);   // first_mb=0
const P3a = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x41, 0x80]), Buffer.alloc(64, 0x33)]);  // first_mb=0
const P3b = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x41, 0x40]), Buffer.alloc(64, 0x44)]);  // first_mb=1
const P4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x41, 0x80]), Buffer.alloc(64, 0x55)]);  // ждёт хвоста
const stream1 = Buffer.concat([SPS, PPS, IDR, P2]);
const stream2 = Buffer.concat([P3a, P3b, P4]);

async function main() {
	const mod = require(OUT);
	const manager = new mod.DeviceScreenManager({});
	await manager.open('emu-smoke');
	const ds = manager.screens.get('emu-smoke');
	const DS = ds.constructor;

	// S2: семантика isFirstSlice
	check('S2 isFirstSlice(first_mb=0)===true', DS.isFirstSlice(Buffer.from([0x00, 0x00, 0x01, 0x41, 0x80]), 3) === true, 'buf[headerEnd] — это NAL-заголовок (F|NRI|Type), а не slice header');
	check('S2b isFirstSlice(first_mb=1)===false', DS.isFirstSlice(Buffer.from([0x00, 0x00, 0x01, 0x41, 0x40]), 3) === false);

	// S1: полный конвейер — кадров должно быть 3 (IDR, кадр2, многослайсный кадр3)
	const sent = [];
	const inst = Object.create(DS.prototype);
	inst.pending = Buffer.alloc(0);
	inst.lastCodec = '';
	inst.frameTs = 0;
	inst.panel = { webview: { postMessage: async (m) => { sent.push(m); } } };
	inst.onVideoData(stream1);
	inst.onVideoData(stream2);
	const chunks = sent.filter(m => m.type === 'video-chunk');
	check('S1 кадров >= 3 (AU-парсер жив)', chunks.length >= 3, `фактически ${chunks.length}: видео в webview не поедет вообще`);
	check('S1b многослайсный кадр не разрезан', chunks.length === 0 || Buffer.from(chunks[2].data, 'base64').length >= 138, 'кадр3 = слайс А + слайс Б в одном AU');
	check('S1c video-config отправлен', sent.some(m => m.type === 'video-config'), 'кодек-строка из SPS');
	check('S1d первый AU key, остальные delta', chunks.length >= 3 && chunks[0].key === true && chunks[1].key === false && chunks[2].key === false);

	// S3: повторный fallbackToImages — параллельных лупов быть не должно
	let inFlight = 0; let maxLate = 0; let stable = false;
	const inst2 = Object.create(DS.prototype);
	inst2.pending = Buffer.alloc(0);
	inst2.lastCodec = '';
	inst2.frameTs = 0;
	inst2.imageGen = 0;
	inst2.videoGen = 0;
	inst2.streaming = true;
	inst2.disposed = false;
	inst2.mode = 'video';
	inst2.android = {
		captureScreen: async () => {
			inFlight++;
			if (stable) { maxLate = Math.max(maxLate, inFlight); }
			await new Promise(r => setTimeout(r, 40));
			inFlight--;
			return Buffer.alloc(200);
		},
	};
	inst2.panel = { webview: { postMessage: async () => true } };
	inst2.fallbackToImages();
	await new Promise(r => setTimeout(r, 10));
	inst2.fallbackToImages();   // поздний асинхронный video-error
	await new Promise(r => setTimeout(r, 10));
	inst2.fallbackToImages();   // и ещё один
	await new Promise(r => setTimeout(r, 150)); // переходные in-flight закончились
	stable = true;
	await new Promise(r => setTimeout(r, 300));
	check('S3 после трёх fallbackToImages ровно один image-луп (ZAN-5)', maxLate === 1, `макс. параллельных captureScreen в стабильном окне: ${maxLate}`);
	inst2.streaming = false;
	inst2.stop();

	// S4: start() блокируется до webviewReady
	const inst3 = Object.create(DS.prototype);
	inst3.pending = Buffer.alloc(0);
	inst3.lastCodec = '';
	inst3.frameTs = 0;
	inst3.imageGen = 0;
	inst3.videoGen = 0;
	inst3.disposed = false;
	inst3.streaming = false;
	inst3.webviewReady = false;
	inst3.webviewCodecs = false;
	inst3.mode = 'video';
	let started = 0;
	inst3.android = { captureScreen: async () => { started++; return Buffer.alloc(200); } };
	inst3.panel = { visible: true, webview: { postMessage: async () => true } };
	inst3.start();
	await new Promise(r => setTimeout(r, 80));
	check('S4 start() до ready не стартует стрим (ZAN-9)', inst3.streaming === false && started === 0, `streaming=${inst3.streaming}, captures=${started}`);
	inst3.webviewReady = true;
	inst3.start();
	await new Promise(r => setTimeout(r, 80));
	check('S4b после ready start() стартует', inst3.streaming === true && started > 0);
	inst3.stop();

	// S5: webview HTML
	const html = DS.prototype.html.call(ds);
	check('S5 CSP default-src none', /Content-Security-Policy[^>]*default-src 'none'/.test(html));
	check('S5b script nonce', /<script nonce=/.test(html));
	check('S5c avc-плацебо удалено', !/avc\s*:/.test(html));
	check('S5d MODE_TITLES через data-атрибуты', /MODE_TITLES = \{ video: l10nEl\.dataset\.video/.test(html));
	const m = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
	let syntaxOk = false;
	if (m) {
		const js = path.join(TMP, 'webview.js');
		fs.writeFileSync(js, m[1]);
		try { execSync(`node --check "${js}"`, { stdio: 'pipe' }); syntaxOk = true; } catch { syntaxOk = false; }
	}
	check('S5e node --check webview-скрипта', syntaxOk);

	console.log(failed ? `\nИТОГ: ${failed} FAIL — код не принимается` : '\nИТОГ: все проверки зелёные');
	process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error('SMOKE ERROR:', e); process.exit(1); });
