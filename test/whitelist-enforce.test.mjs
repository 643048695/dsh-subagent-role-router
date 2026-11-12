import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, pickWhitelistRoute, hostWhitelistModels } from '../lib/index.js';

// A route this page never listed must never reach a provider.
//
// THE BUG THIS FILE KEEPS DEAD: the page whitelist gated `/batch` and birth
// routing, but a pick made through the host's own model seat (or an older client
// POSTing `/select`) reached the child untouched — the access log showed a child
// really running `codex/gpt-6.1-sol` and then `gm4/gemini-4-carbon` on a page
// whose whitelist named neither. The fix is a SWITCH, not a refusal: store a
// whitelisted route and push it through the host's front door.
//
//   1. `pickWhitelistRoute` is the single decision point (unit-tested here).
//   2. `/select` answers with the route it actually applied (`substituted`).
//   3. The `agent/request` watcher catches the seat bypass: same seed object
//      handed back, the whitelisted route pushed onto the child.

const config = {
  roleMode: true,
  exploreProvider: 'p', exploreModel: 'explore',
  patchProvider: 'p', patchModel: 'general',
  planProvider: 'p', planModel: 'plan',
  injectRouteContext: false,
  failoverEnabled: false,
  models: [{ provider: 'p', model: 'a' }, { provider: 'q', model: 'b' }],
  roleSlotCooldownSeconds: 0
};

/** A page with nothing configured: no pool, no role, no team model. */
const bare = {
  roleMode: false,
  injectRouteContext: false,
  failoverEnabled: false,
  models: [],
  roleSlotCooldownSeconds: 0
};

