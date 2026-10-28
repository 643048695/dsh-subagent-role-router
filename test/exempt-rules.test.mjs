// Plugin exemption rules: some plugins spawn dedicated subagents for their own
// work (EGM's goldfish reviewers, for one). A child matching an exemption rule
// must be born WITHOUT the injected default pool, must never enter the automatic
// failover, and may carry an optional pinned birth model. Matching is an exact,
// case-sensitive PREFIX over one of the spawn's identity fields (label /
// agentPreset / cwd), because stable ids carry version suffixes and scratch
// rooms carry mkdtemp suffixes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, noteBirthSeen, birthSeenSuggestions, setBirthSeenPath } from '../lib/index.js';

// The observation file must never be the real one during tests.
setBirthSeenPath(join(tmpdir(), `srr-candidates-test-${process.pid}.json`));

const config = {
  injectRouteContext: false,
  failoverEnabled: true,
  models: [{ provider: 'p', model: 'a' }, { provider: 'q', model: 'b' }],
  roleSlotCooldownSeconds: 0,
  exemptRules: [
    { name: 'egm goldfish', match: 'label', pattern: 'egm-goldfish-', provider: 'tp', model: 'tm', effort: 'tmax' }
  ]
};

function harness(settings = config) {
  const listeners = new Map();
  const cleanups = [];
  const routes = [];
  const warnings = [];
  const agents = new Map();
  const spawns = [];

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
      if (names.includes('subagents')) {
        const subagents = {
          startActivation(spec) {
            spawns.push({ kind: 'startActivation', spec });
            return { childId: spec.childId };
          },
          startContinuable(spec) {
            spawns.push({ kind: 'startContinuable', spec });
            return { childId: spec.childId };
          },
          start(childId, request) {
            spawns.push({ kind: 'start', childId, request });
            return Promise.resolve({ childId });
          }
        };
        ctx.subagents = subagents;
        fn({ logger: ctx.logger, on: ctx.on, effect: ctx.effect, subagents });
      }
    },
    get(key) {
      if (key === 'agents') return { get: (id) => agents.get(id) };
      return undefined;
    }
  };

  apply(ctx, settings);

  async function error(agent, failure, value) {
    const list = listeners.get('agent/request-error') ?? [];
    const payload = { turn: 0, step: 0, agent, provider: 'p', failure };
    const run = (i) => (i === list.length ? Promise.resolve(value) : list[i](payload, () => run(i + 1)));
    return run(0);
  }

  async function request(agent, seed) {
    const list = listeners.get('agent/request') ?? [];
    const payload = { turn: 0, step: 0, agent };
    const run = (i) => (i === list.length ? Promise.resolve(seed) : list[i](payload, () => run(i + 1)));
    return run(0);
  }

  /** Register a live child the way the host would. */
  function liveChild(id, { label = id, route = { provider: 'p', model: 'a' } } = {}) {
    const agent = {
      id,
      session: {
        header: { origin: 'subagent', label },
        requestContext: () => route,
        snapshotEvents: () => []
      },
      options: { provider: 'parent', model: 'parent' }
    };
    agents.set(id, agent);
    return agent;
  }

  return { ctx, agents, spawns, warnings, routes, error, request, liveChild, dispose() { for (const fn of cleanups.reverse()) fn(); } };
}

/** A plugin spawn: exactly the shape egm's dispatch.js hands to startActivation. */
const goldfishSpawn = (overrides = {}) => ({
  provider: 'spawn',
  label: 'egm-goldfish-logic',
  request: { prompt: [{ type: 'text', text: 'review the design' }], ...overrides.request },
  ...overrides.top
});

test('a label hit pins the birth model and skips the pool', () => {
  const h = harness();
  h.ctx.subagents.startActivation(goldfishSpawn());
  assert.equal(h.spawns.length, 1);
  const spec = h.spawns[0].spec;
  // The pin lands in agentOptions; the spawn-mode provider stays untouched.
  assert.deepEqual(spec.request.agentOptions, { provider: 'tp', model: 'tm', reasoningEffort: 'tmax' });
  assert.equal(spec.provider, 'spawn');
  // No pool lane: a plain (non-exempt) spawn would have received one.
  h.ctx.subagents.startActivation({ provider: 'spawn', label: 'plain helper', request: { prompt: [] } });
  const plain = h.spawns[1].spec;
  assert.notEqual(plain.request.agentOptions, undefined);
  assert.notDeepEqual(plain.request.agentOptions, { provider: 'tp', model: 'tm', reasoningEffort: 'tmax' });
  h.dispose();
});

test('a hit without a pinned model leaves the spawn completely alone', () => {
  const h = harness({ ...config, exemptRules: [{ name: 'egm', match: 'label', pattern: 'egm-goldfish-' }] });
  h.ctx.subagents.startActivation(goldfishSpawn());
  const spec = h.spawns[0].spec;
  assert.equal(spec.request.agentOptions, undefined);
  h.dispose();
});

test('an explicit agentOptions on the spawn beats the pin', () => {
  const h = harness();
  h.ctx.subagents.startActivation(goldfishSpawn({
    request: { prompt: [], agentOptions: { provider: 'x', model: 'y' } }
  }));
  const spec = h.spawns[0].spec;
  assert.deepEqual(spec.request.agentOptions, { provider: 'x', model: 'y' });
  h.dispose();
});

