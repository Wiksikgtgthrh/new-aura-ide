/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { suite, test } from 'node:test';
import es from 'event-stream';
import vfs from 'vinyl-fs';
import VinylFile from 'vinyl';
import { describeFailure, drainStream, forwardErrorsTo, isNetworkUnavailable, isTruthyEnvFlag, pipeStreams, runSyncJobs } from '../resilientSync.ts';

/** The shape `fetch` produces on a machine that cannot reach the host (undici wraps the reason). */
function connectTimeoutError() {
	const cause = Object.assign(new Error('Connect Timeout Error (attempted address: marketplace.visualstudio.com:443, timeout: 10000ms)'), {
		name: 'ConnectTimeoutError',
		code: 'UND_ERR_CONNECT_TIMEOUT',
	});
	return Object.assign(new TypeError('fetch failed'), { cause });
}

suite('resilientSync', () => {

	test('isNetworkUnavailable recognizes offline failures', () => {
		const aggregate = new AggregateError([
			Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
			Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' }),
		], 'All promises were rejected');
		const aborted = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
		const socket = Object.assign(new Error('other side closed'), { cause: { code: 'UND_ERR_SOCKET' } });

		assert.deepStrictEqual({
			connectTimeout: isNetworkUnavailable(connectTimeoutError()),
			aggregate: isNetworkUnavailable(aggregate),
			aborted: isNetworkUnavailable(aborted),
			socket: isNetworkUnavailable(socket),
			bareCode: isNetworkUnavailable({ code: 'UND_ERR_SOCKET' }),
			bareMessage: isNetworkUnavailable(new Error('socket hang up')),
		}, {
			connectTimeout: true,
			aggregate: true,
			aborted: true,
			socket: true,
			bareCode: true,
			bareMessage: true,
		});
	});

	test('isNetworkUnavailable keeps other failures fatal', () => {
		// The messages below are the ones `build/lib/fetch.ts` throws for a bad response or a bad
		// checksum; treating them as "offline" would silently skip a genuinely broken download.
		const httpError = new Error('Request https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-vscode/vsextensions/js-debug/1.117.0/vspackage failed with status code: 404');
		const checksum = new Error('Checksum mismatch for https://example.com/x.vsix (expected abc, actual def))');
		const missingAsset = new Error('Could not find asset in release of microsoft/vscode-js-debug @ 1.117.0');
		const cyclic = new Error('download failed for reasons') as Error & { cause?: unknown };
		cyclic.cause = cyclic;

		assert.deepStrictEqual({
			http: isNetworkUnavailable(httpError),
			checksum: isNetworkUnavailable(checksum),
			missingAsset: isNetworkUnavailable(missingAsset),
			cyclic: isNetworkUnavailable(cyclic),
			plain: isNetworkUnavailable(new Error('something else')),
			notAnError: isNetworkUnavailable('offline'),
			nothing: isNetworkUnavailable(undefined),
		}, {
			http: false,
			checksum: false,
			missingAsset: false,
			cyclic: false,
			plain: false,
			notAnError: false,
			nothing: false,
		});
	});

	test('describeFailure prefers the deepest code', () => {
		const nested = new Error('outer') as Error & { cause?: unknown; code?: string };
		nested.cause = { code: 'ECONNRESET' };

		assert.deepStrictEqual({
			code: describeFailure(connectTimeoutError()),
			rootCodeWins: describeFailure(Object.assign(new Error('outer'), { code: 'EAI_AGAIN', cause: { code: 'ENOTFOUND' } })),
			nested: describeFailure(nested),
			name: describeFailure(Object.assign(new Error('boom'), { name: 'AbortError' })),
			message: describeFailure(new Error('boom')),
			notAnError: describeFailure(42),
		}, {
			code: 'UND_ERR_CONNECT_TIMEOUT',
			rootCodeWins: 'EAI_AGAIN',
			nested: 'ECONNRESET',
			name: 'AbortError',
			message: 'boom',
			notAnError: '42',
		});
	});

	test('runSyncJobs reports failures without throwing and tags connectivity', async () => {
		const offline = connectTimeoutError();
		const checksum = new Error('Checksum mismatch for https://example.com/x.vsix (expected abc, actual def))');
		let finished = false;

		const failures = await runSyncJobs([
			{ name: 'cached', run: async () => { finished = true; } },
			{ name: 'js-debug', run: async () => { throw offline; } },
			{ name: 'js-profile-table', run: async () => { throw checksum; } },
		]);

		assert.deepStrictEqual({
			finished,
			failures: failures.map(f => ({ name: f.name, network: f.network, error: f.error })),
		}, {
			finished: true,
			failures: [
				{ name: 'js-debug', network: true, error: offline },
				{ name: 'js-profile-table', network: false, error: checksum },
			],
		});
	});

	test('forwardErrorsTo delivers an upstream error to the last stream', async () => {
		const downloaded = new PassThrough();
		const unzipped = downloaded.pipe(new PassThrough());
		const extension = unzipped.pipe(new PassThrough());
		const failure = connectTimeoutError();

		const received = new Promise<unknown>(resolve => extension.on('error', resolve));
		forwardErrorsTo(extension, [downloaded, unzipped]);

		// The stages downstream of `downloaded` do not forward errors themselves.
		downloaded.emit('error', failure);

		assert.deepStrictEqual({
			error: await received,
			listeners: extension.listenerCount('error'),
			unchanged: forwardErrorsTo(extension, [extension]) === extension,
		}, {
			error: failure,
			listeners: 1,
			unchanged: true,
		});
	});

	test('drainStream completes a file-writing pipeline and reports its files', async () => {
		const destination = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'resilient-sync-'));
		const contents = Buffer.from('downloaded');
		// Mirrors the shape of the real sync: a source, an intermediate stage and `vinyl-fs#dest`,
		// whose readable side is not consumed by anything else.
		const written = pipeStreams(es.readArray([new VinylFile({ cwd: '/', base: '/', path: '/an-extension/package.json', contents })]))
			.pipe(es.mapSync((file: VinylFile) => file))
			.pipe(vfs.dest(destination))
			.done();

		await drainStream(written);

		try {
			const file = path.join(destination, 'an-extension', 'package.json');
			assert.deepStrictEqual({
				written: (await fs.promises.readFile(file)).toString(),
				contents: contents.toString(),
			}, {
				written: 'downloaded',
				contents: 'downloaded',
			});
		} finally {
			await fs.promises.rm(destination, { recursive: true, force: true });
		}
	});

	test('drainStream rejects when a stage of the pipeline fails', async () => {
		const destination = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'resilient-sync-'));
		const failure = connectTimeoutError();
		const written = pipeStreams(es.readArray([new VinylFile({ cwd: '/', base: '/', path: '/x', contents: Buffer.from('x') })]))
			.pipe(es.mapSync((_file: VinylFile) => { throw failure; }))
			.pipe(vfs.dest(destination))
			.done();

		let rejected: unknown;
		try {
			await drainStream(written);
		} catch (error) {
			rejected = error;
		} finally {
			await fs.promises.rm(destination, { recursive: true, force: true });
		}

		assert.deepStrictEqual({ rejected, skipped: isNetworkUnavailable(rejected) }, { rejected: failure, skipped: true });
	});

	test('runSyncJobs runs jobs in parallel', async () => {
		const started: string[] = [];
		let release: () => void = () => { /* set below */ };
		// Only resolves once both jobs have been started, so a sequential runner fails here
		// instead of hanging the suite.
		const bothStarted = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('jobs did not run in parallel')), 1000);
			release = () => { clearTimeout(timer); resolve(); };
		});
		const job = (name: string) => async () => {
			started.push(name);
			if (started.length === 2) {
				release();
			}
			await bothStarted;
		};

		const failures = await runSyncJobs([{ name: 'a', run: job('a') }, { name: 'b', run: job('b') }]);

		assert.deepStrictEqual({ started, failures: failures.map(f => f.name) }, { started: ['a', 'b'], failures: [] });
	});

	test('isTruthyEnvFlag accepts the usual spellings', () => {
		assert.deepStrictEqual({
			unset: isTruthyEnvFlag(undefined),
			empty: isTruthyEnvFlag(''),
			zero: isTruthyEnvFlag('0'),
			false: isTruthyEnvFlag('false'),
			no: isTruthyEnvFlag('NO'),
			off: isTruthyEnvFlag(' off '),
			one: isTruthyEnvFlag('1'),
			true: isTruthyEnvFlag('true'),
			yes: isTruthyEnvFlag('Yes'),
			on: isTruthyEnvFlag('on'),
			spaces: isTruthyEnvFlag('  1  '),
		}, {
			unset: false,
			empty: false,
			zero: false,
			false: false,
			no: false,
			off: false,
			one: true,
			true: true,
			yes: true,
			on: true,
			spaces: true,
		});
	});
});