function harness(settings = config) {
  const listeners = new Map();
  const cleanups = [];
  const routes = [];
  const warnings = [];
  const agents = new Map();
  let current = settings;

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
      return undefined;
    }
  };

  apply(ctx, current);

  /** Run the `agent/request` waterfall the way cordis does. */
  async function request(payload, value) {
    const list = listeners.get('agent/request') ?? [];
    const run = (i) => (i === list.length ? Promise.resolve(value) : list[i](payload, () => run(i + 1)));
    return run(0);
  }

  /** Drive the plugin's own HTTP route the way the web server would. */
  async function call({ method = 'POST', path, body, remote = '127.0.0.1' }) {
    const route = routes.find((entry) => entry.path === '/subagent-role-router');
    assert.ok(route, 'the plugin must claim /subagent-role-router');
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = {
      method,
      url: path,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
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

  /** A live continuable child with the host's front door recorded. */
  function liveChild(id) {
    const selects = [];
    const agent = {
      id,
      session: {
        header: { origin: 'subagent', label: id },
        requestContext: () => ({ provider: 'codex', model: 'gpt-6.1-sol', contextWindow: 1000 }),
        requestHeader: () => ({ config: { provider: 'codex', model: 'gpt-6.1-sol' } }),
        snapshotEvents: () => []
      },
      model: { selects, select(selection) { selects.push({ ...selection }); } },
      options: { provider: 'parent', model: 'parent' }
    };
    agents.set(id, agent);
    return agent;
  }

  return { ctx, agents, routes, warnings, request, call, liveChild, dispose() { for (const fn of cleanups.reverse()) fn(); } };
}

const childPayload = (agent) => ({ turn: 0, step: 0, agent });

// ── the decision point ─────────────────────────────────────────────────────

test('an approved route needs no substitute', () => {
  assert.equal(pickWhitelistRoute(config, { provider: 'p', model: 'a' }), null);
  assert.equal(pickWhitelistRoute(config, { provider: 'p', model: 'general' }), null, 'a role pool route counts as approved');
  assert.equal(pickWhitelistRoute(config, { provider: 'whatever', model: 'explore' }), null, 'the model name alone is enough (gateway aliases rename providers)');
  // A name the page never listed is switched even when no provider came with
  // it: "not on this page" is the whole test, and there is no guesswork in
  // picking the substitute (first route, or the asked provider's own entry).
  assert.deepEqual(pickWhitelistRoute(config, { provider: '', model: 'dnq' }), { provider: 'p', model: 'a' });
});

test('an unlisted route is switched inside its own provider first', () => {
  assert.deepEqual(pickWhitelistRoute(config, { provider: 'codex', model: 'gpt-6.1-sol' }), { provider: 'p', model: 'a' }, 'no codex entry -> the first route this page configures');
  assert.deepEqual(pickWhitelistRoute(config, { provider: 'q', model: 'nope' }), { provider: 'q', model: 'b' }, 'same provider stays available, so prefer it');
  assert.deepEqual(pickWhitelistRoute(config, { provider: 'Q', model: 'nope' }), { provider: 'q', model: 'b' }, 'provider match ignores case');
});

test('nothing configured and nothing asked are both pass-throughs', () => {
  assert.equal(pickWhitelistRoute(bare, { provider: 'codex', model: 'gpt-6.1-sol' }), null, 'no whitelist to switch to');
  assert.equal(pickWhitelistRoute(config, { provider: '', model: '' }), null, 'an empty pick must not invent a route');
  assert.equal(pickWhitelistRoute(undefined, { provider: 'codex', model: 'x' }), null);
  assert.deepEqual(hostWhitelistModels(bare), []);
});

// ── the endpoint ───────────────────────────────────────────────────────────

test('/select stores and applies the whitelisted route it substituted', async () => {
  const h = harness();
  const child = h.liveChild('child-1');
  const answer = await h.call({
    path: '/subagent-role-router/select',
    body: { childId: 'child-1', provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' }
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.ok, true);
  assert.deepEqual(answer.body.substituted, {
    from: { provider: 'codex', model: 'gpt-6.1-sol' },
    to: { provider: 'p', model: 'a' }
  });
  assert.deepEqual(answer.body.value.override, { provider: 'p', model: 'a' }, 'the override must be the route that will actually run');
  // Effort is dropped: `xhigh` belonged to the model being left behind.
  assert.deepEqual(child.model.selects, [{ provider: 'p', model: 'a' }], 'the switch goes through the host front door');
  h.dispose();
});

test('/select keeps an approved pick exactly as asked', async () => {
  const h = harness();
  const child = h.liveChild('child-1');
  const answer = await h.call({
    path: '/subagent-role-router/select',
    body: { childId: 'child-1', provider: 'q', model: 'b', reasoningEffort: 'low' }
  });
  assert.equal(answer.body.ok, true);
  assert.equal(answer.body.substituted, undefined, 'no substitution on an approved route');
  assert.deepEqual(answer.body.value.override, { provider: 'q', model: 'b', reasoningEffort: 'low' });
  assert.deepEqual(child.model.selects, [{ provider: 'q', model: 'b', reasoningEffort: 'low' }]);
  h.dispose();
});

// ── the seat bypass ────────────────────────────────────────────────────────

test('a request seeded with an unlisted route is switched, seed untouched', async () => {
  const h = harness();
  const child = h.liveChild('child-1');
  const seeded = { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh', maxTokens: 4096 };

  const back = await h.request(childPayload(child), seeded);
  assert.equal(back, seeded, 'the host throws when the waterfall rewrites the frozen seed');
  assert.equal(back.maxTokens, 4096);
  assert.deepEqual(child.model.selects, [{ provider: 'p', model: 'a' }], 'the whitelisted route is pushed onto the child instead');

  // Idempotent: once the seed caught up, the watcher stops pushing.
  await h.request(childPayload(child), { provider: 'p', model: 'a' });
  assert.equal(child.model.selects.length, 1, 'a child already on a whitelisted route must not be re-selected');
  h.dispose();
});

test('a request already on an approved route is left completely alone', async () => {
  const h = harness();
  const child = h.liveChild('child-1');
  const seeded = { provider: 'p', model: 'a' };
  assert.equal(await h.request(childPayload(child), seeded), seeded);
  assert.deepEqual(child.model.selects, []);
  h.dispose();
});

test('a page with no whitelist never touches a child', async () => {
  const h = harness(bare);
  const child = h.liveChild('child-1');
  const seeded = { provider: 'codex', model: 'gpt-6.1-sol' };
  assert.equal(await h.request(childPayload(child), seeded), seeded);
  assert.deepEqual(child.model.selects, [], 'no approved route exists, so there is nothing to switch to');
  h.dispose();
});