test('preset and cwd rules match their own identity field', () => {
  const h = harness({
    ...config,
    exemptRules: [
      { name: 'preset rule', match: 'preset', pattern: 'egm-goldfish-', provider: 'tp', model: 'tm', effort: '' },
      { name: 'cwd rule', match: 'cwd', pattern: '/ws/.egm', provider: '', model: '' }
    ]
  });
  // Preset match: goldfish preset ids carry a version suffix, hence prefix.
  h.ctx.subagents.startActivation({
    provider: 'spawn',
    request: { prompt: [], agentPreset: 'egm-goldfish-9.9.9' }
  });
  // An effortless pin is stored without the key (the adapter then resolves the
  // model's own default effort) — same contract as the team birth model.
  assert.deepEqual(h.spawns[0].spec.request.agentOptions, { provider: 'tp', model: 'tm' });
  // cwd match: mkdtemp rooms carry a random suffix, hence prefix. No pin → untouched.
  h.ctx.subagents.startActivation({
    provider: 'spawn',
    request: { prompt: [], cwd: '/ws/.egm/review-AbCdEf' }
  });
  assert.equal(h.spawns[1].spec.request.agentOptions, undefined);
  // A preset rule must not fire on a matching label: fields do not cross-match.
  h.ctx.subagents.startActivation({ provider: 'spawn', label: 'egm-goldfish-9.9.9', request: { prompt: [] } });
  assert.notDeepEqual(h.spawns[2].spec.request.agentOptions, { provider: 'tp', model: 'tm', reasoningEffort: '' });
  h.dispose();
});

test('an exempt child never enters the automatic failover', async () => {
  const h = harness();
  const exemptChild = h.liveChild('exempt-1', { label: 'egm-goldfish-logic' });
  const plainChild = h.liveChild('plain-1', { label: 'researcher' });
  const failure = { code: 'RATE_LIMIT', message: 'boom' };
  // The exempt child's failure is passed through untouched — no retry verdict.
  const out = await h.error(exemptChild, failure, 'passthrough');
  assert.equal(out, 'passthrough');
  // ...and its failure leaves no pending switch: the rebuilt request is the seed.
  const seed = { provider: 'p', model: 'a', reasoningEffort: 'high', maxTokens: 5 };
  const untouched = await h.request(exemptChild, seed);
  assert.equal(untouched, seed);
  // The plain child still fails over: error asks for a retry, and the rebuilt
  // request is swapped to the second pool entry (the inherited effort is
  // dropped because it belongs to the route that just failed).
  const verdict = await h.error(plainChild, failure, undefined);
  assert.deepEqual(verdict, { kind: 'retry' });
  const switched = await h.request(plainChild, seed);
  assert.equal(switched.provider, 'q');
  assert.equal(switched.model, 'b');
  assert.equal(switched.maxTokens, 5);
  assert.equal(switched.reasoningEffort, undefined);
  h.dispose();
});

test('schema: exemptRules accepts UI-shaped rules and defaults to []', () => {
  // Imported lazily so the harness import above stays the only module cost.
  return import('../lib/index.js').then((mod) => {
    const read = (v) => (v !== null && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v);
    const resolved = mod.Config({});
    assert.deepEqual(read(resolved.exemptRules), []);
    const filled = mod.Config({
      exemptRules: [
        { match: 'cwd', pattern: '/ws/.egm' },
        { name: 'n', match: 'label', pattern: 'egm-goldfish-', provider: 'tp', model: 'tm', effort: 'tmax' }
      ]
    });
    assert.deepEqual(read(filled.exemptRules), [
      { name: '', match: 'cwd', pattern: '/ws/.egm', provider: '', model: '', effort: '' },
      { name: 'n', match: 'label', pattern: 'egm-goldfish-', provider: 'tp', model: 'tm', effort: 'tmax' }
    ]);
  });
});

test('observed birth identities feed the point-and-pick candidates', async () => {
  const h = harness();
  // A spawn through the wrapper is recorded — the integration the editor's
  // pick list relies on (egm's exact dispatch shape).
  h.ctx.subagents.startActivation(goldfishSpawn({
    request: { agentPreset: 'egm-goldfish-0.2.0', cwd: 'C:/rooms/.egm/review-abc' }
  }));
  const suggestions = birthSeenSuggestions();
  assert.ok(suggestions.some((item) => item.kind === 'label' && item.value === 'egm-goldfish-logic'));
  // The preset suggestion is version-less so the rule survives plugin upgrades.
  assert.ok(suggestions.some((item) => item.kind === 'preset' && item.value === 'egm-goldfish'));
  // The candidates endpoint serves the same list, loopback-only like its siblings.
  const route = h.routes.find((entry) => entry.path === '/subagent-role-router');
  assert.ok(route, 'the plugin must claim /subagent-role-router');
  const req = {
    method: 'GET',
    url: '/subagent-role-router/exempt-candidates',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    on() { return req; },
    destroy() {}
  };
  let status = 0;
  let raw = '';
  const res = { writeHead(code) { status = code; }, end(chunk) { raw += chunk ?? ''; } };
  await route.handler(req, res);
  assert.equal(status, 200);
  const body = JSON.parse(raw);
  assert.equal(body.ok, true);
  assert.ok(body.value.candidates.some((item) => item.kind === 'label' && item.value === 'egm-goldfish-logic'));
  // Direct seeding also works (a plugin observed outside this process).
  noteBirthSeen({ label: 'other-plugin-worker' }, {});
  assert.ok(birthSeenSuggestions().some((item) => item.kind === 'label' && item.value === 'other-plugin-worker'));
});
