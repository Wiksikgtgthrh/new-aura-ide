/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — встроенный экран устройства («красивый эмулятор» внутри IDE).
 *  Webview-панель: живой экран через adb exec-out screenrecord --output-format=h264
 *  (кадры режутся по NAL-границам и декодируются WebCodecs VideoDecoder в canvas),
 *  фолбэк — screencap-кадры подряд, без фиксированного интервала. Тапы/свайпы мышью и
 *  пальцем (Pointer Events, координаты масштабируются в разрешение устройства), два
 *  пальца — локальный pinch-zoom картинки, даблклик — сброс зума. Панель
 *  кнопок (назад/домой/недавние/громкость/power/поворот) и ввод текста. Поворот экрана
 *  пересчитывает wm size и раскладку stage. Пока панель скрыта, поток на паузе.
 *  Панель одна на устройство; при закрытии стрим останавливается, screenrecord убивается.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tr } from './l10n';
import { AndroidPanel } from './android';

/** Целевая точка входа: строка с id, узел дерева устройства или AVD. */
type ScreenTarget = string | { id?: string; runningDevice?: string } | undefined;

const KEYCODES = { back: 4, home: 3, recents: 187, volDown: 25, volUp: 24, power: 26 } as const;
/** Битрейт screenrecord: 8 Мбит/с хватает для плавной картинки и не грузит энкодер (дефолт — 20). */
const VIDEO_BITRATE = 8_000_000;
/** screenrecord сам завершается через 180 с — перезапускаем после паузы. Рестарт при повороте — наш ручной. */
const VIDEO_RESTART_DELAY_MS = 600;
/** Столько быстрых (<3 с) падений потока подряд — устройство не тянет screenrecord, уходим в скриншоты. */
const VIDEO_MAX_FAST_FAILS = 3;
/** Фолбэк: минимальная пауза между screencap-кадрами — следующий кадр сразу после доставки предыдущего. */
const IMAGE_MIN_DELAY_MS = 16;
/** Фолбэк: период ретрая, когда устройство недоступно. */
const IMAGE_RETRY_MS = 3000;
/** Пауза, чтобы система успела применить новую ориентацию после rotate. */
const ROTATE_SETTLE_MS = 1200;

class DeviceScreen implements vscode.Disposable {

	private readonly panel: vscode.WebviewPanel;
	private disposed = false;
	/** Поток разрешён: панель видима и webview прислал 'ready'. */
	private streaming = false;
	/** 'video' — screenrecord+WebCodecs, 'image' — фолбэк screencap. */
	private mode: 'video' | 'image' = 'video';
	/** Был поворот экрана: дальше --size не передаём никогда — wm size застыл в нативной
	 *  ориентации, а реальный буфер повёрнут (летербокс/рассинхрон тапов). До конца сессии. */
	private rotated = false;
	/** Webview сообщил, что WebCodecs (VideoDecoder) доступен. */
	private webviewCodecs = false;
	private video?: ChildProcess;
	private videoFails = 0;
	private videoStartedAt = 0;
	/** Поколение видеозапуска: stop/kill его инвалидирует — проснувшийся после await startVideo не должен спавнить осиротевший screenrecord. */
	private videoGen = 0;
	/** Поколение image-лупа: fallbackToImages инвалидирует предыдущий, чтобы не появилось два параллельных тика. */
	private imageGen = 0;
	/** Webview загрузился и прислал 'ready' — старт потока только после рукопожатия. */
	private webviewReady = false;
	/** Не разбитые на кадры остатки h264-потока (NAL могут приходить кусками). */
	private pending: Buffer = Buffer.alloc(0);
	private lastCodec = '';
	private frameTs = 0;
	private timer: NodeJS.Timeout | undefined;

