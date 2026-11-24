import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

// STALL WATCHDOG — "no output for N seconds" is not an error, so failover can
// never see it. Live case (session-7a929cab): a coordinator child sat on
// "thinking 2m52s" with nothing streamed and nothing failing; the user had to
// switch by hand. The host publishes assistant-stream frames, so the silence is
// measurable: start arms the timer, the FIRST chunk cancels it.
//
// What this file pins:
//   1. 3 minutes of silence cuts the attempt and moves the child to the next
//      candidate in ITS list (a manual pick is withdrawn first).
//   2. Any streamed byte means "alive" — the watchdog must never fire then.
//   3. The switch is announced, and the child is told to continue.
//   4. Two stalls on one child, then the watchdog stands down.
//   5. The feature can be switched off, and 0 seconds disables it.

const config = {
  roleMode: false,
  injectRouteContext: false,
  failoverEnabled: true,
  stallWatchdogEnabled: true,
  stallWatchdogSeconds: 180,
  roleSlotCooldownSeconds: 0,
  models: [{ provider: 'p', model: 'a' }, { provider: 'q', model: 'b' }]
};

function harness(settings = config) {
  const listeners = new Map();
  const cleanups = [];
  const routes = [];
  const warnings = [];
  const agents = new Map();

  const ctx = {
    logger: { warn: (...args) => warnings.push(args.join(' ')), info: () => {} },
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
    inject(names, fn) {
      if (names.includes('webServer')) {
        fn({
          logger: ctx.logger,
          effect(register) {
            const off = register();
            if (typeof off === 'function') cleanups.push(off);
          },
          webServer: {
            register(route) {
              routes.push(route);
              return () => {
                const at = routes.indexOf(route);
                if (at >= 0) routes.splice(at, 1);
              };
            }
          }
        });
      }
    },
    get(key) {
      if (key === 'agents') return { get: (id) => agents.get(id) };
      return undefined;
    }
  };

  apply(ctx, settings);

  function emit(name, payload) {
    for (const fn of listeners.get(name) ?? []) fn(payload);
  }

  function stream(agent, type) {
    emit('agent/assistant-stream', { agent, frame: { type } });
  }

  function liveChild(id, route = { provider: 'p', model: 'a' }) {
    const selects = [];
    const cancels = [];
    const followups = [];
    const served = { provider: route.provider, model: route.model };
    const agent = {
      id,
      status: 'running',
      session: {
        id,
        header: { origin: 'subagent', label: id, parentSession: 'parent-1' },
        requestContext: () => ({ provider: served.provider, model: served.model, contextWindow: 1000 }),
        requestHeader: () => ({ config: { ...served } }),
        snapshotEvents: () => []
      },
      model: {
        selects,
        select(selection) {
          selects.push({ ...selection });
          if (typeof selection.provider === 'string') served.provider = selection.provider;
          if (typeof selection.model === 'string') served.model = selection.model;
        }
      },
      cancel(cause, options) { cancels.push({ cause, options }); },
      followup(message) { followups.push(message); },
      cancels,
      followups,
      options: { provider: 'parent', model: 'parent' }
    };
    agents.set(id, agent);
    return agent;
  }

  /** Emit one durable session event to the plugin's recovery observer. */
  function emitSession(session, event) {
    const payload = { session, event };
    for (const fn of listeners.get('session/event') ?? []) fn(payload.session, payload.event);
  }

  /** Open the plugin's SSE stream and collect every frame. */
  function openEvents() {
    const route = routes.find((entry) => entry.path === '/subagent-role-router');
    const chunks = [];
    let onClose = null;
    const req = {
      method: 'GET',
      url: '/subagent-role-router/events',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      on(event, fn) { if (event === 'close') onClose = fn; return req; }
    };
    const res = { writeHead() {}, write(chunk) { chunks.push(String(chunk)); return true; }, end() {} };
    void route.handler(req, res);
    return {
      frames() {
        return chunks
          .join('')
          .split('\n\n')
          .map((block) => block.trim())
          .filter((block) => block.startsWith('data:'))
          .map((block) => JSON.parse(block.slice(5).trim()));
      },
      close() { if (typeof onClose === 'function') onClose(); }
    };
  }

  return { warnings, emit, stream, liveChild, emitSession, openEvents, dispose() { for (const fn of cleanups.reverse()) fn(); } };
}

test('3 minutes of silence cuts the attempt and moves to the next model', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  const child = h.liveChild('child-1', { provider: 'p', model: 'a' });
  const events = h.openEvents();

  h.stream(child, 'start');
  t.mock.timers.tick(179_000);
  assert.deepEqual(child.model.selects, [], 'before the threshold nothing happens');

  t.mock.timers.tick(1_000);
  assert.deepEqual(child.model.selects, [{ provider: 'q', model: 'b' }]);
  assert.equal(child.cancels.length, 1);
  assert.equal(child.cancels[0].cause.kind, 'hook');
  assert.equal(child.cancels[0].cause.reason, 'stall-watchdog');
  assert.equal(child.cancels[0].options.keepInbox, true);
  assert.equal(child.followups.length, 1, 'the child must be told to continue, not left idle');
  const text = child.followups[0].content.map((part) => part.text).join('');
  assert.match(text, /继续/);
  assert.match(text, /q|b/, 'the continuation names the new route');
  const frames = events.frames().filter((frame) => frame.type === 'failover');
  assert.equal(frames.length, 1, 'the header pill gets exactly one announcement');
  assert.equal(frames[0].reason, 'stall-watchdog');
  assert.deepEqual(frames[0].from, { provider: 'p', model: 'a', reasoningEffort: '' });
  assert.deepEqual(frames[0].to, { provider: 'q', model: 'b', reasoningEffort: '' });
  events.close();
  h.dispose();
});

