/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import nodemailer from 'nodemailer';
import { config } from './config.js';

export async function sendVerificationEmail(email: string, verificationUrl: string): Promise<void> {
	if (!config.smtp) {
		if (process.env.NODE_ENV === 'production') { throw new Error('SMTP configuration is required in production'); }
		console.info(`[mail:development] Verification for ${email}: ${verificationUrl}`);
		return;
	}
	const transport = nodemailer.createTransport({
		host: config.smtp.host,
		port: config.smtp.port,
		secure: config.smtp.secure,
		auth: config.smtp.user && config.smtp.password ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
		// Локальный relay (127.0.0.1) использует самоподписанный сертификат postfix — не проверяем его.
		tls: config.smtp.host === '127.0.0.1' || config.smtp.host === 'localhost' ? { rejectUnauthorized: false } : undefined
	});
	await transport.sendMail({
		from: config.smtp.from,
		to: email,
		subject: 'Confirm your Aura Team account',
		text: `Confirm your Aura Team account: ${verificationUrl}`,
		html: `<p>Confirm your Aura Team account:</p><p><a href="${escapeHtml(verificationUrl)}">Confirm email</a></p>`
	});
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
}
