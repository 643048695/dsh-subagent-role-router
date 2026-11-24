import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// BIRTH BOUNDARY — the profile-shaped regression set.
//
// The fixture below is the ACTUAL desktop profile's role/coordinator layout:
//   general/role/team: magpie dnq, 1017, eco
//   coordinator:       dnq, 1017, codex, gemini (codex + gemini are group-only)
// Overlap alone must not revoke ordinary membership (dnq/1017 are in both the
// general and coordinator lists), while a route that exists ONLY in a
// coordinator list must never reach an ordinary child.
//
// Every spawn goes through the real `apply()` service wrapper; the fake
// subagents service only records the rewritten spec. State paths are redirected
// to a per-harness temp directory and NODE_TEST_CONTEXT is set, so no live
// coordinator ledger, candidate file or error journal is read or written.

process.env.NODE_TEST_CONTEXT = process.env.NODE_TEST_CONTEXT ?? '1';
const BASE = mkdtempSync(join(tmpdir(), 'router-birth-boundary-'));
// The module reads its default candidate file while evaluating; point the
// home-derived defaults at the temp tree before the dynamic import so the live
// ~/.dsh files are not even read.
process.env.USERPROFILE = BASE;
process.env.HOME = BASE;
process.env.DSH_SUBAGENT_ROLE_ROUTER_STATE = join(BASE, 'state');

const router = await import('../lib/index.js');
const {
  apply,
  classifyCoordinatorTask,
  hostGateModels,
  hostModelPool,
  hostWhitelistModels,
  setBirthSeenPath,
} = router;

after(() => {
  rmSync(BASE, { recursive: true, force: true });
});

const magpie = (model, effort) => ({
  provider: 'magpie',
  model,
  ...(effort === undefined ? {} : { reasoningEffort: effort }),
});

/** The desktop profile, trimmed only to fields this boundary reads. */
function profileConfig(overrides = {}) {
  return {
    provider: 'magpie',
    model: '',
    models: [
      magpie('group/dnq', 'high'),
      magpie('group/1017', 'high'),
      magpie('opendesign/deepseek-v4.1-flash-eco', 'high'),
      'group/1017'
    ],
    strategy: 'round-robin',
    failoverEnabled: true,
    injectRouteContext: false,
    birthRoutePolicy: 'pool',
    roleMode: true,
    exploreProvider: 'magpie',
    exploreModel: 'group/dnq',
    exploreEffort: 'low',
    planProvider: 'magpie',
    planModel: 'group/1017',
    planEffort: 'max',
    patchProvider: 'magpie',
    patchModel: 'group/dnq',
    patchEffort: 'high',
    exploreModels: [magpie('group/dnq', 'low')],
    planModels: [magpie('group/1017', 'max')],
    patchModels: [
      magpie('group/dnq', 'high'),
      magpie('group/1017', 'high'),
      magpie('opendesign/deepseek-v4.1-flash-eco', 'high')
    ],
    roleSlotCooldownSeconds: 15,
    teamModelProvider: 'magpie',
    teamModelName: 'group/dnq',
    teamModelEffort: 'high',
    exemptRules: [],
    coordinatorEnabled: true,
    coordinatorPresetPrefix: 'dsh-orchestrator-worker',
    coordinatorUiModels: [
      { provider: 'magpie-anthropic', model: 'agy-cli/gemini-4-hydrogen', reasoningEffort: 'high' },
      magpie('group/1017', 'max')
    ],
    coordinatorResearchModels: [magpie('group/dnq', 'high')],
    coordinatorDeliveryModels: [magpie('group/dnq', 'high')],
    coordinatorBackendModels: [
      { provider: 'magpie-responses', model: 'codex/gpt-6.1-sol', reasoningEffort: 'xhigh' },
      magpie('group/1017', 'max'),
      magpie('group/dnq', 'max')
    ],
    coordinatorCooldownPreset: 'medium',
    coordinatorCooldownSteps: [],
    coordinatorCooldownCap: 0,
    coordinatorNoFallback: false,
    ...overrides
  };
}

