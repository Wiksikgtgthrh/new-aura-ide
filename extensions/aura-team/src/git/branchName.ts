/*---------------------------------------------------------------------------------------------
 *  Имя ветки для задачи: командный стандарт `task/<id>-<слаг>`.
 *  Модуль без зависимостей от vscode — покрыт тестами (test/git-branch-name.test.mjs).
 *--------------------------------------------------------------------------------------------*/

/** Транслитерация для веток: git не любит кириллицу в именах, а readme её не объяснит. */
const TRANSLIT: Record<string, string> = {
	а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
	к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
	х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
};

/** Слаг из заголовка задачи: максимум 40 символов, только [a-z0-9-]. */
export function slugifyTaskTitle(title: string | undefined): string {
	const source = String(title ?? '').toLowerCase();
	let out = '';
	for (const char of source) {
		if (TRANSLIT[char] !== undefined) { out += TRANSLIT[char]; continue; }
		if (/[a-z0-9]/.test(char)) { out += char; continue; }
		out += '-';
	}
	return out
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 40)
		.replace(/-$/, '');
}

/**
 * Ветка задачи: `task/<первые 8 символов id>-<слаг>`.
 * Хвост заголовка в имя не тянем — иначе длинные названия ломают лимит git и команды в терминале.
 */
export function branchNameForTask(id: string, title?: string): string {
	const short = String(id ?? '').replace(/[^\w-]/g, '').slice(0, 8) || 'task';
	const slug = slugifyTaskTitle(title);
	return slug ? `task/${short}-${slug}` : `task/${short}`;
}

/** Ищет в сообщении коммита ссылку на задачу (`#<hex>`), как это делает сервер. */
export function taskRefInMessage(message: string | undefined): string | undefined {
	const match = /#([0-9a-f]{6,36})\b/i.exec(String(message ?? ''));
	return match?.[1];
}
