#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, list, readJson, writeJsonAtomic, withLock, appendEvent, stateDir, fail } from './lib.mjs';

const RISKS = ['read', 'write', 'sensitive', 'destructive'];
const NEEDS_APPROVAL = new Set(['sensitive', 'destructive']);
const ERROR_CLASSES = ['transient', 'permanent', 'policy', 'timeout'];
const TERMINAL = new Set(['done', 'failed', 'cancelled']);

const cwd = process.cwd();
const dir = stateDir(cwd);
const file = path.join(dir, 'tasks.json');
const lock = path.join(dir, 'tasks.lock');

function emptyState() {
  return { version: 2, seq: 0, budget: { maxTasks: 50, maxAttempts: 3, defaultTimeoutMin: 30 }, tasks: {} };
}

function load() {
  const state = readJson(file, emptyState());
  if (state.version !== 2) fail(`Unsupported state version in ${file}. Move it away and run init.`);
  return state;
}

function mutate(fn) {
  return withLock(lock, () => {
    const state = load();
    const result = fn(state);
    writeJsonAtomic(file, state);
    return result;
  });
}

function now() {
  return new Date().toISOString();
}

function requireTask(state, id) {
  const task = state.tasks[id];
  if (!task) fail(`Unknown task ${id}`);
  return task;
}

function requireOwner(task, agent, force) {
  if (force) return;
  if (!agent) fail('--agent is required');
  if (task.owner !== agent) fail(`Task ${task.id} is owned by ${task.owner ?? 'nobody'}, not ${agent}`);
}

function touch(task, patch) {
  Object.assign(task, patch, { updatedAt: now() });
}

function reclaimExpired(state) {
  const reclaimed = [];
  const current = Date.now();
  for (const task of Object.values(state.tasks)) {
    if (task.status !== 'running' || !task.leaseUntil) continue;
    if (Date.parse(task.leaseUntil) > current) continue;
    applyFailure(task, 'timeout', `Lease expired for ${task.owner}`);
    reclaimed.push(task.id);
  }
  return reclaimed;
}

function applyFailure(task, errorClass, message) {
  const retryable = errorClass === 'transient' || errorClass === 'timeout';
  const canRetry = retryable && task.attempts < task.maxAttempts;
  touch(task, {
    status: canRetry ? 'pending' : 'failed',
    owner: null,
    leaseUntil: null,
    lastError: { class: errorClass, message, at: now() },
  });
}

function depsState(state, task) {
  const deps = task.deps.map((id) => state.tasks[id]);
  if (deps.some((d) => !d || d.status === 'failed' || d.status === 'cancelled')) return 'broken';
  if (deps.every((d) => d.status === 'done')) return 'ready';
  return 'waiting';
}

function printTable(state) {
  const rows = Object.values(state.tasks);
  if (!rows.length) {
    console.log('No tasks.');
    return;
  }
  for (const t of rows) {
    const deps = t.deps.length ? ` deps=${t.deps.join(',')}(${depsState(state, t)})` : '';
    const owner = t.owner ? ` owner=${t.owner}` : '';
    const err = t.lastError ? ` lastError=${t.lastError.class}` : '';
    const verified = t.status === 'done' ? (t.verified ? ' verified' : ' UNVERIFIED') : '';
    console.log(`${t.id}  ${t.status.padEnd(17)} ${t.role.padEnd(10)} risk=${t.risk} try=${t.attempts}/${t.maxAttempts}${owner}${deps}${err}${verified}  ${t.title}`);
  }
}

