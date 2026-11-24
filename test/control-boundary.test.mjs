import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, pickGroupRoute } from '../lib/index.js';

// THE CONTROL BOUNDARY for the single-target write routes:
//   POST /subagent-role-router/select | /clear | /group
//
// These endpoints are loopback-only and carry no caller identity. The old
// `resolve()` helper fabricated an agent object from a session DIRECTORY, so a
// write could land on a non-live child — and the caller's `childId` was never
// checked for ownership at all. The boundary now is:
//
//   1. the id must name a LIVE agent whose durable header says origin=subagent
//      (a main agent, a folder, or a missing id is refused);
//   2. its parent comes from the request when supplied, otherwise from the
//      child's own durable `header.parentSession`;
//   3. the host's parent catalog must list that child as a DIRECT child of that
//      parent — "cannot verify" is refused, never guessed.

const config = {
  roleMode: false,
  failoverEnabled: false,
  injectRouteContext: true,
  models: [{ provider: 'p', model: 'a' }, { provider: 'q', model: 'b' }],
  coordinatorEnabled: true,
  coordinatorNoFallback: false,
  coordinatorUiModels: [{ provider: 'p', model: 'explore' }, { provider: 'q', model: 'b' }],
  coordinatorResearchModels: [{ provider: 'p', model: 'plan' }],
  coordinatorBackendModels: [],
  coordinatorDeliveryModels: []
};