test('one streamed byte means alive: the watchdog never fires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  const child = h.liveChild('child-1', { provider: 'p', model: 'a' });

  h.stream(child, 'start');
  t.mock.timers.tick(120_000);
  h.stream(child, 'chunk');
  t.mock.timers.tick(600_000);
  assert.deepEqual(child.cancels, [], 'a slow but talking model must not be cut');
  h.dispose();
});

test('a finished attempt leaves no timer behind', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  const child = h.liveChild('child-1', { provider: 'p', model: 'a' });

  h.stream(child, 'start');
  h.stream(child, 'end');
  t.mock.timers.tick(600_000);
  assert.deepEqual(child.cancels, []);
  h.dispose();
});

test('the stalled route is never reselected for the retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  const child = h.liveChild('child-1', { provider: 'q', model: 'b' });

  h.stream(child, 'start');
  t.mock.timers.tick(180_000);
  assert.equal(child.cancels.length, 1);
  assert.deepEqual(child.model.selects, [{ provider: 'p', model: 'a' }], 'anything but the route that hung');
  h.dispose();
});

test('a stalled route is never retried in the same episode, so the second stall stands down', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  const child = h.liveChild('child-1', { provider: 'p', model: 'a' });

  // A stalls: B is the only untried candidate, so the watchdog cuts once.
  h.stream(child, 'start');
  t.mock.timers.tick(180_000);
  assert.equal(child.cancels.length, 1);
  assert.deepEqual(child.model.selects, [{ provider: 'q', model: 'b' }]);

  // B stalls too. Both routes have now actually failed in this episode, so
  // there is nothing left to try: cutting back to A would re-run a route that
  // already hung. The watchdog stands down.
  h.stream(child, 'start');
  t.mock.timers.tick(180_000);
  assert.equal(child.cancels.length, 1, 'no second cut: the episode is bounded by actual failed routes');
  assert.equal(child.followups.length, 1);
  assert.ok(h.warnings.some((line) => line.includes('standing down')));

  h.stream(child, 'start');
  t.mock.timers.tick(600_000);
  assert.equal(child.cancels.length, 1, 'a later stall in the same episode cannot cut again');
  h.dispose();
});

test('only a real assistant message resets the stall episode', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  const child = h.liveChild('child-1', { provider: 'p', model: 'a' });

  h.stream(child, 'start');
  t.mock.timers.tick(180_000);
  assert.equal(child.cancels.length, 1);
  assert.deepEqual(child.model.selects, [{ provider: 'q', model: 'b' }]);

  // A streamed chunk is not success: it only cancels the current timer.
  h.stream(child, 'start');
  h.stream(child, 'chunk');
  t.mock.timers.tick(600_000);
  assert.equal(child.cancels.length, 1, 'a chunk must not clear the episode');

  // B really answered — the route works, so a later stall may try A again.
  h.emitSession(child.session, {
    type: 'assistant/message',
    data: { turn: 1, step: 2, message: { source: { provider: 'q', model: 'b' } } }
  });
  h.stream(child, 'start');
  t.mock.timers.tick(180_000);
  assert.equal(child.cancels.length, 2, 'a committed assistant message re-opens the episode');
  assert.deepEqual(child.model.selects.at(-1), { provider: 'p', model: 'a' });
  h.dispose();
});

test('a user stop before the timer fires is never resurrected', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  const child = h.liveChild('child-1', { provider: 'p', model: 'a' });

  h.stream(child, 'start');
  // The parent/user cancelled the child; the generation latches dead before
  // the watchdog timer fires.
  h.emitSession(child.session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }
  });
  t.mock.timers.tick(600_000);
  assert.deepEqual(child.model.selects, []);
  assert.deepEqual(child.cancels, [], 'a stopped child must not be cut and resumed');
  assert.deepEqual(child.followups, []);
  h.dispose();
});

test('a disposed child leaves no timer and cannot be resurrected', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  const child = h.liveChild('child-1', { provider: 'p', model: 'a' });

  h.stream(child, 'start');
  h.emit('agent/disposed', { agent: child });
  t.mock.timers.tick(600_000);
  assert.deepEqual(child.cancels, []);
  assert.deepEqual(child.followups, []);
  h.dispose();
});

test('the watchdog can be switched off, and 0 seconds disables it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const off = harness({ ...config, stallWatchdogEnabled: false });
  const child = off.liveChild('child-1', { provider: 'p', model: 'a' });
  off.stream(child, 'start');
  t.mock.timers.tick(600_000);
  assert.deepEqual(child.cancels, []);
  off.dispose();

  const zero = harness({ ...config, stallWatchdogSeconds: 0 });
  const child2 = zero.liveChild('child-2', { provider: 'p', model: 'a' });
  zero.stream(child2, 'start');
  t.mock.timers.tick(600_000);
  assert.deepEqual(child2.cancels, []);
  zero.dispose();
});
