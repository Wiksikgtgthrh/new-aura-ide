/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { suite, test } from 'node:test';
import { createNLSCollector, finalizeNLS } from '../nls-plugin.ts';
import { mapWithConcurrency, postProcessFileNLS, transpileFile } from '../transpile.ts';

suite('transpile', () => {
	test('bounds concurrent work and preserves result order', async () => {
		let active = 0;
		let maximumActive = 0;

		const results = await mapWithConcurrency([0, 1, 2, 3, 4], 2, async item => {
			active++;
			maximumActive = Math.max(maximumActive, active);
			await new Promise(resolve => setImmediate(resolve));
			active--;
			return item * 2;
		});

		assert.deepStrictEqual({ maximumActive, results }, {
			maximumActive: 2,
			results: [0, 2, 4, 6, 8],
		});
	});

	test('propagates errors and stops scheduling work', async () => {
		const started: number[] = [];

		await assert.rejects(mapWithConcurrency([0, 1, 2, 3], 2, async item => {
			started.push(item);
			if (item === 0) {
				throw new Error('expected failure');
			}
			await new Promise(resolve => setImmediate(resolve));
		}), /expected failure/);

		assert.deepStrictEqual(started, [0, 1]);
	});

	test('transpiles NLS calls to shared message indices', async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vscode-transpile-nls-'));
		try {
			const srcDir = path.join(root, 'src');
			const outDir = path.join(root, 'out');
			const sourcePath = path.join(srcDir, 'vs', 'workbench', 'sample.ts');
			const outputPath = path.join(outDir, 'vs', 'workbench', 'sample.js');
			await fs.promises.mkdir(path.dirname(sourcePath), { recursive: true });
			await fs.promises.writeFile(sourcePath, `import { localize } from '../../vs/nls';\nexport const label = localize('sample.label', "Sample");\n`);

			const nls = { baseDir: srcDir, collector: createNLSCollector() };
			await transpileFile(sourcePath, outputPath, nls);
			const { indexMap } = await finalizeNLS(nls.collector, outDir);
			await postProcessFileNLS(outputPath, indexMap);

			const output = await fs.promises.readFile(outputPath, 'utf8');
			assert.match(output, /localize\(0,\s*null\)/);
			assert.doesNotMatch(output, /%%NLS:/);
			assert.ok(await fs.promises.stat(path.join(outDir, 'nls.keys.json')));
			assert.ok(await fs.promises.stat(path.join(outDir, 'nls.messages.json')));
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
