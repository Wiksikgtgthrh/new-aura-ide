/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { API, GitExtension, Repository } from './git';
import { GitBranchInfo, GitSnapshot } from '../types';
import { detectTestCommand, isValidBranchName, parseLeftRight } from './workflow';

const execFileAsync = promisify(execFile);

export class GitService {
	private readonly api: API;
	/** Пустой файл-эталон для диффов новых/удалённых файлов (кэш на процесс). */
	private emptyFile?: vscode.Uri;

	constructor(private readonly output: vscode.OutputChannel) {
		const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
		if (!extension?.exports?.enabled) {
			throw new Error(vscode.l10n.t('The built-in Git extension is unavailable.'));
		}
		this.api = extension.exports.getAPI(1);
	}

	get repository(): Repository | undefined { return this.api.repositories[0]; }

	registerGitHubCredentials(context: vscode.ExtensionContext): vscode.Disposable {
		return this.api.registerCredentialsProvider({
			getCredentials: async host => {
				if (host.authority !== 'github.com') { return undefined; }
				const token = await context.secrets.get('auraTeam.githubToken');
				return token ? { username: 'x-access-token', password: token } : undefined;
			}
		});
	}

	async getProject(url: string): Promise<void> {
		this.log(`git clone ${url}`);
		const target = await this.api.clone(vscode.Uri.parse(url));
		if (target) {
			await vscode.commands.executeCommand('vscode.openFolder', target);
		}
	}

	/** Снимок состояния репозитория для git-панели вкладки. */
	async getSnapshot(): Promise<GitSnapshot | undefined> {
		const repository = this.repository;
		if (!repository) { return undefined; }
		const changes = [
			...repository.state.indexChanges.map(change => ({ path: vscode.workspace.asRelativePath(change.uri, false), kind: 'index' as const })),
			...repository.state.workingTreeChanges.map(change => ({ path: vscode.workspace.asRelativePath(change.uri, false), kind: 'working' as const })),
			...repository.state.untrackedChanges.map(change => ({ path: vscode.workspace.asRelativePath(change.uri, false), kind: 'untracked' as const }))
		];
		let commits: GitSnapshot['commits'] = [];
		try {
			commits = (await repository.log({ maxEntries: 15 })).map(commit => ({
				hash: commit.hash,
				message: commit.message.split('\n')[0],
				author: commit.authorName,
				date: commit.authorDate?.toISOString()
			}));
		} catch { /* лог недоступен */ }
		let branches: GitBranchInfo[] | undefined;
		try { branches = await this.branchInfo(); } catch { /* нет веток */ }
		return {
			path: repository.rootUri.fsPath,
			branch: repository.state.HEAD?.name ?? '',
			remotes: repository.state.remotes.map(remote => remote.name),
			changes,
			commits,
			branches,
			ahead: branches?.find(b => b.current)?.ahead,
			behind: branches?.find(b => b.current)?.behind
		};
	}

	/**
	 * Дифф файла против HEAD.
	 *
	 * Раньше для новых файлов строился git-URI с ref `/dev/null` — провайдер
	 * `git:` знает только реальные refs и пустое дерево, поэтому чтение падало
	 * с «Unable to resolve nonexistent file 'git:…'» (именно эта ошибка открывалась
	 * вместо сравнения). Теперь левая сторона для отсутствующей версии — настоящий
	 * пустой файл, а правая берётся с диска обычным `Uri.file`, который корректно
	 * переживает кириллицу, пробелы и скобки в пути.
	 */
	async showDiff(filePath: string): Promise<void> {
		const repository = this.requireRepository();
		const absolute = join(repository.rootUri.fsPath, filePath);
		const uri = vscode.Uri.file(absolute);
		const branch = repository.state.HEAD?.name ?? 'HEAD';
		const exists = existsSync(absolute);
		if (!exists) {
			// Файл удалён: слева — версия из HEAD, справа — пусто.
			const head = this.api.toGitUri(vscode.Uri.file(absolute), 'HEAD');
			await vscode.commands.executeCommand('vscode.diff', head, await this.emptyFileUri(), `${filePath} (удалён · ${branch})`);
			return;
		}
		const untracked = repository.state.untrackedChanges.some(change => vscode.workspace.asRelativePath(change.uri, false) === filePath);
		if (untracked) {
			await vscode.commands.executeCommand('vscode.diff', await this.emptyFileUri(), uri, `${filePath} (новый · ${branch})`);
			return;
		}
		const head = this.api.toGitUri(uri, 'HEAD');
		await vscode.commands.executeCommand('vscode.diff', head, uri, `${filePath} (${branch})`);
	}