	constructor(
		private readonly android: AndroidPanel,
		private readonly device: string,
		onDispose: () => void,
	) {
		this.panel = vscode.window.createWebviewPanel(
			'auraKotlin.deviceScreen',
			`${device}`,
			vscode.ViewColumn.Beside,
			// Поток всё равно ставится на паузу, пока панель скрыта — удерживать webview незачем.
			{ enableScripts: true, retainContextWhenHidden: false },
		);
		this.panel.iconPath = new vscode.ThemeIcon('device-mobile');
		this.panel.webview.html = this.html();
		this.panel.webview.onDidReceiveMessage(message => void this.onMessage(message));
		this.panel.onDidChangeViewState(() => {
			// Обязательная пауза потока: скрытая панель не должна жечь CPU и дёргать adb.
			if (this.panel.visible) { this.start(); } else { this.stop(); }
		});
		this.panel.onDidDispose(() => { this.disposed = true; this.stop(); onDispose(); });
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
		this.panel.dispose();
	}

	reveal(): void {
		// Старт не нужен: после показа webview пересоздаётся и сам присылает 'ready'.
		this.panel.reveal();
	}

	/** Запустить поток в текущем режиме (идемпотентно: повторный вызов ничего не делает). */
	private start(): void {
		if (this.disposed || this.streaming || !this.panel.visible || !this.webviewReady) { return; }
		this.streaming = true;
		if (this.mode === 'video' && this.webviewCodecs) { void this.startVideo(); } else { this.startImageLoop(); }
	}

	private stop(): void {
		this.streaming = false;
		this.webviewReady = false; // следующий show пересоздаст webview — ждём новый 'ready'
		if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
		this.killVideo();
		this.pending = Buffer.alloc(0);
	}

	private killVideo(): void {
		this.videoGen++;
		const child = this.video;
		this.video = undefined; // exit-обработчик увидит «уже не текущий» и не станет перезапускать
		// adb exec-out: локальный adb умирает — device-процесс screenrecord получает обрыв
		// stdout и завершается сам на следующей записи кадра.
		child?.kill();
	}

	/** Живой поток: adb exec-out screenrecord --output-format=h264 - (raw Annex-B).
	 *  @param skipSize — после поворота не передаём --size: screenrecord сам берёт текущий размер дисплея. */
	private async startVideo(skipSize?: boolean): Promise<void> {
		const gen = ++this.videoGen;
		this.pending = Buffer.alloc(0);
		this.frameTs = 0;
		this.lastCodec = ''; // webview (пере)создан — конфиг декодера всегда посылаем заново
		const args = ['-s', this.device, 'exec-out', 'screenrecord', '--output-format=h264', '--bit-rate', String(VIDEO_BITRATE)];
		const size = await this.android.screenSize(this.device);
		if (this.disposed || !this.streaming || gen !== this.videoGen) { return; }
		if (size && !skipSize) {
			// Ограничение энкодера screenrecord — 1920 по длинной стороне; размеры чётные.
			const scale = Math.min(1, 1920 / Math.max(size.width, size.height));
			const w = Math.max(2, Math.round(size.width * scale / 2) * 2);
			const h = Math.max(2, Math.round(size.height * scale / 2) * 2);
			args.push('--size', `${w}x${h}`);
		}
		args.push('-');
		let child: ChildProcess;
		try {
			child = spawn(this.android.adbPath() ?? 'adb', args, { windowsHide: true });
		} catch {
			this.fallbackToImages();
			return;
		}
		this.video = child;
		this.videoStartedAt = Date.now();
		child.stdout?.on('data', (chunk: Buffer) => {
			if (this.video === child) { this.onVideoData(chunk); }
		});
		child.on('error', () => {
			if (this.video === child) { this.fallbackToImages(); }
		});
		child.on('exit', () => {
			if (this.video !== child) { return; }
			this.video = undefined;
			if (this.disposed || !this.streaming) { return; }
			// Быстрый выход = screenrecord недоступен; обычный — лимит 180 с или ручной перезапуск при повороте.
			if (Date.now() - this.videoStartedAt < 3000) { this.videoFails++; } else { this.videoFails = 0; }
			if (this.videoFails >= VIDEO_MAX_FAST_FAILS) { this.fallbackToImages(); return; }
			this.timer = setTimeout(() => {
				this.timer = undefined;
				if (this.streaming && !this.disposed && this.mode === 'video') { void this.startVideo(this.rotated); }
			}, VIDEO_RESTART_DELAY_MS);
		});
	}

