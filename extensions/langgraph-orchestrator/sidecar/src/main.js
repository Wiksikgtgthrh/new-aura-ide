'use strict';

const { SidecarRpc } = require('./rpc');
const { Orchestrator } = require('./orchestrator');

const rpc = new SidecarRpc(process.stdin, process.stdout);
const orchestrator = new Orchestrator(rpc, { mock: process.env.AURA_ORM_MOCK_LLM === '1' });

rpc.onCommand((method, params) => orchestrator.handleCommand(method, params));

process.on('uncaughtException', err => {
	rpc.notify('log', { message: `sidecar uncaughtException: ${err.message}` });
});
process.on('unhandledRejection', err => {
	rpc.notify('log', { message: `sidecar unhandledRejection: ${err instanceof Error ? err.message : String(err)}` });
});
