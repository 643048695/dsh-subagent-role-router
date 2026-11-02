import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, hostModelPool, batchModelCatalog, effectiveRouteOf, strictChildrenOf } from '../lib/index.js';

// Batch model/effort switching for the DIRECT children of one conversation.
//
// This surface is the first one that WRITES a route for a child the caller only
// NAMED, so the tests below are mostly about what must be refused:
//
//   * membership comes from the host's catalog (`subagents.listChildren`) and
//     from nowhere else — a child of another conversation, a main agent, an
//     id the catalog never returned, and a host without the service must all be
//     refused rather than guessed at;
//   * an ended/exempt child is listed but not writable, and a batch with one bad
//     item still applies its siblings;
//   * the model list is the page's own configuration (deduplicated, with the
//     sources and configured efforts kept), and an effort the provider does not
//     offer is refused instead of silently becoming "default".

const config = {
  provider: 'p',
  model: 'a',
  reasoningEffort: 'low',
  roleMode: true,
  exploreProvider: 'p', exploreModel: 'explore',
  planProvider: 'p', planModel: 'plan',
  patchProvider: 'p', patchModel: 'a',
  teamModelProvider: 't', teamModelName: 'tm', teamModelEffort: 'deep',
  injectRouteContext: false,
  failoverEnabled: false,
  models: [
    { provider: 'p', model: 'a' },
    { provider: 'q', model: 'b' },
    { provider: 'p', model: 'a', reasoningEffort: 'high' }
  ],
  exemptRules: [{ pattern: 'keep-', match: 'label' }]
};

/**
 * What `llm.listModels(provider)` really sends: `{ provider, id, name, description }`
 * and NO reasoning block. The earlier fixture put `reasoning.efforts` here, which
 * no host ever does — and that let a real bug (reading efforts off the list) pass.
 */
const LISTED = {
  p: [
    { provider: 'p', id: 'a', name: 'Alpha', description: 'the default one' },
    { provider: 'p', id: 'explore', name: 'Explore Pro' },
    { provider: 'p', id: 'plan', name: 'Plan Pro' }
  ],
  q: [{ provider: 'q', id: 'b', name: 'Bravo' }],
  t: [{ provider: 't', id: 'tm', name: 'Team Model' }]
};

/**
 * What `llm.resolveModelInfo(provider, model)` answers — the ONLY place
 * strengths live, named by `name` (not `label`). `t/tm` deliberately has no
 * `reasoning` block at all: a provider that reports none offers none.
 */
const INFO = {
  'p/a': {
    provider: 'p',
    id: 'a',
    name: 'Alpha',
    reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High', description: 'more thinking' }] }
  },
  'p/explore': { provider: 'p', id: 'explore', name: 'Explore Pro', reasoning: { efforts: [] } },
  'p/plan': { provider: 'p', id: 'plan', name: 'Plan Pro' },
  'q/b': { provider: 'q', id: 'b', name: 'Bravo', reasoning: { efforts: [{ id: 'medium', name: 'Medium' }] } },
  't/tm': { provider: 't', id: 'tm', name: 'Team Model' }
};

/**
 * A live child agent whose committed request is `route`.
 *
 * `status` mirrors the host's own listing code: `'running'` mid-turn and
 * `'inactive'` between turns are BOTH resident, so both stay writable.
 */
function liveChild(id, route, label = id, status = 'inactive') {
  return {
    id,
    status,
    session: {
      header: { origin: 'subagent', label },
      requestContext: () => ({ ...route, contextWindow: 1000 }),
      requestHeader: () => ({ config: { ...route } }),
      snapshotEvents: () => []
    }
  };
}

/** A main (non-child) agent: it must never be writable through this surface. */
function mainAgent(id) {
  return {
    id,
    session: {
      header: { origin: 'main', label: id },
      requestContext: () => ({ provider: 'p', model: 'a' }),
      requestHeader: () => ({ config: { provider: 'p', model: 'a' } }),
      snapshotEvents: () => []
    }
  };
}

