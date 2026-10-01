/*---------------------------------------------------------------------------------------------
 *  Командный git-процесс: чистые помощники без зависимостей от vscode.
 *  Разбор GitHub-remote, имя личной ветки, разбор unified diff для графического
 *  просмотра изменений и сводка CI-проверок. Покрыто test/git-workflow.test.mjs.
 *--------------------------------------------------------------------------------------------*/

import { slugifyTaskTitle } from './branchName';

export interface GithubRepoRef { owner: string; repo: string; }

/** owner/repo из URL remote: https, ssh (git@github.com:o/r.git), ssh://, с токеном в URL. */
export function parseGithubRemote(url: string | undefined): GithubRepoRef | undefined {
	const text = String(url ?? '').trim();
	if (!text) { return undefined; }
	const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/|git:\/\/github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(text);
	if (!match) { return undefined; }
	return { owner: match[1], repo: match[2] };
}

/** Личная ветка разработчика: `dev/<ник>` (кириллица транслитерируется). */
export function personalBranchName(nickname: string | undefined): string {
	const slug = slugifyTaskTitle(nickname).slice(0, 30).replace(/-$/, '');
	return `dev/${slug || 'me'}`;
}

/** Имя ветки допустимо для git и для нашей проверки createBranch. */
export function isValidBranchName(name: string): boolean {
	return /^[\w.\-/]{1,80}$/.test(name) && !name.includes('..') && !name.startsWith('/') && !name.endsWith('/') && !name.endsWith('.lock');
}

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'meta';
export interface DiffLine { kind: DiffLineKind; text: string; oldNo?: number; newNo?: number; }
export interface DiffHunk { header: string; lines: DiffLine[]; }
export interface DiffFile {
	path: string;
	oldPath?: string;
	status: 'added' | 'deleted' | 'modified' | 'renamed';
	binary: boolean;
	additions: number;
	deletions: number;
	hunks: DiffHunk[];
	/** Строк больше лимита — показан только начало, полностью — в редакторе. */
	truncated: boolean;
}
export interface DiffSummary { files: DiffFile[]; additions: number; deletions: number; truncatedFiles: boolean; }

const stripPrefix = (value: string): string => {
	const unquoted = value.startsWith('"') && value.endsWith('"') ? unquoteGitPath(value.slice(1, -1)) : value;
	return unquoted.replace(/^[ab]\//, '');
};

/** git экранирует не-ASCII в путях как "\320\277…" (core.quotePath) — возвращаем UTF-8. */
export function unquoteGitPath(value: string): string {
	const bytes: number[] = [];
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (char === '\\' && i + 1 < value.length) {
			const next = value[i + 1];
			if (/[0-7]/.test(next)) {
				const oct = /^[0-7]{1,3}/.exec(value.slice(i + 1))![0];
				bytes.push(parseInt(oct, 8));
				i += oct.length;
				continue;
			}
			const map: Record<string, number> = { n: 10, t: 9, '"': 34, '\\': 92 };
			if (map[next] !== undefined) { bytes.push(map[next]); i++; continue; }
		}
		for (const byte of new TextEncoder().encode(char)) { bytes.push(byte); }
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Разбор `git diff` / `git show` / patch из GitHub API в файлы → ханки → строки.
 * maxLinesPerFile ограничивает объём для вебвью: огромный lock-файл не должен вешать вкладку.
 */
export function parseUnifiedDiff(text: string, maxLinesPerFile = 600, maxFiles = 300): DiffSummary {
	const files: DiffFile[] = [];
	let file: DiffFile | undefined;
	let hunk: DiffHunk | undefined;
	let oldNo = 0;
	let newNo = 0;
	let shown = 0;
	let truncatedFiles = false;
	const start = (path: string, oldPath?: string): DiffFile => {
		const created: DiffFile = { path, oldPath, status: 'modified', binary: false, additions: 0, deletions: 0, hunks: [], truncated: false };
		if (files.length < maxFiles) { files.push(created); } else { truncatedFiles = true; }
		hunk = undefined;
		shown = 0;
		return created;
	};
	for (const line of String(text ?? '').split(/\r?\n/)) {
		if (line.startsWith('diff --git ')) {
			const rest = line.slice('diff --git '.length);
			const quoted = /^"(.+?)" "(.+)"$/.exec(rest);
			const plain = /^(\S+) (\S+)$/.exec(rest) ?? /^a\/(.+) b\/(.+)$/.exec(rest);
			const a = quoted ? stripPrefix(`"${quoted[1]}"`) : plain ? stripPrefix(plain[1]) : rest;
			const b = quoted ? stripPrefix(`"${quoted[2]}"`) : plain ? stripPrefix(plain[2]) : rest;
			file = start(b, a !== b ? a : undefined);
			if (a !== b) { file.status = 'renamed'; }
			continue;
		}
		if (!file) {
			// patch из GitHub API приходит без заголовка diff --git
			if (line.startsWith('@@')) { file = start(''); } else { continue; }
		}
		if (!hunk) {
			if (line.startsWith('new file mode')) { file.status = 'added'; continue; }
			if (line.startsWith('deleted file mode')) { file.status = 'deleted'; continue; }
			if (line.startsWith('rename from ')) { file.oldPath = unquoteMaybe(line.slice(12)); file.status = 'renamed'; continue; }
			if (line.startsWith('rename to ')) { file.path = unquoteMaybe(line.slice(10)); file.status = 'renamed'; continue; }
			if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) { file.binary = true; continue; }
			if (line.startsWith('--- ')) {
				if (line === '--- /dev/null') { file.status = 'added'; }
				continue;
			}
			if (line.startsWith('+++ ')) {
				if (line === '+++ /dev/null') { file.status = 'deleted'; } else if (!file.path) { file.path = stripPrefix(line.slice(4)); }
				continue;
			}
		}
		if (line.startsWith('@@')) {
			const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
			oldNo = m ? Number(m[1]) : 0;
			newNo = m ? Number(m[2]) : 0;
			hunk = { header: line, lines: [] };
			file.hunks.push(hunk);
			continue;
		}
		if (!hunk) { continue; }
		const push = (entry: DiffLine): void => {
			if (shown < maxLinesPerFile) { hunk!.lines.push(entry); shown++; } else { file!.truncated = true; }
		};
		if (line.startsWith('+')) { file.additions++; push({ kind: 'add', text: line.slice(1), newNo: newNo++ }); }
		else if (line.startsWith('-')) { file.deletions++; push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ }); }
		else if (line.startsWith(' ')) { push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ }); }
		else if (line.startsWith('\\')) { push({ kind: 'meta', text: line }); }
	}
	// Пустые ханки (после усечения) убираем, чтобы не рисовать пустые заголовки.
	for (const item of files) { item.hunks = item.hunks.filter(h => h.lines.length > 0 || !item.truncated); }
	return {
		files,
		additions: files.reduce((sum, f) => sum + f.additions, 0),
		deletions: files.reduce((sum, f) => sum + f.deletions, 0),
		truncatedFiles
	};
}