	/** Видеопоток не сложился (нет screenrecord/WebCodecs, упал декодер) — скриншоты до конца сессии панели. */
	private fallbackToImages(): void {
		this.mode = 'image';
		this.killVideo();
		if (this.streaming && !this.disposed) { this.startImageLoop(); }
	}

	/**
	 * Фолбэк AURA-007: screencap → base64 → webview без временных файлов.
	 * Следующий кадр запрашивается сразу после доставки предыдущего (не раз в 800 мс);
	 * ошибка = «устройство офлайн», ретраи раз в 3 с.
	 */
	private startImageLoop(): void {
		const myGen = ++this.imageGen;
		const tick = async (): Promise<void> => {
			if (!this.streaming || this.disposed || this.imageGen !== myGen) { return; }
			try {
				const frame = await this.android.captureScreen(this.device);
				if (!this.streaming || this.disposed || this.imageGen !== myGen) { return; }
				if (frame.length > 100) {
					await this.panel.webview.postMessage({ type: 'frame', data: frame.toString('base64') });
				}
			} catch {
				if (!this.streaming || this.disposed || this.imageGen !== myGen) { return; }
				void this.panel.webview.postMessage({ type: 'offline' });
				this.timer = setTimeout(() => { this.timer = undefined; void tick(); }, IMAGE_RETRY_MS);
				return;
			}
			if (!this.streaming || this.disposed || this.imageGen !== myGen) { return; }
			this.timer = setTimeout(() => { this.timer = undefined; void tick(); }, IMAGE_MIN_DELAY_MS);
		};
		void tick();
	}

	/** Следующий NAL Annex-B потока: позиция start code, конец заголовка и тип. */
	private static nextNal(buf: Buffer, from: number): { start: number; headerEnd: number; type: number } | undefined {
		for (let i = Math.max(0, from); i + 4 <= buf.length; i++) {
			if (buf[i] !== 0 || buf[i + 1] !== 0) { continue; }
			if (buf[i + 2] === 1) { return { start: i, headerEnd: i + 3, type: buf[i + 3] & 0x1f }; }
			if (buf[i + 2] === 0 && i + 5 <= buf.length && buf[i + 3] === 1) { return { start: i, headerEnd: i + 4, type: buf[i + 4] & 0x1f }; }
		}
		return undefined;
	}

	/** Является ли VCL NAL первым слайсом кадра: first_mb_in_slice (ue(v)) == 0 → бит '1'.
	 *  headerEnd — индекс байта NAL-заголовка (F|NRI|Type, RFC 6184 §1.3); slice header
	 *  с first_mb_in_slice начинается байтом позже — читаем buf[headerEnd + 1]. */
	private static isFirstSlice(buf: Buffer, headerEnd: number): boolean {
		return headerEnd + 1 < buf.length && (buf[headerEnd + 1] & 0x80) !== 0;
	}

	/**
	 * Разбивка сырого h264 на кадры (access unit): граница кадра — VCL NAL с first_mb_in_slice == 0
	 * (начало первого слайса нового кадра). Без этого многослайсные кадры резались бы на части.
	 */
	private onVideoData(chunk: Buffer): void {
		this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
		for (;;) {
			let cut = -1;
			let seenSlice = false;
			let nal = DeviceScreen.nextNal(this.pending, 0);
			while (nal) {
				// type 1..5 — coded slice (кадр); SPS/PPS/SEI идут префиксом того же кадра.
				if (nal.type >= 1 && nal.type <= 5) {
					if (seenSlice && DeviceScreen.isFirstSlice(this.pending, nal.headerEnd)) { cut = nal.start; break; }
					seenSlice = true;
				}
				nal = DeviceScreen.nextNal(this.pending, nal.headerEnd);
			}
			if (cut < 0) { break; }
			const unit = this.pending.subarray(0, cut);
			this.pending = this.pending.subarray(cut);
			this.emitVideo(unit);
		}
		if (this.pending.length > 16 * 1024 * 1024) { this.pending = Buffer.alloc(0); } // защита от мусора в потоке
	}