function harness(options = {}) {
  const settings = options.settings ?? config;
  const cleanups = [];
  const routes = [];
  const listCalls = [];
  const modelCalls = [];
  const infoCalls = [];
  const agents = new Map();
  for (const [id, route, label, status] of options.live ?? []) agents.set(id, liveChild(id, route, label, status));
  for (const id of options.mains ?? []) agents.set(id, mainAgent(id));
  const children = options.children ?? [];
  const listChildren = options.listChildren ?? (async (parentSessionId) => {
    listCalls.push(parentSessionId);
    return children;
  });
  const llm = options.withoutCatalog
    ? undefined
    : {
      async listModels(provider) {
        modelCalls.push(provider);
        if (options.throwCatalog === provider) throw new Error('catalog down');
        return LISTED[provider] ?? [];
      },
      async resolveModelInfo(provider, model) {
        const key = `${provider}/${model}`;
        infoCalls.push(key);
        if (options.throwCatalog === provider || options.throwInfo === key) throw new Error('catalog down');
        return INFO[key] ?? { provider, id: model, name: model };
      }
    };
  const subagents = options.withoutCatalog ? undefined : { listChildren };

  const listeners = new Map();
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
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
      if (!names.includes('webServer')) return;
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
    },
    get(key) {
      if (key === 'agents') return { get: (id) => agents.get(id) };
      if (key === 'subagents') return subagents;
      if (key === 'llm') return llm;
      return undefined;
    }
  };

  apply(ctx, settings);

  /** Drive the plugin's own HTTP route the way the web server would. */
  async function call({ method = 'GET', path, body, remote = '127.0.0.1', contentType = 'application/json' }) {
    const route = routes.find((entry) => entry.path === '/subagent-router');
    assert.ok(route, 'the plugin must claim /subagent-router');
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = {
      method,
      url: path,
      headers: body === undefined ? {} : { 'content-type': contentType },
      socket: { remoteAddress: remote },
      on(event, fn) {
        if (event === 'data' && payload !== '') queueMicrotask(() => fn(Buffer.from(payload)));
        if (event === 'end') queueMicrotask(() => fn());
        return req;
      },
      destroy() {}
    };
    const captured = { status: 0, body: null };
    const res = {
      writeHead(status) { captured.status = status; },
      end(text) { captured.body = text === undefined ? null : JSON.parse(text); }
    };
    await route.handler(req, res);
    return captured;
  }

  const batch = (parentSessionId) => call({ path: `/subagent-router/batch?parentSessionId=${encodeURIComponent(parentSessionId)}` });
  const select = (parentSessionId, selections) => call({ method: 'POST', path: '/subagent-router/batch/select', body: { parentSessionId, selections } });
  const clear = (parentSessionId, childIds) => call({ method: 'POST', path: '/subagent-router/batch/clear', body: { parentSessionId, childIds } });

  /** Run the `agent/request` waterfall exactly the way the host does. */
  async function request(payload, value) {
    const list = listeners.get('agent/request') ?? [];
    const run = (i) => (i === list.length ? Promise.resolve(value) : list[i](payload, () => run(i + 1)));
    return run(0);
  }

  return {
    batch,
    select,
    clear,
    call,
    request,
    listCalls,
    modelCalls,
    infoCalls,
    agent: (id) => agents.get(id),
    dispose: () => { for (const off of cleanups.splice(0)) off(); }
  };
}

// ── the model list ─────────────────────────────────────────────────────────

test('the model list is the page configuration, deduplicated, with sources kept', () => {
  const pool = hostModelPool(config);
  const keys = pool.map((row) => `${row.provider}/${row.model}`);
  assert.deepEqual(keys, ['p/a', 'q/b', 'p/explore', 'p/plan', 't/tm'], 'each provider/model appears once, in page order');
  const alpha = pool[0];
  assert.deepEqual(alpha.sources, ['base', 'single', 'role:patch'], 'every source that named the route is kept');
  assert.deepEqual(alpha.configuredEfforts, ['high', 'low'], 'configured efforts from all sources are merged');
  const team = pool.at(-1);
  assert.deepEqual(team.sources, ['team']);
  assert.deepEqual(team.configuredEfforts, ['deep']);
});

