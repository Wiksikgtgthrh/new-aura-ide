/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Readable, Stream } from 'stream';

/**
 * Helpers for build steps that fetch something over the network.
 *
 * A developer machine can be offline (air-gapped, behind a proxy, or the remote is simply
 * unreachable right now). In that case a build step should report what it could not fetch and
 * carry on with whatever is already on disk, instead of aborting the whole launch. Failures
 * that are *not* about connectivity - a bad checksum, an HTTP error status, an asset that does
 * not exist - stay fatal, because continuing silently would hide a broken configuration.
 */

/** Error codes that mean "the network could not be reached", from `net`, `undici` and `node:http`. */
const networkErrorCodes = new Set([
	'ENOTFOUND',
	'EAI_AGAIN',
	'EAI_FAIL',
	'ECONNREFUSED',
	'ECONNRESET',
	'ECONNABORTED',
	'ETIMEDOUT',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'ENETDOWN',
	'EPIPE',
	'ERR_SOCKET_CONNECTION_TIMEOUT',
	'ABORT_ERR',
	'UND_ERR_ABORTED',
	'UND_ERR_BODY_TIMEOUT',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_SOCKET',
]);

/** Error names used by `undici` (which backs `fetch`) and by DOMException-style aborts. */
const networkErrorNames = new Set([
	'AbortError',
	'ConnectTimeoutError',
	'HeadersTimeoutError',
	'BodyTimeoutError',
	'SocketError',
	'TimeoutError',
]);

const networkMessagePatterns = [
	/fetch failed/i,
	/request to .* failed/i,
	/socket hang up/i,
	/getaddrinfo/i,
	/network is unreachable/i,
	/connect(ion)? timeout/i,
	/timed? ?out/i,
];

/**
 * True when the error (or anything in its `cause`/`errors` chain) indicates that the network
 * is unreachable rather than that the remote answered with something unexpected.
 */
export function isNetworkUnavailable(error: unknown): boolean {
	const seen = new Set<unknown>();
	const pending: unknown[] = [error];

	while (pending.length > 0) {
		const current = pending.shift();
		if (current === null || typeof current !== 'object' || seen.has(current)) {
			continue;
		}
		seen.add(current);

		const { code, name, message, cause, errors } = current as {
			code?: unknown;
			name?: unknown;
			message?: unknown;
			cause?: unknown;
			errors?: unknown;
		};

		if (typeof code === 'string' && networkErrorCodes.has(code)) {
			return true;
		}
		if (typeof name === 'string' && (networkErrorNames.has(name) || name.endsWith('TimeoutError'))) {
			return true;
		}
		if (typeof message === 'string' && networkMessagePatterns.some(pattern => pattern.test(message))) {
			return true;
		}

		// `AggregateError` from a dual-stack connect attempt keeps the real reason in `errors`.
		if (Array.isArray(errors)) {
			pending.push(...errors);
		}
		if (cause !== undefined) {
			pending.push(cause);
		}
	}

	return false;
}

/** A short, loggable reason for a failure: its error code, else its name, else its message. */
export function describeFailure(error: unknown): string {
	const seen = new Set<unknown>();
	let current: unknown = error;

	while (current !== null && typeof current === 'object' && !seen.has(current)) {
		seen.add(current);
		const { code, name, message, cause } = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };

		if (typeof code === 'string' && code.length > 0) {
			return code;
		}
		if (cause === undefined) {
			// `Error` is the default name and says nothing, so only a specific name is worth logging.
			if (typeof name === 'string' && name.length > 0 && name !== 'Error') {
				return name;
			}
			return typeof message === 'string' && message.length > 0 ? message : String(error);
		}
		current = cause;
	}

	return String(error);
}

/**
 * Anything that can carry work through a build pipeline: node streams, gulp plugins, vinyl
 * streams. Their concrete types are not mutually assignable, so pipelines are described with
 * what they have in common instead.
 */
export type PipelineStage = Stream | NodeJS.ReadWriteStream;

