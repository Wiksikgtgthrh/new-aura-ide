#!/usr/bin/env node
/*
 * Сервер обновлений Aura IDE — совместим с API VS Code.
 *
 * Клиент при старте (и раз в час) запрашивает:
 *   GET /api/update/win32-x64-user/ide/<commit>
 * и ждёт один из двух ответов:
 *   204            — обновлений нет (клиент уже на последней сборке);
 *   JSON IUpdate   — { version, productVersion, url, sha256hash, timestamp }.
 * Если ответился JSON, клиент сам скачает installer по url, сверит sha256
 * и поставит поверх в фоне.
 *
 * Что отдавать, задаёт файл latest.json (его перезаписывает
 * scripts/publish-ide-update.sh). Файл читается на каждый запрос — перезапуск
 * сервиса после публикации не нужен.
 *
 * Запуск: node scripts/ide-update-server.mjs   (env: PORT, LATEST, HOST)
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3211);
const LATEST = process.env.LATEST ?? '/opt/ide-updates/latest.json';

async function latest() {
	const raw = await readFile(LATEST, 'utf8');
	return JSON.parse(raw);
}

function empty(reply, status = 204) {
	reply.writeHead(status, { 'Cache-Control': 'no-store' });
	reply.end();
}

function json(reply, status, value) {
	const body = JSON.stringify(value);
	reply.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(body),
		'Cache-Control': 'no-store'
	});
	reply.end(body);
}

const server = createServer(async (request, reply) => {
	const { pathname } = new URL(request.url ?? '/', 'http://localhost');

	if (request.method !== 'GET' || pathname === '/health') {
		return json(reply, 200, { ok: true });
	}

	// platform: win32-x64 | win32-x64-user | win32-arm64-user …
	// quality:  ide; commit — то, на чём сидит клиент.
	const match = pathname.match(/^\/api\/update\/([^/]+)\/([^/]+)\/([^/]+)$/);
	if (!match) {
		return empty(reply, 404);
	}

	const [, platform, quality, commit] = match.map(decodeURIComponent);
	try {
		const release = await latest();
		if (!release.version || !release.productVersion || !release.url) {
			console.warn('[update] latest.json неполный — обновлений не предлагаю');
			return empty(reply);
		}
		if (commit === release.version) {
			return empty(reply); // клиент уже на последней сборке
		}
		console.log(`[update] ${platform}/${quality}: ${commit.slice(0, 8)} → ${release.version.slice(0, 8)}`);
		return json(reply, 200, {
			version: release.version,
			productVersion: release.productVersion,
			timestamp: release.timestamp ?? Date.now(),
			url: release.url,
			sha256hash: release.sha256hash,
			supportsFastUpdate: true
		});
	} catch (error) {
		// Нет latest.json или он битый — для клиента это «обновлений нет»,
		// а не 500: старый редактор на 500 показал бы ошибку проверки обновлений.
		console.warn(`[update] не удалось прочитать ${LATEST}: ${error.message}`);
		return empty(reply);
	}
});

server.listen(PORT, HOST, () => console.log(`[update] http://${HOST}:${PORT} → ${LATEST}`));