test('the catalog fills display names and effort labels, and degrades to unknown', async () => {
  const h = harness({ children: [{ id: 'abc', mode: 'continuable' }] });
  const { status, body } = await h.batch('parent-1');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const rows = body.value.models;
  const alpha = rows.find((row) => row.provider === 'p' && row.model === 'a');
  assert.equal(alpha.displayName, 'Alpha');
  assert.equal(alpha.capabilityKnown, true);
  const effortIds = alpha.efforts.map((entry) => entry.id).sort();
  assert.deepEqual(effortIds, ['high', 'low'], 'the strengths are the ones the provider reports');
  const high = alpha.efforts.find((entry) => entry.id === 'high');
  assert.equal(high.label, 'High', 'the display name comes from `name`, which is the field the host sends');
  assert.equal(high.description, 'more thinking');
  assert.equal(high.source, 'catalog');
  assert.equal(high.configured, true, 'a catalog strength this page also pins is marked as configured');
  const bravo = rows.find((row) => row.model === 'b');
  assert.deepEqual(bravo.efforts.map((entry) => entry.id), ['medium']);
  const team = rows.find((row) => row.provider === 't');
  assert.equal(team.capabilityKnown, true);
  assert.deepEqual(team.efforts, [], 'the provider reports no strengths, so none are offered — a page pin is not evidence');
  assert.deepEqual(team.configuredEfforts, ['deep'], 'the pinned strength is still reported as a pin');
  const plan = rows.find((row) => row.model === 'plan');
  assert.equal(plan.displayName, 'Plan Pro', 'an info without a reasoning block still names the model');
  assert.deepEqual(plan.efforts, []);
  h.dispose();
});

test('batchModelCatalog keeps configured efforts when the catalog cannot answer', () => {
  const rows = batchModelCatalog(config, new Map());
  const alpha = rows.find((row) => row.model === 'a');
  assert.equal(alpha.capabilityKnown, false);
  assert.deepEqual(alpha.efforts.map((entry) => entry.id), ['high', 'low'], 'the user config is still authoritative about its own pin');
  assert.deepEqual(alpha.efforts.map((entry) => entry.source), ['config', 'config']);
});

test('a provider is asked once per provider and once per model, then cached', async () => {
  const h = harness({ children: [{ id: 'abc', mode: 'continuable' }] });
  await h.batch('parent-1');
  assert.deepEqual(h.modelCalls.slice().sort(), ['p', 'q', 't'], 'one list call per configured provider');
  assert.deepEqual(
    h.infoCalls.slice().sort(),
    ['p/a', 'p/explore', 'p/plan', 'q/b', 't/tm'],
    'the strengths are asked for per model, which is the only call that reports them'
  );
  const before = [h.modelCalls.length, h.infoCalls.length];
  await h.batch('parent-1');
  assert.deepEqual([h.modelCalls.length, h.infoCalls.length], before, 'the second read is served from the cache');
  h.dispose();
});

test('a provider whose catalog throws is unknown, not fatal', async () => {
  const h = harness({ children: [{ id: 'abc', mode: 'continuable' }], throwCatalog: 'q' });
  const { body } = await h.batch('parent-1');
  assert.equal(body.ok, true);
  const bravo = body.value.models.find((row) => row.model === 'b');
  assert.equal(bravo.capabilityKnown, false);
  assert.deepEqual(bravo.efforts, [], 'nothing is invented for the broken provider');
  h.dispose();
});

test('an idle resident child stays writable; a closing or vanished one does not', async () => {
  const h = harness({
    children: [
      { id: 'idle', mode: 'continuable' },
      { id: 'closing', mode: 'continuable' },
      { id: 'gone', mode: 'continuable' }
    ],
    live: [
      ['idle', { provider: 'p', model: 'a' }, 'idle-1', 'inactive'],
      ['closing', { provider: 'p', model: 'a' }, 'closing-1', 'disposed']
    ]
  });
  const { body } = await h.batch('parent-1');
  const byId = new Map(body.value.children.map((row) => [row.childId, row]));
  assert.equal(byId.get('idle').selectable, true, 'inactive means between turns, not ended');
  assert.equal(byId.get('idle').activity, 'inactive');
  assert.equal(byId.get('closing').reason, 'ending');
  assert.equal(byId.get('closing').selectable, false);
  assert.equal(byId.get('gone').reason, 'unverified');
  const written = await h.select('parent-1', [{ childId: 'closing', provider: 'q', model: 'b' }]);
  assert.equal(written.body.value.results[0].error.code, 'ending');
  h.dispose();
});

