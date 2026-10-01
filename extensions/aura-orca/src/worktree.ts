/*---------------------------------------------------------------------------------------------
 *  Orca — изолированные рабочие деревья для параллельных агентов (git worktree).
 *  Каждый агент получает свою ветку orca/<имя> в .orca/worktrees/<имя>: агенты не
 *  мешают друг другу и основной ветке, а результат сливается одной кнопкой.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface WorktreeInfo { path: string; branch: string; base: string; }
export interface WorktreeChange { status: string; path: string; }

export class Worktrees {
	constructor(private readonly gitPath: () => string, private readonly log: (line: string) => void) { }

	async git(cwd: string, args: string[], allow: number[] = []): Promise<string> {
		this.log(`[git] ${args.join(' ')}  (${cwd})`);
		try {
			const result = await run(this.gitPath(), args, { cwd, maxBuffer: 32 * 1024 * 1024 });
			return result.stdout;
		} catch (error) {
			const failed = error as Error & { code?: number; stdout?: string; stderr?: string };
			if (typeof failed.code === 'number' && allow.includes(failed.code)) { return failed.stdout ?? ''; }
			throw new Error((failed.stderr || failed.message).trim());
		}
	}

	async root(cwd: string): Promise<string | undefined> {
		try { return (await this.git(cwd, ['rev-parse', '--show-toplevel'])).trim() || undefined; } catch { return undefined; }
	}

	/** Новое дерево от текущего HEAD; .orca/ прячется через info/exclude, а не .gitignore. */
	async create(root: string, name: string): Promise<WorktreeInfo> {
		const base = (await this.git(root, ['rev-parse', 'HEAD'])).trim();
		const path = join(root, '.orca', 'worktrees', name);
		const branch = `orca/${name}`;
		mkdirSync(join(root, '.orca', 'worktrees'), { recursive: true });
		await this.ensureExcluded(root);
		await this.git(root, ['worktree', 'add', '-b', branch, path, base]);
		return { path, branch, base };
	}

	private async ensureExcluded(root: string): Promise<void> {
		try {
			let common = (await this.git(root, ['rev-parse', '--git-common-dir'])).trim();
			if (!isAbsolute(common)) { common = join(root, common); }
			const exclude = join(common, 'info', 'exclude');
			mkdirSync(join(common, 'info'), { recursive: true });
			const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
			if (!/^\/?\.orca\/?$/m.test(current)) { appendFileSync(exclude, `${current.endsWith('\n') || !current ? '' : '\n'}.orca/\n`); }
		} catch (error) { this.log(`[git] exclude failed: ${String(error)}`); }
	}

	/** Существующие деревья Orca (переживают перезагрузку окна). */
	async list(root: string): Promise<WorktreeInfo[]> {
		const text = await this.git(root, ['worktree', 'list', '--porcelain']).catch(() => '');
		const out: WorktreeInfo[] = [];
		for (const block of text.split(/\n\n+/)) {
			const path = /^worktree (.+)$/m.exec(block)?.[1];
			const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
			if (path && branch?.startsWith('orca/') && /[\\/]\.orca[\\/]worktrees[\\/]/.test(path)) {
				const base = (await this.git(root, ['merge-base', 'HEAD', branch]).catch(() => '')).trim();
				out.push({ path, branch, base });
			}
		}
		return out;
	}

	/** Изменения агента относительно точки старта: коммиты + незакоммиченное + новые файлы. */
	async changes(info: WorktreeInfo): Promise<{ files: WorktreeChange[]; commits: string[]; stat: string }> {
		await this.git(info.path, ['add', '-A', '-N']).catch(() => '');
		const nameStatus = await this.git(info.path, ['diff', '--name-status', '-M', info.base]).catch(() => '');
		const files = nameStatus.split('\n').filter(Boolean).map(line => {
			const parts = line.split('\t');
			return { status: parts[0][0], path: parts[parts.length - 1] };
		});
		const commits = (await this.git(info.path, ['log', '--format=%h %s', `${info.base}..HEAD`]).catch(() => '')).split('\n').filter(Boolean);
		const stat = (await this.git(info.path, ['diff', '--shortstat', info.base]).catch(() => '')).trim();
		return { files, commits, stat };
	}

	async showAt(info: WorktreeInfo, file: string): Promise<string> {
		return this.git(info.path, ['show', `${info.base}:${file}`]).catch(() => '');
	}

	/** Закоммитить работу агента и влить ветку в текущую ветку основного дерева. */
	async merge(root: string, info: WorktreeInfo, message: string): Promise<{ merged: boolean; conflicts: boolean; output: string }> {
		const dirty = (await this.git(info.path, ['status', '--porcelain'])).trim();
		if (dirty) {
			await this.git(info.path, ['add', '-A']);
			await this.git(info.path, ['commit', '-m', message]);
		}
		const ahead = (await this.git(root, ['rev-list', '--count', `HEAD..${info.branch}`])).trim();
		if (ahead === '0') { return { merged: false, conflicts: false, output: 'nothing to merge' }; }
		try {
			const output = await this.git(root, ['merge', '--no-ff', '--no-edit', info.branch]);
			return { merged: true, conflicts: false, output };
		} catch (error) {
			const conflicted = (await this.git(root, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim();
			if (conflicted) { return { merged: false, conflicts: true, output: conflicted }; }
			throw error;
		}
	}

	async remove(root: string, info: WorktreeInfo): Promise<void> {
		await this.git(root, ['worktree', 'remove', '--force', info.path]).catch(error => this.log(`[git] worktree remove: ${String(error)}`));
		await this.git(root, ['branch', '-D', info.branch]).catch(error => this.log(`[git] branch -D: ${String(error)}`));
		await this.git(root, ['worktree', 'prune']).catch(() => '');
	}
}