const commands = {
  init(flags) {
    mutate((state) => {
      if (flags['max-tasks']) state.budget.maxTasks = Number(flags['max-tasks']);
      if (flags['max-attempts']) state.budget.maxAttempts = Number(flags['max-attempts']);
      if (flags['timeout']) state.budget.defaultTimeoutMin = Number(flags.timeout);
      console.log(`Initialized ${file}`, JSON.stringify(state.budget));
    });
  },

  add(flags) {
    if (!flags.title || flags.title === true) fail('--title is required');
    const risk = flags.risk ?? 'write';
    if (!RISKS.includes(risk)) fail(`--risk must be one of ${RISKS.join(', ')}`);
    const task = mutate((state) => {
      const active = Object.values(state.tasks).filter((t) => t.status !== 'cancelled').length;
      if (active >= state.budget.maxTasks) fail(`Budget exceeded: maxTasks=${state.budget.maxTasks}`);
      const deps = list(flags.deps);
      for (const dep of deps) if (!state.tasks[dep]) fail(`Unknown dependency ${dep}`);
      state.seq += 1;
      const id = `T-${String(state.seq).padStart(4, '0')}`;
      const created = {
        id,
        title: flags.title,
        role: flags.role && flags.role !== true ? flags.role : 'builder',
        risk,
        deps,
        status: NEEDS_APPROVAL.has(risk) ? 'awaiting_approval' : 'pending',
        attempts: 0,
        maxAttempts: Number(flags['max-attempts'] ?? state.budget.maxAttempts),
        timeoutMin: Number(flags.timeout ?? state.budget.defaultTimeoutMin),
        owner: null,
        leaseUntil: null,
        approval: null,
        verified: false,
        evidence: [],
        notes: [],
        next: flags.next && flags.next !== true ? flags.next : null,
        lastError: null,
        createdAt: now(),
        updatedAt: now(),
      };
      state.tasks[id] = created;
      return created;
    });
    appendEvent(cwd, { type: 'task.added', id: task.id, risk: task.risk, role: task.role });
    console.log(task.id);
  },

  approve(flags) {
    if (!flags.id || !flags.by || flags.by === true) fail('--id and --by are required');
    mutate((state) => {
      const task = requireTask(state, flags.id);
      if (task.status !== 'awaiting_approval') fail(`Task ${task.id} is ${task.status}, not awaiting_approval`);
      touch(task, { status: 'pending', approval: { by: flags.by, note: flags.note ?? null, at: now() } });
    });
    appendEvent(cwd, { type: 'task.approved', id: flags.id, by: flags.by });
    console.log(`Approved ${flags.id} by ${flags.by}`);
  },

  claim(flags) {
    if (!flags.agent || flags.agent === true) fail('--agent is required');
    const role = flags.role && flags.role !== true ? flags.role : null;
    const wantedId = flags.id && flags.id !== true ? flags.id : null;
    const claimed = mutate((state) => {
      const reclaimed = reclaimExpired(state);
      for (const id of reclaimed) appendEvent(cwd, { type: 'task.reclaimed', id });
      let candidate;
      if (wantedId) {
        const task = state.tasks[wantedId];
        if (!task) fail(`Unknown task ${wantedId}`);
        if (task.status !== 'pending') fail(`Task ${wantedId} is ${task.status}, not pending`);
        const deps = depsState(state, task);
        if (deps !== 'ready') fail(`Task ${wantedId} deps are ${deps}`);
        candidate = task;
      } else {
        candidate = Object.values(state.tasks).find(
          (t) => t.status === 'pending' && (!role || t.role === role) && depsState(state, t) === 'ready',
        );
      }
      if (!candidate) return null;
      const lease = new Date(Date.now() + candidate.timeoutMin * 60_000).toISOString();
      touch(candidate, { status: 'running', owner: flags.agent, attempts: candidate.attempts + 1, leaseUntil: lease });
      return candidate;
    });
    if (!claimed) {
      console.log('No claimable task.');
      process.exit(3);
    }
    appendEvent(cwd, { type: 'task.claimed', id: claimed.id, agent: flags.agent, attempt: claimed.attempts });
    console.log(JSON.stringify(claimed, null, 2));
  },

  heartbeat(flags) {
    mutate((state) => {
      const task = requireTask(state, flags.id);
      if (task.status !== 'running') fail(`Task ${task.id} is ${task.status}`);
      requireOwner(task, flags.agent, false);
      touch(task, { leaseUntil: new Date(Date.now() + task.timeoutMin * 60_000).toISOString() });
    });
    console.log(`Lease extended for ${flags.id}`);
  },

  note(flags) {
    if (!flags.text || flags.text === true) fail('--text is required');
    mutate((state) => {
      const task = requireTask(state, flags.id);
      task.notes.push({ at: now(), by: flags.agent ?? null, text: flags.text });
      if (flags.next && flags.next !== true) task.next = flags.next;
      touch(task, {});
    });
    console.log(`Note added to ${flags.id}`);
  },

  finish(flags) {
    const evidence = list(flags.evidence);
    const unverified = Boolean(flags.unverified);
    if (!evidence.length && !unverified) fail('Provide --evidence path1,path2 or mark explicitly with --unverified');
    mutate((state) => {
      const task = requireTask(state, flags.id);
      if (task.status !== 'running') fail(`Task ${task.id} is ${task.status}, not running`);
      requireOwner(task, flags.agent, Boolean(flags.force));
      task.evidence.push(...evidence);
      if (flags.note && flags.note !== true) task.notes.push({ at: now(), by: flags.agent ?? null, text: flags.note });
      touch(task, { status: 'done', owner: null, leaseUntil: null, verified: evidence.length > 0 && !unverified });
    });
    appendEvent(cwd, { type: 'task.finished', id: flags.id, verified: evidence.length > 0 && !unverified });
    console.log(`Finished ${flags.id}${unverified ? ' (UNVERIFIED)' : ''}`);
  },

  fail(flags) {
    const errorClass = flags.class ?? 'permanent';
    if (!ERROR_CLASSES.includes(errorClass)) fail(`--class must be one of ${ERROR_CLASSES.join(', ')}`);
    const task = mutate((state) => {
      const t = requireTask(state, flags.id);
      if (t.status !== 'running') fail(`Task ${t.id} is ${t.status}, not running`);
      requireOwner(t, flags.agent, Boolean(flags.force));
      applyFailure(t, errorClass, flags.error && flags.error !== true ? flags.error : 'unspecified');
      return t;
    });
    appendEvent(cwd, { type: 'task.failed', id: task.id, class: errorClass, status: task.status });
    console.log(`${task.id} -> ${task.status}${task.status === 'pending' ? ` (retry ${task.attempts}/${task.maxAttempts})` : ''}`);
  },

  cancel(flags) {
    mutate((state) => {
      const task = requireTask(state, flags.id);
      if (TERMINAL.has(task.status)) fail(`Task ${task.id} is already ${task.status}`);
      task.notes.push({ at: now(), by: flags.by ?? null, text: `cancelled: ${flags.reason ?? 'no reason'}` });
      touch(task, { status: 'cancelled', owner: null, leaseUntil: null });
    });
    appendEvent(cwd, { type: 'task.cancelled', id: flags.id });
    console.log(`Cancelled ${flags.id}`);
  },

  reclaim() {
    const reclaimed = mutate((state) => reclaimExpired(state));
    for (const id of reclaimed) appendEvent(cwd, { type: 'task.reclaimed', id });
    console.log(reclaimed.length ? `Reclaimed: ${reclaimed.join(', ')}` : 'Nothing to reclaim.');
  },

  reopen(flags) {
    mutate((state) => {
      const task = requireTask(state, flags.id);
      if (task.status !== 'failed' && task.status !== 'cancelled') fail(`Task ${task.id} is ${task.status}, not failed/cancelled`);
      const reset = Boolean(flags['reset-attempts']);
      touch(task, {
        status: NEEDS_APPROVAL.has(task.risk) ? 'awaiting_approval' : 'pending',
        owner: null,
        leaseUntil: null,
        attempts: reset ? 0 : task.attempts,
        lastError: null,
        verified: false,
      });
      task.notes.push({ at: now(), by: flags.by ?? null, text: `reopened${reset ? ' (attempts reset)' : ''}` });
    });
    appendEvent(cwd, { type: 'task.reopened', id: flags.id });
    console.log(`Reopened ${flags.id}`);
  },

  show(flags) {
    const task = requireTask(load(), flags.id);
    console.log(JSON.stringify(task, null, 2));
  },

  events(flags) {
    const eventsFile = path.join(dir, 'events.jsonl');
    if (!fs.existsSync(eventsFile)) {
      console.log('(no events)');
      return;
    }
    const tail = Number(flags.tail ?? 20);
    console.log(fs.readFileSync(eventsFile, 'utf8').trim().split('\n').slice(-tail).join('\n'));
  },

  status(flags) {
    const state = load();
    if (flags.json) {
      console.log(JSON.stringify(state, null, 2));
      return;
    }
    console.log(`Budget: maxTasks=${state.budget.maxTasks} maxAttempts=${state.budget.maxAttempts} timeout=${state.budget.defaultTimeoutMin}m`);
    printTable(state);
  },
};