// ── membership: only the host's catalog may grant it ────────────────────────

test('the child list is the host catalog for THIS parent, and nothing else', async () => {
  const h = harness({
    children: [
      { id: 'abc', mode: 'continuable', label: 'explore-1' },
      { id: 'ghost', mode: 'continuable' }
    ],
    live: [['abc', { provider: 'p', model: 'a' }, 'explore-1']]
  });
  const { body } = await h.batch('parent-1');
  assert.deepEqual(h.listCalls, ['parent-1'], 'the host is asked about exactly one parent');
  assert.deepEqual(body.value.children.map((row) => row.childId), ['abc', 'ghost']);
  const abc = body.value.children[0];
  assert.equal(abc.selectable, true);
  assert.equal(abc.live, true);
  assert.equal(abc.provider, 'p');
  const ghost = body.value.children[1];
  assert.equal(ghost.selectable, false, 'a child the registry no longer has cannot be confirmed as writable');
  assert.equal(ghost.reason, 'unverified');
  assert.equal(ghost.live, false);
  assert.equal(ghost.activity, 'gone');
  assert.equal(ghost.actual, null, 'no live request means no actual route — not an invented one');
  assert.equal(ghost.provider, '', 'an idle child has no live route to report');
  h.dispose();
});

test('a host without the catalog service refuses instead of guessing', async () => {
  const h = harness({ withoutCatalog: true });
  const read = await h.batch('parent-1');
  assert.equal(read.status, 200);
  assert.equal(read.body.ok, false);
  assert.equal(read.body.error.code, 'catalog-unavailable');
  const write = await h.select('parent-1', [{ childId: 'abc', provider: 'p', model: 'a' }]);
  assert.equal(write.body.ok, false);
  assert.equal(write.body.error.code, 'catalog-unavailable', 'the write is refused for the same reason as the read');
  h.dispose();
});

test('a catalog that throws is reported, not translated into an empty list', async () => {
  const h = harness({ listChildren: async () => { throw new Error('projection missing'); } });
  const { body } = await h.batch('parent-1');
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'catalog-unavailable');
  assert.match(body.error.message, /projection missing/);
  h.dispose();
});

test('a missing parent session id is a bad request, on read and on write', async () => {
  const h = harness({ children: [] });
  const read = await h.call({ path: '/subagent-router/batch' });
  assert.equal(read.status, 400);
  assert.equal(read.body.error.code, 'bad-request');
  const write = await h.select('   ', [{ childId: 'abc', provider: 'p', model: 'a' }]);
  assert.equal(write.status, 400);
  h.dispose();
});

test('an id the catalog never returned is not owned — even when it is live', async () => {
  const h = harness({
    children: [{ id: 'abc', mode: 'continuable' }],
    live: [['abc', { provider: 'p', model: 'a' }], ['main-1', { provider: 'p', model: 'a' }]],
    mains: ['main-1']
  });
  const ghost = await h.select('parent-1', [{ childId: 'ghost', provider: 'q', model: 'b' }]);
  assert.equal(ghost.body.value.results[0].ok, false);
  assert.equal(ghost.body.value.results[0].error.code, 'not-owned');
  const main = await h.select('parent-1', [{ childId: 'main-1', provider: 'q', model: 'b' }]);
  assert.equal(main.body.value.results[0].error.code, 'not-owned', 'a main agent is never a child of this parent');
  h.dispose();
});

test('ids are normalised in both spellings before and after the write', async () => {
  const h = harness({
    children: [{ id: 'abc', mode: 'continuable' }],
    live: [['abc', { provider: 'p', model: 'a' }]]
  });
  const written = await h.select('parent-1', [{ childId: 'session-abc', provider: 'q', model: 'b', reasoningEffort: 'medium' }]);
  assert.equal(written.body.value.results[0].ok, true);
  const read = await h.batch('parent-1');
  const row = read.body.value.children[0];
  assert.deepEqual(row.override, { provider: 'q', model: 'b', reasoningEffort: 'medium' });
  assert.equal(row.pending, true, 'the child has not adopted the override yet');
  assert.equal(row.provider, 'p', 'the live pair is still reported separately');
  assert.deepEqual(row.actual, { provider: 'p', model: 'a', reasoningEffort: '' }, 'actual stays actual, with no override mixed in');
  assert.deepEqual(row.pendingRoute, { provider: 'q', model: 'b', reasoningEffort: 'medium' }, 'what the next request will use is a separate field');
  const cleared = await h.clear('parent-1', ['abc']);
  assert.equal(cleared.body.value.results[0].ok, true);
  const after = await h.batch('parent-1');
  assert.equal(after.body.value.children[0].override, null, 'one spelling is enough to clear every spelling');
  h.dispose();
});

