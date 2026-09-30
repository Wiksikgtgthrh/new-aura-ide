// Дымовой тест сайдкара в mock-режиме: start → события графа → checkpoint → finish.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [path.join(root, 'dist', 'sidecar.cjs')], {
	stdio: ['pipe', 'pipe', 'pipe'],
	env: { ...process.env, AURA_ORM_MOCK_LLM: '1' },
});

let buffer = '';
const events = [];
let started = false;
let cancelOk = false;
let finished = false;

/** Ждём и конец графа, и ответ на команду отмены: выход по первому из них — гонка. */
function maybeExit() {
	if (!cancelOk || !finished) {
		return;
	}
	console.log('\nFINISHED OK');
	child.kill();
	process.exit(0);
}

child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
	buffer += chunk;
	let idx;
	while ((idx = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, idx).trim();
		buffer = buffer.slice(idx + 1);
		if (!line) { continue; }
		const msg = JSON.parse(line);
		events.push(msg);
		if (msg.kind === 'ntf') {
			console.log('ntf:', msg.method, msg.params?.type || '', msg.params?.message || msg.params?.node?.id || '');
		}
		if (msg.kind === 'res' && msg.id === 2) {
			// Отмена подзадачи должна приниматься на любом шаге графа: панель шлёт её по клику.
			if (!msg.ok || msg.result?.cancelled !== true) {
				console.error('cancelNode command failed:', JSON.stringify(msg));
				child.kill();
				process.exit(1);
			}
			console.log('cancelNode OK:', msg.result.nodeId);
			cancelOk = true;
			maybeExit();
		}
		if (msg.kind === 'ntf' && msg.params?.type === 'graph.finished') {
			finished = true;
			maybeExit();
		}
	}
});

child.stderr.on('data', d => console.error('stderr:', d.toString()));

setTimeout(() => {
	if (!started) {
		started = true;
		child.stdin.write(JSON.stringify({ kind: 'cmd', id: 1, method: 'start', params: { task: 'smoke test task', tools: [] } }) + '\n');
		// Отмена отдельной подзадачи: заведомо несуществующий узел, проверяем сам канал.
		child.stdin.write(JSON.stringify({ kind: 'cmd', id: 2, method: 'cancelNode', params: { nodeId: 'coder#1.0' } }) + '\n');
	}
}, 500);

setTimeout(() => {
	console.error('TIMEOUT. events so far:', events.length);
	child.kill();
	process.exit(1);
}, 30000);