function harness(config = profileConfig(), options = {}) {
  const dir = mkdtempSync(join(BASE, 'h-'));
  process.env.DSH_SUBAGENT_ROLE_ROUTER_STATE = join(dir, 'state');
  setBirthSeenPath(join(dir, 'candidates.json'));

  const listeners = new Map();
  const cleanups = [];
  const spawns = [];
  const warnings = [];
  const catalogCalls = [];
  const childIds = new Map();
  let seq = 0;

  const dispatch = (spec) => {
    if (options.dispatchThrows === true && throwOnDispatch) {
      throwOnDispatch = false;
      throw new Error('sync dispatch boom');
    }
    spawns.push(spec);
    const childId = spec.childId ?? `child-${++seq}`;
    childIds.set(childId, spec);
    if (options.interveningRoute) {
      const agent = { id: childId, options: { ...options.interveningRoute },
        session: { header: { origin: 'subagent', parentSession: spec.parent?.id } },
        model: { current: () => agent.options, select: (route) => { agent.options = { ...route }; } } };
      // An old wrapper retained by another plugin changes the original spawn
      // before creation. Our final commitment runs before the first step.
      for (const listener of listeners.get('agent/created') ?? []) listener({ agent });
      spec.served = { ...agent.options };
    }
    // A pending result keeps a role lane occupied exactly as a live child
    // would; the wrapper's lease releases only when the result settles.
    return { childId, result: new Promise(() => {}) };
  };
  let throwOnDispatch = options.dispatchThrows === true;
  const startActivation = options.syncActivation === true
    ? dispatch
    : async function startActivation(spec) {
      return dispatch(spec);
    };

  const ctx = {
    logger: {
      warn: (...args) => warnings.push(args.join(' ')),
      info: () => {}
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
      if (names.includes('subagents')) fn(ctx);
    },
    get(name) {
      if (name === 'llm' && options.catalog !== undefined) {
        return {
          async listModels(provider) {
            catalogCalls.push(provider);
            const listed = typeof options.catalog === 'function'
              ? options.catalog(provider)
              : options.catalog[provider];
            return (Array.isArray(listed) ? listed : []).map((id) => ({ id }));
          }
        };
      }
      return undefined;
    },
    subagents: { startActivation }
  };

  apply(ctx, config);

  const flush = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  };

  return {
    config,
    catalogCalls,
    retainUnderOtherWrapper() {
      const held = ctx.subagents.startActivation;
      ctx.subagents.startActivation = (...args) => held(...args);
    },
    tool: async (args, defaults = magpie('opendesign/deepseek-v4.1-flash-eco', 'high')) => {
      const exec = { name: 'subagent', arguments: args, agent: { id: 'lead' } };
      const list = listeners.get('tools/execute') ?? [];
      const terminal = async () => {
        // Native rc.5 tools resolve defaults and preflight asynchronously before
        // calling startActivation. No route arguments still becomes agentOptions.
        await Promise.resolve();
        const options = args.model ? { provider: args.provider, model: args.model } : defaults;
        return ctx.subagents.startActivation({ provider: 'spawn', parent: exec.agent, label: args.description, prompt: args.prompt, agentOptions: options });
      };
      const run = (index) => index === list.length ? terminal() : list[index](exec, () => run(index + 1));
      return run(0);
    },
    spawn: (args = {}) => {
      const spec = {
        provider: 'spawn',
        prompt: 'do the thing',
        parent: { id: 'lead' },
        ...args
      };
      return ctx.subagents.startActivation(spec);
    },
    warm: async () => {
      // `apply()` warms the birth catalog in the background; two turns let the
      // provider promises settle before the first wrapped start.
      await flush();
      await flush();
    },
    error: async (agent, failure, value = { kind: 'continue' }) => {
      const list = listeners.get('agent/request-error') ?? [];
      const payload = { turn: 0, step: 0, agent, provider: 'magpie', failure };
      const run = (index) => (index === list.length
        ? Promise.resolve(value)
        : list[index](payload, () => run(index + 1)));
      return run(0);
    },
    flush,
    spawns,
    warnings,
    dispose() {
      for (const off of cleanups.reverse()) off();
    }
  };
}