function harness(options = {}) {
  const listeners = new Map();
  const cleanups = [];
  const routes = [];
  const agents = new Map();
  const children = options.children ?? [];
  const interruptCalls = [];

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
      if (key === 'llm' && options.catalog) return { listModels: async (provider) => options.catalog[provider] ?? [] };
      if (key === 'agents') return { get: (id) => agents.get(id) };
      // This is the catalog the write boundary reads. The rows come from the
      // registered agents' headers, exactly like the host's parent catalog.
      if (key === 'subagents' && options.withoutCatalog !== true) {
        return {
          ...(options.interrupt === undefined ? {} : {
            interrupt(id, authority) {
              interruptCalls.push([id, authority?.kind]);
              return options.interrupt(id, authority);
            }
          }),
          async listDescendants(root) {
            const forms = [root, root.startsWith('session-') ? root.slice(8) : 'session-' + root];
            const out = [];
            for (const [id, agent] of agents) {
              const header = agent.session?.header ?? {};
              if (header.origin !== 'subagent') continue;
              if (!forms.includes(header.parentSession)) continue;
              const known = children.find((row) => row.id === id);
              out.push({
                id,
                mode: known?.mode ?? 'continuable',
                label: header.label ?? id,
                parentId: header.parentSession,
                depth: 1
              });
            }
            return out;
          }
        };
      }
      return undefined;
    }
  };

  apply(ctx, config);

  async function call({ method = 'POST', path, body }) {
    const route = routes.find((entry) => entry.path === '/subagent-role-router');
    assert.ok(route, 'the plugin must claim /subagent-role-router');
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = {
      method,
      url: path,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
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

  function liveChild(id, route = { provider: 'p', model: 'a' }, header = {}) {
    const selects = [];
    const agent = {
      id,
      status: 'inactive',
      session: {
        header: { origin: 'subagent', label: id, parentSession: 'parent-1', ...header },
        requestContext: () => ({ ...route, contextWindow: 1000 }),
        requestHeader: () => ({ config: { ...route } }),
        snapshotEvents: () => []
      },
      model: { selects, select(selection) { selects.push({ ...selection }); } }
    };
    agents.set(id, agent);
    return agent;
  }

  return {
    ctx,
    agents,
    routes,
    interruptCalls,
    call,
    liveChild,
    dispose() { for (const fn of cleanups.reverse()) fn(); }
  };
}

// ── the live-child gate ────────────────────────────────────────────────────

test('a live child is writable, and the write is scoped to its verified parent', async () => {
  const h = harness();
  const child = h.liveChild('child-1');
  const selected = await h.call({
    path: '/subagent-role-router/select',
    body: { childId: 'child-1', provider: 'q', model: 'b' }
  });
  assert.equal(selected.status, 200);
  assert.equal(selected.body.ok, true);
  assert.deepEqual(child.model.selects, [{ provider: 'q', model: 'b' }]);

  // The shipped picker sends no parent; the header supplied the exact one, and
  // the host catalog confirmed membership.
  const cleared = await h.call({ path: '/subagent-role-router/clear', body: { childId: 'child-1' } });
  assert.equal(cleared.body.ok, true);
  assert.equal(cleared.body.value.override, null);
  h.dispose();
});

test('a non-live id is refused: a session directory is storage, not authority', async () => {
  const h = harness();
  // No live agent at all. The old resolver looked for `.dsh/sessions/<ws>/<id>`
  // and fabricated an agent object from it; that path is gone for writes.
  const selected = await h.call({ path: '/subagent-role-router/select', body: { childId: 'ghost', provider: 'q', model: 'b' } });
  assert.equal(selected.body.ok, false);
  assert.equal(selected.body.error.code, 'not-live');
  assert.equal(h.agents.has('ghost'), false);
  h.dispose();
});

test('a live main agent is not a child and is refused on every write route', async () => {
  const h = harness();
  h.agents.set('main-1', {
    id: 'main-1',
    session: { header: { origin: 'main', id: 'main-1' }, requestContext: () => ({}) }
  });
  for (const [path, body] of [
    ['/subagent-role-router/select', { childId: 'main-1', provider: 'q', model: 'b' }],
    ['/subagent-role-router/clear', { childId: 'main-1' }],
    ['/subagent-role-router/group', { childId: 'main-1', group: 'ui' }]
  ]) {
    const answer = await h.call({ path, body });
    assert.equal(answer.body.ok, false, `${path} must refuse a live main agent`);
    assert.equal(answer.body.error.code, 'not-child', 'the refusal names the live-not-child case');
  }
  h.dispose();
});

test('an unverifiable write is refused instead of guessed at', async () => {
  // The child names no parent (a legacy/foreign object), and the caller supplied
  // none: there is nothing to verify against.
  const h = harness();
  h.liveChild('child-2', { provider: 'p', model: 'a' }, { parentSession: undefined });
  const selected = await h.call({ path: '/subagent-role-router/select', body: { childId: 'child-2', provider: 'q', model: 'b' } });
  assert.equal(selected.body.ok, false);
  assert.equal(selected.body.error.code, 'unverifiable');
  h.dispose();
});

test('a host without the parent catalog cannot verify, so it refuses', async () => {
  const h = harness({ withoutCatalog: true });
  h.liveChild('child-3');
  const selected = await h.call({
    path: '/subagent-role-router/select',
    body: { childId: 'child-3', provider: 'q', model: 'b', parentSessionId: 'parent-1' }
  });
  assert.equal(selected.body.ok, false);
  assert.equal(selected.body.error.code, 'unverifiable');
  h.dispose();
});

test('a supplied parentSessionId is enforced, not decorative', async () => {
  const h = harness();
  h.liveChild('child-4', { provider: 'p', model: 'a' }, { parentSession: 'parent-2' });
  const answer = await h.call({
    path: '/subagent-role-router/select',
    body: { childId: 'child-4', provider: 'q', model: 'b', parentSessionId: 'parent-1' }
  });
  assert.equal(answer.body.ok, false);
  assert.equal(answer.body.error.code, 'not-owned');
  h.dispose();
});

test('a non-string parentSessionId is a bad request', async () => {
  const h = harness();
  h.liveChild('child-5');
  const answer = await h.call({
    path: '/subagent-role-router/select',
    body: { childId: 'child-5', provider: 'q', model: 'b', parentSessionId: 7 }
  });
  assert.equal(answer.status, 400);
  assert.equal(answer.body.error.code, 'bad-request');
  h.dispose();
});

// ── group / ungroup ────────────────────────────────────────────────────────

test('grouping applies the verified list head and records the parent', async () => {
  const h = harness();
  const child = h.liveChild('child-6');
  const grouped = await h.call({ path: '/subagent-role-router/group', body: { childId: 'child-6', group: 'ui' } });
  assert.equal(grouped.body.ok, true);
  assert.deepEqual(grouped.body.target, { provider: 'p', model: 'explore' });
  assert.equal(grouped.body.parentSessionId, 'parent-1');
  assert.deepEqual(child.model.selects.at(-1), { provider: 'p', model: 'explore' });
  h.dispose();
});

test('ungrouping clears the override AND moves the child to the general next choice', async () => {
  const h = harness();
  const child = h.liveChild('child-7');
  await h.call({ path: '/subagent-role-router/group', body: { childId: 'child-7', group: 'ui' } });
  assert.deepEqual(child.model.selects.at(-1), { provider: 'p', model: 'explore' });

  const ungrouped = await h.call({ path: '/subagent-role-router/group', body: { childId: 'child-7', group: '' } });
  assert.equal(ungrouped.body.ok, true);
  assert.equal(ungrouped.body.group, null);
  // The coordinator override (p/explore) is gone: this child is an ordinary
  // child again, so it must run on the general pool's next choice, not on a
  // reserved route nobody owns any more.
  assert.deepEqual(ungrouped.body.target, { provider: 'p', model: 'a' });
  assert.deepEqual(ungrouped.body.value.override, { provider: 'p', model: 'a' });
  assert.deepEqual(child.model.selects.at(-1), { provider: 'p', model: 'a' });

  const batch = await h.call({ method: 'GET', path: '/subagent-role-router/batch?parentSessionId=parent-1' });
  assert.ok(batch.body.ok);
  assert.equal(batch.body.value.children[0].override.provider, 'p');
  h.dispose();
});

// ── the stop boundary ──────────────────────────────────────────────────────

test('the stop endpoint presents an exact live ancestor and nothing else', async () => {
  const h = harness({ interrupt: () => undefined });
  h.liveChild('child-10');
  h.agents.set('parent-1', { id: 'parent-1', session: { header: { origin: 'main', id: 'parent-1' } } });
  const stopped = await h.call({
    path: '/subagent-role-router/stop',
    body: { childId: 'child-10', parentSessionId: 'parent-1' }
  });
  assert.equal(stopped.body.ok, true, 'a verified resident descendant is interrupted');
  assert.deepEqual(h.interruptCalls, [['child-10', 'ancestor']]);
  assert.equal(stopped.body.value.attempts[0].authority, 'ancestor');
  h.dispose();
});

test('the stop endpoint refuses an unverifiable target instead of claiming success', async () => {
  const h = harness({ interrupt: () => undefined });
  h.liveChild('child-11');
  // The parent conversation agent is NOT live, so no ancestor authority exists.
  const stopped = await h.call({
    path: '/subagent-role-router/stop',
    body: { childId: 'child-11', parentSessionId: 'parent-1' }
  });
  assert.equal(stopped.body.ok, false, 'a no-op must not be reported as a stop');
  assert.equal(stopped.body.error.code, 'no-live-ancestor');
  assert.equal(h.interruptCalls.length, 0, 'nothing was handed to the host');
  h.dispose();
});

test('the stop endpoint refuses a child that is not the named parent\'s', async () => {
  const h = harness({ interrupt: () => undefined });
  h.liveChild('child-12', { provider: 'p', model: 'a' }, { parentSession: 'parent-2' });
  h.agents.set('parent-1', { id: 'parent-1', session: { header: { origin: 'main', id: 'parent-1' } } });
  const stopped = await h.call({
    path: '/subagent-role-router/stop',
    body: { childId: 'child-12', parentSessionId: 'parent-1' }
  });
  assert.equal(stopped.body.ok, false);
  assert.equal(stopped.body.error.code, 'not-owned');
  assert.equal(h.interruptCalls.length, 0);
  h.dispose();
});

// ── noFallback ─────────────────────────────────────────────────────────────

test('noFallback takes the list head even while it cools; a dead head is still skipped', () => {
  const ctx = { logger: { warn: () => {} } };
  const section = {
    coordinatorUiModels: [{ provider: 'p', model: 'explore' }, { provider: 'q', model: 'b' }],
    coordinatorNoFallback: true
  };
  const coolingHead = new Map([['ui\u0000p/explore', { until: Date.now() + 60_000, strikes: 1, at: Date.now(), minutes: 1 }]]);
  const state = { getSection: () => section, coordCooldown: coolingHead, birthCatalog: null };
  assert.deepEqual(pickGroupRoute(ctx, state, 'ui'), { provider: 'p', model: 'explore' },
    'the head is taken even though it is cooling');

  // ...but "the head" never means a route the provider retired.
  const deadCatalog = { map: new Map([['p', new Set(['a'])]]), at: Date.now() };
  const deadState = { getSection: () => section, coordCooldown: new Map(), birthCatalog: deadCatalog };
  assert.deepEqual(pickGroupRoute(ctx, deadState, 'ui'), { provider: 'q', model: 'b' },
    'a provably dead head is skipped, not presented as the head');
});

test('without noFallback a cooling head is skipped for the first ready row', () => {
  const ctx = { logger: { warn: () => {} } };
  const section = {
    coordinatorUiModels: [{ provider: 'p', model: 'explore' }, { provider: 'q', model: 'b' }],
    coordinatorNoFallback: false
  };
  const state = {
    getSection: () => section,
    coordCooldown: new Map([['ui\u0000p/explore', { until: Date.now() + 60_000, strikes: 1, at: Date.now(), minutes: 1 }]]),
    birthCatalog: null
  };
  assert.deepEqual(pickGroupRoute(ctx, state, 'ui'), { provider: 'q', model: 'b' });
});

test('a live write with no remaining served model never selects a known-dead route', async (t) => {
  const h = harness({ catalog: { p: [{ id: 'different' }], q: [{ id: 'different' }] } });
  t.after(() => h.dispose());
  const child = h.liveChild('retired-child');
  for (let i = 0; i < 24; i += 1) await Promise.resolve();
  const answer = await h.call({ path: '/subagent-role-router/select', body: { childId: 'retired-child', provider: 'p', model: 'a' } });
  assert.deepEqual(child.model.selects, [], 'known-dead routes must never reach model.select');
  assert.equal(answer.body.applied, false, 'a refused selection cannot claim application');
});