	/** Пустой файл-эталон во временной папке: сторона «до» для новых и удалённых файлов. */
	private async emptyFileUri(): Promise<vscode.Uri> {
		if (this.emptyFile) { return this.emptyFile; }
		const target = vscode.Uri.joinPath(vscode.Uri.file(tmpdir()), 'aura-team-empty.txt');
		try { await vscode.workspace.fs.writeFile(target, new Uint8Array()); } catch { /* файл могли создать раньше */ }
		this.emptyFile = target;
		return target;
	}

	async listBranches(): Promise<string[]> {
		const repository = this.requireRepository();
		const result = await execFileAsync(this.api.git?.path ?? 'git', ['branch', '--format', '%(refname:short)'], { cwd: repository.rootUri.fsPath });
		return result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	}

	/** Ветки с флагом текущей и ahead/behind относительно upstream. */
	async branchInfo(): Promise<GitBranchInfo[]> {
		const repository = this.requireRepository();
		const current = repository.state.HEAD?.name ?? '';
		const result = await execFileAsync(this.api.git?.path ?? 'git', ['branch', '--format', '%(refname:short)%09%(upstream:track)'], { cwd: repository.rootUri.fsPath });
		return result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
			const [name, track = ''] = line.split('\t');
			const ahead = /ahead (\d+)/.exec(track)?.[1];
			const behind = /behind (\d+)/.exec(track)?.[1];
			return { name, current: name === current, ahead: ahead ? Number(ahead) : undefined, behind: behind ? Number(behind) : undefined };
		});
	}

	async createBranch(name: string): Promise<void> {
		const repository = this.requireRepository();
		if (!/^[\w.\-/]{1,80}$/.test(name)) { throw new Error(vscode.l10n.t('Invalid branch name.')); }
		this.log(`git checkout -b ${name}`);
		await this.runGit(repository, ['checkout', '-b', name]);
	}

	async deleteBranch(name: string): Promise<void> {
		const repository = this.requireRepository();
		this.log(`git branch -d ${name}`);
		await this.runGit(repository, ['branch', '-d', name]);
	}

	/** git stash push (с untracked) — перед пулом при грязном дереве. */
	async stashPush(message = 'aura-team autostash'): Promise<boolean> {
		const repository = this.requireRepository();
		const dirty = [...repository.state.workingTreeChanges, ...repository.state.indexChanges, ...repository.state.untrackedChanges];
		if (dirty.length === 0) { return false; }
		this.log('git stash push -u');
		await this.runGit(repository, ['stash', 'push', '-u', '-m', message]);
		return true;
	}

	/** Вернуть последний stash (pop). */
	async stashPop(): Promise<void> {
		const repository = this.requireRepository();
		this.log('git stash pop');
		await this.runGit(repository, ['stash', 'pop']);
	}

	async checkout(branch: string): Promise<void> {
		const repository = this.requireRepository();
		this.log(`git checkout ${branch}`);
		await this.runGit(repository, ['checkout', branch]);
	}

	/** Закоммитить всё (включая новые файлы) и запушить с pull-rebase при отклонении. */
	async commitAll(message: string): Promise<{ hash: string; message: string; remoteUrl?: string }> {
		const repository = this.requireRepository();
		const commit = await this.commitOnly(message, repository);
		await this.pushWithRetry(repository);
		return commit;
	}

	/** Коммит без пуша — пуш делается отдельно, чтобы ошибка отправки не маскировала успешный коммит. */
	async commitOnly(message: string, repository?: Repository): Promise<{ hash: string; message: string; remoteUrl?: string }> {
		const repo = repository ?? this.requireRepository();
		const paths = [...repo.state.workingTreeChanges, ...repo.state.untrackedChanges].map(change => change.uri.fsPath);
		if (paths.length === 0 && repo.state.indexChanges.length === 0) { throw new Error(vscode.l10n.t('There are no changes to save.')); }
		if (paths.length > 0) {
			this.log(`git add -- ${paths.join(' ')}`);
			await repo.add(paths);
		}
		this.log(`git commit -m ${JSON.stringify(message)}`);
		await repo.commit(message);
		const commit = await repo.getCommit('HEAD');
		return { hash: commit.hash, message, remoteUrl: repo.state.remotes.find(remote => remote.name === 'origin')?.fetchUrl };
	}

	/** Коммит только выбранных файлов: сначала снимаем staged, добавляем выбранные, коммитим. */
	async commitSelected(message: string, selectedPaths: string[]): Promise<{ hash: string; message: string; remoteUrl?: string }> {
		const repository = this.requireRepository();
		if (selectedPaths.length === 0) { throw new Error(vscode.l10n.t('No files were selected.')); }
		// Всё, что уже в индексе, но не выбрано — временно снимаем, чтобы не попало в коммит.
		const stagedNotSelected = repository.state.indexChanges.map(change => change.uri.fsPath).filter(p => !selectedPaths.includes(p));
		if (stagedNotSelected.length > 0) {
			this.log(`git restore --staged -- ${stagedNotSelected.length} files`);
			await repository.restore(stagedNotSelected, { staged: true });
		}
		const toAdd = selectedPaths.filter(p => !repository.state.indexChanges.some(change => change.uri.fsPath === p));
		if (toAdd.length > 0) {
			this.log(`git add -- ${toAdd.length} files`);
			await repository.add(toAdd);
		}
		this.log(`git commit -m ${JSON.stringify(message)}`);
		await repository.commit(message);
		const commit = await repository.getCommit('HEAD');
		return { hash: commit.hash, message, remoteUrl: repository.state.remotes.find(remote => remote.name === 'origin')?.fetchUrl };
	}

	async push(): Promise<void> {
		const repository = this.requireRepository();
		await this.pushWithRetry(repository);
	}

	private async pushWithRetry(repository: Repository): Promise<void> {
		this.log('git push');
		try {
			await repository.push();
		} catch (error) {
			if (!isPushRejected(error)) { throw error; }
			this.log('git pull --rebase');
			await this.runGit(repository, ['pull', '--rebase']);
			await this.handleConflicts(repository);
			this.log('git push');
			await repository.push();
		}
	}

	async saveWork(message: string): Promise<{ hash: string; message: string; remoteUrl?: string }> {
		const repository = this.requireRepository();
		const changesByPath = new Map<string, { change: { uri: vscode.Uri }; source: string; picked: boolean }>();
		for (const change of repository.state.indexChanges) { changesByPath.set(change.uri.fsPath, { change, source: vscode.l10n.t('All Changes in Staged File'), picked: true }); }
		for (const change of repository.state.workingTreeChanges) { changesByPath.set(change.uri.fsPath, { change, source: vscode.l10n.t('All Changes in File'), picked: true }); }
		for (const change of repository.state.untrackedChanges) { changesByPath.set(change.uri.fsPath, { change, source: vscode.l10n.t('New File'), picked: false }); }
		const changes = [...changesByPath.values()];
		if (changes.length === 0) { throw new Error(vscode.l10n.t('There are no changes to save.')); }
		const selected = await vscode.window.showQuickPick(changes.map(item => ({
			label: vscode.workspace.asRelativePath(item.change.uri),
			description: item.source,
			picked: item.picked,
			path: item.change.uri.fsPath
		})), { canPickMany: true, placeHolder: vscode.l10n.t('Select files to commit. New files are not selected automatically.') });
		if (!selected?.length) { throw new Error(vscode.l10n.t('No files were selected.')); }
		const paths = selected.map(item => item.path);
		const confirmation = await vscode.window.showWarningMessage(
			vscode.l10n.t('Commit and push {0} selected file(s)?', paths.length),
			{ modal: true, detail: selected.map(item => item.label).join('\n') },
			vscode.l10n.t('Commit and Push')
		);
		if (confirmation !== vscode.l10n.t('Commit and Push')) { throw new Error(vscode.l10n.t('Save Work was cancelled.')); }
		const stagedPaths = repository.state.indexChanges.map(change => change.uri.fsPath);
		if (stagedPaths.length > 0) {
			this.log(`git restore --staged -- ${stagedPaths.join(' ')}`);
			await repository.restore(stagedPaths, { staged: true });
		}
		this.log(`git add -- ${paths.join(' ')}`);
		await repository.add(paths);
		this.log(`git commit -m ${JSON.stringify(message)}`);
		await repository.commit(message);
		await this.pushWithRetry(repository);
		const commit = await repository.getCommit('HEAD');
		return { hash: commit.hash, message, remoteUrl: repository.state.remotes.find(remote => remote.name === 'origin')?.fetchUrl };
	}

	async update(): Promise<void> {
		const repository = this.requireRepository();
		this.log('git fetch --all --prune');
		await repository.fetch({ all: true, prune: true });
		// Грязное дерево — прячем локальные изменения в stash и возвращаем их после пулла.
		const stashed = await this.stashPush('aura-team: перед pull');
		try {
			this.log('git pull --rebase');
			await this.runGit(repository, ['pull', '--rebase']);
			await this.handleConflicts(repository);
		} finally {
			if (stashed) {
				try { await this.stashPop(); } catch (error) {
					this.log(`stash pop failed: ${String(error)}`);
					vscode.window.showWarningMessage(vscode.l10n.t('Your stashed changes could not be applied automatically — run "git stash pop" manually.'));
				}
			}
		}
	}

	/** Пути изменённых/новых файлов — для авто-коммита по шаблону. */
	async changedFiles(): Promise<string[]> {
		const repository = this.requireRepository();
		return [
			...repository.state.indexChanges,
			...repository.state.workingTreeChanges,
			...repository.state.untrackedChanges
		].map(change => vscode.workspace.asRelativePath(change.uri, false));
	}

	async undoUncommitted(): Promise<void> {
		const repository = this.requireRepository();
		const paths = [...repository.state.indexChanges, ...repository.state.workingTreeChanges].map(change => change.uri.fsPath);
		if (paths.length === 0) { return; }
		this.log(`git restore --staged --worktree -- ${paths.join(' ')}`);
		await repository.restore(paths, { staged: true });
		await repository.restore(paths);
	}

	async revertLastCommit(): Promise<void> {
		const repository = this.requireRepository();
		this.log('git revert --no-edit HEAD');
		await this.runGit(repository, ['revert', '--no-edit', 'HEAD']);
		await this.handleConflicts(repository);
	}

	async restoreFile(uri: vscode.Uri, ref: string): Promise<void> {
		const repository = this.requireRepository();
		const relativePath = vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/');
		this.log(`git restore --source=${ref} -- ${relativePath}`);
		await repository.restore([uri.fsPath], { ref });
	}

	/** Отменить изменения в одном файле (git restore --staged --worktree). */
	async discardFile(filePath: string): Promise<void> {
		const repository = this.requireRepository();
		const uri = await this.toUri(filePath);
		if (!uri) { throw new Error(vscode.l10n.t('File not found in workspace: {0}', filePath)); }
		this.log(`git restore --staged --worktree -- ${filePath}`);
		await repository.restore([uri.fsPath], { staged: true });
		await repository.restore([uri.fsPath]);
	}

	/** Сбросить ветку к HEAD~1: soft — изменения остаются в индексе, hard — стираются. */
	async resetBranch(mode: 'soft' | 'hard'): Promise<void> {
		const repository = this.requireRepository();
		this.log(`git reset --${mode} HEAD~1`);
		await this.runGit(repository, ['reset', `--${mode}`, 'HEAD~1']);
	}

	private async toUri(filePath: string): Promise<vscode.Uri | undefined> {
		const roots = vscode.workspace.workspaceFolders ?? [];
		for (const root of roots) {
			const candidate = vscode.Uri.joinPath(root.uri, filePath);
			try { await vscode.workspace.fs.stat(candidate); return candidate; } catch { /* не в этой папке */ }
		}
		return undefined;
	}

	async relink(url: string): Promise<void> {
		const repository = this.requireRepository();
		const hasOrigin = repository.state.remotes.some(remote => remote.name === 'origin');
		if (hasOrigin) {
			this.log('git remote remove origin');
			await repository.removeRemote('origin');
		}
		this.log(`git remote add origin ${url}`);
		await repository.addRemote('origin', url);
	}

	async showHistory(): Promise<void> {
		const repository = this.requireRepository();
		this.log('git log -50');
		const commits = await repository.log({ maxEntries: 50 });
		const selected = await vscode.window.showQuickPick(commits.map(commit => ({
			label: commit.message.split('\n')[0],
			description: `${commit.hash.slice(0, 8)} · ${commit.authorName ?? ''}`,
			detail: commit.authorDate?.toLocaleString(),
			commit
		})), { placeHolder: vscode.l10n.t('Select a commit to compare with the current version') });
		if (selected) {
			const file = await pickWorkspaceFile();
			if (file) {
				await vscode.commands.executeCommand('vscode.diff', this.api.toGitUri(file, selected.commit.hash), file, selected.label);
			}
		}
	}

	/* ================= Командный процесс: ветка → main → тесты → дифф → PR → откат ================= */

	/** git с возвратом stdout (большой буфер — диффы бывают крупными). */
	async runGitOut(args: string[], allowExitCodes: number[] = []): Promise<string> {
		const repository = this.requireRepository();
		try {
			const result = await execFileAsync(this.api.git?.path ?? 'git', args, { cwd: repository.rootUri.fsPath, maxBuffer: 64 * 1024 * 1024 });
			return result.stdout;
		} catch (error) {
			const failed = error as Error & { code?: number; stdout?: string; stderr?: string };
			if (typeof failed.code === 'number' && allowExitCodes.includes(failed.code)) { return failed.stdout ?? ''; }
			throw new Error((failed.stderr || failed.message || String(error)).trim());
		}
	}

	private async refExists(ref: string): Promise<boolean> {
		try { await this.runGitOut(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return true; } catch { return false; }
	}

	/** Основная ветка команды: origin/HEAD → main → master → текущая. */
	async defaultBranch(): Promise<string> {
		try {
			const head = (await this.runGitOut(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
			if (head.startsWith('origin/')) { return head.slice('origin/'.length); }
		} catch { /* origin/HEAD не выставлен — ищем по именам */ }
		for (const name of ['main', 'master', 'develop']) {
			if (await this.refExists(`origin/${name}`) || await this.refExists(name)) { return name; }
		}
		return this.repository?.state.HEAD?.name || 'main';
	}

	/** Ref основной ветки для сравнения: удалённая версия, если она есть. */
	async baseRef(base?: string): Promise<{ base: string; ref: string }> {
		const name = base ?? await this.defaultBranch();
		return { base: name, ref: await this.refExists(`origin/${name}`) ? `origin/${name}` : name };
	}

	hasOrigin(): boolean {
		return Boolean(this.repository?.state.remotes.some(remote => remote.name === 'origin'));
	}

	originUrl(): string | undefined {
		return this.repository?.state.remotes.find(remote => remote.name === 'origin')?.fetchUrl;
	}

	isDirty(): boolean {
		const repository = this.requireRepository();
		return repository.state.workingTreeChanges.length + repository.state.indexChanges.length + repository.state.untrackedChanges.length > 0;
	}

	private async fetchOrigin(): Promise<void> {
		if (!this.hasOrigin()) { return; }
		this.log('git fetch origin --prune');
		try { await this.runGit(this.requireRepository(), ['fetch', 'origin', '--prune']); } catch (error) { this.log(`fetch failed: ${String(error)}`); }
	}

	/** Насколько ветка ушла от main: ahead — моих коммитов, behind — новых в main. */
	async divergence(): Promise<{ base: string; ahead: number; behind: number }> {
		const { base, ref } = await this.baseRef();
		try {
			const counts = parseLeftRight(await this.runGitOut(['rev-list', '--left-right', '--count', `${ref}...HEAD`]));
			return { base, ...counts };
		} catch { return { base, ahead: 0, behind: 0 }; }
	}

	/** Перейти в свою ветку: локальную, удалённую (с трекингом) или новую от свежего main. */
	async startBranch(name: string): Promise<{ branch: string; created: boolean }> {
		const repository = this.requireRepository();
		if (!isValidBranchName(name)) { throw new Error(vscode.l10n.t('Invalid branch name.')); }
		if (repository.state.HEAD?.name === name) { return { branch: name, created: false }; }
		await this.fetchOrigin();
		if (await this.refExists(`refs/heads/${name}`)) {
			this.log(`git checkout ${name}`);
			await this.runGit(repository, ['checkout', name]);
			return { branch: name, created: false };
		}
		if (await this.refExists(`origin/${name}`)) {
			this.log(`git checkout -b ${name} --track origin/${name}`);
			await this.runGit(repository, ['checkout', '-b', name, '--track', `origin/${name}`]);
			return { branch: name, created: false };
		}
		const { ref } = await this.baseRef();
		const from = await this.refExists(ref) ? ref : 'HEAD';
		this.log(`git checkout -b ${name} ${from}`);
		await this.runGit(repository, ['checkout', '--no-track', '-b', name, from]);
		return { branch: name, created: true };
	}

	/** Подтянуть свежий main в текущую ветку (merge), локальные правки — через stash. */
	async syncWithBase(): Promise<{ base: string; upToDate: boolean; behindBefore: number }> {
		const repository = this.requireRepository();
		await this.fetchOrigin();
		const { base, ref } = await this.baseRef();
		const before = await this.divergence();
		if (before.behind === 0) { return { base, upToDate: true, behindBefore: 0 }; }
		const stashed = await this.stashPush('aura-team: перед слиянием main');
		try {
			if (repository.state.HEAD?.name === base) {
				this.log(`git merge --ff-only ${ref}`);
				await this.runGit(repository, ['merge', '--ff-only', ref]);
			} else {
				this.log(`git merge --no-edit ${ref}`);
				try { await this.runGit(repository, ['merge', '--no-edit', ref]); } catch (error) {
					await this.waitForState();
					await this.handleConflicts(repository);
					throw error;
				}
			}
		} finally {
			if (stashed) {
				try { await this.stashPop(); } catch (error) {
					this.log(`stash pop failed: ${String(error)}`);
					vscode.window.showWarningMessage(vscode.l10n.t('Your stashed changes could not be applied automatically — run "git stash pop" manually.'));
				}
			}
		}
		return { base, upToDate: false, behindBefore: before.behind };
	}

	/** Даём git-расширению обновить state (mergeChanges) после внешней команды. */
	private async waitForState(): Promise<void> {
		await new Promise(resolve => setTimeout(resolve, 600));
	}

	/** Что ветка принесёт в main: дифф от точки ответвления до HEAD. */
	async diffAgainstBase(): Promise<{ base: string; ref: string; text: string }> {
		await this.fetchOrigin();
		const { base, ref } = await this.baseRef();
		const text = await this.runGitOut(['diff', '--no-color', '--no-ext-diff', '-M', `${ref}...HEAD`]);
		return { base, ref, text };
	}

	/** Несохранённые изменения: tracked против HEAD + новые файлы целиком. */
	async diffWorking(): Promise<string> {
		const repository = this.requireRepository();
		let text = await this.runGitOut(['diff', '--no-color', '--no-ext-diff', '-M', 'HEAD']).catch(() => this.runGitOut(['diff', '--no-color', '--no-ext-diff', '--cached']));
		for (const change of repository.state.untrackedChanges.slice(0, 40)) {
			const relative = vscode.workspace.asRelativePath(change.uri, false).replaceAll('\\', '/');
			text += '\n' + await this.runGitOut(['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', change.uri.fsPath], [1])
				.then(out => out.replace(/^diff --git .*$/m, `diff --git a/${relative} b/${relative}`).replace(/^\+\+\+ .*$/m, `+++ b/${relative}`))
				.catch(() => '');
		}
		return text;
	}

	private static assertHash(hash: string): string {
		const value = String(hash ?? '').trim();
		if (!/^[0-9a-f]{4,40}$/i.test(value)) { throw new Error(vscode.l10n.t('Invalid commit hash.')); }
		return value;
	}

	private async parentCount(hash: string): Promise<number> {
		const line = (await this.runGitOut(['rev-list', '--parents', '-n', '1', hash])).trim();
		return Math.max(0, line.split(/\s+/).length - 1);
	}

	/** Дифф одного коммита (для merge-коммита — против первого родителя). */
	async commitDiff(hash: string): Promise<{ text: string; subject: string; author: string; date: string }> {
		const ref = GitService.assertHash(hash);
		const meta = (await this.runGitOut(['show', '-s', '--format=%s%x1f%an%x1f%aI', ref])).trim().split('\x1f');
		const parents = await this.parentCount(ref);
		const text = parents === 0
			? await this.runGitOut(['show', '--format=', '--no-color', '--no-ext-diff', '-M', ref])
			: await this.runGitOut(['diff', '--no-color', '--no-ext-diff', '-M', `${ref}^1`, ref]);
		return { text, subject: meta[0] ?? '', author: meta[1] ?? '', date: meta[2] ?? '' };
	}

	/** Откатить конкретный коммит новым коммитом (merge-коммит — относительно main, -m 1). */
	async revertCommit(hash: string): Promise<{ hash: string }> {
		const repository = this.requireRepository();
		const ref = GitService.assertHash(hash);
		if (this.isDirty()) { throw new Error(vscode.l10n.t('Save or discard your changes before reverting a commit.')); }
		const args = (await this.parentCount(ref)) > 1 ? ['revert', '--no-edit', '-m', '1', ref] : ['revert', '--no-edit', ref];
		this.log(`git ${args.join(' ')}`);
		try { await this.runGit(repository, args); } catch (error) {
			await this.waitForState();
			await this.handleConflicts(repository);
			throw error;
		}
		return { hash: (await this.runGitOut(['rev-parse', 'HEAD'])).trim() };
	}

	/** Отправить текущую ветку и выставить upstream (нужно перед созданием PR). */
	async pushCurrentBranch(): Promise<string> {
		const repository = this.requireRepository();
		const branch = repository.state.HEAD?.name;
		if (!branch) { throw new Error(vscode.l10n.t('Check out a branch first.')); }
		if (!this.hasOrigin()) { throw new Error(vscode.l10n.t('The repository has no origin remote.')); }
		this.log(`git push -u origin ${branch}`);
		try { await repository.push('origin', branch, true); } catch (error) {
			if (!isPushRejected(error)) { throw error; }
			this.log('git pull --rebase');
			await this.runGit(repository, ['pull', '--rebase', 'origin', branch]);
			await this.handleConflicts(repository);
			await repository.push('origin', branch, true);
		}
		return branch;
	}

	/**
	 * Слить ветку в main без GitHub (локально): main ← merge --no-ff ветки → push → назад.
	 * Только на чистом дереве: смешивать слияние с несохранённой работой опасно.
	 */
	async mergeIntoBase(branch: string): Promise<{ base: string; pushed: boolean }> {
		const repository = this.requireRepository();
		if (this.isDirty()) { throw new Error(vscode.l10n.t('Save or discard your changes before merging.')); }
		const { base, ref } = await this.baseRef();
		if (branch === base) { throw new Error(vscode.l10n.t('You are already on the main branch.')); }
		await this.fetchOrigin();
		this.log(`git checkout ${base}`);
		await this.runGit(repository, ['checkout', base]);
		let pushed = false;
		try {
			if (ref !== base) {
				this.log(`git merge --ff-only ${ref}`);
				await this.runGit(repository, ['merge', '--ff-only', ref]);
			}
			this.log(`git merge --no-ff --no-edit ${branch}`);
			try { await this.runGit(repository, ['merge', '--no-ff', '--no-edit', branch]); } catch (error) {
				await this.waitForState();
				await this.handleConflicts(repository);
				throw error;
			}
			if (this.hasOrigin()) {
				this.log(`git push origin ${base}`);
				await repository.push('origin', base, false);
				pushed = true;
			}
		} finally {
			if (repository.state.mergeChanges.length === 0) {
				this.log(`git checkout ${branch}`);
				await this.runGit(repository, ['checkout', branch]).catch(error => this.log(`checkout back failed: ${String(error)}`));
			}
		}
		return { base, pushed };
	}

	/** Ветка отката PR: от свежего main, revert merge-коммита, push. */
	async prepareRevertBranch(name: string, mergeSha: string): Promise<string> {
		const repository = this.requireRepository();
		if (this.isDirty()) { throw new Error(vscode.l10n.t('Save or discard your changes before reverting a commit.')); }
		await this.fetchOrigin();
		const { ref } = await this.baseRef();
		this.log(`git checkout --no-track -B ${name} ${ref}`);
		await this.runGit(repository, ['checkout', '--no-track', '-B', name, ref]);
		await this.revertCommit(mergeSha);
		await this.pushCurrentBranch();
		return name;
	}

	/** Открыть файл в редакторе сравнения: слева версия на ref, справа рабочая (или rightRef). */
	async openFileAgainst(filePath: string, leftRef: string, rightRef?: string): Promise<void> {
		const repository = this.requireRepository();
		const absolute = join(repository.rootUri.fsPath, filePath);
		const uri = vscode.Uri.file(absolute);
		const left = this.api.toGitUri(uri, leftRef);
		const right = rightRef ? this.api.toGitUri(uri, rightRef) : (existsSync(absolute) ? uri : await this.emptyFileUri());
		await vscode.commands.executeCommand('vscode.diff', left, right, `${filePath} (${leftRef} ↔ ${rightRef ?? vscode.l10n.t('working tree')})`);
	}

	/** Команда тестов: настройка auraTeam.git.testCommand или автоопределение по файлам проекта. */
	async testCommand(): Promise<string | undefined> {
		const configured = vscode.workspace.getConfiguration('auraTeam').get<string>('git.testCommand', '').trim();
		if (configured) { return configured; }
		const root = this.requireRepository().rootUri.fsPath;
		const read = async (name: string): Promise<string | undefined> => {
			try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(join(root, name)))); } catch { return undefined; }
		};
		return detectTestCommand({
			packageJson: await read('package.json'),
			hasPyproject: existsSync(join(root, 'pyproject.toml')),
			hasPytestIni: existsSync(join(root, 'pytest.ini')),
			hasCargo: existsSync(join(root, 'Cargo.toml')),
			hasGoMod: existsSync(join(root, 'go.mod')),
			hasMakefile: await read('Makefile')
		});
	}

	/** Запуск тестов задачей VS Code (вывод — в терминале), ждём код выхода. */
	async runTests(): Promise<{ command: string; exitCode: number | undefined }> {
		const repository = this.requireRepository();
		const command = await this.testCommand();
		if (!command) { throw new Error(vscode.l10n.t('No test command found. Set "auraTeam.git.testCommand" in settings.')); }
		const folder = vscode.workspace.getWorkspaceFolder(repository.rootUri) ?? vscode.TaskScope.Workspace;
		const task = new vscode.Task({ type: 'shell', task: 'aura-team-tests' }, folder, 'Aura Team: tests', 'aura-team', new vscode.ShellExecution(command, { cwd: repository.rootUri.fsPath }));
		task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
		this.log(`tests: ${command}`);
		const execution = await vscode.tasks.executeTask(task);
		const exitCode = await new Promise<number | undefined>(resolve => {
			const done = vscode.tasks.onDidEndTaskProcess(event => {
				if (event.execution === execution) { done.dispose(); ended.dispose(); resolve(event.exitCode); }
			});
			const ended = vscode.tasks.onDidEndTask(event => {
				if (event.execution === execution) { setTimeout(() => { done.dispose(); ended.dispose(); resolve(undefined); }, 300); }
			});
		});
		return { command, exitCode };
	}

	/** Кинет ошибку, если репозитория нет; доступен подклассам и сервисам синка. */
	requireRepository(): Repository {
		if (!this.repository) { throw new Error(vscode.l10n.t('Open a Git project first.')); }
		return this.repository;
	}

	/** Путь к открытой папке (для init нового репозитория). */
	workspaceRoot(): string | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	/** git init в открытой папке, первый коммит, привязка remote и пуш текущей ветки. */
	async initAndPublish(remoteUrl: string, message: string): Promise<void> {
		const root = this.workspaceRoot();
		if (!root) { throw new Error(vscode.l10n.t('Open a folder to publish first.')); }
		const gitPath = this.api.git?.path ?? 'git';
		const run = async (...args: string[]): Promise<void> => {
			this.log(`git ${args.join(' ')}`);
			const result = await execFileAsync(gitPath, args, { cwd: root });
			if (result.stdout) { this.output.append(result.stdout); }
			if (result.stderr) { this.output.append(result.stderr); }
		};
		await run('init');
		await run('add', '--all');
		await run('commit', '--allow-empty', '-m', message || 'Initial commit');
		await run('remote', 'remove', 'origin').catch(() => undefined);
		await run('remote', 'add', 'origin', remoteUrl);
		const branch = (await execFileAsync(gitPath, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root })).stdout.trim() || 'main';
		this.log(`git push -u origin ${branch}`);
		await execFileAsync(gitPath, ['push', '-u', 'origin', branch], { cwd: root });
	}

	private async handleConflicts(repository: Repository): Promise<void> {
		if (repository.state.mergeChanges.length > 0) {
			const mine = vscode.l10n.t('Take Mine');
			const theirs = vscode.l10n.t('Take Theirs');
			const compare = vscode.l10n.t('Open Comparison');
			const choice = await vscode.window.showWarningMessage(vscode.l10n.t('Git found conflicts in {0} file(s).', repository.state.mergeChanges.length), { modal: true }, mine, theirs, compare);
			if (choice === compare || !choice) {
				await vscode.commands.executeCommand('workbench.view.scm');
			} else {
				const paths = repository.state.mergeChanges.map(change => change.uri.fsPath);
				const side = choice === mine ? '--ours' : '--theirs';
				this.log(`git checkout ${side} -- ${paths.join(' ')}`);
				await this.runGit(repository, ['checkout', side, '--', ...paths]);
				this.log(`git add -- ${paths.join(' ')}`);
				await repository.add(paths);
			}
			throw new Error(vscode.l10n.t('Git found conflicts. Choose yours, theirs, or open the comparison in Source Control.'));
		}
	}

	private async runGit(repository: Repository, args: string[]): Promise<void> {
		const result = await execFileAsync(this.api.git?.path ?? 'git', args, { cwd: repository.rootUri.fsPath });
		if (result.stdout) { this.output.append(result.stdout); }
		if (result.stderr) { this.output.append(result.stderr); }
	}

	private log(command: string): void {
		this.output.appendLine(`[git] ${command}`);
	}
}

async function pickWorkspaceFile(): Promise<vscode.Uri | undefined> {
	const files = await vscode.workspace.findFiles('**/*', '**/{.git,node_modules,out,dist}/**', 500);
	const item = await vscode.window.showQuickPick(files.map(uri => ({ label: vscode.workspace.asRelativePath(uri), uri })), { placeHolder: vscode.l10n.t('Select a file to compare') });
	return item?.uri;
}

function isPushRejected(error: unknown): boolean {
	if (!(error instanceof Error)) { return false; }
	const code = (error as Error & { gitErrorCode?: string }).gitErrorCode;
	return code === 'PushRejected' || /non-fast-forward|fetch first|rejected/i.test(error.message);
}
