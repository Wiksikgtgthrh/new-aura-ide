/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { API, GitExtension, Repository } from './git';
import { GitBranchInfo, GitSnapshot } from '../types';

const execFileAsync = promisify(execFile);

export class GitService {
	private readonly api: API;

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

	/** Дифф файла: рабочая версия против HEAD (для клика по файлу в списке изменений). */
	async showDiff(filePath: string): Promise<void> {
		const repository = this.requireRepository();
		const uri = vscode.Uri.file(join(repository.rootUri.fsPath, filePath));
		const title = `${filePath} (${repository.state.HEAD?.name ?? 'HEAD'})`;
		const untracked = repository.state.untrackedChanges.some(change => vscode.workspace.asRelativePath(change.uri, false) === filePath);
		if (untracked) {
			// Нового файла нет в HEAD — сравниваем с пустой версией.
			const empty = this.api.toGitUri(uri, '/dev/null');
			await vscode.commands.executeCommand('vscode.diff', empty, uri, title);
			return;
		}
		const head = this.api.toGitUri(uri, 'HEAD');
		await vscode.commands.executeCommand('vscode.diff', head, uri, title);
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