	/** Отправить кадр в webview: сначала (пере)конфиг декодера по SPS, потом сам чанк. */
	private emitVideo(unit: Buffer): void {
		let key = false;
		let sps: Buffer | undefined;
		let nal = DeviceScreen.nextNal(unit, 0);
		while (nal) {
			if (nal.type === 7) { key = true; sps = unit.subarray(nal.headerEnd); }
			else if (nal.type === 5) { key = true; }
			nal = DeviceScreen.nextNal(unit, nal.headerEnd);
		}
		if (sps) {
			const codec = DeviceScreen.codecFromSps(sps);
			if (codec && codec !== this.lastCodec) {
				this.lastCodec = codec;
				void this.panel.webview.postMessage({ type: 'video-config', codec });
			}
		}
		if (!this.lastCodec) { return; } // до SPS кадры не шлём: декодеру не с чем конфигурироваться
		this.frameTs += 33_333; // ~30 fps: для живого отображения важна монотонность, не точность
		void this.panel.webview.postMessage({ type: 'video-chunk', data: unit.toString('base64'), key, ts: this.frameTs });
	}

	/** Кодек-строка avc1.PPCCLL для VideoDecoder.configure из первых байт SPS. */
	private static codecFromSps(sps: Buffer): string | undefined {
		// sps[0] — заголовок NAL, sps[1] — profile_idc, sps[2] — constraint-флаги, sps[3] — level_idc.
		if (sps.length < 4) { return undefined; }
		const hex = (b: number) => b.toString(16).padStart(2, '0');
		return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
	}

	/** AURA-008: разрешение устройства (wm size) в webview — раскладка stage под portrait/landscape. */
	private async pushSize(): Promise<void> {
		const size = await this.android.screenSize(this.device);
		if (size && !this.disposed) {
			void this.panel.webview.postMessage({ type: 'size', width: size.width, height: size.height });
		}
	}

	/** После поворота: новые размеры — в webview, поток — на перезапуск без --size (screenrecord сам берёт текущий размер). */
	private async afterRotate(): Promise<void> {
		if (this.disposed) { return; }
		this.rotated = true; // действует и на 180-с автоперезапуски: --size после поворота вреден
		await this.pushSize();
		if (this.streaming) {
			this.stop();
			this.streaming = true;
			if (this.mode === 'video' && this.webviewCodecs) { void this.startVideo(true); }
			else { this.startImageLoop(); }
		}
	}

	private async onMessage(message: { type: string; [key: string]: unknown }): Promise<void> {
		try {
			switch (message.type) {
				case 'ready':
					// Webview создан (или пересоздан после скрытия): стартуем заново, чтобы
					// конфиг декодера точно пришёл после регистрации обработчика сообщений.
					this.webviewCodecs = Boolean(message.codecs);
					if (!this.webviewCodecs) { this.mode = 'image'; }
					this.stop();
					this.webviewReady = true; // после stop, чтобы start() увидел флаг
					this.start();
					await this.pushSize();
					break;
				case 'video-error':
					// Декодер не справился (неподдерживаемый профиль/поток) — уходим в скриншоты.
					this.fallbackToImages();
					break;
				case 'tap':
					await this.android.inputTap(this.device, Number(message.x), Number(message.y));
					break;
				case 'swipe':
					await this.android.inputSwipe(this.device, Number(message.x1), Number(message.y1), Number(message.x2), Number(message.y2), Number(message.duration));
					break;
				case 'key':
					await this.android.inputKey(this.device, KEYCODES[message.key as keyof typeof KEYCODES]);
					break;
				case 'text':
					await this.android.inputText(this.device, String(message.text ?? ''));
					break;
				case 'rotate':
					await this.android.rotateScreen(this.device);
					setTimeout(() => void this.afterRotate(), ROTATE_SETTLE_MS);
					break;
				case 'refresh':
					// Просто дожидаемся следующего кадра — цикл и так идёт.
					break;
			}
		} catch (error) {
			void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
		}
	}

