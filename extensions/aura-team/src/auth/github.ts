/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

interface DeviceResponse { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number; }
interface TokenResponse { access_token?: string; error?: string; interval?: number; }

export async function connectGitHub(context: vscode.ExtensionContext): Promise<void> {
	const clientId = vscode.workspace.getConfiguration('auraTeam').get<string>('githubClientId', '').trim();
	if (!clientId) {
		throw new Error(vscode.l10n.t('Set auraTeam.githubClientId to the Client ID of your GitHub OAuth App first.'));
	}
	const deviceResponse = await fetch('https://github.com/login/device/code', {
		method: 'POST',
		headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ client_id: clientId, scope: 'repo read:user' })
	});
	if (!deviceResponse.ok) { throw new Error(vscode.l10n.t('GitHub device authorization failed.')); }
	const device = await deviceResponse.json() as DeviceResponse;
	await vscode.env.clipboard.writeText(device.user_code);
	await vscode.env.openExternal(vscode.Uri.parse(device.verification_uri));
	vscode.window.showInformationMessage(vscode.l10n.t('GitHub code {0} was copied. Paste it in the browser.', device.user_code));
	const deadline = Date.now() + device.expires_in * 1000;
	let interval = Math.max(device.interval, 5);
	while (Date.now() < deadline) {
		await delay(interval * 1000);
		const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
			method: 'POST',
			headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ client_id: clientId, device_code: device.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
		});
		const result = await tokenResponse.json() as TokenResponse;
		if (result.access_token) {
			await context.secrets.store('auraTeam.githubToken', result.access_token);
			return;
		}
		if (result.error === 'slow_down') { interval += result.interval ?? 5; continue; }
		if (result.error !== 'authorization_pending') { throw new Error(result.error ?? vscode.l10n.t('GitHub authorization failed.')); }
	}
	throw new Error(vscode.l10n.t('GitHub authorization expired.'));
}

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}