test('strictChildrenOf normalises parent session ID double-spelling when host only accepts session- prefix', async () => {
  const BARE = '968fa2ba-b30c-4726-a8fc-3834503e5464';
  const PREFIXED = `session-${BARE}`;
  // 78 children, matching the creator's real-world reproduction environment
  const children = Array.from({ length: 78 }, (_, i) => ({
    id: `child-${i + 1}`,
    mode: 'continuable',
    label: `worker-${i + 1}`
  }));
  const calls = [];
  const h = harness({
    children,
    live: children.map((c) => [c.id, { provider: 'p', model: 'a' }]),
    listChildren: async (parentSessionId) => {
      calls.push(parentSessionId);
      // Simulate host sessionQuery behavior: bare UUID throws not found, prefixed succeeds
      if (!parentSessionId.startsWith('session-')) {
        throw new Error(`catalog-unavailable: session "${parentSessionId}" not found`);
      }
      return children;
    }
  });

  // 1. Calling with bare UUID:
  // First attempt (bare) fails with 'session not found', falls back to prefixed and succeeds.
  calls.length = 0;
  const resBare = await h.call({
    method: 'GET',
    path: `/subagent-router/batch?parentSessionId=${BARE}`
  });
  assert.equal(resBare.status, 200);
  assert.equal(resBare.body.ok, true);
  assert.equal(resBare.body.value.children.length, 78);
  assert.deepEqual(calls, [BARE, PREFIXED], 'tried original bare first, then session- prefix on not found');

  // 2. Calling with prefixed ID:
  // First attempt (prefixed) succeeds directly; no redundant fallback retry.
  calls.length = 0;
  const resPrefixed = await h.call({
    method: 'GET',
    path: `/subagent-router/batch?parentSessionId=${PREFIXED}`
  });
  assert.equal(resPrefixed.status, 200);
  assert.equal(resPrefixed.body.ok, true);
  assert.equal(resPrefixed.body.value.children.length, 78);
  assert.deepEqual(calls, [PREFIXED], 'prefixed call hits directly without retry');

  // 3. Both forms return identical direct children
  assert.deepEqual(resBare.body.value.children, resPrefixed.body.value.children);

  // 4. When both candidate spellings fail, catalog-unavailable error is cleanly returned
  const hFailing = harness({
    listChildren: async (parentSessionId) => {
      throw new Error(`session "${parentSessionId}" not found`);
    }
  });
  const resFail = await hFailing.call({
    method: 'GET',
    path: `/subagent-router/batch?parentSessionId=${BARE}`
  });
  assert.equal(resFail.status, 200);
  assert.equal(resFail.body.ok, false);
  assert.equal(resFail.body.error.code, 'catalog-unavailable');
  assert.match(resFail.body.error.message, /not found/);

  h.dispose();
  hFailing.dispose();
});

// ── which children may be written ──────────────────────────────────────────

test('ended, external, unknown-mode and exempt children are listed but not writable', async () => {
  const h = harness({
    children: [
      { id: 'ended', mode: 'one-shot' },
      { id: 'ext', mode: 'external' },
      { id: 'myst', mode: 'unknown' },
      { id: 'keep-1', mode: 'continuable', label: 'keep-1' }
    ]
  });
  const { body } = await h.batch('parent-1');
  const byId = new Map(body.value.children.map((row) => [row.childId, row]));
  assert.equal(byId.get('ended').reason, 'ended');
  assert.equal(byId.get('ext').reason, 'external');
  assert.equal(byId.get('myst').reason, 'unknown-mode');
  assert.equal(byId.get('keep-1').reason, 'exempt', 'the exemption rule matches the catalog label');
  for (const row of byId.values()) assert.equal(row.selectable, false);

  const written = await h.select('parent-1', [
    { childId: 'ended', provider: 'p', model: 'a' },
    { childId: 'keep-1', provider: 'p', model: 'a' },
    { childId: 'ext', provider: 'p', model: 'a' }
  ]);
  assert.deepEqual(written.body.value.results.map((row) => row.error.code), ['ended', 'exempt', 'external']);
  h.dispose();
});

