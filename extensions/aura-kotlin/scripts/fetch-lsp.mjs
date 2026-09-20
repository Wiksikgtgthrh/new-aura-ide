/**
 * Offline-комплект Kotlin Language Server для aura-kotlin (этап 6 ТЗ: «поставка LSP в комплекте»).
 *
 *   npm run fetch-server          — скачать в <ext>/server/ (упакуется вместе с расширением)
 *   npm run fetch-server -- --ci  — то же, без вопросов (для CI)
 *
 * Итог: extensions/aura-kotlin/server/{bin,lib} — то же, что кладёт runtime-скачивание
 * в globalStorage, поэтому src/lspInstall.ts находит его автоматически (source: 'bundled').
 * Каталог server/ не должен попадать в git (см. .gitignore) — только в дистрибутив.
 */

import { get as httpsGet } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, renameSync, rmSync, createWriteStream, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_VERSION = '1.3.13';
const SERVER_URL = `https://github.com/fwcd/kotlin-language-server/releases/download/${SERVER_VERSION}/server.zip`;
const here = dirname(fileURLToPath(import.meta.url));
const extRoot = dirname(here);
const dest = join(extRoot, 'server');

function download(url, file, redirects = 0) {
	if (redirects > 5) { throw new Error('too many redirects'); }
	return new Promise((resolve, reject) => {
		httpsGet(url, response => {
			if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
				response.resume();
				resolve(download(new URL(response.headers.location, url).toString(), file, redirects + 1));
				return;
			}
			if (response.statusCode !== 200) { reject(new Error(`HTTP ${response.statusCode} for ${url}`)); return; }
			const out = createWriteStream(file);
			response.pipe(out);
			out.on('finish', () => out.close(resolve));
			out.on('error', reject);
		}).on('error', reject);
	});
}

function extractZip(zip, dir) {
	const attempts = [
		['tar', ['-xf', zip, '-C', dir]],
		['unzip', ['-q', '-o', zip, '-d', dir]],
		...(process.platform === 'win32'
			? [['powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${zip}" -DestinationPath "${dir}" -Force`]]]
			: []),
	];
	for (const [command, args] of attempts) {
		try {
			execFileSync(command, args, { stdio: 'ignore', timeout: 10 * 60_000 });
			if (readdirSync(dir).length > 0) { return; }
		} catch { /* пробуем следующий */ }
	}
	throw new Error('no zip extractor available (tar/unzip/PowerShell)');
}

async function main() {
	if (existsSync(join(dest, 'lib')) && readdirSync(join(dest, 'lib')).some(name => name.startsWith('server-'))) {
		console.log(`server/ already present (${dest}) — nothing to do. Remove it to re-download.`);
		return;
	}
	console.log(`Downloading ${SERVER_URL} …`);
	const work = mkdtempSync(join(tmpdir(), 'kls-fetch-'));
	const zip = join(work, 'server.zip');
	await download(SERVER_URL, zip);
	console.log('Extracting…');
	extractZip(zip, work);
	const inner = existsSync(join(work, 'server')) ? join(work, 'server') : work;
	rmSync(dest, { recursive: true, force: true });
	renameSync(inner, dest);
	rmSync(work, { recursive: true, force: true });
	const jars = readdirSync(join(dest, 'lib')).length;
	console.log(`Done: ${dest} (${jars} jars). Extension will run it via: java -cp "server/lib/*" org.javacs.kt.MainKt`);
}

main().catch(error => { console.error(error.message ?? error); process.exit(1); });
