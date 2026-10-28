import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

// Agent-teams members: the spawn interface has no model picker (the tool layer
// hardcodes the placeholder providers "spawn"/"fork" and every member lands on
// the team default), so this plugin adds TWO things:
//
//   1. A birth model: `teamModelProvider/Name/Effort` are written into the
//      spawn's agentOptions exactly like routeDelegation does for plain
//      subagents — but WITHOUT lanes, cooldowns, or failover, so team semantics
//      stay untouched. An explicit agentOptions on the spawn still wins.
//   2. Live re-routing: a teammate is just another subagent child (the teams
//      service spawns through `startActivation`), so the override endpoint
//      accepts team members too. The AUTOMATIC failover keeps excluding them
//      (`isSubagentAgent`), because an explicit user pick is not automatic.

const config = {
  teamModelProvider: 'tp',
  teamModelName: 'tm',
  teamModelEffort: 'tmax',
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
        // The team spawn path: `startActivation` is what the teams service
        // calls for each member. Record the spec it received.
        const subagents = {
          startActivation(spec) {
            spawns.push(spec);
            return { childId: spec.childId };
          },
          startContinuable(spec) {
            spawns.push(spec);
            return { childId: spec.childId };
          },
          start(childId, request) {
            spawns.push({ childId, request });
            return Promise.resolve({ childId });
          }
        };
        fn({ logger: ctx.logger, on: ctx.on, effect: ctx.effect, subagents });
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

  /** Register a live child the way the host would. Team members differ only in the label. */
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

  return { ctx, agents, routes, spawns, warnings, request, error, call, liveChild, dispose() { for (const fn of cleanups.reverse()) fn(); } };
}

/** The spec the teams service passes for one member. */
const teamSpawn = (childId) => ({
  childId,
  provider: 'spawn',
  label: 'agent-teams: worker',
  request: { prompt: [{ type: 'text', text: 'do the thing' }], parent: { id: 'lead' } }
});

const childPayload = (agent) => ({ turn: 0, step: 0, agent });

test('a team spawn is born on the configured team model', async () => {
  const listeners = new Map();
  const cleanups = [];
  const spawns = [];
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on(name, fn) {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
      return () => {};
    },
    effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off); },
    inject(names, fn) {
      if (names.includes('subagents')) {
        const subagents = {
          startActivation(spec) { spawns.push(spec); return { childId: spec.childId }; },
          startContinuable(spec) { spawns.push(spec); return { childId: spec.childId }; },
          start(id, request) { spawns.push({ childId: id, request }); return Promise.resolve({ childId: id }); }
        };
        fn({ logger: ctx.logger, on: ctx.on, effect: ctx.effect, subagents });
        ctx.subagents = subagents;
      }
    },
    get() { return undefined; }
  };
  apply(ctx, config);
  assert.equal(typeof ctx.subagents.startActivation, 'function');
  ctx.subagents.startActivation(teamSpawn('m1'));
  assert.equal(spawns.length, 1);
  const received = spawns[0];
  assert.deepEqual(received.request.agentOptions, { provider: 'tp', model: 'tm', reasoningEffort: 'tmax' });
  // The spawn mode provider ("spawn") is the teams service's own concern and
  // must survive untouched.
  assert.equal(received.provider, 'spawn');
  for (const off of cleanups.reverse()) off();
});

test('without a team model the spawn is left alone', async () => {
  const listeners = new Map();
  const cleanups = [];
  const spawns = [];
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on(name, fn) {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
      return () => {};
    },
    effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off); },
    inject(names, fn) {
      if (names.includes('subagents')) {
        const subagents = {
          startActivation(spec) { spawns.push(spec); return { childId: spec.childId }; },
          startContinuable(spec) { spawns.push(spec); return { childId: spec.childId }; },
          start(id, request) { spawns.push({ childId: id, request }); return Promise.resolve({ childId: id }); }
        };
        fn({ logger: ctx.logger, on: ctx.on, effect: ctx.effect, subagents });
        ctx.subagents = subagents;
      }
    },
    get() { return undefined; }
  };
  apply(ctx, { injectRouteContext: false, failoverEnabled: false, models: [] });
  ctx.subagents.startActivation(teamSpawn('m2'));
  assert.equal(spawns[0].request.agentOptions, undefined);
  for (const off of cleanups.reverse()) off();
});

test('an explicit agentOptions on a team spawn wins over the birth model', async () => {
  const listeners = new Map();
  const cleanups = [];
  const spawns = [];
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on(name, fn) {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
      return () => {};
    },
    effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off); },
    inject(names, fn) {
      if (names.includes('subagents')) {
        const subagents = {
          startActivation(spec) { spawns.push(spec); return { childId: spec.childId }; },
          startContinuable(spec) { spawns.push(spec); return { childId: spec.childId }; },
          start(id, request) { spawns.push({ childId: id, request }); return Promise.resolve({ childId: id }); }
        };
        fn({ logger: ctx.logger, on: ctx.on, effect: ctx.effect, subagents });
        ctx.subagents = subagents;
      }
    },
    get() { return undefined; }
  };
  apply(ctx, config);
  const spec = teamSpawn('m3');
  spec.request.agentOptions = { provider: 'x', model: 'chosen' };
  ctx.subagents.startActivation(spec);
  assert.deepEqual(spawns[0].request.agentOptions, { provider: 'x', model: 'chosen' });
  for (const off of cleanups.reverse()) off();
});

test('the override endpoint accepts an agent-teams member and re-routes it', async () => {
  const h = harness();
  const member = h.liveChild('m4', { label: 'agent-teams: worker' });

  const read = await h.call({ method: 'GET', path: '/subagent-role-router/route?childId=m4' });
  assert.equal(read.status, 200);
  assert.equal(read.body.ok, true, 'a team member is a live child for the override');
  assert.equal(read.body.value.model, 'a');

  const selected = await h.call({
    path: '/subagent-role-router/select',
    body: { childId: 'm4', provider: 'q', model: 'b', reasoningEffort: 'high' }
  });
  assert.equal(selected.status, 200);
  assert.equal(selected.body.ok, true);

  const after = await h.request(childPayload(member), { provider: 'p', model: 'a', maxTokens: 4096 });
  assert.equal(after.provider, 'q');
  assert.equal(after.model, 'b');
  assert.equal(after.reasoningEffort, 'high');
  assert.equal(after.maxTokens, 4096);
  h.dispose();
});

test('automatic failover still skips agent-teams members', async () => {
  const h = harness();
  const member = h.liveChild('m5', { label: 'agent-teams: worker' });
  const seeded = { provider: 'p', model: 'a' };
  const passed = await h.error(member, { code: 'TIMEOUT', message: 'slow' }, seeded);
  assert.equal(passed, seeded, 'teams are exempt from the automatic switch');
  h.dispose();
});
