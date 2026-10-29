import test from 'node:test';
import assert from 'node:assert/strict';
import { interruptChildNow } from '../lib/index.js';

// The host's own `interruptByParent` looks a child up in its resident-activation
// table and returns silently on a miss: the UI reports "accepted" and the child
// keeps running. `interruptChildNow` is the second attempt behind that, and it is
// exported precisely because a wrong shape here is invisible in production —
// every path below ends in the host swallowing the call.

function fakeCtx({ interrupt, agents } = {}) {
  return {
    get(name) {
      if (name === 'subagents') return interrupt === undefined ? undefined : { interrupt };
      if (name === 'agents') return agents;
      return undefined;
    }
  };
}

test('interruptChildNow accepts on the first id form it can spell', () => {
  const calls = [];
  const ctx = fakeCtx({ interrupt: (id, authority) => { calls.push([id, authority.kind]); } });
  const result = interruptChildNow(ctx, 'child-1', 'parent-1');
  assert.equal(result.ok, true);
  assert.equal(calls[0][0], 'child-1');
  assert.equal(calls[0][1], 'user');
  assert.ok(result.attempts.some((a) => a.ok === true));
});

test('interruptChildNow keeps trying after the host throws on one form', () => {
  const calls = [];
  const ctx = fakeCtx({
    interrupt: (id) => {
      calls.push(id);
      if (id === 'child-2') throw new Error('no such activation');
    }
  });
  const result = interruptChildNow(ctx, 'child-2', 'parent-2');
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.ok(result.attempts.some((a) => typeof a.error === 'string'));
  assert.ok(result.attempts.some((a) => a.ok === true));
});

test('interruptChildNow reports why it could not stop anything', () => {
  const none = interruptChildNow(fakeCtx({}), 'child-3', 'parent-3');
  assert.equal(none.ok, false);
  assert.equal(none.attempts[0].reason, 'no-subagents-service');

  const calls = [];
  const orphan = interruptChildNow(fakeCtx({ interrupt: (id) => { calls.push(id); } }), 'child-4', '');
  assert.equal(orphan.ok, false);
  assert.equal(calls.length, 0);
  assert.ok(orphan.attempts.every((a) => a.reason === 'no-parent-session'));
});

test('interruptChildNow reaches an ancestor authority when one is resident', () => {
  const authorities = [];
  const ancestor = { id: 'parent-agent' };
  const ctx = fakeCtx({
    interrupt: (_id, authority) => { authorities.push(authority.kind); },
    agents: { get: (id) => (id === 'session-parent-5' || id === 'parent-5' ? ancestor : undefined) }
  });
  const result = interruptChildNow(ctx, 'child-5', 'parent-5');
  assert.equal(result.ok, true);
  assert.ok(authorities.includes('user'));
  assert.ok(authorities.includes('ancestor'));
});
