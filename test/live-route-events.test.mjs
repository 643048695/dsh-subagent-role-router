import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { apply } from '../lib/index.js';

// The no-poll live-route pipeline, both halves:
//
//   server — every route write and every applied switch pushes one SSE frame
//   to connected pages, so pickers in OTHER windows converge without the old
//   5-second timer. The frame is a hint; the client answers with GET /route.
//
//   client — the pure seams the picker leans on: store folding, epoch
//   tracking, and the page-level SSE singleton (ref-counted, degrading to
//   the signal set after three consecutive hard failures).

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

  async function request(payload, value) {
    const list = listeners.get('agent/request') ?? [];
    const run = (i) => (i === list.length ? Promise.resolve(value) : list[i](payload, () => run(i + 1)));
    return run(0);
  }

  async function error(agent, failure, value) {
    const list = listeners.get('agent/request-error') ?? [];
    const payload = { turn: 0, step: 0, agent, provider: 'p', failure };
    const run = (i) => (i === list.length ? Promise.resolve(value) : list[i](payload, () => run(i + 1)));
    return run(0);
  }

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
   * Open one SSE listener against the plugin's events endpoint. The fake res
   * collects raw frames in order; the request never ends (a live stream).
   */
  async function openEvents() {
    const route = routes.find((entry) => entry.path === '/subagent-role-router');
    assert.ok(route, 'the plugin must claim /subagent-role-router');
    const closeHandlers = [];
    const req = {
      method: 'GET',
      url: '/subagent-role-router/events',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      on(event, fn) {
        if (event === 'close') closeHandlers.push(fn);
        return req;
      },
      destroy() {}
    };
    const res = {
      status: 0,
      headers: null,
      writes: [],
      writeHead(code, headers) { res.status = code; res.headers = headers; },
      write(chunk) { res.writes.push(chunk); },
      end() { res.ended = true; }
    };
    await route.handler(req, res);
    // Mirror the socket closing: the handler must stop its heartbeat.
    return { req, res, close() { for (const fn of closeHandlers.splice(0)) fn(); } };
  }

  function liveChild(id, route = { provider: 'p', model: 'a' }, opts = {}) {
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
    if (opts.withModelSelect) {
      // The host's front door (`model.select`); disk stubs and older hosts do
      // not have one. Recorded so tests can assert the exact pushes.
      const selects = [];
      agent.model = { selects, select(selection) { selects.push({ ...selection }); } };
    }
    agents.set(id, agent);
    return agent;
  }

  return { ctx, agents, routes, warnings, request, error, call, openEvents, liveChild, dispose() { for (const fn of cleanups.reverse()) fn(); } };
}

const childPayload = (agent) => ({ turn: 0, step: 0, agent });

/** Parse `data: {json}` frames out of the collected SSE writes. */
const frames = (writes) => writes
  .filter((chunk) => typeof chunk === 'string' && chunk.startsWith('data: '))
  .map((chunk) => JSON.parse(chunk.slice(6)));

