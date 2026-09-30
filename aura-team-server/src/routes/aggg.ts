/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FastifyInstance } from 'fastify';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { userId } from '../access.js';
import { config } from '../config.js';
import { hasEntitlement } from '../database.js';
import { GATED_FEATURES } from '../features.js';
import { digest } from '../security.js';

/** Файлы манифеста внешнего агента: ровно те, по которым клиент опознаёт каталог. */
const AGENT_FILES = ['VERSION', 'CLAUDE.md', join('harness', 'core.txt')] as const;

/** Ядро небольшое; ограничение защищает от случайного гигабайта в ответе. */
const MAX_FILE_BYTES = 512 * 1024;

/**
 * Внешнее ядро AGGG 5.2 отдаётся с сервера и только по праву.
 *
 * Так лицензия проверяется там, где её нельзя обойти: файлы ядра просто не попадают
 * к тому, у кого нет права, — даже если он соберёт IDE из исходников и уберёт
 * проверку в интерфейсе. Локальный каталог, заданный в настройках вручную,
 * по-прежнему работает: это файлы самого пользователя, не поставка Aura.
 */
export async function agggRoutes(app: FastifyInstance): Promise<void> {

	app.get('/v1/aggg/features', async () => ({ features: GATED_FEATURES }));

	app.get('/v1/aggg/agent', async (request, reply) => {
		const user = await userId(request);
		if (!hasEntitlement(user, 'aggg52')) {
			return reply.code(403).send({ error: 'AGGG 5.2 is not licensed for this account', feature: 'aggg52' });
		}
		const root = (config.agggCorePath ?? '').trim();
		if (!root) {
			return reply.code(404).send({ error: 'The server does not ship AGGG 5.2: set AURA_AGGG_CORE_PATH' });
		}
		// Путь может указывать и на каталог агента, и на сам core.txt.
		const isDirectory = await stat(root).then(info => info.isDirectory()).catch(() => false);
		const base = isDirectory ? root : join(root, '..', '..');
		const files: Record<string, string> = {};
		for (const name of AGENT_FILES) {
			const path = isDirectory ? join(root, name) : join(base, name);
			const content = await readFile(path, 'utf8').catch(() => undefined);
			if (content === undefined || content.length > MAX_FILE_BYTES) { continue; }
			files[name.split('\\').join('/')] = content;
		}
		if (!files['harness/core.txt']) {
			// Каталог задан, но ядра в нём нет — это ошибка конфигурации, а не отказ в праве.
			return reply.code(404).send({ error: `AGGG 5.2 core not found under ${root}` });
		}
		return {
			version: '5.2',
			// Хэш ядра: клиент кэширует файлы и не перекачивает их каждый запуск.
			digest: digest(files['harness/core.txt']),
			files,
		};
	});
}
