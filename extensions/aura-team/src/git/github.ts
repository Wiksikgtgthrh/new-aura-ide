/*---------------------------------------------------------------------------------------------
 *  GitHub REST для командного процесса: pull request'ы, проверки CI, слияние.
 *  Токен — тот же, что у входа в GitHub (secrets `auraTeam.githubToken`).
 *  Без vscode-зависимостей: fetch передаётся снаружи, чтобы модуль тестировался.
 *--------------------------------------------------------------------------------------------*/

import { ChecksState, DiffSummary, GithubRepoRef, diffFromGithubFiles, summarizeChecks } from './workflow';

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface PullRequestInfo {
	number: number;
	title: string;
	url: string;
	head: string;
	base: string;
	author: string;
	draft: boolean;
	state: 'open' | 'closed' | 'merged';
	updatedAt?: string;
	mergedAt?: string;
	mergeCommitSha?: string;
	headSha?: string;
}

export interface PullRequestDetails extends PullRequestInfo {
	mergeable: boolean | null;
	mergeableState: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	checks: { state: ChecksState; total: number; passed: number; failed: number; pending: number };
	approvals: number;
	changesRequested: number;
}

export class GithubError extends Error {
	constructor(message: string, readonly status: number) { super(message); }
}

type RawPull = {
	number: number; title: string; html_url: string; draft?: boolean; state: string; merged_at?: string | null; updated_at?: string;
	merge_commit_sha?: string | null; user?: { login?: string }; head: { ref: string; sha: string }; base: { ref: string };
	mergeable?: boolean | null; mergeable_state?: string; additions?: number; deletions?: number; changed_files?: number;
};

export class GithubClient {
	constructor(private readonly token: string, private readonly repo: GithubRepoRef, private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike) { }

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await this.fetchImpl(`https://api.github.com/repos/${this.repo.owner}/${this.repo.repo}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${this.token}`,
				accept: 'application/vnd.github+json',
				'x-github-api-version': '2022-11-28',
				'user-agent': 'aura-team',
				...(body ? { 'content-type': 'application/json' } : {})
			},
			body: body ? JSON.stringify(body) : undefined
		});
		if (response.status === 204) { return undefined as T; }
		const text = await response.text();
		let data: unknown;
		try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
		if (!response.ok) {
			const payload = data as { message?: string; errors?: Array<{ message?: string }> } | undefined;
			const detail = payload?.errors?.map(e => e.message).filter(Boolean).join('; ');
			throw new GithubError(`GitHub ${response.status}: ${payload?.message ?? 'error'}${detail ? ` (${detail})` : ''}`, response.status);
		}
		return data as T;
	}

	private static map(pull: RawPull): PullRequestInfo {
		return {
			number: pull.number,
			title: pull.title,
			url: pull.html_url,
			head: pull.head.ref,
			base: pull.base.ref,
			author: pull.user?.login ?? '',
			draft: Boolean(pull.draft),
			state: pull.merged_at ? 'merged' : pull.state === 'open' ? 'open' : 'closed',
			updatedAt: pull.updated_at,
			mergedAt: pull.merged_at ?? undefined,
			mergeCommitSha: pull.merge_commit_sha ?? undefined,
			headSha: pull.head.sha
		};
	}

	async listPullRequests(state: 'open' | 'closed' = 'open', perPage = 30): Promise<PullRequestInfo[]> {
		const pulls = await this.request<RawPull[]>('GET', `/pulls?state=${state}&per_page=${perPage}&sort=updated&direction=desc`);
		return pulls.map(GithubClient.map);
	}

	async findOpenPullRequest(head: string): Promise<PullRequestInfo | undefined> {
		const pulls = await this.request<RawPull[]>('GET', `/pulls?state=open&head=${encodeURIComponent(`${this.repo.owner}:${head}`)}`);
		return pulls[0] ? GithubClient.map(pulls[0]) : undefined;
	}

	/** Создать PR; если на эту ветку PR уже открыт (422) — вернуть существующий. */
	async createPullRequest(input: { head: string; base: string; title: string; body?: string; draft?: boolean }): Promise<PullRequestInfo & { existing: boolean }> {
		try {
			const pull = await this.request<RawPull>('POST', '/pulls', { head: input.head, base: input.base, title: input.title, body: input.body ?? '', draft: Boolean(input.draft) });
			return { ...GithubClient.map(pull), existing: false };
		} catch (error) {
			if (error instanceof GithubError && error.status === 422) {
				const existing = await this.findOpenPullRequest(input.head);
				if (existing) { return { ...existing, existing: true }; }
			}
			throw error;
		}
	}

	async pullRequestDetails(number: number): Promise<PullRequestDetails> {
		const pull = await this.request<RawPull>('GET', `/pulls/${number}`);
		const base = GithubClient.map(pull);
		const [status, runs, reviews] = await Promise.all([
			this.request<{ statuses?: Array<{ state?: string }> }>('GET', `/commits/${pull.head.sha}/status`).catch(() => ({ statuses: [] })),
			this.request<{ check_runs?: Array<{ status?: string; conclusion?: string | null }> }>('GET', `/commits/${pull.head.sha}/check-runs?per_page=100`).catch(() => ({ check_runs: [] })),
			this.request<Array<{ state?: string; user?: { login?: string } }>>('GET', `/pulls/${number}/reviews?per_page=100`).catch(() => [])
		]);
		// Последний отзыв каждого ревьюера определяет его голос.
		const lastByUser = new Map<string, string>();
		for (const review of reviews) { if (review.user?.login && review.state && review.state !== 'COMMENTED') { lastByUser.set(review.user.login, review.state); } }
		const votes = [...lastByUser.values()];
		return {
			...base,
			mergeable: pull.mergeable ?? null,
			mergeableState: pull.mergeable_state ?? 'unknown',
			additions: pull.additions ?? 0,
			deletions: pull.deletions ?? 0,
			changedFiles: pull.changed_files ?? 0,
			checks: summarizeChecks(status.statuses ?? [], runs.check_runs ?? []),
			approvals: votes.filter(v => v === 'APPROVED').length,
			changesRequested: votes.filter(v => v === 'CHANGES_REQUESTED').length
		};
	}

	async pullRequestDiff(number: number): Promise<DiffSummary> {
		const files: Array<{ filename: string; previous_filename?: string; status?: string; patch?: string; additions?: number; deletions?: number }> = [];
		for (let page = 1; page <= 3; page++) {
			const batch = await this.request<typeof files>('GET', `/pulls/${number}/files?per_page=100&page=${page}`);
			files.push(...batch);
			if (batch.length < 100) { break; }
		}
		return diffFromGithubFiles(files);
	}

	async mergePullRequest(number: number, method: 'merge' | 'squash' | 'rebase'): Promise<{ sha: string; merged: boolean; message: string }> {
		return this.request('PUT', `/pulls/${number}/merge`, { merge_method: method });
	}

	async deleteBranch(branch: string): Promise<void> {
		await this.request('DELETE', `/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
	}

	async getPullRequest(number: number): Promise<PullRequestInfo> {
		return GithubClient.map(await this.request<RawPull>('GET', `/pulls/${number}`));
	}
}
