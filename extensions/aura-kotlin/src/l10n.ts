/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — перевод интерфейса (Russian-first).
 *  Локаль IDE в dev-сборке английская, поэтому vscode.l10n.t отдавал бы исходный
 *  английский, хотя продукт локализован на русский. Берём строки напрямую из
 *  ru-бандла; английский остаётся фолбэком для отсутствующих ключей.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';

let ruBundle: Record<string, string> | undefined;

function bundle(): Record<string, string> {
	if (ruBundle === undefined) {
		try {
			ruBundle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'l10n', 'bundle.l10n.ru.json'), 'utf8')) as Record<string, string>;
		} catch {
			ruBundle = {};
		}
	}
	return ruBundle;
}

/** Замена vscode.l10n.t: сначала русская строка из бандла, потом исходная. */
export function tr(message: string, ...args: Array<string | number>): string {
	let text = bundle()[message] ?? message;
	for (let i = 0; i < args.length; i++) {
		text = text.split(`{${i}}`).join(String(args[i]));
	}
	return text;
}
