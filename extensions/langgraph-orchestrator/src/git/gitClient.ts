import * as cp from 'child_process';

/**
 * Результат вызова git: код возврата и потоки, без бросания исключений —
 * вызывающий сам решает, что считать ошибкой. stderr сохраняем целиком:
 * по нему парсятся конфликты merge и причины отказов.
 */
export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Информация о рабочем дереве узла (изоляция воркеров, Этап 4.1). */
export interface WorktreeInfo {
	/** Абсолютный путь рабочего дерева (внутри .aura/worktrees). */
	worktree: string;
	branch: string;
}

/** Итог коммита рабочего дерева: либо sha, либо «нечего коммитить». */
export interface CommitInfo {
	commit: string;
	clean: boolean;
}

/** Итог merge: ok=false — конфликт, conflicts — файлы (по ним строится interrupt). */
export interface MergeInfo {
	ok: boolean;
	conflicts: string[];
	stderr: string;
}

/** Коммит-автор агентских коммитов: не приписываем правки пользователю. */
const AGENT_IDENTITY = ['-c', 'user.name=Aura Orchestrator', '-c', 'user.email=aura-orchestrator@local'];

/**
 * Тонкая обёртка над git через execFile: аргументы передаются массивом,
 * поэтому имя ветки/путь не могут стать частью shell-команды. Рабочая
 * директория всегда задаётся явно — работаем в конкретном worktree.
 */
export class GitClient {
	constructor(private gitPath = 'git') {}

	setPath(gitPath: string): void {
		this.gitPath = gitPath || 'git';
	}

