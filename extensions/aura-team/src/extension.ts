/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AuraApiClient } from './api/client';
import { connectGitHub } from './auth/github';
import { GitService } from './git/service';
import { BoardSnapshot, Project, Session, TeamApiKey } from './types';
import { BoardPanel } from './views/board';
import { AuraWebviewViewProvider } from './webview/webviewViewProvider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const output = vscode.window.createOutputChannel('Aura Team');
	const api = new AuraApiClient(context, output);
	const gitExtension = vscode.extensions.getExtension('vscode.git');
	await gitExtension?.activate();
	const git = new GitService(output);
	const updateSimpleModeContext = async (): Promise<void> => vscode.commands.executeCommand('setContext', 'auraTeam.simpleMode', vscode.workspace.getConfiguration('auraTeam').get<boolean>('simpleMode', true));
		const state: { session?: Session; board?: BoardSnapshot; teamId?: string; keys?: TeamApiKey[] } = {};
		const boardPanel = new BoardPanel(api, () => state.teamId, async () => refresh());


	context.subscriptions.push(output, api, git.registerGitHubCredentials(context), vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('auraTeam.simpleMode')) { void updateSimpleModeContext(); }
	}));
		await updateSimpleModeContext();


		const refresh = async (): Promise<void> => {
			try {
				state.session = await api.getSession();
				state.teamId = state.teamId && state.session.teams.some(team => team.id === state.teamId) ? state.teamId : state.session.teams[0]?.id;
				state.board = state.teamId ? await api.getBoard(state.teamId) : undefined;
				state.keys = state.teamId ? await api.listApiKeys(state.teamId) : undefined;
				if (state.teamId) { api.connect(state.teamId); }
				if (state.board) { 
					boardPanel.update(state.board); 
					provider.update(state.board.tasks);
				}
			} catch (error) {
				state.session = undefined;
				state.board = undefined;
				state.keys = undefined;
				output.appendLine(`[api] ${errorMessage(error)}`);
			}
		};
		
		const provider = new AuraWebviewViewProvider(context.extensionUri);
		['members', 'project', 'tasks', 'keys'].forEach(kind => 
			context.subscriptions.push(vscode.window.registerWebviewViewProvider(`auraTeam.${kind}`, provider))
		);

	register(context, 'auraTeam.signIn', async () => {
		const device = await api.startDeviceAuthorization();
		await vscode.env.clipboard.writeText(device.userCode);
		await vscode.env.openExternal(vscode.Uri.parse(device.verificationUri));
		vscode.window.showInformationMessage(vscode.l10n.t('Sign-in code {0} was copied. Complete sign-in in the browser.', device.userCode));
		const deadline = Date.now() + device.expiresIn * 1000;
		while (Date.now() < deadline) {
			await delay(device.interval * 1000);
			const result = await api.pollDeviceAuthorization(device.deviceCode);
			if ('accessToken' in result) { await api.storeTokens(result); await refresh(); return; }
		}
		throw new Error(vscode.l10n.t('Sign-in expired. Try again.'));
	});
	register(context, 'auraTeam.signOut', async () => { await api.signOut(); await refresh(); });
	register(context, 'auraTeam.selectTeam', async () => {
		const selected = await vscode.window.showQuickPick(state.session?.teams.map(team => ({ label: team.name, description: team.role, id: team.id })) ?? [], { placeHolder: vscode.l10n.t('Select a team') });
		if (selected) { state.teamId = selected.id; await context.workspaceState.update('auraTeam.teamId', selected.id); await refresh(); }
	});
	register(context, 'auraTeam.toggleSimpleMode', async () => {
		const configuration = vscode.workspace.getConfiguration('auraTeam');
		const next = !configuration.get<boolean>('simpleMode', true);
		await configuration.update('simpleMode', next, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(next ? vscode.l10n.t('Simple Git mode is enabled.') : vscode.l10n.t('Advanced Git mode is enabled.'));
	});
	register(context, 'auraTeam.connectGitHub', async () => { await connectGitHub(context); vscode.window.showInformationMessage(vscode.l10n.t('GitHub is connected.')); });
	register(context, 'auraTeam.connectAuraApi', async () => {
		const teamId = requireTeam(state);
		const model = await requiredInput(vscode.l10n.t('Model ID'));
		const credential = await api.createProxyToken(teamId, 'openai', model);
		try {
			await vscode.commands.executeCommand('auraApi.addTeamProxy', {
				name: 'Aura Team · OpenAI',
				baseUrl: `${api.getServerUrl()}/v1/teams/${teamId}/proxy/openai/v1`,
				model,
				token: credential.token,
				provider: 'openai-compatible'
			});
			vscode.window.showInformationMessage(vscode.l10n.t('Team AI proxy was added to Aura API.'));
		} catch (error) {
			await api.revokeProxyToken(teamId, credential.id).catch(() => undefined);
			throw new Error(vscode.l10n.t('Install the Aura API plugin before connecting the team proxy. {0}', errorMessage(error)));
		}
	});
	register(context, 'auraTeam.createTeam', async () => { const name = await requiredInput(vscode.l10n.t('Team name')); await api.createTeam(name); await refresh(); });
	register(context, 'auraTeam.joinTeam', async () => { const code = await requiredInput(vscode.l10n.t('Invite code')); await api.joinTeam(code); await refresh(); });
	register(context, 'auraTeam.createInvite', async () => { const teamId = requireTeam(state); const invite = await api.createInvite(teamId); await vscode.env.clipboard.writeText(invite.code); vscode.window.showInformationMessage(vscode.l10n.t('Invite code {0} was copied.', invite.code)); });
	register(context, 'auraTeam.changeRole', async () => {
		const member = await vscode.window.showQuickPick(state.board?.members.filter(item => item.role !== 'owner').map(item => ({ label: item.displayName, description: item.role, id: item.id })) ?? [], { placeHolder: vscode.l10n.t('Select a team member') });
		const role = await vscode.window.showQuickPick(['maintainer', 'dev', 'viewer'], { placeHolder: vscode.l10n.t('Select the new role') });
		if (member && role) { await api.changeRole(requireTeam(state), member.id, role); await refresh(); }
	});
	register(context, 'auraTeam.createProject', async () => {
		const name = await requiredInput(vscode.l10n.t('Project name'));
		const gitUrl = await requiredInput(vscode.l10n.t('Git repository URL'));
		const branch = await requiredInput(vscode.l10n.t('Default branch'), 'main');
		await api.createProject(requireTeam(state), name, gitUrl, branch);
		await refresh();
	});
	register(context, 'auraTeam.createTask', async () => { const title = await requiredInput(vscode.l10n.t('Task title')); await api.createTask(requireTeam(state), title); await refresh(); });
	register(context, 'auraTeam.storeApiKey', async () => {
		const provider = await vscode.window.showQuickPick(['openai', 'anthropic'], { placeHolder: vscode.l10n.t('Provider') });
		const accessRole = await vscode.window.showQuickPick(['owner', 'maintainer', 'dev', 'viewer'], { placeHolder: vscode.l10n.t('Minimum role allowed to use this key') });
		if (!provider || !accessRole) { return; }
		const label = await requiredInput(vscode.l10n.t('Key name'), `${provider} team key`);
		const priorityText = await requiredInput(vscode.l10n.t('Priority (0 is highest)'), '100');
		const priority = Number(priorityText);
		if (!Number.isInteger(priority) || priority < 0 || priority > 1000) { throw new Error(vscode.l10n.t('Priority must be an integer from 0 to 1000.')); }
		const value = await vscode.window.showInputBox({ prompt: vscode.l10n.t('API key'), password: true, ignoreFocusOut: true });
		if (!value) { return; }
		await api.storeApiKey(requireTeam(state), provider, value, accessRole, label, priority);
		vscode.window.showInformationMessage(vscode.l10n.t('The API key is encrypted on the server.'));
		await refresh();
	});
	register(context, 'auraTeam.disableApiKey', async (key?: TeamApiKey) => {
		if (!key || !await confirm(vscode.l10n.t('Disable {0}? Existing clients will immediately stop using it.', key.label))) { return; }
		await api.disableApiKey(requireTeam(state), key.id);
		vscode.window.showInformationMessage(vscode.l10n.t('The team API key was disabled.'));
		await refresh();
	});
	register(context, 'auraTeam.uploadArchive', async () => {
		const uri = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'tar.zst': ['zst', 'tzst'] } }))?.[0];
		if (!uri) { return; }
		const bytes = await vscode.workspace.fs.readFile(uri);
		if (bytes.byteLength > 50 * 1024 * 1024) { throw new Error(vscode.l10n.t('The archive exceeds 50 MiB.')); }
		const projectName = await requiredInput(vscode.l10n.t('Project name'));
		const result = await api.uploadArchive(requireTeam(state), uri.path.split('/').pop() ?? 'project.tar.zst', projectName, bytes);
		vscode.window.showInformationMessage(vscode.l10n.t('Archive uploaded. It expires at {0}.', new Date(result.expiresAt).toLocaleString()));
		await refresh();
	});
	register(context, 'auraTeam.downloadArchive', async (project?: Project) => {
		if (!project?.archiveId) { throw new Error(vscode.l10n.t('This project has no archive.')); }
		const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${project.name}.tar.zst`), filters: { 'tar.zst': ['zst'] } });
		if (!destination) { return; }
		await vscode.workspace.fs.writeFile(destination, await api.downloadArchive(requireTeam(state), project.archiveId));
		vscode.window.showInformationMessage(vscode.l10n.t('Archive saved to {0}.', destination.fsPath));
	});
	register(context, 'auraTeam.openBoard', async () => { if (!state.board) { await refresh(); } if (state.board) { await boardPanel.show(state.board); } });
	register(context, 'auraTeam.getProject', async (project?: Project) => git.getProject(project?.gitUrl ?? await requiredInput(vscode.l10n.t('Git repository URL'))));
	register(context, 'auraTeam.saveWork', async () => {
		const commit = await git.saveWork(await requiredInput(vscode.l10n.t('Commit message'), 'task #TASK_ID: describe the completed work'));
		if (state.teamId && commit.remoteUrl) { await api.reportCommit(state.teamId, commit.hash, commit.remoteUrl, commit.message); }
	});
	register(context, 'auraTeam.updateProject', () => git.update());
	register(context, 'auraTeam.undoChanges', async () => { if (await confirm(vscode.l10n.t('Discard all uncommitted changes?'))) { await git.undoUncommitted(); } });
	register(context, 'auraTeam.revertLastCommit', async () => { if (await confirm(vscode.l10n.t('Create a new commit that reverses the last commit?'))) { await git.revertLastCommit(); } });
	register(context, 'auraTeam.restoreFile', async () => { const uri = await pickFile(); if (uri) { await git.restoreFile(uri, await requiredInput(vscode.l10n.t('Commit hash or tag'))); } });
	register(context, 'auraTeam.relink', async () => git.relink(await requiredInput(vscode.l10n.t('New origin URL'))));
	register(context, 'auraTeam.history', () => git.showHistory());

	state.teamId = context.workspaceState.get<string>('auraTeam.teamId');
	await refresh();
}

function register(context: vscode.ExtensionContext, command: string, callback: (...args: never[]) => Promise<void> | Thenable<void> | void): void {
	context.subscriptions.push(vscode.commands.registerCommand(command, async (...args: never[]) => {
		try { await callback(...args); } catch (error) { vscode.window.showErrorMessage(errorMessage(error)); }
	}));
}

function requireTeam(state: { teamId?: string }): string {
	if (!state.teamId) { throw new Error(vscode.l10n.t('Create or join a team first.')); }
	return state.teamId;
}

async function requiredInput(prompt: string, value?: string): Promise<string> {
	const result = await vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true });
	if (!result?.trim()) { throw new Error(vscode.l10n.t('The value is required.')); }
	return result.trim();
}

async function confirm(message: string): Promise<boolean> {
	return await vscode.window.showWarningMessage(message, { modal: true }, vscode.l10n.t('Continue')) === vscode.l10n.t('Continue');
}

async function pickFile(): Promise<vscode.Uri | undefined> {
	const selection = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false });
	return selection?.[0];
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function delay(milliseconds: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

export function deactivate(): void { }
