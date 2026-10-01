/* Командный git-процесс: разбор remote, личная ветка, графический дифф, сводка CI, GitHub-клиент. */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let checks = 0;
let failures = 0;
async function check(name, fn) {
	checks++;
	try { await fn(); console.log('  ok   ' + name); } catch (error) { failures++; console.error('  FAIL ' + name + '\n       ' + error.message); }
}
const eq = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual) ?? "null"), JSON.parse(JSON.stringify(expected) ?? "null"));

const cache = new Map();
function load(relative) {
	if (cache.has(relative)) { return cache.get(relative); }
	const source = readFileSync(join(root, 'src/git', relative + '.ts'), 'utf8');
	const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
	const module = { exports: {} };
	cache.set(relative, module.exports);
	const sandbox = { module, exports: module.exports, TextEncoder, TextDecoder, require: (name) => load(name.replace(/^\.\//, '')) };
	vm.runInNewContext(out, sandbox, { filename: relative + '.ts' });
	cache.set(relative, module.exports);
	return module.exports;
}
const wf = load('workflow');
const { GithubClient } = load('github');

await check('remote GitHub: https, ssh, токен в URL, без .git', () => {
	eq({ ...wf.parseGithubRemote('https://github.com/Wiksikgtgthrh/new-aura-ide.git') }, { owner: 'Wiksikgtgthrh', repo: 'new-aura-ide' });
	eq({ ...wf.parseGithubRemote('git@github.com:org/repo.git') }, { owner: 'org', repo: 'repo' });
	eq({ ...wf.parseGithubRemote('ssh://git@github.com/org/my.repo') }, { owner: 'org', repo: 'my.repo' });
	eq({ ...wf.parseGithubRemote('https://x-access-token:abc@github.com/o/r') }, { owner: 'o', repo: 'r' });
	eq(wf.parseGithubRemote('https://gitlab.com/o/r.git'), undefined);
	eq(wf.parseGithubRemote(''), undefined);
});

await check('личная ветка: dev/<ник> с транслитом', () => {
	eq(wf.personalBranchName('Викс'), 'dev/viks');
	eq(wf.personalBranchName('Wiks Dev'), 'dev/wiks-dev');
	eq(wf.personalBranchName(''), 'dev/me');
	assert.ok(wf.isValidBranchName('dev/viks'));
	assert.ok(!wf.isValidBranchName('bad..name'));
	assert.ok(!wf.isValidBranchName('x.lock'));
});

const sample = [
	'diff --git a/src/a.ts b/src/a.ts',
	'index 111..222 100644',
	'--- a/src/a.ts',
	'+++ b/src/a.ts',
	'@@ -1,3 +1,4 @@ header',
	' keep',
	'-old',
	'+new',
	'+added',
	' tail',
	'diff --git a/new.md b/new.md',
	'new file mode 100644',
	'--- /dev/null',
	'+++ b/new.md',
	'@@ -0,0 +1 @@',
	'+hello',
	'\\ No newline at end of file',
	'diff --git a/gone.txt b/gone.txt',
	'deleted file mode 100644',
	'--- a/gone.txt',
	'+++ /dev/null',
	'@@ -1 +0,0 @@',
	'-bye',
	'diff --git a/old/name.ts b/new/name.ts',
	'similarity index 90%',
	'rename from old/name.ts',
	'rename to new/name.ts',
	'diff --git a/logo.png b/logo.png',
	'Binary files a/logo.png and b/logo.png differ',
	'diff --git "a/\\320\\264\\320\\276\\320\\272.md" "b/\\320\\264\\320\\276\\320\\272.md"',
	'--- "a/\\320\\264\\320\\276\\320\\272.md"',
	'+++ "b/\\320\\264\\320\\276\\320\\272.md"',
	'@@ -2 +2 @@',
	'-а',
	'+б',
].join('\n');

await check('unified diff: файлы, статусы, счётчики', () => {
	const d = wf.parseUnifiedDiff(sample);
	eq(d.files.map((f) => [f.path, f.status]), [['src/a.ts', 'modified'], ['new.md', 'added'], ['gone.txt', 'deleted'], ['new/name.ts', 'renamed'], ['logo.png', 'modified'], ['док.md', 'modified']]);
	eq([d.additions, d.deletions], [4, 3]);
	assert.equal(d.files[3].oldPath, 'old/name.ts');
	assert.ok(d.files[4].binary);
});

await check('unified diff: номера строк в ханке', () => {
	const lines = wf.parseUnifiedDiff(sample).files[0].hunks[0].lines;
	eq(lines.map((l) => [l.kind, l.oldNo ?? null, l.newNo ?? null]), [['ctx', 1, 1], ['del', 2, null], ['add', null, 2], ['add', null, 3], ['ctx', 3, 4]]);
	assert.equal(wf.parseUnifiedDiff(sample).files[1].hunks[0].lines[1].kind, 'meta');
});

await check('unified diff: лимит строк на файл помечает усечение', () => {
	const big = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -0,0 +1,50 @@', ...Array.from({ length: 50 }, (_, i) => '+' + i)].join('\n');
	const f = wf.parseUnifiedDiff(big, 10).files[0];
	assert.equal(f.hunks[0].lines.length, 10);
	assert.equal(f.additions, 50);
	assert.ok(f.truncated);
});

await check('patch из GitHub API без заголовка разбирается', () => {
	const d = wf.diffFromGithubFiles([{ filename: 'a.js', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b', additions: 1, deletions: 1 }, { filename: 'img.png', status: 'added', additions: 0, deletions: 0 }]);
	eq(d.files.map((f) => [f.path, f.status, f.hunks.length, f.binary]), [['a.js', 'modified', 1, false], ['img.png', 'added', 0, true]]);
});

await check('сводка CI: провал важнее ожидания, пусто — none', () => {
	assert.equal(wf.summarizeChecks([], []).state, 'none');
	assert.equal(wf.summarizeChecks([{ state: 'success' }], [{ status: 'completed', conclusion: 'success' }]).state, 'success');
	assert.equal(wf.summarizeChecks([{ state: 'pending' }], [{ status: 'completed', conclusion: 'skipped' }]).state, 'pending');
	const s = wf.summarizeChecks([{ state: 'pending' }], [{ status: 'completed', conclusion: 'failure' }]);
	eq([s.state, s.failed, s.pending, s.total], ['failure', 1, 1, 2]);
});

await check('ahead/behind и команда тестов', () => {
	eq({ ...wf.parseLeftRight('3\t5\n') }, { behind: 3, ahead: 5 });
	eq(wf.detectTestCommand({ packageJson: '{"scripts":{"test":"node t.js"}}' }), 'npm test');
	eq(wf.detectTestCommand({ packageJson: '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}', hasGoMod: true }), 'go test ./...');
	eq(wf.detectTestCommand({ hasPyproject: true }), 'python -m pytest');
	eq(wf.detectTestCommand({ hasMakefile: 'build:\n\ttsc\ntest:\n\tnode t' }), 'make test');
	eq(wf.detectTestCommand({}), undefined);
	eq(wf.compareUrl({ owner: 'o', repo: 'r' }, 'main', 'dev/viks'), 'https://github.com/o/r/compare/main...dev%2Fviks?expand=1');
});

/* ---------- GitHub-клиент на поддельном fetch ---------- */
const fakeFetch = (routes) => {
	const calls = [];
	const fn = async (url, init = {}) => {
		const method = init.method || 'GET';
		calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
		const route = routes.find((r) => r.method === method && url.includes(r.path));
		const status = route ? route.status ?? 200 : 404;
		const payload = route ? route.body : { message: 'Not Found' };
		return { ok: status < 300, status, json: async () => payload, text: async () => payload === undefined ? '' : JSON.stringify(payload) };
	};
	fn.calls = calls;
	return fn;
};
const pull = (n, extra = {}) => ({ number: n, title: 'PR ' + n, html_url: 'https://github.com/o/r/pull/' + n, state: 'open', user: { login: 'wiks' }, head: { ref: 'dev/viks', sha: 'sha' + n }, base: { ref: 'main' }, ...extra });

await check('создание PR: 422 → возвращается уже открытый', async () => {
	const f = fakeFetch([
		{ method: 'POST', path: '/repos/o/r/pulls', status: 422, body: { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for o:dev/viks.' }] } },
		{ method: 'GET', path: '/repos/o/r/pulls?state=open&head=o%3Adev%2Fviks', body: [pull(7)] }
	]);
	const pr = await new GithubClient('tok', { owner: 'o', repo: 'r' }, f).createPullRequest({ head: 'dev/viks', base: 'main', title: 't' });
	eq([pr.number, pr.existing, pr.head], [7, true, 'dev/viks']);
	assert.equal(f.calls[0].headers.authorization, 'Bearer tok');
	eq(f.calls[0].body, { head: 'dev/viks', base: 'main', title: 't', body: '', draft: false });
});

await check('детали PR: проверки, голоса ревьюеров, конфликт', async () => {
	const f = fakeFetch([
		{ method: 'GET', path: '/pulls/5/reviews', body: [{ state: 'CHANGES_REQUESTED', user: { login: 'a' } }, { state: 'APPROVED', user: { login: 'a' } }, { state: 'APPROVED', user: { login: 'b' } }, { state: 'COMMENTED', user: { login: 'c' } }] },
		{ method: 'GET', path: '/commits/sha5/status', body: { statuses: [{ state: 'success' }] } },
		{ method: 'GET', path: '/commits/sha5/check-runs', body: { check_runs: [{ status: 'in_progress' }] } },
		{ method: 'GET', path: '/pulls/5', body: pull(5, { mergeable: false, mergeable_state: 'dirty', additions: 3, deletions: 1, changed_files: 2 }) }
	]);
	const d = await new GithubClient('t', { owner: 'o', repo: 'r' }, f).pullRequestDetails(5);
	eq([d.checks.state, d.approvals, d.changesRequested, d.mergeable, d.changedFiles], ['pending', 2, 0, false, 2]);
});

await check('слияние PR и удаление ветки — правильные запросы', async () => {
	const f = fakeFetch([
		{ method: 'PUT', path: '/pulls/9/merge', body: { sha: 'm', merged: true, message: 'ok' } },
		{ method: 'DELETE', path: '/git/refs/heads/dev/viks', status: 204 }
	]);
	const c = new GithubClient('t', { owner: 'o', repo: 'r' }, f);
	const r = await c.mergePullRequest(9, 'squash');
	await c.deleteBranch('dev/viks');
	eq([r.merged, f.calls[0].body.merge_method, f.calls[1].method], [true, 'squash', 'DELETE']);
});

await check('ошибка GitHub несёт статус и текст', async () => {
	const f = fakeFetch([{ method: 'PUT', path: '/pulls/1/merge', status: 405, body: { message: 'Pull Request is not mergeable' } }]);
	await assert.rejects(new GithubClient('t', { owner: 'o', repo: 'r' }, f).mergePullRequest(1, 'merge'), /405: Pull Request is not mergeable/);
});

await check('слитые PR отличаются от закрытых', async () => {
	const f = fakeFetch([{ method: 'GET', path: '/pulls?state=closed', body: [pull(1, { state: 'closed', merged_at: '2024-01-01T00:00:00Z', merge_commit_sha: 'abc' }), pull(2, { state: 'closed' })] }]);
	const list = await new GithubClient('t', { owner: 'o', repo: 'r' }, f).listPullRequests('closed');
	eq(list.map((p) => [p.number, p.state, p.mergeCommitSha ?? null]), [[1, 'merged', 'abc'], [2, 'closed', null]]);
});

console.log(failures === 0 ? `\nALL ${checks} CHECKS PASSED` : `\n${failures} CHECK(S) FAILED`);
if (failures) { process.exit(1); }
