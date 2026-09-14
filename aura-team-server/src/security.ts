/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { config } from './config.js';

const jwtKey = new TextEncoder().encode(config.jwtSecret);
export const id = (): string => randomUUID();
export const token = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

export async function accessToken(userId: string): Promise<string> {
	return new SignJWT({ sub: userId, type: 'access' }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('15m').sign(jwtKey);
}

export async function verifyAccess(value: string): Promise<string> {
	const { payload } = await jwtVerify(value, jwtKey);
	if (payload.type !== 'access' || !payload.sub) { throw new Error('Invalid access token'); }
	return payload.sub;
}

function encryptionKey(): Buffer {
	if (!config.masterKey) { throw new Error('AURA_MASTER_KEY is required for API key storage'); }
	const key = Buffer.from(config.masterKey, 'base64');
	if (key.length !== 32) { throw new Error('AURA_MASTER_KEY must be a base64-encoded 32-byte key'); }
	return key;
}

export function encrypt(value: string): string {
	const nonce = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
	const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
	return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decrypt(value: string): string {
	const packed = Buffer.from(value, 'base64');
	const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), packed.subarray(0, 12));
	decipher.setAuthTag(packed.subarray(12, 28));
	return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8');
}