test('one bad selection does not stop its siblings, and the summary counts both', async () => {
  const h = harness({
    children: [
      { id: 'abc', mode: 'continuable' },
      { id: 'ended', mode: 'one-shot' }
    ],
    live: [['abc', { provider: 'p', model: 'a' }]]
  });
  const { status, body } = await h.select('parent-1', [
    { childId: 'ended', provider: 'q', model: 'b' },
    { childId: 'ghost', provider: 'q', model: 'b' },
    { childId: 'abc', provider: 'q', model: 'b' }
  ]);
  assert.equal(status, 200, 'partial success is still a served request');
  assert.equal(body.ok, true);
  assert.deepEqual(body.value.results.map((row) => row.ok), [false, false, true]);
  assert.deepEqual(body.value.summary, { total: 3, ok: 1, failed: 2 });
  h.dispose();
});

// ── the write itself ───────────────────────────────────────────────────────

test('an unconfigured model is refused; a configured one is applied', async () => {
  const h = harness({ children: [{ id: 'abc', mode: 'continuable' }], live: [['abc', { provider: 'p', model: 'a' }]] });
  const bad = await h.select('parent-1', [{ childId: 'abc', provider: 'x', model: 'y' }]);
  assert.equal(bad.body.value.results[0].error.code, 'model-not-allowed');
  const good = await h.select('parent-1', [{ childId: 'abc', provider: 'q', model: 'b', reasoningEffort: 'medium' }]);
  const row = good.body.value.results[0];
  assert.equal(row.ok, true);
  assert.deepEqual(row.route, { provider: 'q', model: 'b', reasoningEffort: 'medium' });
  assert.equal(row.pending, true, 'set is reported as set, not as running on it');
  h.dispose();
});

test('an effort the model does not offer is refused instead of silently defaulting', async () => {
  const h = harness({ children: [{ id: 'abc', mode: 'continuable' }], live: [['abc', { provider: 'p', model: 'a' }]] });
  const bad = await h.select('parent-1', [{ childId: 'abc', provider: 'p', model: 'a', reasoningEffort: 'ultra' }]);
  assert.equal(bad.body.value.results[0].error.code, 'effort-unknown');
  const typed = await h.select('parent-1', [{ childId: 'abc', provider: 'p', model: 'a', reasoningEffort: 7 }]);
  assert.equal(typed.body.value.results[0].error.code, 'bad-request');
  h.dispose();
});

test('a strength this page pins is refused once the provider says it offers none', async () => {
  const h = harness({ children: [{ id: 'abc', mode: 'continuable' }], live: [['abc', { provider: 'p', model: 'a' }]] });
  const refused = await h.select('parent-1', [{ childId: 'abc', provider: 't', model: 'tm', reasoningEffort: 'deep' }]);
  assert.equal(refused.body.value.results[0].error.code, 'effort-unknown', 'leftover configuration does not make a strength supported');
  const invented = await h.select('parent-1', [{ childId: 'abc', provider: 't', model: 'tm', reasoningEffort: 'warp' }]);
  assert.equal(invented.body.value.results[0].error.code, 'effort-unknown');
  h.dispose();
});

test('when the provider cannot answer, a configured pin is legal and an invented one is not', async () => {
  const h = harness({
    children: [{ id: 'abc', mode: 'continuable' }],
    live: [['abc', { provider: 'p', model: 'a' }]],
    throwInfo: 'p/a'
  });
  const pinned = await h.select('parent-1', [{ childId: 'abc', provider: 'p', model: 'a', reasoningEffort: 'high' }]);
  assert.equal(pinned.body.value.results[0].ok, true, 'the page pin is the only evidence there is');
  assert.equal(pinned.body.value.results[0].route.reasoningEffort, 'high');
  const invented = await h.select('parent-1', [{ childId: 'abc', provider: 'p', model: 'a', reasoningEffort: 'ultra' }]);
  assert.equal(invented.body.value.results[0].error.code, 'effort-unverified', 'an unverifiable strength is never written');
  h.dispose();
});

