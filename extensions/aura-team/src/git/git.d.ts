/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, Event, Uri } from 'vscode';

export interface Commit { readonly hash: string; readonly message: string; readonly authorName?: string; readonly authorDate?: Date; }
export interface Change { readonly uri: Uri; }
export interface Branch { readonly name?: string; readonly upstream?: { remote: string; name: string }; }
export interface Repository {
	readonly rootUri: Uri;
	readonly state: { readonly HEAD?: Branch; readonly remotes: readonly { name: string; fetchUrl?: string }[]; readonly mergeChanges: readonly Change[]; readonly indexChanges: readonly Change[]; readonly workingTreeChanges: readonly Change[]; readonly untrackedChanges: readonly Change[]; readonly onDidChange: Event<void> };
	add(paths: string[]): Promise<void>;
	restore(paths: string[], options?: { staged?: boolean; ref?: string }): Promise<void>;
	commit(message: string, options?: { all?: boolean | 'tracked' }): Promise<void>;
	fetch(options?: { all?: boolean; prune?: boolean }): Promise<void>;
	pull(): Promise<void>;
	push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
	log(options?: { maxEntries?: number; path?: string }): Promise<Commit[]>;
	getCommit(ref: string): Promise<Commit>;
	show(ref: string, path: string): Promise<string>;
	removeRemote(name: string): Promise<void>;
	addRemote(name: string, url: string): Promise<void>;
}
export interface API {
	readonly git: { readonly path: string };
	readonly repositories: Repository[];
	clone(url: Uri, options?: { parentPath?: Uri }): Promise<Uri | null>;
	registerCredentialsProvider(provider: { getCredentials(host: Uri): Promise<{ username: string; password: string } | undefined> }): Disposable;
	toGitUri(uri: Uri, ref: string): Uri;
}
export interface GitExtension { readonly enabled: boolean; getAPI(version: 1): API; }
