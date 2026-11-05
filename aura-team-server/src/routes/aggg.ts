/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FastifyInstance } from 'fastify';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { userId } from '../access.js';
import { config } from '../config.js';
import { GATED_FEATURES } from '../features.js';
import { digest } from '../security.js';

/** Файлы манифеста внешнего агента: ровно те, по которым клиент опознаёт каталог. */
const AGENT_FILES = ['VERSION', 'CLAUDE.md', join('harness', 'core.txt')] as const;

/** Ядро небольшое; ограничение защищает от случайного гигабайта в ответе. */
const MAX_FILE_BYTES = 512 * 1024;

/**
 * Внешнее ядро AGGG 5.2 отдаётся с сервера всем вошедшим аккаунтам.
 *
 * Раньше поставка была закрыта правом `aggg52`; теперь обвязка (harness) обновляется
 * прямо на сервере и доступна каждому — новая версия не требует сборки IDE.
 * Файлы всё равно приходят клиенту только отсюда: в поставке IDE ядра нет.
 * Локальный каталог, заданный в настройках вручную, тоже работает: это файлы
 * самого пользователя, не поставка Aura.
 */
export async function agggRoutes(app: FastifyInstance): Promise<void> {

	app.get('/v1/aggg/features', async () => ({ features: GATED_FEATURES }));

	app.get('/v1/aggg/agent', async (request, reply) => {
		// Авторизация обязательна (ядро не отдаём анонимам), лицензия — нет.
		await userId(request);
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
