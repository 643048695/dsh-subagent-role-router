import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

// Live per-child route override: the Web UI picks a model/effort for a RUNNING
// subagent and the plugin applies it on that child's next request.
//
// The two invariants worth locking down here are the ones that are invisible in
// the UI and expensive to rediscover from a browser:
//
//   1. The override must WIN over the automatic failover swap. Cordis waterfalls
//      run listeners in registration order and unwind in reverse, so the plugin
//      registers this listener FIRST on purpose. If someone reorders `apply()`,
//      the user's explicit pick silently becomes the failover's pick — the exact
//      "I clicked and nothing happened" bug this feature exists to fix.
//   2. The override is per child. A sibling subagent on the same pool must keep
//      its own route.

const config = {
  roleMode: true,
  exploreProvider: 'p', exploreModel: 'explore',
  patchProvider: 'p', patchModel: 'general',
  planProvider: 'p', planModel: 'plan',
  injectRouteContext: false,
  failoverEnabled: true,
  models: [{ provider: 'p', model: 'a' }, { provider: 'q', model: 'b' }],
  roleSlotCooldownSeconds: 0
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
      // The override endpoint needs the web server; the subagent wrapper needs
      // the subagents service. Neither is under test here, so only serve the
      // web server and let the rest no-op.
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
      if (key === 'agents') {
        return { get: (id) => agents.get(id) };
      }
      return undefined;
    }
  };

  apply(ctx, settings);

  /** Run the `agent/request` waterfall the way cordis does (post-next unwinds in reverse). */
  async function request(payload, value) {
    const list = listeners.get('agent/request') ?? [];
    const run = (i) => (i === list.length ? Promise.resolve(value) : list[i](payload, () => run(i + 1)));
    return run(0);
  }

  /** Emit a plain (non-waterfall) event. */
  function emit(name, payload) {
    for (const fn of listeners.get(name) ?? []) fn(payload);
  }

  /** Run the `agent/request-error` waterfall. */
  async function error(agent, failure, value) {
    const list = listeners.get('agent/request-error') ?? [];
    const payload = { turn: 0, step: 0, agent, provider: 'p', failure };
    const run = (i) => (i === list.length ? Promise.resolve(value) : list[i](payload, () => run(i + 1)));
    return run(0);
  }

  /** Drive the plugin's own HTTP route. */
  async function call({ method = 'POST', path, body, remote = '127.0.0.1', contentType = 'application/json' }) {
    const route = routes.find((entry) => entry.path === '/subagent-role-router');
    assert.ok(route, 'the plugin must claim /subagent-role-router');
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = {
      method,
      url: path,
      headers: body === undefined ? {} : { 'content-type': contentType },
      socket: { remoteAddress: remote },
      on(event, fn) {
        if (event === 'data' && payload !== '') fn(Buffer.from(payload));
        if (event === 'end') fn();
        return req;
      },
      destroy() {}
    };
    let status = 0;
    let raw = '';
    const res = {
      writeHead(code) { status = code; },
      end(chunk) { raw += chunk ?? ''; }
    };
    await route.handler(req, res);
    return { status, body: raw === '' ? null : JSON.parse(raw) };
  }

  /**
   * Register a live subagent agent the way the host really shapes it.
   *
   * THE SPLIT MATTERS: a real session log stores
   * `request/context = {provider, model, contextWindow}` — NO effort — while
   * `requestHeader().config` carries `{provider, model, reasoningEffort,
   * maxTokens}`. An earlier fixture handed the whole route (effort included)
   * back from `requestContext()`, which no real host ever does, so the UI
   * showed "Default" for every child while the suite stayed green. The fake
   * now mirrors the real split so that gap cannot reopen.
   */
  function liveChild(id, route = { provider: 'p', model: 'general' }) {
    const agent = {
      id,
      session: {
        header: { origin: 'subagent', label: id },
        requestContext: () => ({ provider: route.provider, model: route.model, contextWindow: 1000 }),
        requestHeader: () => ({ config: { ...route } }),
        snapshotEvents: () => []
      },
      options: { provider: 'parent', model: 'parent' }
    };
    agents.set(id, agent);
    return agent;
  }

  return { ctx, agents, routes, warnings, request, error, emit, call, liveChild, dispose() { for (const fn of cleanups.reverse()) fn(); } };
}