/**
 * Makes the errors of a pipeline reachable from one of its streams.
 *
 * `.pipe()` does not forward errors, so an error emitted by a stage in the middle of a download
 * chain (a failed fetch, a corrupt archive) is unhandled, which kills the process instead of
 * reaching the consumer's `error` handler. Prefer {@link pipeStreams}, which applies this to
 * every stage as the pipeline is built.
 */
export function forwardErrorsTo<T extends PipelineStage>(target: T, sources: readonly PipelineStage[]): T {
	for (const source of sources) {
		if (source !== target) {
			source.on('error', error => target.emit('error', error));
		}
	}

	return target;
}

export interface IStreamPipeline {
	/** Appends a stage and returns the pipeline, so stages can be chained as with `.pipe()`. */
	pipe(stage: PipelineStage): IStreamPipeline;
	/** The last stage, which reports the errors of every stage before it. */
	done(): Stream;
}

/**
 * Builds a pipeline in which an error from any stage reaches the consumer of the last one. The
 * stages are written exactly as with `.pipe()`:
 *
 *   const stream = pipeStreams(downloaded).pipe(unzipped).pipe(onlyExtensionFiles).done();
 *   stream.on('error', ...); // also sees errors raised by `downloaded` and `unzipped`
 *
 * Without this, an error emitted by a stage in the middle of a chain has no listener, and Node
 * turns it into an uncaught exception that kills the build.
 */
export function pipeStreams(head: PipelineStage): IStreamPipeline {
	const stages: PipelineStage[] = [head];

	return {
		pipe(stage: PipelineStage): IStreamPipeline {
			const previous = stages[stages.length - 1] as NodeJS.ReadWriteStream;
			previous.pipe(stage as NodeJS.ReadWriteStream);
			stages.push(stage);
			return this;
		},
		done(): Stream {
			return forwardErrorsTo(stages[stages.length - 1] as Stream, stages);
		},
	};
}

/**
 * Resolves once a sync stream is finished, whether it copied an extension or downloaded one.
 *
 * A pipeline built with {@link pipeStreams} can be a duplex (for example `vinyl-fs#dest`), whose
 * readable side may end before the last file is flushed, so completion is taken from whichever of
 * 'end', 'finish' or 'close' comes first. A torn connection can destroy a stream without any of
 * them following an error, so 'close' counts as done: whoever consumes the result re-checks it.
 */
export function drainStream(stream: Stream): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const settle = (error?: unknown) => {
			if (settled) {
				return;
			}
			settled = true;
			if (error === undefined) {
				resolve();
			} else {
				reject(error);
			}
		};

		stream.on('error', error => settle(error));
		stream.on('end', () => settle());
		stream.on('finish', () => settle());
		stream.on('close', () => settle());

		// Nothing else consumes these streams, and a paused stream would never reach its end.
		(stream as Readable).resume();
	});
}

export interface ISyncJob {
	/** Used in log messages; also identifies the item in {@link ISyncFailure}. */
	readonly name: string;
	/** Invoked once, when the batch starts. */
	readonly run: () => Promise<void>;
}

export interface ISyncFailure {
	readonly name: string;
	readonly error: unknown;
	/** Whether the failure looks like missing connectivity, in which case it can be skipped. */
	readonly network: boolean;
}

/**
 * Runs every job in parallel and returns the failures instead of throwing, so the caller can
 * decide per item whether it is tolerable. An empty result means everything succeeded.
 */
export async function runSyncJobs(jobs: readonly ISyncJob[]): Promise<ISyncFailure[]> {
	const results = await Promise.allSettled(jobs.map(job => Promise.resolve().then(job.run)));

	const failures: ISyncFailure[] = [];
	results.forEach((result, index) => {
		if (result.status === 'rejected') {
			failures.push({ name: jobs[index].name, error: result.reason, network: isNetworkUnavailable(result.reason) });
		}
	});

	return failures;
}

/**
 * Reads a boolean environment flag. Unset, empty and the usual negative spellings all mean
 * "off", so `FLAG=0` behaves the way a user expects.
 */
export function isTruthyEnvFlag(value: string | undefined): boolean {
	if (value === undefined) {
		return false;
	}

	const normalized = value.trim().toLowerCase();
	return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no' && normalized !== 'off';
}