test('the events stream opens with a hello frame and announces override writes', async () => {
  const h = harness();
  h.liveChild('child-1');
  const stream = await h.openEvents();

  assert.equal(stream.res.status, 200);
  assert.equal(stream.res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(stream.res.ended, undefined, 'a live stream must not be ended by the handler');
  const hello = frames(stream.res.writes).at(-1);
  assert.equal(hello.type, 'hello');
  assert.equal(typeof hello.epoch, 'string');

  const before = stream.res.writes.length;
  const selected = await h.call({
    path: '/subagent-role-router/select',
    body: { childId: 'child-1', provider: 'q', model: 'b' }
  });
  assert.equal(selected.status, 200);
  assert.equal(typeof selected.body.epoch, 'string', 'select responses carry the epoch');

  const routeFrames = frames(stream.res.writes.slice(before)).filter((f) => f.type === 'route');
  assert.equal(routeFrames.length, 1);
  assert.equal(routeFrames[0].childId, 'child-1');
  assert.equal(routeFrames[0].reason, 'override-set');
  assert.equal(typeof routeFrames[0].revision, 'number');
  stream.close();
  h.dispose();
});

test('a failing SSE connection is dropped without disturbing the others', async () => {
  const h = harness();
  h.liveChild('child-2');
  const bad = await h.openEvents();
  const good = await h.openEvents();

  // The connection dies; the write throws exactly the way a destroyed
  // socket does. The fan-out must swallow it and drop this client.
  bad.res.write = () => { throw new Error('EPIPE'); };

  const before = good.res.writes.length;
  await h.call({ path: '/subagent-role-router/select', body: { childId: 'child-2', provider: 'q', model: 'b' } });
  assert.equal(frames(good.res.writes.slice(before)).filter((f) => f.type === 'route').length, 1,
    'the healthy stream still received the frame');

  // If the dead client had been dropped, restoring a collector must stay
  // empty: the fan-out no longer knows about it.
  const resurrected = [];
  bad.res.write = (chunk) => resurrected.push(chunk);
  const mid = good.res.writes.length;
  await h.call({ path: '/subagent-role-router/clear', body: { childId: 'child-2' } });
  assert.equal(frames(resurrected).filter((f) => f.type === 'route').length, 0,
    'the dead client must be dropped from the fan-out');
  assert.equal(frames(good.res.writes.slice(mid)).filter((f) => f.type === 'route').length, 1);
  good.close();
  h.dispose();
});

test('an override applying on a request is announced once, and the failover stays silent under it', async () => {
  const h = harness();
  const child = h.liveChild('child-3', { provider: 'p', model: 'a' }, { withModelSelect: true });
  const stream = await h.openEvents();

  // The pick is pushed through the front door the moment it is written.
  await h.call({ path: '/subagent-role-router/select', body: { childId: 'child-3', provider: 'q', model: 'b' } });
  assert.deepEqual(child.model.selects, [{ provider: 'q', model: 'b' }]);

  // The request the child is already running keeps flowing through untouched
  // (the host freezes the selection and throws on a differing proposal), while
  // the lagging seed triggers one idempotent re-pick — and no announcement:
  // the pick never landed, so there is nothing to celebrate yet.
  const seeded = { provider: 'p', model: 'a', reasoningEffort: 'max', maxTokens: 4096 };
  const mid = stream.res.writes.length;
  const after = await h.request(childPayload(child), seeded);
  assert.deepEqual(after, seeded);
  assert.equal(child.model.selects.length, 2, 'the lagging seed re-picks the override');
  assert.equal(frames(stream.res.writes.slice(mid)).filter((f) => f.type === 'route').length, 0,
    'no announcement while the seed has not caught up');

  // Once the host's own seed carries the override, the applied switch is
  // announced exactly once.
  const landed = { provider: 'q', model: 'b', reasoningEffort: 'max', maxTokens: 4096 };
  const tail = stream.res.writes.length;
  const caught = await h.request(childPayload(child), landed);
  assert.deepEqual(caught, landed);
  const applied = frames(stream.res.writes.slice(tail)).filter((f) => f.type === 'route');
  assert.equal(applied.length, 1, 'exactly one announcement for the applied switch');
  assert.equal(applied[0].reason, 'override-applied');
  assert.equal(applied[0].childId, 'child-3');

  // Same seed again: a re-pick of the same route is not news.
  const last = stream.res.writes.length;
  await h.request(childPayload(child), landed);
  assert.equal(frames(stream.res.writes.slice(last)).filter((f) => f.type === 'route').length, 0);
  stream.close();
  h.dispose();
});

test('a failover switch with no override announces itself exactly once', async () => {
  const h = harness();
  const child = h.liveChild('child-4', { provider: 'p', model: 'a' }, { withModelSelect: true });
  const stream = await h.openEvents();

  // A timeout moves the failover cursor to the next pool entry (q/b) and
  // pushes it through the front door at once, so the NEXT step uses it.
  await h.error(child, { code: 'TIMEOUT', message: 'slow' }, { kind: 'continue' });
  assert.deepEqual(child.model.selects, [{ provider: 'q', model: 'b' }]);

  // The request the child is already running is never rewritten (the host
  // freezes the selection): it comes back as-is, but the switch to the
  // failover target is announced even before the seed catches up.
  const before = stream.res.writes.length;
  const seeded = { provider: 'p', model: 'a' };
  const switched = await h.request(childPayload(child), seeded);
  assert.deepEqual(switched, seeded);

  const announce = frames(stream.res.writes.slice(before)).filter((f) => f.type === 'route');
  assert.equal(announce.length, 1);
  assert.equal(announce[0].reason, 'failover-switch');
  assert.equal(announce[0].childId, 'child-4');

  const again = stream.res.writes.length;
  await h.request(childPayload(child), { provider: 'p', model: 'a' });
  assert.equal(frames(stream.res.writes.slice(again)).filter((f) => f.type === 'route').length, 0,
    'the same failover target re-announced would flap every picker');
  stream.close();
  h.dispose();
});

// ── client: the pure seams ───────────────────────────────────────────────

const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** Load the client module with a scriptable EventSource and timers. */
function loadClient() {
  let capturedModule = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(module) { capturedModule = module; }
      }
    },
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, setAttribute() {}, textContent: '' }),
      head: { appendChild() {} }
    },
    console
  };
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.closed = false;
      FakeEventSource.instances.push(this);
    }
    close() { this.closed = true; this.readyState = 2; }
  }
  FakeEventSource.instances = [];
  // Timers are captured, never fired: the test drives the retry manually.
  sandbox.__timers = [];
  sandbox.setTimeout = (fn) => { sandbox.__timers.push(fn); return sandbox.__timers.length; };
  sandbox.clearTimeout = (id) => { sandbox.__timers[id - 1] = null; };
  sandbox.EventSource = FakeEventSource;
  vm.runInNewContext(clientSource, sandbox, { filename: 'client.js' });
  if (!capturedModule || typeof capturedModule.factory !== 'function') {
    throw new Error('client.js failed to register with __ModuleLoader__');
  }
  const fakeRequire = (id) => {
    if (id === 'react') {
      return {
        useState: (init) => [init, () => {}],
        useMemo: (fn) => fn(),
        useRef: (init) => ({ current: init }),
        useEffect: (fn) => {
          const cleanup = fn();
          return typeof cleanup === 'function' ? cleanup : () => {};
        },
        createElement: () => ({})
      };
    }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Toast: function Toast() {} };
    return {};
  };
  return { client: capturedModule.factory(fakeRequire), FakeEventSource, timers: sandbox.__timers, fireTimer(index) { const fn = sandbox.__timers[index]; if (fn) fn(); } };
}

