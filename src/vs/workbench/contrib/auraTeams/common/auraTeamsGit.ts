/*---------------------------------------------------------------------------------------------
 *  Aura Teams — чистые функции для умного коммита, контрольных точек и истории задач.
 *--------------------------------------------------------------------------------------------*/

/** Маркер связи коммита с задачей — в конце сообщения, чтобы не мешать заголовку. */
export const TASK_TRAILER_PREFIX = 'Aura-Task: ';

export const CHECKPOINT_TAG_PREFIX = 'aura/checkpoint/';

/** Лимит diff для промпта модели: дальше идут только имена файлов. */
export const SMART_COMMIT_DIFF_LIMIT = 24_000;

export interface IAuraCommit {
	readonly hash: string;
	readonly message: string;
	readonly parents: readonly string[];
	readonly authorName?: string;
	readonly authorDate?: number;
}

export interface IAuraCheckpoint {
	readonly tag: string;
	readonly commit: string;
	readonly createdAt: number;
	readonly label: string;
}

/** Обрезка diff с сохранением заголовков файлов, чтобы модель видела весь список изменений. */
export function truncateDiffForPrompt(diff: string, limit: number = SMART_COMMIT_DIFF_LIMIT): string {
	if (diff.length <= limit) {
		return diff;
	}
	const head = diff.slice(0, limit);
	const cut = head.lastIndexOf('\ndiff --git ');
	const kept = cut > limit / 2 ? head.slice(0, cut) : head;
	const remainingFiles = diff.slice(kept.length).split('\n')
		.filter(l => l.startsWith('diff --git '))
		.map(l => l.replace(/^diff --git a\/(\S+) b\/.*$/, '$1'));
	const tail = remainingFiles.length > 0 ? `\n\n[diff обрезан; ещё изменены файлы: ${remainingFiles.join(', ')}]` : '\n\n[diff обрезан]';
	return kept + tail;
}

export function buildSmartCommitPrompt(diff: string, taskTitle?: string): string {
	const parts = [
		'Ты пишешь сообщение git-коммита по diff. Ответь ТОЛЬКО текстом сообщения, без пояснений, без кавычек и без markdown.',
		'Формат: первая строка — заголовок до 72 символов в стиле conventional commits (feat/fix/refactor/docs/chore/test: …), на русском, в повелительном наклонении.',
		'Если изменений много — после пустой строки добавь 2–5 маркированных пунктов «- …», каждый до 100 символов. Не описывай очевидное, не перечисляй файлы.',
	];
	if (taskTitle) {
		parts.push(`Коммит относится к задаче: «${taskTitle}». Учитывай это в заголовке, но не копируй название дословно.`);
	}
	parts.push('', 'DIFF:', '', truncateDiffForPrompt(diff));
	return parts.join('\n');
}

/** Чистка ответа модели: снять кодовые ограждения и кавычки, убрать префикс «Сообщение:» и пустые хвосты. */
export function cleanCommitMessage(raw: string): string {
	let text = raw.trim();
	const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text);
	if (fenced) {
		text = fenced[1].trim();
	}
	text = text.replace(/^(сообщение( коммита)?|commit message)\s*:\s*/i, '');
	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('«') && text.endsWith('»'))) {
		text = text.slice(1, -1).trim();
	}
	const lines = text.split('\n').map(l => l.replace(/\s+$/g, ''));
	while (lines.length > 0 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines.join('\n');
}

/** Дописать трейлер задачи, если его ещё нет. */
export function withTaskTrailer(message: string, taskId: string): string {
	if (taskTrailerOf(message) === taskId) {
		return message;
	}
	const body = message.replace(/\s+$/g, '');
	return `${body}\n\n${TASK_TRAILER_PREFIX}${taskId}`;
}

export function taskTrailerOf(message: string): string | undefined {
	const m = new RegExp(`^${TASK_TRAILER_PREFIX.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(\\S+)\\s*$`, 'm').exec(message);
	return m?.[1];
}

/** Коммиты задачи из журнала: только с трейлером этой задачи, в порядке журнала (новые первыми). */
export function commitsForTask(log: readonly IAuraCommit[], taskId: string): IAuraCommit[] {
	return log.filter(c => taskTrailerOf(c.message) === taskId);
}

/** Первая строка сообщения — заголовок для списков. */
export function commitSubject(message: string): string {
	return message.split('\n', 1)[0].trim();
}

export function checkpointTagName(now: number): string {
	const d = new Date(now);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${CHECKPOINT_TAG_PREFIX}${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Разбор тега контрольной точки в дату; чужие теги дают undefined. */
export function parseCheckpointTag(tag: string): number | undefined {
	if (!tag.startsWith(CHECKPOINT_TAG_PREFIX)) {
		return undefined;
	}
	const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(tag.slice(CHECKPOINT_TAG_PREFIX.length));
	if (!m) {
		return undefined;
	}
	const [, y, mo, d, h, mi, s] = m.map(Number);
	return new Date(y, mo - 1, d, h, mi, s).getTime();
}

/** «5 мин назад», «вчера», дата — для списка контрольных точек. */
export function relativeTime(from: number, now: number): string {
	const diffSec = Math.max(0, Math.round((now - from) / 1000));
	if (diffSec < 60) {
		return 'только что';
	}
	const min = Math.round(diffSec / 60);
	if (min < 60) {
		return `${min} мин назад`;
	}
	const hours = Math.round(min / 60);
	if (hours < 24) {
		return `${hours} ч назад`;
	}
	const days = Math.round(hours / 24);
	if (days === 1) {
		return 'вчера';
	}
	if (days < 7) {
		return `${days} дн назад`;
	}
	return new Date(from).toLocaleDateString();
}

/** Список контрольных точек из refs: только наши теги, новые первыми. */
export function checkpointsFromRefs(refs: readonly { name?: string; commit?: string }[], now: number): IAuraCheckpoint[] {
	const result: IAuraCheckpoint[] = [];
	for (const ref of refs) {
		const name = ref.name?.replace(/^refs\/tags\//, '');
		if (!name || !ref.commit) {
			continue;
		}
		const createdAt = parseCheckpointTag(name);
		if (createdAt === undefined) {
			continue;
		}
		result.push({ tag: name, commit: ref.commit, createdAt, label: relativeTime(createdAt, now) });
	}
	return result.sort((a, b) => b.createdAt - a.createdAt);
}