	private html(): string {
		const t = (en: string) => tr(en);
		const nonce = randomBytes(16).toString('base64');
		return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:;">
<style>
	body { margin: 0; display: flex; flex-direction: column; height: 100vh; background: var(--vscode-sideBar-background); color: var(--vscode-foreground); overflow: hidden; }
	#bar { display: flex; gap: 4px; padding: 6px; align-items: center; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
	button { padding: 4px 8px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
	button:hover { background: var(--vscode-button-secondaryHoverBackground); }
	#text { flex: 1; min-width: 90px; padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; }
	#mode { font-size: 12px; padding: 0 4px; cursor: default; }
	#stage { flex: 1; min-height: 0; display: grid; place-items: center; overflow: hidden; position: relative; }
	/* AURA-010: корпус телефона — только CSS, без внешних картинок. */
	#device { position: relative; padding: 16px 13px; border-radius: 42px; background: linear-gradient(160deg, #4a4d53 0%, #26282c 40%, #17181b 100%); box-shadow: 0 22px 55px rgba(0,0,0,.55), 0 0 0 1px #0b0c0e, inset 0 1px 0 rgba(255,255,255,.16); }
	#stage[data-orientation='landscape'] #device { padding: 13px 18px; }
	#device .edge { position: absolute; right: -3px; width: 3.5px; border-radius: 0 3px 3px 0; background: linear-gradient(180deg, #5c6067, #33363b); }
	#device .edge.vol { top: 24%; height: 88px; }
	#device .edge.pwr { top: 46%; height: 52px; }
	#box { position: relative; border-radius: 28px; overflow: hidden; background: #000; box-shadow: inset 0 0 0 2px #0a0a0c; }
	#box .cam { position: absolute; top: 9px; left: 50%; transform: translateX(-50%); width: 9px; height: 9px; border-radius: 50%; background: #040405; box-shadow: inset 0 0 0 1.5px #23262b; pointer-events: none; z-index: 2; }
	.screen { display: block; width: 280px; height: 560px; cursor: crosshair; user-select: none; touch-action: none; }
	.screen[hidden] { display: none; }
	#offline { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; text-align: center; padding: 16px; font-size: 13px; color: var(--vscode-errorForeground); background: rgba(0,0,0,.55); z-index: 3; }
</style>
</head>
<body>
<div id="bar">
	<button data-key="back" title="${t('Back')}">◀</button>
	<button data-key="home" title="${t('Home')}">●</button>
	<button data-key="recents" title="${t('Recents')}">■</button>
	<button data-key="volDown" title="Vol −">🔉</button>
	<button data-key="volUp" title="Vol +">🔊</button>
	<button data-key="power" title="Power">⏻</button>
	<button id="rotate" title="${t('Rotate')}">⟳</button>
	<input id="text" placeholder="${t('Type text…')}">
	<button id="send">${t('Send')}</button>
	<span id="mode" title=""></span>
</div>
<div id="stage" data-orientation="portrait">
	<div id="device">
		<div class="edge vol"></div>
		<div class="edge pwr"></div>
		<div id="box">
			<canvas id="canvas" class="screen" hidden></canvas>
			<img id="screen" class="screen" draggable="false" alt="">
			<div class="cam"></div>
			<div id="offline">${t('Device offline — reconnecting…')}</div>
		</div>
	</div>
</div>
<div id="l10n" data-video="${t('Live video stream')}" data-image="${t('Screenshot stream (fallback)')}" hidden></div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const stage = document.getElementById('stage');
	const canvas = document.getElementById('canvas');
	const img = document.getElementById('screen');
	const offline = document.getElementById('offline');
	const modeEl = document.getElementById('mode');
	const ctx = canvas.getContext('2d');
	const l10nEl = document.getElementById('l10n');
	const MODE_TITLES = { video: l10nEl.dataset.video, image: l10nEl.dataset.image };
	let mode = 'image';
	let decoder = null;
	let lastCodec = null;    // кодек последнего configure — нужен для повторного configure после reset()
	let skipUntilKey = false; // перегрузка декодера: дропаем всё до первого ключевого кадра
	let devSize = null; // разрешение устройства (wm size) для раскладки — фолбэк, не ground truth

	function b64ToBytes(b64) {
		const bin = atob(b64);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
		return out;
	}

	function setMode(next) {
		mode = next;
		canvas.hidden = next !== 'video';
		img.hidden = next !== 'image';
		modeEl.textContent = next === 'video' ? '🎥' : '🖼️';
		modeEl.title = MODE_TITLES[next];
		layout();
	}

	// AURA-008: размеры экрана и ориентация stage — из разрешения устройства;
	// пересчитывается после поворота ('size'), смены кадра и ресайза панели.
	function layout() {
		const src = (mode === 'video' && canvas.width) ? { w: canvas.width, h: canvas.height }
			: img.naturalWidth ? { w: img.naturalWidth, h: img.naturalHeight } : null;
		// Истина — фактический размер медиа (canvas/img), devSize — только фолбэк для CSS до первого кадра.
		const w = src ? src.w : (devSize ? devSize.width : 1080);
		const h = src ? src.h : (devSize ? devSize.height : 2400);
		stage.dataset.orientation = w > h ? 'landscape' : 'portrait';
		const ar = w / h;
		const availW = Math.max(120, stage.clientWidth - 56);   // запас на рамку корпуса
		const availH = Math.max(120, stage.clientHeight - 56);
		let sw = availW;
		let sh = sw / ar;
		if (sh > availH) { sh = availH; sw = sh * ar; }
		canvas.style.width = img.style.width = sw + 'px';
		canvas.style.height = img.style.height = sh + 'px';
	}

	function resetDecoder(codec) {
		lastCodec = codec;
		skipUntilKey = false;
		if (decoder) { try { decoder.close(); } catch { /* уже закрыт */ } }
		decoder = new VideoDecoder({
			output: frame => {
				if (canvas.width !== frame.codedWidth || canvas.height !== frame.codedHeight) {
					canvas.width = frame.codedWidth;
					canvas.height = frame.codedHeight;
					layout();
				}
				// Видео-поверхность показываем только с первым реально декодированным кадром:
				// до этого canvas — дефолтные 300×150, тап маппился бы в мусорные координаты.
				if (mode !== 'video') { setMode('video'); }
				ctx.drawImage(frame, 0, 0);
				frame.close();
				offline.style.display = 'none';
			},
			error: err => {
				decoder = null;
				vscode.postMessage({ type: 'video-error', message: String((err && err.message) || err) });
			},
		});
		decoder.configure({ codec: codec, optimizeForLatency: true });
		// description отсутствует ⇒ вход Annex B (W3C AVC registration §3).
	}

	function feedChunk(msg) {
		if (!decoder || decoder.state === 'closed') { return; }
		if (!skipUntilKey && decoder.decodeQueueSize > 60) {
			// Перегрузка: очередь не стекает. По W3C reset() сбрасывает ВСЁ состояние,
			// включая конфигурацию (state → "unconfigured"), поэтому без повторного
			// configure следующий decode() гарантированно бросит InvalidStateError.
			// Дельты с разорванной референс-цепью декодировать бессмысленно —
			// дропаем всё до первого ключевого кадра, независимо от размера очереди.
			skipUntilKey = true;
			try {
				decoder.reset();
				decoder.configure({ codec: lastCodec, optimizeForLatency: true });
			} catch (err) {
				decoder = null;
				vscode.postMessage({ type: 'video-error', message: String((err && err.message) || err) });
				return;
			}
		}
		if (skipUntilKey) {
			if (!msg.key) { return; }
			skipUntilKey = false; // ключевой кадр дошёл — декодируем с чистого декодера
		}
		try {
			decoder.decode(new EncodedVideoChunk({ type: msg.key ? 'key' : 'delta', timestamp: msg.ts, data: b64ToBytes(msg.data) }));
		} catch (err) {
			decoder = null;
			vscode.postMessage({ type: 'video-error', message: String((err && err.message) || err) });
		}
	}

	window.addEventListener('message', event => {
		const msg = event.data;
		if (msg.type === 'video-config') { resetDecoder(msg.codec); }
		else if (msg.type === 'video-chunk') { feedChunk(msg); }
		else if (msg.type === 'frame') {
			if (mode !== 'image') { setMode('image'); }
			img.src = 'data:image/png;base64,' + msg.data;
			offline.style.display = 'none';
		}
		else if (msg.type === 'size') { devSize = { width: msg.width, height: msg.height }; layout(); }
		else if (msg.type === 'offline') { offline.style.display = 'flex'; }
	});

	function toDevice(el, e) {
		const rect = el.getBoundingClientRect();
		// Истина — фактический размер элемента (naturalWidth/Height), devSize только как последний фолбэк.
		const w = el.naturalWidth || el.width || (devSize && devSize.width) || rect.width;
		const h = el.naturalHeight || el.height || (devSize && devSize.height) || rect.height;
		return { x: (e.clientX - rect.left) * (w / rect.width), y: (e.clientY - rect.top) * (h / rect.height) };
	}

	// Жесты указателем через Pointer Events (мышь/тач/перо) с захватом указателя:
	// свайп не теряется, даже если курсор ушёл за пределы экрана. Состояние общее
	// для canvas и img: видимый элемент всегда один, события приходят только на него.
	const view = { scale: 1, ox: 50, oy: 50 }; // AURA-009: зум картинки и его центр (% от размера экрана)
	const pointers = new Map(); // pointerId → {x, y} — активные указатели на экране
	let down = null;  // одиночный жест: точка нажатия в координатах устройства + время
	let pinch = null; // двойной жест: {dist, scale} на момент второго касания

	function applyZoom() {
		for (const el of [canvas, img]) {
			el.style.transform = view.scale > 1 ? 'scale(' + view.scale + ')' : '';
			el.style.transformOrigin = view.ox + '% ' + view.oy + '%';
		}
	}

	function pinchDistance() {
		const pts = [...pointers.values()];
		return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
	}

	for (const el of [canvas, img]) {
		el.addEventListener('pointerdown', e => {
			if (e.pointerType === 'mouse' && e.button !== 0) { return; }
			el.setPointerCapture(e.pointerId);
			pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (pointers.size === 2) {
				// Второй палец: одиночный жест отменяем (тап не сработает), начинаем pinch.
				down = null;
				if (view.scale === 1) {
					// Центр зума — между пальцами. При повторном pinch (уже зумированы) центр
					// не трогаем: смена origin при scale > 1 дала бы скачок картинки.
					const rect = el.getBoundingClientRect();
					const pts = [...pointers.values()];
					view.ox = ((pts[0].x + pts[1].x) / 2 - rect.left) / rect.width * 100;
					view.oy = ((pts[0].y + pts[1].y) / 2 - rect.top) / rect.height * 100;
				}
				pinch = { dist: pinchDistance(), scale: view.scale };
			} else if (pointers.size === 1) {
				down = Object.assign(toDevice(el, e), { time: Date.now() });
			}
		});
		el.addEventListener('pointermove', e => {
			if (!pointers.has(e.pointerId)) { return; }
			pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			// AURA-009: pinch-zoom — локальный зум картинки, 1x..4x. adb input multi-touch
			// не умеет, поэтому на устройство жест не шлём. Тапам/свайпам зум не мешает:
			// при uniform scale bounding rect растёт пропорционально, и перевод координат
			// в разрешение устройства через rect остаётся точным.
			if (pinch && pointers.size >= 2) {
				const d = pinchDistance();
				if (d > 0 && pinch.dist > 0) {
					view.scale = Math.min(4, Math.max(1, pinch.scale * d / pinch.dist));
					applyZoom();
				}
			}
		});
		el.addEventListener('pointerup', e => {
			pointers.delete(e.pointerId);
			if (pinch && pointers.size < 2) {
				pinch = null;
				// Почти без зума — щёлкаем обратно в 1:1, чтобы не висеть на 1.03x.
				if (view.scale < 1.15) { view.scale = 1; view.ox = view.oy = 50; applyZoom(); }
			}
			if (!down) { return; }
			const up = toDevice(el, e);
			const rect = el.getBoundingClientRect();
			// AURA-029: порог тапа — 12 CSS-пикселей, пересчитанных в пиксели устройства;
			// фиксированные 12 device-px на маленьких экранах превращали скролл в тап.
			// Источник ширины — в том же приоритете, что в toDevice: факт медиа → devSize → rect.
			const scale = (el.naturalWidth || el.width || (devSize && devSize.width) || rect.width) / rect.width;
			const dist = Math.hypot(up.x - down.x, up.y - down.y);
			if (dist < 12 * scale && Date.now() - down.time < 400) {
				vscode.postMessage({ type: 'tap', x: down.x, y: down.y });
			} else {
				vscode.postMessage({ type: 'swipe', x1: down.x, y1: down.y, x2: up.x, y2: up.y, duration: Math.min(Date.now() - down.time, 1200) });
			}
			down = null;
		});
		el.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); pinch = null; down = null; });
		// Даблклик/даблтап по экрану — сброс зума в 1:1.
		el.addEventListener('dblclick', () => { view.scale = 1; view.ox = view.oy = 50; applyZoom(); });
	}

	for (const btn of document.querySelectorAll('button[data-key]')) {
		btn.addEventListener('click', () => vscode.postMessage({ type: 'key', key: btn.dataset.key }));
	}
	document.getElementById('rotate').addEventListener('click', () => vscode.postMessage({ type: 'rotate' }));
	const text = document.getElementById('text');
	const send = () => { if (text.value) { vscode.postMessage({ type: 'text', text: text.value }); text.value = ''; } };
	document.getElementById('send').addEventListener('click', send);
	text.addEventListener('keydown', e => { if (e.key === 'Enter') { send(); } });

	if (typeof ResizeObserver !== 'undefined') { new ResizeObserver(layout).observe(stage); }
	window.addEventListener('resize', layout);
	// Кадр в image-режиме может поменять аспект (поворот) без resize — пересчитать раскладку.
	img.addEventListener('load', layout);
	setMode('image'); // до первого video-config показываем img-поверхность
	vscode.postMessage({ type: 'ready', codecs: typeof VideoDecoder !== 'undefined' });
