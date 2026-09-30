/*---------------------------------------------------------------------------------------------
 *  Троттлинг с хвостом: первый вызов проходит сразу, остальные в окне схлопываются
 *  в один отложенный.
 *
 *  Зачем: хост отправляет состояние панели на каждое событие графа, каждый спан и каждую
 *  строку лога, а `panelState()` собирает объект целиком (доски, ключи, бюджет, 400 спанов,
 *  300 строк лога) — и всё это уходит в webview. За прогон это сотни полных сборок и
 *  перерисовок вместо десятков.
 *
 *  Ведущее ребро важно: после тишины (клик по «Пауза») состояние уходит мгновенно,
 *  задерживается только то, что попало в пачку.
 *--------------------------------------------------------------------------------------------*/

export interface Throttle {
	/** Запросить отправку: сразу, если окно прошло, иначе — одной отложенной. */
	schedule(): void;
	/** Отменить отложенную отправку (при dispose, чтобы не дёргать панель после закрытия). */
	cancel(): void;
}

export function createThrottle(intervalMs: number, fire: () => void): Throttle {
	const window = Math.max(0, Number(intervalMs) || 0);
	let lastAt = Number.NEGATIVE_INFINITY;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const run = (): void => {
		lastAt = Date.now();
		fire();
	};
	return {
		schedule(): void {
			if (timer) {
				return; // в окне уже стоит отложенная отправка — она и отправит последнее состояние
			}
			const wait = window - (Date.now() - lastAt);
			if (wait <= 0) {
				run();
				return;
			}
			timer = setTimeout(() => {
				timer = undefined;
				run();
			}, wait);
		},
		cancel(): void {
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
		}
	};
}

/** Немного ниже кадра: 12 отправок в секунду панель всё равно не различит. */
export const STATE_PUSH_INTERVAL_MS = 80;