test('omitting the effort clears the old one instead of inheriting it', async () => {
  const h = harness({ children: [{ id: 'abc', mode: 'continuable' }], live: [['abc', { provider: 'p', model: 'a' }]] });
  await h.select('parent-1', [{ childId: 'abc', provider: 'q', model: 'b', reasoningEffort: 'medium' }]);
  const second = await h.select('parent-1', [{ childId: 'abc', provider: 'q', model: 'b' }]);
  assert.equal(second.body.value.results[0].override.reasoningEffort, undefined, 'no effort key is written at all');
  const explicitNull = await h.select('parent-1', [{ childId: 'abc', provider: 'q', model: 'b', reasoningEffort: null }]);
  assert.equal(explicitNull.body.value.results[0].ok, true);
  assert.equal(explicitNull.body.value.results[0].override.reasoningEffort, undefined);
  h.dispose();
});

test('keepModel changes only the effort, and refuses a model outside the page', async () => {
  const h = harness({
    children: [
      { id: 'abc', mode: 'continuable' },
      { id: 'def', mode: 'continuable' }
    ],
    live: [
      ['abc', { provider: 'q', model: 'b' }],
      ['def', { provider: 'elsewhere', model: 'z' }]
    ]
  });
  const kept = await h.select('parent-1', [{ childId: 'abc', keepModel: true, reasoningEffort: 'medium' }]);
  assert.equal(kept.body.value.results[0].ok, true);
  assert.deepEqual(kept.body.value.results[0].route, { provider: 'q', model: 'b', reasoningEffort: 'medium' });
  const refused = await h.select('parent-1', [{ childId: 'def', keepModel: true, reasoningEffort: 'medium' }]);
  assert.equal(refused.body.value.results[0].error.code, 'model-not-allowed', 'keepModel never smuggles in an unconfigured route');
  h.dispose();
});

test('keepEffort carries the strength already set, and cannot be combined with keepModel', async () => {
  const h = harness({ children: [{ id: 'abc', mode: 'continuable' }], live: [['abc', { provider: 'q', model: 'b' }]] });
  await h.select('parent-1', [{ childId: 'abc', provider: 'q', model: 'b', reasoningEffort: 'medium' }]);
  const kept = await h.select('parent-1', [{ childId: 'abc', keepEffort: true, provider: 'q', model: 'b' }]);
  assert.equal(kept.body.value.results[0].ok, true);
  assert.deepEqual(kept.body.value.results[0].route, { provider: 'q', model: 'b', reasoningEffort: 'medium' });
  const moved = await h.select('parent-1', [{ childId: 'abc', keepEffort: true, provider: 'p', model: 'a' }]);
  assert.equal(moved.body.value.results[0].error.code, 'effort-unknown',
    'a carried strength the new model does not offer is refused, not silently dropped to its default');
  const whatever = await h.select('parent-1', [{ childId: 'abc', keepEffort: true, keepModel: true }]);
  assert.equal(whatever.body.value.results[0].error.code, 'bad-request', 'both flags at once is a contradiction, not a preference');
  h.dispose();
});

test('the batch write lands in the very next request, and a default strength clears the old one', async () => {
  const h = harness({
    children: [{ id: 'abc', mode: 'continuable' }],
    live: [['abc', { provider: 'p', model: 'a', reasoningEffort: 'low' }]]
  });
  const selected = await h.select('parent-1', [{ childId: 'abc', provider: 'q', model: 'b', reasoningEffort: 'medium' }]);
  assert.equal(selected.body.value.results[0].ok, true);
  const agent = h.agent('abc');
  const first = await h.request({ agent }, { provider: 'p', model: 'a', reasoningEffort: 'low', maxTokens: 100 });
  assert.equal(first.provider, 'q');
  assert.equal(first.model, 'b');
  assert.equal(first.reasoningEffort, 'medium');
  assert.equal(first.maxTokens, 100, 'the rest of the request header survives untouched');
  const cleared = await h.select('parent-1', [{ childId: 'abc', provider: 'q', model: 'b' }]);
  assert.equal(cleared.body.value.results[0].ok, true);
  const second = await h.request({ agent }, { provider: 'p', model: 'a', reasoningEffort: 'low' });
  assert.equal(second.provider, 'q');
  assert.equal(second.reasoningEffort, undefined, 'asking for the default DELETES the inherited strength instead of keeping it');
  h.dispose();
});

