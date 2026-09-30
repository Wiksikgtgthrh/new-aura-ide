/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs';
import path from 'path';
import os from 'os';
import rimraf from 'rimraf';
import es from 'event-stream';
import { rename } from './gulp/facade.ts';
import vfs from 'vinyl-fs';
import * as ext from './extensions.ts';
import { getCurrentExtensionTarget, getPlatformSpecificAssetName } from './extensionTarget.ts';
import fancyLog from 'fancy-log';
import ansiColors from 'ansi-colors';
import { Stream } from 'stream';
import { describeFailure, drainStream, isTruthyEnvFlag, pipeStreams, runSyncJobs } from './resilientSync.ts';

export interface IExtensionDefinition {
	name: string;
	version: string;
	sha256: string;
	repo: string;
	platforms?: string[];
	vsix?: string;
	/**
	 * Per-target checksums for a platform-specific extension published to a GitHub release.
	 * Keyed by marketplace target platform (e.g. `win32-x64`, `linux-armhf`, `alpine-x64`).
	 * The matching release asset is resolved by convention as `<name>-<osAlias>-<arch>.vsix`.
	 */
	platformSpecific?: { [target: string]: string };
	metadata: {
		id: string;
		publisherId: {
			publisherId: string;
			publisherName: string;
			displayName: string;
			flags: string;
		};
		publisherDisplayName: string;
	};
}

const root = path.dirname(path.dirname(import.meta.dirname));
const productjson = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../product.json'), 'utf8'));
const builtInExtensions = productjson.builtInExtensions as IExtensionDefinition[] || [];
const webBuiltInExtensions = productjson.webBuiltInExtensions as IExtensionDefinition[] || [];
const controlFilePath = path.join(os.homedir(), '.vscode-oss-dev', 'extensions', 'control.json');
const ENABLE_LOGGING = !process.env['VSCODE_BUILD_BUILTIN_EXTENSIONS_SILENCE_PLEASE'];

/**
 * Set this to keep working on a machine that has no access to the marketplace: cached built-in
 * extensions are used as-is and no download is attempted, which also avoids the connect and
 * retry timeouts that an offline download would otherwise burn on every launch.
 */
const offlineEnvVar = 'VSCODE_BUILTIN_EXTENSIONS_OFFLINE';

function log(...messages: string[]): void {
	if (ENABLE_LOGGING) {
		fancyLog(...messages);
	}
}

function getExtensionPath(extension: IExtensionDefinition): string {
	return getExtensionPathForName(extension.name);
}

function getExtensionPathForName(name: string): string {
	return path.join(root, '.build', 'builtInExtensions', name);
}

function readCachedVersion(extension: IExtensionDefinition): string | undefined {
	const packagePath = path.join(getExtensionPath(extension), 'package.json');

	if (!fs.existsSync(packagePath)) {
		return undefined;
	}

	try {
		const diskVersion = JSON.parse(fs.readFileSync(packagePath, { encoding: 'utf8' })).version;
		return typeof diskVersion === 'string' ? diskVersion : undefined;
	} catch (err) {
		return undefined;
	}
}

function isUpToDate(extension: IExtensionDefinition): boolean {
	return readCachedVersion(extension) === extension.version;
}

function isInsiders(): boolean {
	return process.env['VSCODE_QUALITY'] === 'insider';
}

function getExtensionDownloadStream(extension: IExtensionDefinition) {
	let input: Stream;

	if (extension.vsix) {
		input = ext.fromVsix(path.join(root, extension.vsix), extension);
	} else if (extension.platformSpecific) {
		// A platform-specific extension publishes its VSIX assets on a GitHub release using a
		// specific asset naming convention, so it is always downloaded from GitHub and never falls
		// back to the Marketplace (which does not serve those assets) even when a gallery is configured.
		const asset = resolvePlatformSpecificAsset(extension);
		if (!asset) {
			return es.readArray([]);
		}
		input = ext.fromGithub(extension, { asset, latest: isInsiders() });
	} else if (productjson.extensionsGallery?.serviceUrl) {
		input = ext.fromMarketplace(productjson.extensionsGallery.serviceUrl, extension);
	} else {
		input = ext.fromGithub(extension, { latest: isInsiders() });
	}

	return pipeStreams(input)
		.pipe(rename(p => p.dirname = `${extension.name}/${p.dirname}`))
		.done();
}

function resolvePlatformSpecificAsset(extension: IExtensionDefinition): { assetName: string; sha256: string } | undefined {
	const target = getCurrentExtensionTarget();
	if (!target) {
		// Unsupported build platform (e.g. FreeBSD): no platform-specific asset can apply, so skip
		// this extension gracefully instead of failing the whole build.
		log(ansiColors.yellow('[skip]'), `${extension.name}: no platform-specific asset for unsupported platform '${process.platform}-${process.env['VSCODE_ARCH'] ?? process.arch}'`);
		return undefined;
	}

	const sha256 = extension.platformSpecific![target];
	if (!sha256) {
		// The extension declares platform-specific assets but is missing one for this known target.
		// This is a configuration error, so fail loudly.
		throw new Error(`Built-in extension '${extension.name}' is platform-specific but has no asset for target '${target}'. Available targets: [${Object.keys(extension.platformSpecific!)}]`);
	}

	return { assetName: getPlatformSpecificAssetName(extension.name, target), sha256 };
}

export function getExtensionStream(extension: IExtensionDefinition) {
	// if the extension exists on disk, use those files instead of downloading anew
	if (isUpToDate(extension)) {
		log('[extensions]', `${extension.name}@${extension.version} up to date`, ansiColors.green('✔︎'));
		return vfs.src(['**'], { cwd: getExtensionPath(extension), dot: true })
			.pipe(rename(p => p.dirname = `${extension.name}/${p.dirname}`));
	}

	return getExtensionDownloadStream(extension);
}

