import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, subagentErrorJournalPath } from '../lib/index.js';

// THE STACK THE HOST THROWS AWAY.
//
// A live failure (2026-11-24, session-7a929cab) ended a worker child with
// `ctx is not defined` and no stack anywhere: the child session kept only
// message+code, the orchestrator log kept the message, the parent transcript
// kept the message. `agent/error` hands plugins the RAW error object, so this
// journal is where the stack survives — and it is the reason this file exists.

function harness() {
  const listeners = new Map();
  const cleanups = [];
  const ctx = {
    logger: { warn() {}, info() {} },
    on(name, fn) {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
      return () => {
        const at = list.indexOf(fn);
        if (at >= 0) list.splice(at, 1);
      };
    },
    effect(fn) {
      const off = fn();
      if (typeof off === 'function') cleanups.push(off);
    },
    inject() {},
    get() { return undefined; }
  };
  apply(ctx, { models: [], roleMode: false });
  return {
    emit(name, payload) {
      for (const fn of listeners.get(name) ?? []) fn(payload);
    },
    dispose() { for (const fn of cleanups.reverse()) fn(); }
  };
}

const childAgent = (id = 'child-1') => ({
  id,
  session: { header: { origin: 'subagent', label: 'worker', agentPreset: 'dsh-orchestrator-worker' }, snapshotEvents: () => [] }
});

test('a failed subagent turn lands in the journal with its stack', () => {
  const dir = mkdtempSync(join(tmpdir(), 'srr-journal-'));
  const previous = process.env.DSH_SUBAGENT_ROLE_ROUTER_STATE;
  process.env.DSH_SUBAGENT_ROLE_ROUTER_STATE = dir;
  try {
    const h = harness();
    const error = new ReferenceError('ctx is not defined');
    h.emit('agent/error', { agent: childAgent('worker-1'), turn: 1, step: 1, error });
    const file = subagentErrorJournalPath();
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.agentId, 'worker-1');
    assert.equal(entry.message, 'ctx is not defined');
    assert.match(entry.stack, /ReferenceError: ctx is not defined/);
    assert.match(entry.stack, /at /, 'the stack must carry frames, not just the message');
    h.dispose();
  } finally {
    if (previous === undefined) delete process.env.DSH_SUBAGENT_ROLE_ROUTER_STATE;
    else process.env.DSH_SUBAGENT_ROLE_ROUTER_STATE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main-agent errors stay out of the journal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'srr-journal-'));
  const previous = process.env.DSH_SUBAGENT_ROLE_ROUTER_STATE;
  process.env.DSH_SUBAGENT_ROLE_ROUTER_STATE = dir;
  try {
    const h = harness();
    h.emit('agent/error', {
      agent: { id: 'root', session: { header: { origin: 'main' }, snapshotEvents: () => [] } },
      turn: 1,
      step: 1,
      error: new Error('boom')
    });
    const file = subagentErrorJournalPath();
    assert.equal(existsSync(file) ? readFileSync(file, 'utf8').trim() : '', '');
    h.dispose();
  } finally {
    if (previous === undefined) delete process.env.DSH_SUBAGENT_ROLE_ROUTER_STATE;
    else process.env.DSH_SUBAGENT_ROLE_ROUTER_STATE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