const born = (spec) => spec?.agentOptions ?? null;

const liveAgent = (id, route, label) => ({
  id,
  session: {
    header: { origin: 'subagent', label },
    requestContext: () => ({ ...route, contextWindow: 1000 }),
    requestHeader: () => ({ config: { ...route } }),
    snapshotEvents: () => []
  },
  model: { select() {} }
});

// ── membership ───────────────────────────────────────────────────────────────

test('ordinary membership keeps overlapping routes and excludes group-only ones', () => {
  const config = profileConfig();
  const ordinary = hostWhitelistModels(config);

  assert.deepEqual(ordinary, [
    { provider: 'magpie', model: 'group/dnq' },
    { provider: 'magpie', model: 'group/1017' },
    { provider: 'magpie', model: 'opendesign/deepseek-v4.1-flash-eco' }
  ], 'overlap with a coordinator list must not revoke ordinary membership');

  const pool = hostModelPool(config);
  assert.equal(pool.some((row) => row.model === 'codex/gpt-6.1-sol'), false, 'codex is backend-list-only');
  assert.equal(pool.some((row) => row.provider === 'magpie-anthropic'), false, 'gemini is ui-list-only');

  const gate = hostGateModels(config);
  assert.ok(gate.some((route) => route.model === 'codex/gpt-6.1-sol'), 'the host union still carries group-only routes');
  assert.ok(gate.some((route) => route.provider === 'magpie-anthropic'), 'the host union still carries ui routes');
});

test('ordinary exploration is born on the profile explore lane', async (t) => {
  const h = harness();
  t.after(() => h.dispose());

  h.spawn({ label: '[explore] map the repository', prompt: 'map it' });
  await h.flush();

  assert.deepEqual(born(h.spawns.at(-1)), {
    provider: 'magpie',
    model: 'group/dnq',
    reasoningEffort: 'low'
  });
});

test('ordinary patch fills the three profile lanes in order', async (t) => {
  const h = harness();
  t.after(() => h.dispose());

  h.spawn({ label: '[patch] first lane', prompt: 'implement one' });
  await h.flush();
  h.spawn({ label: '[patch] second lane', prompt: 'implement two' });
  await h.flush();
  h.spawn({ label: '[patch] third lane', prompt: 'implement three' });
  await h.flush();

  assert.deepEqual(h.spawns.map((spec) => born(spec)), [
    { provider: 'magpie', model: 'group/dnq', reasoningEffort: 'high' },
    { provider: 'magpie', model: 'group/1017', reasoningEffort: 'high' },
    { provider: 'magpie', model: 'opendesign/deepseek-v4.1-flash-eco', reasoningEffort: 'high' }
  ], 'patch lanes must fill dnq, then 1017, then eco');
});

// ── explicit selection ───────────────────────────────────────────────────────

test('an explicit provider mismatch is not whitelist-approved', async (t) => {
  const h = harness();
  t.after(() => h.dispose());

  h.spawn({
    label: '[patch] implement the thing',
    prompt: 'implement',
    agentOptions: { provider: 'magpie-responses', model: 'group/dnq' }
  });
  await h.flush();

  assert.deepEqual(born(h.spawns.at(-1)), {
    provider: 'magpie',
    model: 'group/dnq',
    reasoningEffort: 'high'
  }, 'magpie-responses/group/dnq is not the page route magpie/group/dnq');
});

test('a replaced route never keeps the inherited xhigh effort', async (t) => {
  const h = harness();
  t.after(() => h.dispose());

  h.spawn({
    label: '[patch] implement the thing',
    prompt: 'implement',
    agentOptions: {
      provider: 'magpie-responses',
      model: 'codex/gpt-6.1-sol',
      reasoningEffort: 'xhigh'
    }
  });
  await h.flush();

  const route = born(h.spawns.at(-1));
  assert.equal(route.provider, 'magpie');
  assert.equal(route.model, 'group/dnq');
  assert.notEqual(route.reasoningEffort, 'xhigh', 'xhigh belonged to the rejected codex route');
  assert.equal(route.reasoningEffort, 'high', 'the patch lane supplies its own effort');
});