test('liveStoreSignature folds one child across every id spelling', () => {
  const { client } = loadClient();
  const snapshot = {
    byId: {
      'child-a': { running: true, origin: 'subagent', parentId: 'p1', updatedAt: 5 },
      'session-child-b': { running: false, origin: 'subagent', parentId: 'p1', updatedAt: 6, blank: true }
    }
  };
  assert.equal(client.liveStoreSignature(null, 'child-a'), null, 'no store handed over → no signal');
  assert.equal(client.liveStoreSignature({ byId: {} }, 'child-a'), 'absent', 'absent is a signature too');
  const bare = client.liveStoreSignature(snapshot, 'child-a');
  const prefixed = client.liveStoreSignature(snapshot, 'session-child-a');
  assert.equal(bare, prefixed, 'both spellings must fold to the same signature');
  assert.notEqual(client.liveStoreSignature(snapshot, 'child-b'), bare);

  const running = client.liveStoreSignature(snapshot, 'child-a');
  const exited = client.liveStoreSignature(
    { byId: { 'child-a': { ...snapshot.byId['child-a'], running: false } } }, 'child-a');
  assert.notEqual(exited, running, 'running → exited must flip the signature');
  const touched = client.liveStoreSignature(
    { byId: { 'child-a': { ...snapshot.byId['child-a'], updatedAt: 9 } } }, 'child-a');
  assert.notEqual(touched, running, 'a store touch must flip the signature');
});

