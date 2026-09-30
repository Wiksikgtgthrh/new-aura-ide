// Сборка сайдкара в один dist/sidecar.cjs (запуск: node ./build/compile-sidecar.mjs)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist');
fs.mkdirSync(outDir, { recursive: true });

require('esbuild').buildSync({
	entryPoints: [path.join(root, 'sidecar', 'src', 'main.js')],
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'cjs',
	outfile: path.join(outDir, 'sidecar.cjs'),
	external: [],
	logLevel: 'info',
});

console.log('sidecar bundled -> dist/sidecar.cjs');