test('a replacement target without effort clears the inherited value entirely', async (t) => {
  const h = harness(profileConfig({
    roleMode: false,
    models: [{ provider: 'magpie', model: 'group/dnq' }]
  }));
  t.after(() => h.dispose());

  h.spawn({
    label: 'ordinary task',
    prompt: 'do it',
    agentOptions: {
      provider: 'magpie-responses',
      model: 'codex/gpt-6.1-sol',
      reasoningEffort: 'xhigh'
    }
  });
  await h.flush();

  assert.deepEqual(born(h.spawns.at(-1)), {
    provider: 'magpie',
    model: 'group/dnq'
  }, 'a target with no effort must not inherit the rejected route\'s xhigh');
});

// ── coordinator birth ────────────────────────────────────────────────────────

test('noFallback takes the cooling head instead of falling through', async (t) => {
  const h = harness(profileConfig({ coordinatorNoFallback: true }));
  t.after(() => h.dispose());

  h.spawn({
    childId: 'coord-heat',
    label: '【后端】修复登录',
    prompt: '改后端',
    agentPreset: 'dsh-orchestrator-worker'
  });
  await h.flush();
  assert.deepEqual(born(h.spawns.at(-1)), {
    provider: 'magpie-responses',
    model: 'codex/gpt-6.1-sol',
    reasoningEffort: 'xhigh'
  });

  const failing = liveAgent('coord-heat', {
    provider: 'magpie-responses',
    model: 'codex/gpt-6.1-sol'
  }, '【后端】修复登录');
  await h.error(failing, { code: 'RATE_LIMIT', message: '429' });
  await h.flush();

  h.spawn({
    childId: 'coord-next',
    label: '【后端】修复登录',
    prompt: '改后端',
    agentPreset: 'dsh-orchestrator-worker'
  });
  await h.flush();

  assert.deepEqual(born(h.spawns.at(-1)), {
    provider: 'magpie-responses',
    model: 'codex/gpt-6.1-sol',
    reasoningEffort: 'xhigh'
  }, 'noFallback means the head is retried even while cooling');
});

test('a teammate born under a coordinator child keeps the team birth route', async (t) => {
  const h = harness();
  t.after(() => h.dispose());

  h.spawn({
    childId: 'coord-team-parent',
    label: '【后端】修复登录',
    prompt: '改后端',
    agentPreset: 'dsh-orchestrator-worker'
  });
  await h.flush();

  h.spawn({
    childId: 'team-1',
    label: 'agent-teams: worker',
    prompt: 'do the worker task',
    parent: { id: 'coord-team-parent' }
  });
  await h.flush();

  assert.deepEqual(born(h.spawns.at(-1)), {
    provider: 'magpie',
    model: 'group/dnq',
    reasoningEffort: 'high'
  }, 'team identity outranks coordinator inheritance');
});

test('a nested explicit coordinator directive beats the inherited group', async (t) => {
  const h = harness();
  t.after(() => h.dispose());

  h.spawn({
    childId: 'coord-nested-parent',
    label: '【后端】修复登录',
    prompt: '改后端',
    agentPreset: 'dsh-orchestrator-worker'
  });
  await h.flush();

  h.spawn({
    childId: 'coord-nested-child',
    label: '组：审计查阅 盘点表盘内容',
    prompt: '盘点',
    parent: { id: 'coord-nested-parent' }
  });
  await h.flush();

  assert.deepEqual(born(h.spawns.at(-1)), {
    provider: 'magpie',
    model: 'group/dnq',
    reasoningEffort: 'high'
  }, 'the explicit directive names research, not the parent\'s backend list');
});

// ── retirement at birth ─────────────────────────────────────────────────────