test('canonicalSseChildId and noteRouteEpoch behave', () => {
  const { client } = loadClient();
  assert.equal(client.canonicalSseChildId('session-x'), 'x');
  assert.equal(client.canonicalSseChildId('x'), 'x');
  assert.equal(client.canonicalSseChildId(void 0), '');
  assert.equal(client.canonicalSseChildId(null), '');

  assert.equal(client.noteRouteEpoch('s1', 'e1'), false, 'first sighting is not a change');
  assert.equal(client.noteRouteEpoch('s1', 'e1'), false, 'same epoch is not a change');
  assert.equal(client.noteRouteEpoch('s1', 'e2'), true, 'a new epoch IS a change');
  assert.equal(client.noteRouteEpoch('s1', void 0), false, 'a missing epoch is ignored');
  assert.equal(client.noteRouteEpoch('s1', ''), false);
});

test('the SSE singleton connects on demand, resyncs on open, and degrades after three failures', () => {
  const { client, FakeEventSource, fireTimer, timers } = loadClient();
  const seen = [];
  const release = client.liveRouteEventsSubscribe((event) => seen.push(event));

  assert.equal(FakeEventSource.instances.length, 1, 'the first subscriber opens one stream');
  assert.equal(FakeEventSource.instances[0].url, 'subagent-role-router/events');
  let es = FakeEventSource.instances[0];

  es.onopen();
  // Values built inside the vm carry that realm's prototypes; compare shape.
  assert.equal(JSON.stringify(seen), JSON.stringify([{ type: 'resync' }]),
    'a (re)opened stream starts with a resync');

  es.onmessage({ data: JSON.stringify({ type: 'route', childId: 'x', revision: 2 }) });
  assert.equal(JSON.stringify(seen.at(-1)), JSON.stringify({ type: 'route', childId: 'x', revision: 2 }));
  es.onmessage({ data: 'not-json' });
  assert.equal(seen.length, 2, 'garbage frames are dropped');

  // Three consecutive hard failures (browser gave up: CLOSED), each followed
  // by a manual retry. The failure count must SURVIVE retries — that is what
  // makes the ladder reachable — and the third one degrades the page.
  for (let cycle = 0; cycle < 3; cycle++) {
    es.readyState = 2;
    es.onerror();
    assert.equal(es.closed, true, `failure ${cycle + 1}: the dead stream is torn down`);
    const queued = timers.filter(Boolean).length;
    assert.ok(queued >= 1, `failure ${cycle + 1}: a retry is scheduled`);
    fireTimer(timers.length - 1);
    if (cycle < 2) {
      assert.equal(FakeEventSource.instances.length, cycle + 2, `failure ${cycle + 1}: the retry reconnects`);
      es = FakeEventSource.instances.at(-1);
    }
  }
  assert.ok(client.liveRouteEventsSubscribe === client.liveRouteEventsSubscribe); // sanity: same realm
  const before = FakeEventSource.instances.length;
  const release2 = client.liveRouteEventsSubscribe(() => {});
  assert.equal(FakeEventSource.instances.length, before, 'a degraded page must not open new streams');
  release2();

  // The last scheduled retry is the upgrade attempt: it reconnects and a
  // successful open re-enables the stream and resyncs the page.
  const retryIndex = timers.length - 1;
  fireTimer(retryIndex);
  const upgraded = FakeEventSource.instances.at(-1);
  assert.ok(upgraded, 'the upgrade retry reconnects');
  const seenLen = seen.length;
  upgraded.onopen();
  assert.equal(seen.length, seenLen + 1, 'the upgrade resyncs');
  const before2 = FakeEventSource.instances.length;
  client.liveRouteEventsSubscribe(() => {});
  assert.equal(FakeEventSource.instances.length, before2,
    'the stream is a page singleton: a new subscriber shares it instead of opening a second one');

  release();
});

test('releasing the last listener closes the stream and clears its retry', () => {
  const { client, FakeEventSource, timers } = loadClient();
  const release = client.liveRouteEventsSubscribe(() => {});
  const es = FakeEventSource.instances[0];
  release();
  assert.equal(es.closed, true, 'the last release tears the stream down');
  assert.equal(timers.filter(Boolean).length, 0, 'no retry timer outlives the last listener');
});