function unquoteMaybe(value: string): string {
	return value.startsWith('"') && value.endsWith('"') ? unquoteGitPath(value.slice(1, -1)) : value;
}

/** Файл из GitHub API (`pulls/{n}/files`) → тот же формат, что и локальный дифф. */
export function diffFromGithubFiles(items: Array<{ filename: string; previous_filename?: string; status?: string; patch?: string; additions?: number; deletions?: number }>, maxLinesPerFile = 600): DiffSummary {
	const files: DiffFile[] = items.map(item => {
		const parsed = parseUnifiedDiff(item.patch ?? '', maxLinesPerFile).files[0];
		const status: DiffFile['status'] = item.status === 'added' ? 'added' : item.status === 'removed' ? 'deleted' : item.status === 'renamed' ? 'renamed' : 'modified';
		return {
			path: item.filename,
			oldPath: item.previous_filename,
			status,
			binary: !item.patch && (item.additions ?? 0) + (item.deletions ?? 0) === 0 && status !== 'renamed',
			additions: item.additions ?? parsed?.additions ?? 0,
			deletions: item.deletions ?? parsed?.deletions ?? 0,
			hunks: parsed?.hunks ?? [],
			truncated: parsed?.truncated ?? !item.patch
		};
	});
	return { files, additions: files.reduce((s, f) => s + f.additions, 0), deletions: files.reduce((s, f) => s + f.deletions, 0), truncatedFiles: false };
}

export type ChecksState = 'success' | 'failure' | 'pending' | 'none';

/** Сводка проверок CI: combined status + check-runs → одно состояние для бейджа. */
export function summarizeChecks(statuses: Array<{ state?: string }>, runs: Array<{ status?: string; conclusion?: string | null }>): { state: ChecksState; total: number; passed: number; failed: number; pending: number } {
	let passed = 0, failed = 0, pending = 0;
	for (const status of statuses) {
		if (status.state === 'success') { passed++; }
		else if (status.state === 'failure' || status.state === 'error') { failed++; }
		else { pending++; }
	}
	for (const run of runs) {
		if (run.status !== 'completed') { pending++; continue; }
		if (['success', 'neutral', 'skipped'].includes(String(run.conclusion))) { passed++; } else { failed++; }
	}
	const total = passed + failed + pending;
	const state: ChecksState = total === 0 ? 'none' : failed > 0 ? 'failure' : pending > 0 ? 'pending' : 'success';
	return { state, total, passed, failed, pending };
}

/** «ahead behind» из `git rev-list --left-right --count base...HEAD` (слева base, справа HEAD). */
export function parseLeftRight(text: string): { behind: number; ahead: number } {
	const [left, right] = String(text ?? '').trim().split(/\s+/).map(Number);
	return { behind: Number.isFinite(left) ? left : 0, ahead: Number.isFinite(right) ? right : 0 };
}

/** Команда тестов по файлам проекта, если пользователь не задал свою. */
export function detectTestCommand(files: { packageJson?: string; hasPyproject?: boolean; hasPytestIni?: boolean; hasCargo?: boolean; hasGoMod?: boolean; hasMakefile?: string }): string | undefined {
	if (files.packageJson) {
		try {
			const pkg = JSON.parse(files.packageJson) as { scripts?: Record<string, string> };
			const test = pkg.scripts?.test;
			if (test && !/no test specified/.test(test)) { return 'npm test'; }
		} catch { /* битый package.json */ }
	}
	if (files.hasCargo) { return 'cargo test'; }
	if (files.hasGoMod) { return 'go test ./...'; }
	if (files.hasPyproject || files.hasPytestIni) { return 'python -m pytest'; }
	if (files.hasMakefile && /^test:/m.test(files.hasMakefile)) { return 'make test'; }
	return undefined;
}

/** Ссылка «сравнить и создать PR» на GitHub — запасной путь без токена. */
export function compareUrl(repo: GithubRepoRef, base: string, head: string): string {
	return `https://github.com/${repo.owner}/${repo.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1`;
}