</script>
</body>
</html>`;
	}
}

/** Менеджер панелей: одна на устройство, повторный вызов — reveal. */
export class DeviceScreenManager implements vscode.Disposable {

	private readonly screens = new Map<string, DeviceScreen>();

	constructor(private readonly android: AndroidPanel) { }

	async open(target?: ScreenTarget): Promise<void> {
		let device: string | undefined;
		if (typeof target === 'string') { device = target; }
		else if (target?.id) { device = target.id; }
		else if (target?.runningDevice) { device = target.runningDevice; }
		else { device = await this.android.pickDevice(); }
		if (!device) { return; }

		const existing = this.screens.get(device);
		if (existing) { existing.reveal(); return; }
		const screen = new DeviceScreen(this.android, device, () => this.screens.delete(device));
		this.screens.set(device, screen);
	}

	dispose(): void {
		for (const screen of this.screens.values()) { screen.dispose(); }
		this.screens.clear();
	}
}

export function registerDeviceScreen(context: vscode.ExtensionContext, android: AndroidPanel): DeviceScreenManager {
	const manager = new DeviceScreenManager(android);
	context.subscriptions.push(
		manager,
		vscode.commands.registerCommand('auraKotlin.android.deviceScreen', (target?: ScreenTarget) => manager.open(target)),
	);
	return manager;
}
