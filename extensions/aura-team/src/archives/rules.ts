/*---------------------------------------------------------------------------------------------
 *  Правила архивов: те же, что применяет сервер (aura-team-server/src/routes/archives.ts).
 *  Клиент проверяет их ДО отправки, чтобы пользователь получал понятное сообщение,
 *  а не 400 после многосекундной загрузки. Модуль без зависимостей от vscode —
 *  покрыт тестами (test/archives-rules.test.mjs).
 *--------------------------------------------------------------------------------------------*/

/** Допустимые расширения архивов: только zip и rar (регистр не важен). */
export const ARCHIVE_EXTENSIONS = ['.zip', '.rar'] as const;

/** Принимаем ли файл с таким именем как архив. */
export function isArchiveName(name: string | undefined | null): boolean {
	return /\.(zip|rar)$/i.test(String(name ?? '').trim());
}

/** Стандартный фильтр для диалога открытия файла. */
export const ARCHIVE_FILTERS: Record<string, string[]> = { 'Archives': ['zip', 'rar'] };

/** «512 МиБ» / «1 ГиБ» — для сообщений о лимите. */
export function humanBytes(bytes: number): string {
	const value = Number(bytes) || 0;
	if (value >= 1024 * 1024 * 1024) { return (value / (1024 * 1024 * 1024)).toFixed(value % (1024 * 1024 * 1024) === 0 ? 0 : 1) + ' GiB'; }
	if (value >= 1024 * 1024) { return Math.round(value / (1024 * 1024)) + ' MiB'; }
	if (value >= 1024) { return Math.round(value / 1024) + ' KiB'; }
	return value + ' B';
}

/** Имя файла для диалога сохранения: имя проекта + расширение из серверного имени. */
export function suggestedArchiveName(projectName: string | undefined, serverFileName: string | undefined): string {
	const fromServer = String(serverFileName ?? '').trim();
	const extMatch = /\.(zip|rar)$/i.exec(fromServer);
	const ext = extMatch ? extMatch[0].toLowerCase() : '.zip';
	const base = String(projectName ?? '').trim() || fromServer.replace(/\.(zip|rar)$/i, '') || 'archive';
	const safeBase = base.replace(/[\\/:*?"<>|]+/g, '_').replace(/\.(zip|rar)$/i, '').trim() || 'archive';
	return safeBase + ext;
}