const childPayload = (agent) => ({ turn: 0, step: 0, agent });

test('an override picked in the UI wins over the failover swap', async () => {
  const h = harness();
  const child = h.liveChild('child-1');
  // Failover would move this child to the next pool entry; the user's pick must
  // be the route that actually reaches the provider.
  const seeded = { provider: 'p', model: 'a', reasoningEffort: 'max', maxTokens: 4096 };

  const before = await h.request(childPayload(child), seeded);
  assert.equal(before.model, 'a', 'without an override the pool decides');

  const selected = await h.call({
    path: '/subagent-role-router/select',
    body: { childId: 'child-1', provider: 'q', model: 'b', reasoningEffort: 'low' }
  });
  assert.equal(selected.status, 200);
  assert.equal(selected.body.ok, true);
  assert.deepEqual(selected.body.value.override, { provider: 'q', model: 'b', reasoningEffort: 'low' });

  const after = await h.request(childPayload(child), seeded);
  assert.equal(after.provider, 'q');
  assert.equal(after.model, 'b');
  assert.equal(after.reasoningEffort, 'low');
  // Everything else about the request must survive: the override only swaps the
  // route, never the budget or the tool policy.
  assert.equal(after.maxTokens, 4096);
  h.dispose();
});

test('an override applies to its own child only', async () => {
  const h = harness();
  const one = h.liveChild('child-1');
  const two = h.liveChild('child-2');
  await h.call({ path: '/subagent-role-router/select', body: { childId: 'child-1', provider: 'q', model: 'b' } });

  const seeded = { provider: 'p', model: 'a' };
  assert.equal((await h.request(childPayload(one), seeded)).model, 'b');
  assert.equal((await h.request(childPayload(two), seeded)).model, 'a');
  h.dispose();
});

test('an override with no effort drops the inherited one instead of leaking it', async () => {
  const h = harness();
  const child = h.liveChild('child-1');
  await h.call({ path: '/subagent-role-router/select', body: { childId: 'child-1', provider: 'q', model: 'b' } });

  // A provider whose thinking level must agree with the effort rejects a
  // mismatched pair, so inheriting `max` from the route being left would break
  // the very first request after the switch.
  const after = await h.request(childPayload(child), { provider: 'p', model: 'a', reasoningEffort: 'max' });
  assert.equal(after.model, 'b');
  assert.equal('reasoningEffort' in after, false, 'the inherited effort must be dropped, not carried over');
  h.dispose();
});

test('failover stays out of the way while an override is live', async () => {
  const h = harness();
  const child = h.liveChild('child-1');

  // Without an override the pool owns the child: a retryable failure is
  // answered with {kind:'retry'} so the next attempt lands on another model.
  const retried = await h.error(child, { code: 'TIMEOUT', message: 'slow' }, { kind: 'continue' });
  assert.deepEqual(retried, { kind: 'retry' });

  await h.call({ path: '/subagent-role-router/select', body: { childId: 'child-1', provider: 'q', model: 'b' } });

  // With an override live the user has named the model, so an automatic swap
  // would silently overrule that pick. The failure must surface instead, and no
  // cooldown may be recorded against a model the plugin never chose.
  const surfaced = await h.error(child, { code: 'TIMEOUT', message: 'slow' }, { kind: 'continue' });
  assert.deepEqual(surfaced, { kind: 'continue' });
  assert.equal(h.warnings.filter((line) => line.includes('cooling down')).length, 0);
  h.dispose();
});