test('the child of another conversation never sees this conversation\'s write', async () => {
  const h = harness({
    children: [{ id: 'abc', mode: 'continuable' }],
    live: [
      ['abc', { provider: 'p', model: 'a' }],
      ['other', { provider: 'p', model: 'a' }]
    ]
  });
  await h.select('parent-1', [{ childId: 'abc', provider: 'q', model: 'b' }]);
  const sibling = await h.request({ agent: h.agent('other') }, { provider: 'p', model: 'a' });
  assert.equal(sibling.provider, 'p', 'an override is keyed by child id, not by conversation');
  h.dispose();
});

test('a write for one child leaves its sibling untouched', async () => {
  const h = harness({
    children: [
      { id: 'a1', mode: 'continuable' },
      { id: 'a2', mode: 'continuable' }
    ],
    live: [
      ['a1', { provider: 'p', model: 'a' }],
      ['a2', { provider: 'p', model: 'a' }]
    ]
  });
  await h.select('parent-1', [{ childId: 'a1', provider: 'q', model: 'b' }]);
  const { body } = await h.batch('parent-1');
  const rows = new Map(body.value.children.map((row) => [row.childId, row]));
  assert.deepEqual(rows.get('a1').override, { provider: 'q', model: 'b' });
  assert.equal(rows.get('a2').override, null);
  h.dispose();
});

test('clear is ownership-checked and clears every spelling', async () => {
  const h = harness({ children: [{ id: 'abc', mode: 'continuable' }], live: [['abc', { provider: 'p', model: 'a' }]] });
  await h.select('parent-1', [{ childId: 'abc', provider: 'q', model: 'b' }]);
  const forged = await h.clear('parent-1', ['ghost']);
  assert.equal(forged.body.value.results[0].error.code, 'not-owned');
  const ok = await h.clear('parent-1', ['session-abc']);
  assert.equal(ok.body.value.results[0].ok, true);
  const { body } = await h.batch('parent-1');
  assert.equal(body.value.children[0].override, null);
  h.dispose();
});

test('empty selection and clear lists are bad requests', async () => {
  const h = harness({ children: [{ id: 'abc', mode: 'continuable' }] });
  const select = await h.select('parent-1', []);
  assert.equal(select.status, 400);
  const clear = await h.clear('parent-1', []);
  assert.equal(clear.status, 400);
  h.dispose();
});

// ── the fence ──────────────────────────────────────────────────────────────

test('the batch routes are loopback-only and JSON-only', async () => {
  const h = harness({ children: [{ id: 'abc', mode: 'continuable' }], live: [['abc', { provider: 'p', model: 'a' }]] });
  const remote = await h.call({ path: '/subagent-router/batch?parentSessionId=parent-1', remote: '10.0.0.5' });
  assert.equal(remote.status, 403);
  const wrongType = await h.call({ method: 'POST', path: '/subagent-router/batch/select', body: { parentSessionId: 'parent-1', selections: [] }, contentType: 'text/plain' });
  assert.equal(wrongType.status, 415);
  h.dispose();
});

// ── pure helpers ───────────────────────────────────────────────────────────

test('effectiveRouteOf prefers the pending override but never invents a model', () => {
  assert.deepEqual(
    effectiveRouteOf({ provider: 'p', model: 'a', reasoningEffort: 'low', override: null }),
    { provider: 'p', model: 'a', reasoningEffort: 'low' }
  );
  assert.deepEqual(
    effectiveRouteOf({ provider: 'p', model: 'a', reasoningEffort: 'low', override: { provider: 'q', model: 'b', reasoningEffort: 'medium' } }),
    { provider: 'q', model: 'b', reasoningEffort: 'medium' }
  );
  assert.deepEqual(
    effectiveRouteOf({ provider: '', model: '', reasoningEffort: '', override: { provider: 'q', model: 'b' } }),
    { provider: 'q', model: 'b', reasoningEffort: '' },
    'an override without an effort means default, not "keep the old effort"'
  );
});
