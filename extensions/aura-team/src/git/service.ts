/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { API, GitExtension, Repository } from './git';
import { GitSnapshot } from '../types';

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
		return {
			path: repository.rootUri.fsPath,
			branch: repository.state.HEAD?.name ?? '',
			remotes: repository.state.remotes.map(remote => remote.name),
			changes,
			commits
		};
	}

	async listBranches(): Promise<string[]> {
		const repository = this.requireRepository();
		const result = await execFileAsync(this.api.git?.path ?? 'git', ['branch', '--format', '%(refname:short)'], { cwd: repository.rootUri.fsPath });
		return result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	}

	async checkout(branch: string): Promise<void> {
		const repository = this.requireRepository();
		this.log(`git checkout ${branch}`);
		await this.runGit(repository, ['checkout', branch]);
	}

	/** Закоммитить всё (включая новые файлы) и запушить с pull-rebase при отклонении. */
	async commitAll(message: string): Promise<{ hash: string; message: string; remoteUrl?: string }> {
		const repository = this.requireRepository();
		const paths = [...repository.state.workingTreeChanges, ...repository.state.untrackedChanges].map(change => change.uri.fsPath);
		if (paths.length === 0 && repository.state.indexChanges.length === 0) { throw new Error(vscode.l10n.t('There are no changes to save.')); }
		if (paths.length > 0) {
			this.log(`git add -- ${paths.join(' ')}`);
			await repository.add(paths);
		}
		this.log(`git commit -m ${JSON.stringify(message)}`);
		await repository.commit(message);
		await this.pushWithRetry(repository);
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
		this.log('git pull --rebase');
		await this.runGit(repository, ['pull', '--rebase']);
		await this.handleConflicts(repository);
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

	private requireRepository(): Repository {
		if (!this.repository) { throw new Error(vscode.l10n.t('Open a Git project first.')); }
		return this.repository;
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
