/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * content-type: application/json ставим только тогда, когда тело правда есть.
 *
 * У запросов без нагрузки (DELETE задачи, снятие ключа, удаление архива) тела нет, а
 * заголовок стоял — Fastify отвечает на это сочетание 400
 * «Body cannot be empty when content-type is set to 'application/json'», и запрос не
 * доходил до обработчика: с точки зрения интерфейса «задачи не удаляются».
 *
 * Multipart (FormData) и поток архива объявляют свой content-type сами — трогать их нельзя.
 */
export function contentTypeHeader(body: RequestInit['body']): Record<string, string> {
	if (body === undefined || body === null) { return {}; }
	if (body instanceof FormData) { return {}; }
	if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) { return {}; }
	return { 'content-type': 'application/json' };
}