function syncMarketplaceExtension(extension: IExtensionDefinition, offline: boolean): Stream {
	const galleryServiceUrl = productjson.extensionsGallery?.serviceUrl;
	const source = ansiColors.blue(galleryServiceUrl ? '[marketplace]' : '[github]');
	if (isUpToDate(extension)) {
		log(source, `${extension.name}@${extension.version}`, ansiColors.green('✔︎'));
		return es.readArray([]);
	}

	if (offline) {
		logOfflineSkip(extension, source);
		return es.readArray([]);
	}

	rimraf.sync(getExtensionPath(extension));

	return pipeStreams(getExtensionDownloadStream(extension))
		.pipe(vfs.dest('.build/builtInExtensions'))
		.done()
		.on('end', () => log(source, extension.name, ansiColors.green('✔︎')));
}

/** Reports what the cached copy is, or that there is no cached copy to fall back on. */
function logOfflineSkip(extension: IExtensionDefinition, source: string): void {
	const cachedVersion = readCachedVersion(extension);

	if (cachedVersion) {
		log(source, ansiColors.blue('[offline]'), `${extension.name}@${cachedVersion}`, ansiColors.gray(`(wanted ${extension.version})`));
	} else {
		log(ansiColors.yellow('[skip]'), `${extension.name}@${extension.version}: not cached and downloads are disabled`);
	}
}

function syncExtension(extension: IExtensionDefinition, controlState: 'disabled' | 'marketplace', offline: boolean): Stream {
	if (extension.platforms) {
		const platforms = new Set(extension.platforms);

		if (!platforms.has(process.platform)) {
			log(ansiColors.gray('[skip]'), `${extension.name}@${extension.version}: Platform '${process.platform}' not supported: [${extension.platforms}]`, ansiColors.green('✔︎'));
			return es.readArray([]);
		}
	}

	switch (controlState) {
		case 'disabled':
			log(ansiColors.blue('[disabled]'), ansiColors.gray(extension.name));
			return es.readArray([]);

		case 'marketplace':
			return syncMarketplaceExtension(extension, offline);

		default:
			if (!fs.existsSync(controlState)) {
				log(ansiColors.red(`Error: Built-in extension '${extension.name}' is configured to run from '${controlState}' but that path does not exist.`));
				return es.readArray([]);

			} else if (!fs.existsSync(path.join(controlState, 'package.json'))) {
				log(ansiColors.red(`Error: Built-in extension '${extension.name}' is configured to run from '${controlState}' but there is no 'package.json' file in that directory.`));
				return es.readArray([]);
			}

			log(ansiColors.blue('[local]'), `${extension.name}: ${ansiColors.cyan(controlState)}`, ansiColors.green('✔︎'));
			return es.readArray([]);
	}
}

interface IControlFile {
	[name: string]: 'disabled' | 'marketplace';
}

function readControlFile(): IControlFile {
	try {
		return JSON.parse(fs.readFileSync(controlFilePath, 'utf8'));
	} catch (err) {
		return {};
	}
}

function writeControlFile(control: IControlFile): void {
	fs.mkdirSync(path.dirname(controlFilePath), { recursive: true });
	fs.writeFileSync(controlFilePath, JSON.stringify(control, null, 2));
}

export async function getBuiltInExtensions(): Promise<void> {
	log('Synchronizing built-in extensions...');
	log(`You can manage built-in extensions with the ${ansiColors.cyan('--builtin')} flag`);

	const offline = isTruthyEnvFlag(process.env[offlineEnvVar]);
	if (offline) {
		log(ansiColors.blue('[offline]'), `${offlineEnvVar} is set: using cached built-in extensions only`);
	}

	const control = readControlFile();
	const extensions = [...builtInExtensions, ...webBuiltInExtensions];

	for (const extension of extensions) {
		control[extension.name] = control[extension.name] || 'marketplace';
	}

	writeControlFile(control);

	const failures = await runSyncJobs(extensions.map(extension => ({
		name: extension.name,
		run: () => drainStream(syncExtension(extension, control[extension.name], offline)),
	})));

	const skipped: string[] = [];
	let fatal: unknown;

	for (const failure of failures) {
		if (!failure.network) {
			// A bad checksum, an unexpected HTTP status or a missing asset is a broken
			// configuration, not a missing network: keep failing loudly.
			fatal ??= failure.error;
			continue;
		}

		log(ansiColors.yellow('[warn]'), `${failure.name}: ${describeFailure(failure.error)}, the network looks unreachable`);
		removePartialDownload(failure.name);
		skipped.push(failure.name);
	}

	if (fatal !== undefined) {
		throw fatal;
	}

	if (skipped.length > 0) {
		log(ansiColors.yellow('[warn]'), `Continuing without ${skipped.join(', ')}; they stay unavailable until they can be downloaded.`);
		log(ansiColors.yellow('[warn]'), `Set ${ansiColors.cyan(`${offlineEnvVar}=1`)} to skip the download attempt, or run ${ansiColors.cyan('npm run download-builtin-extensions')} once the network is back.`);
	}
}

/**
 * Drops what a failed download left behind. The previous copy was already removed before the
 * download started, so whatever is on disk is incomplete and should not be mistaken for it.
 */
function removePartialDownload(name: string): void {
	try {
		rimraf.sync(getExtensionPathForName(name));
	} catch (err) {
		log(ansiColors.yellow('[warn]'), `Could not clean up a partial download of ${name}: ${err}`);
	}
}

if (import.meta.main) {
	getBuiltInExtensions().then(() => process.exit(0)).catch(err => {
		console.error(err);
		process.exit(1);
	});
}