/** A magpie catalog that still serves every profile route except dnq. */
const magpieWithoutDnq = {
  magpie: ['group/1017', 'opendesign/deepseek-v4.1-flash-eco'],
  'magpie-responses': ['codex/gpt-6.1-sol'],
  'magpie-anthropic': ['agy-cli/gemini-4-hydrogen']
};

test('an approved explicit route that is retired is refused as a pin', async (t) => {
  const h = harness(profileConfig(), { catalog: magpieWithoutDnq });
  t.after(() => h.dispose());
  await h.warm();

  await assert.rejects(
    () => h.spawn({
      label: '[patch] implement the thing',
      agentOptions: { provider: 'magpie', model: 'group/dnq' }
    }),
    /approved birth route .* no longer served/
  );
  assert.equal(h.spawns.length, 0, 'a refused pin must not reach the host');
});

test('a retired first lane is skipped for the next live lane', async (t) => {
  const h = harness(profileConfig({
    patchModels: [magpie('group/dnq', 'high'), magpie('group/1017', 'high')]
  }), { catalog: magpieWithoutDnq });
  t.after(() => h.dispose());
  await h.warm();

  h.spawn({ label: '[patch] first lane', prompt: 'implement' });
  await h.flush();

  assert.deepEqual(born(h.spawns.at(-1)), {
    provider: 'magpie',
    model: 'group/1017',
    reasoningEffort: 'high'
  });
});

test('a retired one-lane role refuses instead of using the base pool', async (t) => {
  const h = harness(profileConfig({
    patchModels: [magpie('group/dnq', 'high')],
    models: [magpie('group/1017', 'high')]
  }), { catalog: magpieWithoutDnq });
  t.after(() => h.dispose());
  await h.warm();

  await assert.rejects(
    () => h.spawn({ label: '[patch] implement the thing', prompt: 'implement' }),
    /every candidate of the patch role pool is no longer served/
  );
  assert.equal(h.spawns.length, 0);
});

test('a retired coordinator group refuses instead of spawning off-list', async (t) => {
  const h = harness(profileConfig({
    coordinatorBackendModels: [{ provider: 'magpie-responses', model: 'codex/gpt-6.1-sol' }]
  }), {
    catalog: {
      magpie: ['group/dnq', 'group/1017', 'opendesign/deepseek-v4.1-flash-eco'],
      'magpie-responses': ['codex/gpt-6.2-legacy'],
      'magpie-anthropic': ['agy-cli/gemini-4-hydrogen']
    }
  });
  t.after(() => h.dispose());
  await h.warm();

  await assert.rejects(
    () => h.spawn({
      childId: 'dead-group',
      label: '【后端】修复登录',
      prompt: '改后端',
      agentPreset: 'dsh-orchestrator-worker'
    }),
    /no .* birth route is still served/
  );
  assert.equal(h.spawns.length, 0, 'coordinator must not inherit the parent route');
});

test('a retired team birth route is refused as a pin', async (t) => {
  const h = harness(profileConfig(), { catalog: magpieWithoutDnq });
  t.after(() => h.dispose());
  await h.warm();

  await assert.rejects(
    () => h.spawn({
      childId: 'team-dead',
      label: 'agent-teams: worker',
      prompt: 'do the worker task'
    }),
    /explicit, team, or exempt pin/
  );
  assert.equal(h.spawns.length, 0);
});

test('a retired exempt pin is refused as a pin', async (t) => {
  const h = harness(profileConfig({
    exemptRules: [{
      name: 'dead-pin',
      match: 'label',
      pattern: 'egm-',
      provider: 'magpie',
      model: 'group/retired',
      effort: ''
    }]
  }), { catalog: magpieWithoutDnq });
  t.after(() => h.dispose());
  await h.warm();

  await assert.rejects(
    () => h.spawn({ label: 'egm-goldfish-review', prompt: 'review' }),
    /explicit, team, or exempt pin/
  );
  assert.equal(h.spawns.length, 0);
});

