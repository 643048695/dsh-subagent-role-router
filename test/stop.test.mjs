import test from 'node:test';
import assert from 'node:assert/strict';
import { interruptChildNow } from '../lib/index.js';

// The host's own stop path is authorized by the Gateway on the target Session.
// This plugin's `/stop` fallback has NO caller identity — it is loopback-only —
// so it may only present an exact live ANCESTOR agent, and it must first prove
// the child really is that ancestor's resident descendant. The old function
// guessed: it tried `{kind:'user'}` and marked `ok:true` whenever the host's
// void call did not throw, even though the host returns silently on a miss.
//
// Every test below therefore checks one of the boundary rules:
//   * no live child            → refused, no interrupt call;
//   * no verifiable parent     → refused, no interrupt call;
//   * child of another parent  → refused, no interrupt call;
//   * parent agent not live    → refused, no interrupt call;
//   * authority is ancestor    → `{kind:'user'}` is never sent;
//   * explicit refusal / throw → `ok:false`, never a silent success.

const PARENT = 'parent-1';

function liveChild(id, parent = PARENT) {
  return {
    id,
    status: 'inactive',
    session: {
      header: { origin: 'subagent', label: id, parentSession: parent },
      requestContext: () => ({ provider: 'p', model: 'a' })
    }
  };
}

function fakeCtx({ interrupt, agents = new Map(), children, listChildren } = {}) {
  const calls = [];
  const service = interrupt === undefined
    ? undefined
    : {
        interrupt(id, authority) {
          calls.push([id, authority?.kind]);
          return interrupt(id, authority);
        }
      };
  return {
    calls,
    get(name) {
      if (name === 'subagents') {
        if (service === undefined) return undefined;
        return {
          ...service,
          listChildren: listChildren ?? (async (parentSessionId) => {
            const rows = children ?? [...agents.values()].map((agent) => ({
              id: agent.id,
              mode: 'continuable',
              label: agent.session?.header?.label ?? agent.id,
              parentId: agent.session?.header?.parentSession
            }));
            return rows.filter((row) => row.parentId === parentSessionId);
          })
        };
      }
      if (name === 'agents') return { get: (id) => agents.get(id) };
      return undefined;
    }
  };
}

const state = () => ({
  getSection: () => ({}),
  childRoutes: new Map(),
  routeRevisions: new Map(),
  coordGroupOfChild: new Map(),
  routeEpoch: 'e0'
});

test('a verified resident child is interrupted under ancestor authority only', async () => {
  const agents = new Map();
  const child = liveChild('child-1');
  agents.set(child.id, child);
  agents.set(PARENT, { id: PARENT, session: { header: { origin: 'main', id: PARENT } } });
  const ctx = fakeCtx({ interrupt: () => undefined, agents });
  const result = await interruptChildNow(ctx, state(), 'child-1', PARENT);
  assert.equal(result.ok, true);
  assert.deepEqual(ctx.calls, [['child-1', 'ancestor']], 'kind:user is never presented by this fallback');
  assert.ok(result.attempts.some((a) => a.ok === true && a.authority === 'ancestor'));
  assert.equal(result.parentSessionId, PARENT);
});

test('the parent can be derived from the live child header when the UI sends none', async () => {
  const agents = new Map();
  const child = liveChild('child-2');
  // Give it an ancestor so the authority can be presented.
  agents.set(child.id, child);
  agents.set(PARENT, { id: PARENT, session: { header: { origin: 'main', id: PARENT } } });
  const ctx = fakeCtx({ interrupt: () => undefined, agents });
  const result = await interruptChildNow(ctx, state(), 'child-2', '');
  assert.equal(result.ok, true, 'the durable header names the exact parent, so verification still happens');
  assert.deepEqual(ctx.calls, [['child-2', 'ancestor']]);
});

