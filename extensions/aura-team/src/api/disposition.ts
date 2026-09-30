/*---------------------------------------------------------------------------------------------
 *  Имя файла из заголовка Content-Disposition.
 *  Сервер отдаёт RFC 5987 (`filename*=UTF-8''…`); старый вариант с percent-encoded
 *  filename внутри кавычек давал на диске имена вида %D0%BF%D1%80…zip.
 *  Модуль без зависимостей от vscode — покрыт тестами (test/api-disposition.test.mjs).
 *--------------------------------------------------------------------------------------------*/

/** Разбор `filename*=UTF-8''<percent-encoded>` с фолбэком на обычный `filename="…"`. */
export function fileNameFromDisposition(header: string | null | undefined, fallback = 'archive'): string {
	const value = String(header ?? '');
	const extended = /filename\*\s*=\s*([^;]+)/i.exec(value);
	if (extended) {
		const raw = extended[1].trim().replace(/^["']|["']$/g, '');
		// Формат: charset'language'value — берём часть после второго апострофа.
		const parts = raw.split("'");
		const encoded = parts.length >= 3 ? parts.slice(2).join("'") : raw;
		try { return sanitize(decodeURIComponent(encoded)) || fallback; } catch { /* битый percent-encoding — падаем на простой filename */ }
	}
	const simple = /filename\s*=\s*([^;]+)/i.exec(value);
	if (simple) {
		const raw = simple[1].trim().replace(/^["']|["']$/g, '');
		// Простой вариант по стандарту latin1: пробуем percent-decode, иначе оставляем как есть.
		const decoded = raw.includes('%') ? safeDecode(raw) : raw;
		return sanitize(decoded) || fallback;
	}
	return fallback;
}

function safeDecode(value: string): string {
	try { return decodeURIComponent(value); } catch { return value; }
}

/** Имя не должно содержать разделители пути и управляющие символы. */
function sanitize(name: string): string {
	return name
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]/g, '')
		.replace(/[\\/]+/g, '_')
		.trim()
		.slice(0, 180);
}