test('reset and disposal forget the override', async () => {
  const h = harness();
  const child = h.liveChild('child-1');
  await h.call({ path: '/subagent-role-router/select', body: { childId: 'child-1', provider: 'q', model: 'b' } });
  assert.equal((await h.request(childPayload(child), { provider: 'p', model: 'a' })).model, 'b');

  const cleared = await h.call({ path: '/subagent-role-router/clear', body: { childId: 'child-1' } });
  assert.equal(cleared.body.ok, true);
  assert.equal(cleared.body.value.override, null);
  assert.equal((await h.request(childPayload(child), { provider: 'p', model: 'a' })).model, 'a');

  await h.call({ path: '/subagent-role-router/select', body: { childId: 'child-1', provider: 'q', model: 'b' } });
  h.emit('agent/disposed', { agent: child });
  assert.equal((await h.request(childPayload(child), { provider: 'p', model: 'a' })).model, 'a');
  h.dispose();
});

test('the route reports the live pair and the pending override separately', async () => {
  const h = harness();
  const child = h.liveChild('child-1', { provider: 'p', model: 'general', reasoningEffort: 'high' });

  // The session fold the UI used to read carries no effort at all — proof that
  // reporting "high" below can only come from the request header.
  assert.equal(child.session.requestContext().reasoningEffort, undefined);

  const initial = await h.call({ method: 'GET', path: '/subagent-role-router/route?childId=child-1', body: undefined });
  assert.equal(initial.body.ok, true);
  assert.equal(initial.body.value.provider, 'p');
  assert.equal(initial.body.value.model, 'general');
  assert.equal(initial.body.value.reasoningEffort, 'high');
  assert.equal(initial.body.value.override, null);

  await h.call({ path: '/subagent-role-router/select', body: { childId: 'child-1', provider: 'q', model: 'b' } });
  const pending = await h.call({ method: 'GET', path: '/subagent-role-router/route?childId=child-1', body: undefined });
  // The child is idle, so `requestContext()` still reports the OLD route while
  // the override describes where it will go next. The UI shows both.
  assert.equal(pending.body.value.model, 'general');
  assert.deepEqual(pending.body.value.override, { provider: 'q', model: 'b' });
  h.dispose();
});

test('an unknown or finished child is refused instead of silently accepted', async () => {
  const h = harness();
  const missing = await h.call({ path: '/subagent-role-router/select', body: { childId: 'nope', provider: 'q', model: 'b' } });
  assert.equal(missing.body.ok, false);
  assert.equal(missing.body.error.code, 'not-live');

  // A main-agent session must not be reachable through this route: the whole
  // point is that it only ever touches subagent children.
  h.agents.set('main-1', { id: 'main-1', session: { header: {}, requestContext: () => ({}) } });
  const main = await h.call({ path: '/subagent-role-router/select', body: { childId: 'main-1', provider: 'q', model: 'b' } });
  assert.equal(main.body.ok, false);
  assert.equal(main.body.error.code, 'not-live');
  h.dispose();
});

test('the endpoint is loopback-only and refuses non-JSON posts', async () => {
  const h = harness();
  h.liveChild('child-1');

  const remote = await h.call({ path: '/subagent-role-router/select', remote: '192.168.1.20', body: { childId: 'child-1', provider: 'q', model: 'b' } });
  assert.equal(remote.status, 403);
  assert.equal(remote.body.error.code, 'forbidden');

  // A cross-site form cannot send application/json without a CORS preflight, so
  // requiring it doubles as CSRF hardening.
  const form = await h.call({ path: '/subagent-role-router/select', contentType: 'text/plain', body: { childId: 'child-1', provider: 'q', model: 'b' } });
  assert.equal(form.status, 415);

  const empty = await h.call({ path: '/subagent-role-router/select', body: { childId: 'child-1', provider: '', model: '' } });
  assert.equal(empty.status, 400);

  const unknown = await h.call({ path: '/subagent-role-router/nope', body: {} });
  assert.equal(unknown.status, 404);
  h.dispose();
});

test('unload releases the HTTP route', () => {
  const h = harness();
  assert.equal(h.routes.length, 1);
  h.dispose();
  assert.equal(h.routes.length, 0, 'a hot reload must not leave the route behind');
});