test('unknown catalog evidence allows the configured route', async (t) => {
  const h = harness(profileConfig(), { catalog: {} });
  t.after(() => h.dispose());
  await h.warm();

  h.spawn({ label: '[patch] implement the thing', prompt: 'implement' });
  await h.flush();

  assert.deepEqual(born(h.spawns.at(-1)), {
    provider: 'magpie',
    model: 'group/dnq',
    reasoningEffort: 'high'
  }, 'a provider absent from the catalog is unknown, never dead');
});

test('model-only and short picks are normalized to the unique configured route', async (t) => {
  const h = harness(profileConfig(), {
    catalog: {
      magpie: ['group/dnq', 'group/1017', 'opendesign/deepseek-v4.1-flash-eco'],
      'magpie-responses': ['codex/gpt-6.1-sol'],
      'magpie-anthropic': ['agy-cli/gemini-4-hydrogen']
    }
  });
  t.after(() => h.dispose());
  await h.warm();

  h.spawn({ label: '[patch] a', prompt: 'implement', agentOptions: { model: 'dnq' } });
  h.spawn({ label: '[patch] b', prompt: 'implement', agentOptions: { provider: 'magpie', model: 'dnq' } });
  h.spawn({ label: '[patch] c', prompt: 'implement', agentOptions: { model: 'group/dnq' } });

  for (const spec of h.spawns) {
    assert.equal(spec.agentOptions.provider, 'magpie');
    assert.equal(spec.agentOptions.model, 'group/dnq');
  }
  assert.equal(h.spawns.some((spec) => spec.agentOptions.model === 'dnq'), false, 'a short id never reaches the host unchanged');
});

test('an ambiguous short id is routed to a full configured route, not admitted', async (t) => {
  const h = harness(profileConfig({
    roleMode: false,
    models: [
      { provider: 'a', model: 'group/x' },
      { provider: 'b', model: 'other/x' }
    ]
  }));
  t.after(() => h.dispose());

  h.spawn({ label: 'ordinary task', agentOptions: { model: 'x' } });
  await h.flush();

  assert.deepEqual(born(h.spawns.at(-1)), { provider: 'a', model: 'group/x' });
});

test('stale catalog evidence does not keep a reintroduced model dead', async (t) => {
  let magpieCalls = 0;
  const catalog = (provider) => {
    if (provider !== 'magpie') return [];
    magpieCalls += 1;
    return magpieCalls === 1
      ? ['group/1017', 'opendesign/deepseek-v4.1-flash-eco']
      : ['group/dnq', 'group/1017', 'opendesign/deepseek-v4.1-flash-eco'];
  };
  const h = harness(profileConfig(), { catalog });
  const realNow = Date.now;
  t.after(() => {
    Date.now = realNow;
    h.dispose();
  });
  await h.warm();

  await assert.rejects(
    () => h.spawn({
      childId: 'ttl-before',
      label: '[patch] ttl before',
      agentOptions: { provider: 'magpie', model: 'group/dnq' }
    }),
    /no longer served/
  );

  const base = realNow();
  Date.now = () => base + 6 * 60 * 1000;
  try {
    h.spawn({
      childId: 'ttl-after',
      label: '[patch] ttl after',
      agentOptions: { provider: 'magpie', model: 'group/dnq' }
    });
    await h.flush();
  } finally {
    Date.now = realNow;
  }

  assert.deepEqual(born(h.spawns.at(-1)), { provider: 'magpie', model: 'group/dnq' });
  assert.ok(magpieCalls >= 2, 'stale evidence must trigger a fresh catalog read');
});


// ── synchronous host contract ───────────────────────────────────────────────

test('a synchronous startActivation throws birth-gate errors, not a rejected promise', async (t) => {
  const h = harness(profileConfig(), {
    syncActivation: true,
    catalog: magpieWithoutDnq
  });
  t.after(() => h.dispose());
  await h.warm();

  assert.throws(
    () => h.spawn({
      label: '[patch] implement the thing',
      prompt: 'implement',
      agentOptions: { provider: 'magpie', model: 'group/dnq' }
    }),
    (error) => error?.code === 'BIRTH_ROUTE_DEAD' && /no longer served/.test(error?.message ?? '')
  );
  assert.equal(h.spawns.length, 0, 'the synchronous host must see a throw, not a rejected promise');
});

