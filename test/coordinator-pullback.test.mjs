import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

// THE "ctx IS NOT DEFINED" CRASH (live, 2026-11-24, session-7a929cab).
//
// A coordinator child ran `magpie-responses/codex/gpt-6.1-sol` while its list
// named `codex/gpt-6.2-sol` (retired at the gateway). The pull-back path ran —
// and died on the first substitution: `ensureCoordinatorRoute` used `ctx`
// without receiving it, so EVERY such child failed at its first step with
// `ReferenceError: ctx is not defined`, 7ms after model selection, before any
// request. The build task survived only because it was already past step 1;
// the upload task, born after the reload, died exactly like that.
//
// The stack (captured by the error journal, not by the host) pointed here:
//   at ensureCoordinatorRoute (lib/index.js:3715)
//   at async Object.<anonymous> (lib/index.js:3754)
//   ... at async ReactLoopAgent.prepareRequest
//
// What this file pins: an off-list coordinator child on a request is moved back
// onto its list WITHOUT throwing, the seed is handed back untouched, and the
// event is logged.

const CHILD = 'child-pullback';

const config = {
  roleMode: false,
  injectRouteContext: false,
  failoverEnabled: true,
  stallWatchdogEnabled: false,
  models: [],
  coordinatorEnabled: true,
  coordinatorPresetPrefix: 'dsh-orchestrator-worker',
  coordinatorUiModels: [{ provider: 'magpie-anthropic', model: 'agy-cli/gemini-4-hydrogen' }],
  coordinatorResearchModels: [{ provider: 'magpie', model: 'group/dnq' }],
  coordinatorBackendModels: [
    { provider: 'magpie-responses', model: 'codex/gpt-6.2-sol' },
    { provider: 'magpie', model: 'group/1017' }
  ],
  coordinatorCooldownPreset: 'medium',
  coordinatorCooldownSteps: [],
  coordinatorCooldownCap: 0,
  coordinatorNoFallback: false
};

function harness(settings = config, options = {}) {
  const listeners = new Map();
  const cleanups = [];
  const routes = [];
  const infos = [];
  const agents = new Map();

  const ctx = {
    logger: {
      warn() {},
      info: (...args) => infos.push(args.join(' ')),
      debug() {}
    },
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
      if (key === 'llm' && options.catalog) {
        return {
          async listModels(provider) { return options.catalog[provider] ?? []; }
        };
      }
      return undefined;
    }
  };

  apply(ctx, settings);

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
    const res = { writeHead(code) { status = code; }, end(chunk) { raw += chunk ?? ''; } };
    await route.handler(req, res);
    return { status, body: raw === '' ? null : JSON.parse(raw) };
  }

  async function request(agent, seed) {
    const list = listeners.get('agent/request') ?? [];
    const run = (i) => (i === list.length ? Promise.resolve(seed) : list[i]({ agent, turn: 1, step: 1, signal: undefined }, () => run(i + 1)));
    return run(0);
  }

  function liveChild(id, route) {
    const selects = [];
    const served = { provider: route.provider, model: route.model };
    const agent = {
      id,
      session: {
        header: { origin: 'subagent', label: 'worker' },
        requestContext: () => ({ ...served, contextWindow: 1000 }),
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
      options: { provider: 'parent', model: 'parent' }
    };
    agents.set(id, agent);
    return agent;
  }

  return {
    ctx,
    routes,
    infos,
    call,
    request,
    liveChild,
    async flush() {
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    },
    dispose() { for (const fn of cleanups.reverse()) fn(); }
  };
}

test('an off-list coordinator child is pulled back without a ReferenceError', async () => {
  // The gateway has retired the list's head (gpt-6.2-sol); only 6.1-sol exists.
  // The child runs 6.1-sol, which is NOT on its list, so the pull-back fires —
  // and must land on a route the provider still serves (group/1017), never back
  // onto the retired head.
  const h = harness(config, { catalog: { 'magpie-responses': [{ id: 'codex/gpt-6.1-sol' }] } });
  const child = h.liveChild(CHILD, { provider: 'magpie-responses', model: 'codex/gpt-6.1-sol' });
  await h.flush();
  const grouped = await h.call({ path: '/subagent-role-router/group', body: { childId: CHILD, group: 'backend' } });
  assert.equal(grouped.body.ok, true);
  // /group also writes a route override; the live failure had NONE (the child
  // was running on a route the host picked). Clear it so the pull-back path is
  // the one under test.
  await h.call({ path: '/subagent-role-router/clear', body: { childId: CHILD } });

  const seed = { provider: 'magpie-responses', model: 'codex/gpt-6.1-sol', reasoningEffort: 'xhigh' };
  const returned = await h.request(child, seed);
  assert.equal(returned, seed, 'the frozen seed is handed back untouched');
  assert.deepEqual(child.model.selects.at(-1), { provider: 'magpie', model: 'group/1017' }, 'the list decides, and a retired head is skipped');
  assert.ok(h.infos.some((line) => line.includes('not on its')), 'the pull-back is logged once');
  h.dispose();
});

test('moving a child to a list skips a retired head', async () => {
  const h = harness(config, { catalog: { 'magpie-responses': [{ id: 'codex/gpt-6.1-sol' }] } });
  const child = h.liveChild(CHILD, { provider: 'magpie-responses', model: 'codex/gpt-6.1-sol' });
  await h.flush();
  const res = await h.call({ path: '/subagent-role-router/group', body: { childId: CHILD, group: 'backend' } });
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.target, { provider: 'magpie', model: 'group/1017' }, 'the list head is retired, so the next live row is applied');
  assert.deepEqual(child.model.selects.at(-1), { provider: 'magpie', model: 'group/1017' });
  h.dispose();
});

test('the coordinator diagnostic names the retired row and the catalog it used', async () => {
  const h = harness(config, { catalog: { 'magpie-responses': [{ id: 'codex/gpt-6.1-sol' }] } });
  await h.flush();
  const res = await h.call({ method: 'GET', path: '/subagent-role-router/coordinator?refresh=1' });
  const dead = res.body.value.dead;
  assert.ok(Array.isArray(dead));
  assert.deepEqual(dead.find((row) => row.group === 'backend'), {
    group: 'backend',
    provider: 'magpie-responses',
    model: 'codex/gpt-6.2-sol'
  });
  assert.ok(res.body.value.catalog, 'the freshness of the verdict is reported');
  h.dispose();
});

test('a coordinator child already on its list is left alone', async () => {
  const h = harness();
  const child = h.liveChild(CHILD, { provider: 'magpie', model: 'group/1017' });
  await h.call({ path: '/subagent-role-router/group', body: { childId: CHILD, group: 'backend' } });
  await h.call({ path: '/subagent-role-router/clear', body: { childId: CHILD } });
  const before = child.model.selects.length;
  const seed = { provider: 'magpie', model: 'group/1017' };
  const returned = await h.request(child, seed);
  assert.equal(returned, seed);
  assert.equal(child.model.selects.length, before, 'an in-list route must not be switched');
  h.dispose();
});
