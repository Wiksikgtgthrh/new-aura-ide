/*---------------------------------------------------------------------------------------------
 *  Test for the HTTP client's content-type rule: JSON header only when there is a body.
 *
 *  Regression: the DELETE of a task went out without a body but with
 *  content-type: application/json, and Fastify answered 400
 *  "Body cannot be empty when content-type is set to 'application/json'" —
 *  so from the UI "tasks are not deleted".
 *
 *  The test reads the compiled module (out/api/headers.js), so the extension
 *  must be built first — same convention as sidebar.render.test.mjs.
 *--------------------------------------------------------------------------------------------*/
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const compiled = join(here, '..', 'out', 'api', 'headers.js');
if (!existsSync(compiled)) {
	console.error('FAIL: out/api/headers.js is missing — build the extension first (npx tsc -p extensions/aura-team/tsconfig.json).');
	process.exit(1);
}

const require = createRequire(import.meta.url);
const { contentTypeHeader } = require(compiled);

let failures = 0;
const check = (name, ok) => { console.log((ok ? '  ok   ' : '  FAIL ') + name); if (!ok) failures++; };
const keys = (value) => Object.keys(contentTypeHeader(value));

check('DELETE without a body: no content-type header at all', keys(undefined).length === 0);
check('Null body: no content-type header either', keys(null).length === 0);
check('JSON string body: application/json', contentTypeHeader('{}')['content-type'] === 'application/json');
check('FormData: the JSON header is not forced onto multipart', keys(new FormData()).length === 0);
check('Archive stream: the JSON header is not forced onto the stream', keys(new ReadableStream({ start(controller) { controller.close(); } })).length === 0);
check('Empty string is still a body, so the header stays', contentTypeHeader('')['content-type'] === 'application/json');

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
