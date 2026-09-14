/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

process.env.AURA_MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
process.env.AURA_JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters';

test('encrypted API key round trips without plaintext storage', async () => {
	const { decrypt, encrypt } = await import('../src/security.js');
	const encrypted = encrypt('YOUR_API_KEY');
	assert.deepEqual({ leaked: encrypted.includes('YOUR_API_KEY'), decrypted: decrypt(encrypted) }, { leaked: false, decrypted: 'YOUR_API_KEY' });
});

test('provider proxy rejects absolute and protocol-relative destinations', async () => {
	const { isAllowedProviderRequest, providerUrl } = await import('../src/routes/keys.js');
	assert.deepEqual([
		providerUrl('https://api.openai.com', 'v1/models').href,
		attempt(() => providerUrl('https://api.openai.com', 'https://attacker.example/steal')),
		attempt(() => providerUrl('https://api.openai.com', '%2F%2Fattacker.example/steal')),
	], ['https://api.openai.com/v1/models', 'rejected', 'rejected']);
	assert.deepEqual([
		isAllowedProviderRequest('openai', 'POST', '/v1/chat/completions'),
		isAllowedProviderRequest('openai', 'DELETE', '/v1/files/file-1'),
		isAllowedProviderRequest('openai', 'POST', '/v1/fine_tuning/jobs'),
	], [true, false, false]);
});

test('production refuses the built-in development JWT secret', () => {
	const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import('./dist/config.js')"], {
		cwd: new URL('..', import.meta.url),
		env: { ...process.env, NODE_ENV: 'production', AURA_JWT_SECRET: '' }
	});
	assert.notEqual(result.status, 0);
});

test('production refuses the documented placeholder JWT secret', () => {
	const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import('./dist/config.js')"], {
		cwd: new URL('..', import.meta.url),
		env: { ...process.env, NODE_ENV: 'production', AURA_JWT_SECRET: 'REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS' }
	});
	assert.notEqual(result.status, 0);
});

function attempt(callback: () => URL): string {
	try { callback(); return 'accepted'; } catch { return 'rejected'; }
}
