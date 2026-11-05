#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Снапшот харнесса в payload расширения (harness/).
 *
 *  Источник — живая копия харнесса (по умолчанию ~/.agent-harness, переопределяется
 *  аргументом `--from <dir>`). Копируется только то, что нужно install.mjs в рантайме:
 *  манифесты, tools, скилы/агенты/команды для pi и opencode, zcode, templates, bench,
 *  journeys. Состояние пользователя (backups, installed.json, .agent-state) не тащим.
 *
 *  Запуск: npm run snapshot   (из extensions/aura-harness)
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const payloadDir = path.join(here, '..', 'harness');

const args = process.argv.slice(2);
const fromIdx = args.indexOf('--from');
const sourceRoot = fromIdx >= 0 && args[fromIdx + 1]
	? path.resolve(args[fromIdx + 1])
	: path.join(process.env.HARNESS_HOME || os.homedir(), '.agent-harness');

const ROOT_FILES = [
	'harness.json',
	'VERSION.md',
	'AGENTS.md',
	'AUTHORS.md',
	'.agent-gates.json',
	'.release-policy.json',
];

const TREES = [
	'tools',
	'.pi/agent/skills',
	'.pi/agent/agents',
	'opencode/skills',
	'opencode/agents',
	'opencode/commands',
	'zcode',
	'templates',
	'bench',
	'journeys',
];

const SINGLE_EXAMPLES = [
	'.pi/agent/settings.json.example',
	'.pi/agent/web-search.json.example',
	'.pi/agent/mcp.json.example',
	'.pi/agent/auth.json.example',
	'opencode/opencode.jsonc.example',
	'opencode/opencode.official.jsonc.example',
	'opencode/cli.json.example',
	'opencode/service.json.example',
];

function* walk(dir) {
	if (!fs.existsSync(dir)) {
		return;
	}
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walk(full);
		} else if (entry.isFile()) {
			yield full;
		}
	}
}

function copyInto(src, destRoot, base) {
	fs.mkdirSync(path.dirname(path.join(destRoot, path.relative(base, src))), { recursive: true });
	fs.copyFileSync(src, path.join(destRoot, path.relative(base, src)));
}

if (!fs.existsSync(path.join(sourceRoot, 'harness.json'))) {
	console.error(`Harness not found at ${sourceRoot} (no harness.json)`);
	process.exit(1);
}

fs.rmSync(payloadDir, { recursive: true, force: true });
fs.mkdirSync(payloadDir, { recursive: true });

let count = 0;
for (const file of ROOT_FILES) {
	const src = path.join(sourceRoot, file);
	if (fs.existsSync(src)) {
		copyInto(src, payloadDir, sourceRoot);
		count++;
	}
}
for (const tree of TREES) {
	const srcDir = path.join(sourceRoot, tree);
	for (const file of walk(srcDir)) {
		copyInto(file, payloadDir, sourceRoot);
		count++;
	}
}
for (const file of SINGLE_EXAMPLES) {
	const src = path.join(sourceRoot, file);
	if (fs.existsSync(src)) {
		copyInto(src, payloadDir, sourceRoot);
		count++;
	}
}

const version = JSON.parse(fs.readFileSync(path.join(payloadDir, 'harness.json'), 'utf8')).version;
console.log(`Snapshot ${version}: ${count} files -> ${payloadDir}`);
