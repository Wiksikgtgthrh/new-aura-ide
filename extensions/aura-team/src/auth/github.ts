/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export const GITHUB_TOKEN_KEY = 'auraTeam.githubToken';

/** Права, которые нужны клонированию, push и созданию репозиториев. */
const GITHUB_SCOPES = ['repo', 'read:user'];

/**
 * Вход в GitHub.
 *
 * Раньше это было поле для вставки personal access token — главный барьер на входе:
 * надо было знать, где взять токен, выбрать scope и не промахнуться при вставке.
 * Теперь сначала пробуем штатный провайдер авторизации IDE (вход через браузер),
 * и только если его в сборке нет — падаем на прежний ввод токена.
 */
export async function connectGitHub(context: vscode.ExtensionContext): Promise<{ login: string; via: 'browser' | 'token' }> {
	const session = await getGithubSession(true);
	if (session) {
		await context.secrets.store(GITHUB_TOKEN_KEY, session.accessToken);
		return { login: session.account.label, via: 'browser' };
	}
	return { login: await pasteToken(context), via: 'token' };
}

/** Сессия провайдера 'github'. createIfNone открывает браузерный вход при первом вызове. */
async function getGithubSession(createIfNone: boolean): Promise<vscode.AuthenticationSession | undefined> {
	try {
		return await vscode.authentication.getSession('github', GITHUB_SCOPES, { createIfNone, silent: !createIfNone });
	} catch {
		// Провайдера может не быть в сборке (или пользователь закрыл окно входа).
		return undefined;
	}
}

/** Запасной путь: вставка токена вручную, если провайдер недоступен. */
async function pasteToken(context: vscode.ExtensionContext): Promise<string> {
	const existing = await context.secrets.get(GITHUB_TOKEN_KEY);
	const token = await vscode.window.showInputBox({
		title: vscode.l10n.t('GitHub access token'),
		prompt: existing
			? vscode.l10n.t('A token is already saved — paste a new one to replace it.')
			: vscode.l10n.t('Browser sign-in is unavailable here. Paste a personal access token with the "repo" scope.'),
		password: true,
		ignoreFocusOut: true,
		placeHolder: 'ghp_… / github_pat_…'
	});
	if (!token) { throw new Error(vscode.l10n.t('GitHub sign-in was cancelled.')); }
	const trimmed = token.trim();
	// Проверяем токен сразу, чтобы не молча падать потом на клонировании.
	const check = await fetch('https://api.github.com/user', {
		headers: { authorization: `Bearer ${trimmed}`, 'user-agent': 'aura-team' }
	});
	if (!check.ok) {
		throw new Error(vscode.l10n.t('GitHub rejected this token (HTTP {0}). Check the token and the "repo" scope.', check.status));
	}
	const user = await check.json() as { login?: string };
	await context.secrets.store(GITHUB_TOKEN_KEY, trimmed);
	return user.login ?? 'github';
}

interface GithubRepo {
	full_name: string;
	private: boolean;
	default_branch: string;
	html_url: string;
	updated_at: string;
}

export async function disconnectGitHub(context: vscode.ExtensionContext): Promise<void> {
	await context.secrets.delete(GITHUB_TOKEN_KEY);
}

export async function hasGitHubToken(context: vscode.ExtensionContext): Promise<boolean> {
	return !!(await context.secrets.get(GITHUB_TOKEN_KEY));
}

/** Все репозитории пользователя (публичные + приватные, до 100 страниц по 100). */
export async function listGithubRepos(context: vscode.ExtensionContext): Promise<GithubRepo[]> {
	const token = await context.secrets.get(GITHUB_TOKEN_KEY);
	if (!token) { throw new Error(vscode.l10n.t('Connect GitHub first — paste a token with the "repo" scope.')); }
	const repos: GithubRepo[] = [];
	for (let page = 1; page <= 3; page++) {
		const response = await fetch(`https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated`, {
			headers: { authorization: `Bearer ${token}`, 'user-agent': 'aura-team' }
		});
		if (!response.ok) { throw new Error(vscode.l10n.t('GitHub API error (HTTP {0}).', response.status)); }
		const batch = await response.json() as GithubRepo[];
		repos.push(...batch);
		if (batch.length < 100) { break; }
	}
	return repos;
}

/** Создание приватного репозитория на GitHub. Возвращает URL для push. */
export async function createGithubRepo(
	context: vscode.ExtensionContext,
	name: string,
	isPrivate: boolean,
	description?: string
): Promise<string> {
	const token = await context.secrets.get(GITHUB_TOKEN_KEY);
	if (!token) { throw new Error(vscode.l10n.t('Connect GitHub first — paste a token with the "repo" scope.')); }
	const response = await fetch('https://api.github.com/user/repos', {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'user-agent': 'aura-team', 'content-type': 'application/json' },
		body: JSON.stringify({ name, private: isPrivate, description: description || undefined, auto_init: false })
	});
	if (response.status === 422) { throw new Error(vscode.l10n.t('A repository named "{0}" already exists on your GitHub account.', name)); }
	if (!response.ok) {
		const body = await response.json().catch(() => undefined) as { message?: string } | undefined;
		throw new Error(vscode.l10n.t('GitHub API error (HTTP {0}): {1}', response.status, body?.message ?? ''));
	}
	const repo = await response.json() as { full_name: string };
	return `https://github.com/${repo.full_name}.git`;
}

/** Клонирование по выбору из списка репозиториев. Возвращает URL выбранного репозитория. */
export async function pickAndCloneGithubRepo(context: vscode.ExtensionContext, clone: (url: string) => Promise<void>): Promise<void> {
	const pick = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Loading repositories…') },
		() => listGithubRepos(context)
	);
	if (!pick.length) {
		vscode.window.showInformationMessage(vscode.l10n.t('No repositories found.'));
		return;
	}
	const items = pick.map(repo => ({
		label: repo.full_name,
		description: repo.private ? vscode.l10n.t('Private') : 'public',
		detail: `⎇ ${repo.default_branch} · ${new Date(repo.updated_at).toLocaleString()}`,
		url: repo.html_url
	}));
	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: vscode.l10n.t('Pick a repository to clone'),
		ignoreFocusOut: true,
		matchOnDetail: true
	});
	if (!selected) { return; }
	await clone(selected.url);
}