const HELP = `Usage: node orchestrator.mjs <command> [flags]

  init      [--max-tasks 50] [--max-attempts 3] [--timeout 30]
  add       --title "..." [--role builder] [--risk read|write|sensitive|destructive]
            [--deps T-0001,T-0002] [--max-attempts N] [--timeout MIN] [--next "..."]
  approve   --id T-0001 --by <human>              (sensitive/destructive tasks only)
  claim     --agent <name> [--role <role>] [--id T-0001]   exit 3 when nothing is claimable
  heartbeat --id T-0001 --agent <name>
  note      --id T-0001 --text "..." [--next "..."] [--agent <name>]
  finish    --id T-0001 --agent <name> --evidence a,b | --unverified [--note "..."]
  fail      --id T-0001 --agent <name> --class transient|permanent|policy|timeout --error "..."
  cancel    --id T-0001 [--reason "..."]
  reopen    --id T-0001 [--by <name>] [--reset-attempts]   failed/cancelled -> pending
  reclaim   return expired leases to the queue
  show      --id T-0001
  events    [--tail 20]
  status    [--json]

State: ./.agent-state/tasks.json (locked, atomic writes). Events: ./.agent-state/events.jsonl`;

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = commands[positional[0]];
if (!command) {
  console.log(HELP);
  process.exit(positional[0] ? 1 : 0);
}
command(flags);