test('an unverifiable parent is refused instead of interrupted', async () => {
  const agents = new Map();
  const child = { id: 'child-3', session: { header: { origin: 'subagent', label: 'child-3' }, requestContext: () => ({}) } };
  agents.set(child.id, child);
  const ctx = fakeCtx({ interrupt: () => undefined, agents });
  const result = await interruptChildNow(ctx, state(), 'child-3', '');
  assert.equal(result.ok, false);
  assert.equal(ctx.calls.length, 0, 'nothing was sent to the host');
  assert.equal(result.reason, 'unverifiable');
});

test('a host without the parent catalog refuses: cannot verify is an error', async () => {
  const agents = new Map();
  const child = liveChild('child-4');
  agents.set(child.id, child);
  const ctx = fakeCtx({ interrupt: () => undefined, agents });
  // Add a child registry but no listing method at all.
  ctx.get = (name) => {
    if (name === 'subagents') return { interrupt: () => undefined };
    if (name === 'agents') return { get: (id) => agents.get(id) };
    return undefined;
  };
  const result = await interruptChildNow(ctx, state(), 'child-4', PARENT);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unverifiable');
});

test('a live main agent is never a stop target', async () => {
  const agents = new Map();
  const main = { id: 'main-1', session: { header: { origin: 'main', id: 'main-1' }, requestContext: () => ({}) } };
  agents.set(main.id, main);
  const ctx = fakeCtx({ interrupt: () => undefined, agents });
  const result = await interruptChildNow(ctx, state(), 'main-1', PARENT);
  assert.equal(result.ok, false);
  assert.equal(ctx.calls.length, 0);
});

test('a child of a different conversation is refused', async () => {
  const agents = new Map();
  const child = liveChild('child-5', 'parent-2');
  agents.set(child.id, child);
  const ctx = fakeCtx({ interrupt: () => undefined, agents });
  const result = await interruptChildNow(ctx, state(), 'child-5', PARENT);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-owned');
  assert.equal(ctx.calls.length, 0);
});

test('an absent parent agent cannot lend ancestor authority', async () => {
  const agents = new Map();
  const child = liveChild('child-6');
  agents.set(child.id, child);
  const ctx = fakeCtx({ interrupt: () => undefined, agents });
  const result = await interruptChildNow(ctx, state(), 'child-6', PARENT);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-live-ancestor');
  assert.equal(ctx.calls.length, 0, 'the invalid ancestor is never handed to the host');
});

test('the host throwing on the catalog spelling is retried once in the other spelling', async () => {
  const agents = new Map();
  const child = liveChild('session-child-7');
  agents.set(child.id, child);
  agents.set(PARENT, { id: PARENT, session: { header: { origin: 'main', id: PARENT } } });
  const tried = [];
  const ctx = fakeCtx({
    agents,
    interrupt: (id) => {
      tried.push(id);
      if (id === 'session-child-7') throw new Error('no such activation');
    }
  });
  const result = await interruptChildNow(ctx, state(), 'session-child-7', PARENT);
  assert.equal(result.ok, true);
  assert.deepEqual(tried, ['session-child-7', 'child-7'], 'the other id form is the second attempt');
  assert.ok(result.attempts.some((a) => typeof a.error === 'string'));
  assert.ok(result.attempts.some((a) => a.ok === true));
});

test('an explicit refusal from the host is not reported as success', async () => {
  const agents = new Map();
  const child = liveChild('child-8');
  agents.set(child.id, child);
  agents.set(PARENT, { id: PARENT, session: { header: { origin: 'main', id: PARENT } } });
  const ctx = fakeCtx({ interrupt: () => ({ accepted: false }), agents });
  const result = await interruptChildNow(ctx, state(), 'child-8', PARENT);
  assert.equal(result.ok, false, 'a silent no-op or a refusal must never look like a stop');
  assert.equal(result.reason, 'interrupt-rejected');
  assert.equal(ctx.calls.length, 2, 'both id spellings were tried before giving up');
});

test('a host without the subagents service says so instead of claiming a stop', async () => {
  const ctx = fakeCtx({});
  const result = await interruptChildNow(ctx, state(), 'child-9', PARENT);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-subagents-service');
  assert.equal(result.attempts[0].reason, 'no-subagents-service');
});