	/** Общий запуск git. Таймаут обязателен: граф не должен ждать git вечно. */
	private run(args: string[], cwd: string, timeoutMs = 60_000): Promise<GitResult> {
		return new Promise(resolve => {
			cp.execFile(this.gitPath, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
				const code = error && typeof (error as { code?: unknown }).code === 'number'
					? (error as { code: number }).code
					: error ? 1 : 0;
				resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
			});
		});
	}

	/** Репозиторий ли это вообще: вне git изоляция просто выключается. */
	async isRepo(cwd: string): Promise<boolean> {
		if (!cwd) {
			return false;
		}
		const result = await this.run(['rev-parse', '--is-inside-work-tree'], cwd, 10_000);
		return result.code === 0 && result.stdout.trim() === 'true';
	}

	/** Базовый коммит запуска: от него создаются ветки узлов и считается патч. */
	async head(cwd: string): Promise<string> {
		const result = await this.run(['rev-parse', 'HEAD'], cwd, 15_000);
		return result.code === 0 ? result.stdout.trim() : '';
	}

	/** Текущая ветка пользователя (может быть пустой в detached HEAD). */
	async currentBranch(cwd: string): Promise<string> {
		const result = await this.run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, 15_000);
		const name = result.stdout.trim();
		return result.code === 0 && name !== 'HEAD' ? name : '';
	}

	/** Создать (или пересоздать) ветку и рабочее дерево от базового коммита. */
	async worktreeAdd(cwd: string, worktreePath: string, branch: string, baseCommit: string): Promise<void> {
		const args = ['worktree', 'add', '-B', branch, worktreePath];
		if (baseCommit) {
			args.push(baseCommit);
		}
		const result = await this.run(args, cwd, 120_000);
		if (result.code !== 0) {
			throw new Error(`git worktree add failed: ${firstLine(result.stderr) || firstLine(result.stdout)}`);
		}
	}

	/** Убрать рабочее дерево и, если просили, его ветку. Ошибки — не фатальны: чистим best-effort. */
	async worktreeRemove(cwd: string, worktreePath: string, branch?: string): Promise<void> {
		await this.run(['worktree', 'remove', '--force', worktreePath], cwd, 60_000);
		if (branch) {
			await this.run(['branch', '-D', branch], cwd, 30_000);
		}
	}

	/** Почистить служебные записи о удалённых worktree. */
	async prune(cwd: string): Promise<void> {
		await this.run(['worktree', 'prune'], cwd, 30_000);
	}

	/**
	 * Закоммитить всё в рабочем дереве на его ветке. Пустой diff — clean=true,
	 * это не ошибка: узел мог не произвести правок.
	 */
	async commitAll(worktree: string, message: string): Promise<CommitInfo> {
		const status = await this.run(['status', '--porcelain'], worktree, 30_000);
		if (status.code !== 0 || status.stdout.trim() === '') {
			return { commit: '', clean: true };
		}
		await this.run(['add', '-A'], worktree, 60_000);
		const commit = await this.run([...AGENT_IDENTITY, 'commit', '-m', message], worktree, 60_000);
		if (commit.code !== 0) {
			throw new Error(`git commit failed: ${firstLine(commit.stderr) || firstLine(commit.stdout)}`);
		}
		const head = await this.run(['rev-parse', '--short', 'HEAD'], worktree, 15_000);
		return { commit: head.stdout.trim(), clean: false };
	}

	/** Дифф-статистика между двумя ссылками — ссылка в results, без сырого лога. */
	async diffStat(cwd: string, from: string, to: string): Promise<string> {
		const result = await this.run(['diff', '--stat', `${from}..${to}`], cwd, 30_000);
		return result.code === 0 ? result.stdout.trim().slice(0, 400) : '';
	}

	/** Список изменённых файлов между ссылками (для карточки финального патча). */
	async filesChanged(cwd: string, from: string, to: string): Promise<string[]> {
		const result = await this.run(['diff', '--name-only', `${from}..${to}`], cwd, 30_000);
		if (result.code !== 0) {
			return [];
		}
		return result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	}

	/** Полный unified-дифф ветки от базы — тело итогового патча. */
	async diff(cwd: string, from: string, to: string): Promise<string> {
		const result = await this.run(['diff', `${from}..${to}`], cwd, 60_000);
		return result.code === 0 ? result.stdout : '';
	}

	/**
	 * Влить исходную ветку в текущую (run-ветку). Конфликт не бросает исключение:
	 * возвращаем файлы конфликта, чтобы граф поднял interrupt и человек решил сам.
	 */
	async mergeBranch(cwd: string, sourceBranch: string, message?: string): Promise<MergeInfo> {
		const args = message ? [...AGENT_IDENTITY, 'merge', '--no-edit', '-m', message, sourceBranch] : ['merge', '--no-edit', sourceBranch];
		const result = await this.run(args, cwd, 120_000);
		if (result.code === 0) {
			return { ok: true, conflicts: [], stderr: '' };
		}
		const conflicts = await this.run(['diff', '--name-only', '--diff-filter=U'], cwd, 30_000);
		const files = conflicts.code === 0
			? conflicts.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
			: [];
		return { ok: false, conflicts: files, stderr: firstLine(result.stderr) || firstLine(result.stdout) };
	}

	/** Продолжить merge после ручного разрешения конфликтов (кнопка «разрешено»). */
	async mergeContinue(cwd: string): Promise<MergeInfo> {
		const result = await this.run([...AGENT_IDENTITY, 'commit', '--no-edit'], cwd, 60_000);
		if (result.code === 0) {
			return { ok: true, conflicts: [], stderr: '' };
		}
		const conflicts = await this.run(['diff', '--name-only', '--diff-filter=U'], cwd, 30_000);
		return { ok: false, conflicts: conflicts.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean), stderr: firstLine(result.stderr) };
	}

	/** Отменить незавершённый merge (отклонение/отмена запуска). */
	async mergeAbort(cwd: string): Promise<void> {
		await this.run(['merge', '--abort'], cwd, 30_000);
	}

	/**
	 * Содержимое файла на ссылке (ref:path) — источник «оригинала» для multi-diff.
	 * Пустая ссылка или отсутствующий файл — пустая строка, а не ошибка: новый
	 * файл в diff показывается как добавленный.
	 */
	async showFile(cwd: string, ref: string, filePath: string): Promise<string> {
		if (!ref || !filePath) {
			return '';
		}
		const result = await this.run(['show', `${ref}:${filePath}`], cwd, 30_000);
		return result.code === 0 ? result.stdout : '';
	}

	/** Список коммитов ветки не от базы — для краткого описания в панели. */
	async commitCount(cwd: string, from: string, to: string): Promise<number> {
		const result = await this.run(['rev-list', '--count', `${from}..${to}`], cwd, 30_000);
		return result.code === 0 ? Number(result.stdout.trim()) || 0 : 0;
	}

	/**
	 * Хэш-основа «грязности» рабочего дерева для кэша тулов (Этап 5.3).
	 * Возвращаем сырой `status --porcelain` — вызывающий его хэширует.
	 */
	async statusPorcelain(cwd: string): Promise<string> {
		if (!cwd) {
			return '';
		}
		const result = await this.run(['status', '--porcelain'], cwd, 15_000);
		return result.code === 0 ? result.stdout : '';
	}

	/** Создать ветку run от базы (для merge-фазы). */
	async branchCreate(cwd: string, branch: string, baseCommit: string): Promise<void> {
		const args = ['branch', '-f', branch];
		if (baseCommit) {
			args.push(baseCommit);
		}
		await this.run(args, cwd, 30_000);
	}
}

/** Первая непустая строка вывода — для короткого сообщения об ошибке. */
function firstLine(text: string): string {
	const line = String(text ?? '').split(/\r?\n/).map(item => item.trim()).find(Boolean);
	return (line ?? '').slice(0, 300);
}