test('a lane acquired before a synchronous start failure is released', async (t) => {
  const h = harness(profileConfig(), {
    syncActivation: true,
    dispatchThrows: true
  });
  t.after(() => h.dispose());

  assert.throws(
    () => h.spawn({ label: '[patch] first', prompt: 'implement' }),
    /sync dispatch boom/
  );

  h.spawn({ label: '[patch] second', prompt: 'implement' });
  await h.flush();

  assert.deepEqual(born(h.spawns.at(-1)), {
    provider: 'magpie',
    model: 'group/dnq',
    reasoningEffort: 'high'
  }, 'a leaked lane would have pushed the second spawn onto group/1017');
});

test('a delivery failure diagnosis is classified backend', () => {
  const classified = classifyCoordinatorTask('上传卡住的原因', '');
  assert.equal(classified.group, 'backend');
  assert.equal(classifyCoordinatorTask('部署失败定位', '').group, 'backend');
});

test('a delivery failure diagnosis is born on the backend list', async (t) => {
  const h = harness();
  t.after(() => h.dispose());

  h.spawn({
    childId: 'coord-delivery-fail',
    label: '上传卡住的原因',
    prompt: '',
    agentPreset: 'dsh-orchestrator-worker'
  });
  await h.flush();

  assert.deepEqual(born(h.spawns.at(-1)), {
    provider: 'magpie-responses',
    model: 'codex/gpt-6.1-sol',
    reasoningEffort: 'xhigh'
  }, 'diagnosing a delivery failure needs the backend list');
});

test('native tool defaults on an approved eco route still use the configured first lane', async (t) => {
  const h = harness(); t.after(() => h.dispose());
  await h.tool({ description: '[patch] native default one', prompt: 'implement' });
  await h.tool({ description: '[patch] native default two', prompt: 'implement' });
  assert.deepEqual(h.spawns.map((spec) => born(spec)), [magpie('group/dnq', 'high'), magpie('group/1017', 'high')]);
});

test('native explicit picks survive alongside automatic defaults without leaking intent', async (t) => {
  const h = harness(); t.after(() => h.dispose());
  await Promise.all([
    h.tool({ description: '[patch] explicit eco', prompt: 'implement', provider: 'magpie', model: 'opendesign/deepseek-v4.1-flash-eco' }),
    h.tool({ description: '[patch] automatic', prompt: 'implement' })
  ]);
  const explicit = h.spawns.find((spec) => spec.label.includes('explicit'));
  const automatic = h.spawns.find((spec) => spec.label.includes('automatic'));
  assert.equal(born(explicit).model, 'opendesign/deepseek-v4.1-flash-eco');
  assert.equal(born(automatic).model, 'group/dnq');
  h.spawn({ label: '[patch] plugin direct pin', agentOptions: magpie('group/1017') });
  await h.flush();
  assert.equal(born(h.spawns.at(-1)).model, 'group/1017', 'native default provenance cannot escape its tool call');
});

test('an intervening old wrapper cannot replace the route before the first request', async (t) => {
  const h = harness(profileConfig(), { interveningRoute: magpie('opendesign/deepseek-v4.1-flash-eco', 'high') });
  t.after(() => h.dispose());
  await h.tool({ description: '[patch] final commitment', prompt: 'implement' });
  assert.equal(h.spawns[0].served.model, 'group/dnq', 'the first step reads the committed route, not the obsolete wrapper pick');
});

test('a disposed wrapper retained by another plugin passes through without obsolete routing', async () => {
  const h = harness();
  h.retainUnderOtherWrapper();
  h.dispose();
  await h.spawn({ agentOptions: magpie('group/1017'), label: '[patch] after unload' });
  assert.deepEqual(born(h.spawns[0]), magpie('group/1017'), 'a retained inactive wrapper is transparent');
});
