// The native subagent model gate (`subagent-model-selection-settings`) decides
// whether a child may name a model at all and which routes it may name. Typing
// the same routes twice is how the two lists drift, so this page's pools are
// mirrored into that gate: base pool + the three role pools + the team birth
// model, deduplicated. A route absent from the page therefore stays unreachable
// for a child — the child chooses inside the user's approval, never outside it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, hostWhitelistModels, planDelegatedModelRoute, repairDelegatedModelName, sameWhitelist, syncHostWhitelist } from '../lib/index.js';

const section = {
  provider: 'magpie',
  model: 'group/dnq',
  models: [
    { provider: 'magpie', model: 'group/dnq' },
    { provider: 'magpie', model: 'workbuddy-ai/kimi-k3' },
    { provider: '', model: 'broken' }
  ],
  roleMode: true,
  exploreModels: [{ provider: 'magpie', model: 'antigravity/gemini-3.8-flash' }],
  patchProvider: 'q',
  patchModel: 'b',
  teamModelProvider: 'tp',
  teamModelName: 'tm',
  exemptRules: [{ name: 'egm', match: 'label', pattern: 'egm-', provider: 'other', model: 'never' }]
};

test('the page\'s pools become one deduplicated route list', () => {
  const models = hostWhitelistModels(section);
  assert.deepEqual(models, [
    { provider: 'magpie', model: 'group/dnq' },
    { provider: 'magpie', model: 'workbuddy-ai/kimi-k3' },
    { provider: 'magpie', model: 'antigravity/gemini-3.8-flash' },
    { provider: 'q', model: 'b' },
    { provider: 'tp', model: 'tm' }
  ]);
  // An exemption pin is a birth override, not something a child may choose.
  assert.equal(models.some((entry) => entry.provider === 'other'), false);
  // Nothing configured → nothing to mirror, never an empty enabled gate.
  assert.deepEqual(hostWhitelistModels({}), []);
  assert.deepEqual(hostWhitelistModels(undefined), []);
});

test('route lists compare as sets, not as orderings', () => {
  const left = [{ provider: 'a', model: '1' }, { provider: 'b', model: '2' }];
  assert.equal(sameWhitelist(left, [{ provider: 'b', model: '2' }, { provider: 'a', model: '1' }]), true);
  assert.equal(sameWhitelist(left, [{ provider: 'a', model: '1' }]), false);
  assert.equal(sameWhitelist(undefined, []), true);
});

function fakeCtx({ current, update, hasSettings = true } = {}) {
  const writes = [];
  return {
    writes,
    get(name) {
      if (name === 'settings') {
        return hasSettings ? { update: (...args) => { writes.push(args); return update?.(...args); } } : undefined;
      }
      if (name === 'subagentModelSelection') {
        return {
          current: () => {
            if (typeof current === 'function') return current();
            return current;
          }
        };
      }
      return undefined;
    }
  };
}

const state = { getSection: () => section };

test('an out-of-date gate is rewritten from the page', async () => {
  const ctx = fakeCtx({ current: { enabled: true, allowedModels: [{ provider: 'old', model: 'x' }] } });
  const outcome = await syncHostWhitelist(ctx, state);
  assert.equal(outcome.synced, true);
  assert.equal(ctx.writes.length, 1);
  const [ns, patch] = ctx.writes[0];
  assert.equal(ns, 'subagent-model-selection-settings');
  assert.equal(patch.enabled, true);
  assert.deepEqual(patch.allowedModels, hostWhitelistModels(section));
});

test('a gate that already matches is left untouched', async () => {
  const ctx = fakeCtx({
    current: () => ({ enabled: true, allowedModels: hostWhitelistModels(section).slice().reverse() })
  });
  const outcome = await syncHostWhitelist(ctx, state);
  assert.equal(outcome.synced, false);
  assert.equal(outcome.reason, 'in-sync');
  assert.equal(ctx.writes.length, 0);
});

test('a disabled or unreadable gate is rewritten instead of trusted', async () => {
  const disabled = fakeCtx({ current: { enabled: false, allowedModels: hostWhitelistModels(section) } });
  assert.equal((await syncHostWhitelist(disabled, state)).synced, true);
  // `current()` throws when the gate is enabled with an empty list.
  const throwing = fakeCtx({ current: () => { throw new Error('enabled subagent model selection requires at least one allowed model'); } });
  assert.equal((await syncHostWhitelist(throwing, state)).synced, true);
  assert.equal(throwing.writes.length, 1);
});

test('missing services and empty pages never throw or half-write', async () => {
  const noSettings = fakeCtx({ current: undefined, hasSettings: false });
  const outcome = await syncHostWhitelist(noSettings, state);
  assert.deepEqual(outcome, { synced: false, reason: 'no-settings' });

  const bare = { get: () => undefined };
  assert.equal((await syncHostWhitelist(bare, state)).reason, 'no-settings');

  const empty = fakeCtx({ current: undefined });
  assert.deepEqual(await syncHostWhitelist(empty, { getSection: () => ({}) }), { synced: false, reason: 'no-models' });
  assert.equal(empty.writes.length, 0);
});

test('a spawn mirrors the page into the gate before the child is built', async () => {
  const writes = [];
  const cleanups = [];
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on: () => () => {},
    effect(fn) {
      const off = fn();
      if (typeof off === 'function') cleanups.push(off);
    },
    inject(names, fn) {
      if (!names.includes('subagents')) return;
      const subagents = {
        startActivation(spec) {
          return { childId: spec.childId };
        }
      };
      ctx.subagents = subagents;
      fn({ logger: ctx.logger, on: ctx.on, effect: ctx.effect, subagents, get: ctx.get });
    },
    get(key) {
      if (key === 'settings') return { update: (...args) => { writes.push(args); return Promise.resolve(); } };
      if (key === 'subagentModelSelection') return { current: () => ({ enabled: true, allowedModels: [] }) };
      return undefined;
    }
  };
  apply(ctx, { injectRouteContext: false, models: [{ provider: 'p', model: 'a' }] });
  ctx.subagents.startActivation({ provider: 'spawn', label: 'child-1', request: { prompt: 'hi' } });
  // The spawn must not wait on the write, but it must have started it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'subagent-model-selection-settings');
  assert.deepEqual(writes[0][1].allowedModels, [{ provider: 'p', model: 'a' }]);
  for (const off of cleanups.reverse()) off();
});

// ── display name vs model id ────────────────────────────────────────────────

const routeState = { getSection: () => ({ models: [{ provider: 'magpie', model: 'group/dnq' }, { provider: 'magpie', model: 'antigravity/gemini-3.8-flash' }] }) };

test('a display name becomes the one configured model id', () => {
  const args = { provider: 'magpie', model: 'dnq', description: 'x' };
  const repaired = repairDelegatedModelName(routeState, args);
  assert.deepEqual(repaired, { before: 'dnq', after: 'group/dnq', provider: 'magpie' });
  assert.equal(args.model, 'group/dnq');
  assert.equal(args.provider, 'magpie');

  // Case-insensitive, and the provider may be inferred when only one route matches.
  const lonely = { model: 'Gemini-3.8-Flash' };
  assert.equal(repairDelegatedModelName(routeState, lonely)?.after, 'antigravity/gemini-3.8-flash');
  assert.equal(lonely.provider, 'magpie');
});

test('exact ids, unknown names and ambiguous short names are left alone', () => {
  const exact = { provider: 'magpie', model: 'group/dnq' };
  assert.equal(repairDelegatedModelName(routeState, exact), undefined);

  const unknown = { provider: 'magpie', model: 'nope' };
  assert.equal(repairDelegatedModelName(routeState, unknown), undefined);
  assert.equal(unknown.model, 'nope');

  // Two routes share the tail x → guessing would be a silent wrong pick.
  const ambiguousState = { getSection: () => ({ models: [{ provider: 'a', model: 'x' }, { provider: 'b', model: 'x' }] }) };
  const ambiguous = { model: 'x' };
  assert.equal(repairDelegatedModelName(ambiguousState, ambiguous), undefined);
  assert.equal(ambiguous.model, 'x');

  // Nothing configured → nothing to match against.
  assert.equal(repairDelegatedModelName({ getSection: () => ({}) }, { model: 'dnq' }), undefined);
});

test('the tool waterfall repairs a delegation call before the host preflight', async () => {
  const listeners = new Map();
  const cleanups = [];
  let dispatched;
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on(name, fn) {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
      return () => {};
    },
    effect(fn) {
      const off = fn();
      if (typeof off === 'function') cleanups.push(off);
    },
    inject() {},
    get() { return undefined; }
  };
  apply(ctx, { injectRouteContext: false, models: [{ provider: 'magpie', model: 'group/dnq' }] });

  const waterfall = listeners.get('tools/execute') ?? [];
  assert.equal(waterfall.length, 1);
  const exec = { name: 'subagent', arguments: { provider: 'magpie', model: 'dnq', prompt: 'go' } };
  await waterfall[0](exec, () => { dispatched = { ...exec.arguments }; return Promise.resolve({}); });
  assert.deepEqual(dispatched, { provider: 'magpie', model: 'group/dnq', prompt: 'go' });

  // A tool that is not a delegation still reaches dispatch untouched.
  const other = { name: 'read_file', arguments: { model: 'dnq' } };
  await waterfall[0](other, () => { dispatched = { ...other.arguments }; return Promise.resolve({}); });
  assert.deepEqual(dispatched, { model: 'dnq' });
  for (const off of cleanups.reverse()) off();
});

test('a frozen arguments object is still repaired by replacing it', async () => {
  const listeners = new Map();
  const cleanups = [];
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on(name, fn) {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
      return () => {};
    },
    effect(fn) {
      const off = fn();
      if (typeof off === 'function') cleanups.push(off);
    },
    inject() {},
    get() { return undefined; }
  };
  apply(ctx, { injectRouteContext: false, models: [{ provider: 'magpie', model: 'group/dnq' }] });
  const waterfall = (listeners.get('tools/execute') ?? [])[0];
  const frozen = Object.freeze({ provider: 'magpie', model: 'dnq', prompt: 'go' });
  const exec = { name: 'subagent', arguments: frozen };
  await waterfall(exec, () => Promise.resolve({}));
  assert.notEqual(exec.arguments, frozen);
  assert.equal(exec.arguments.model, 'group/dnq');
  assert.equal(exec.arguments.prompt, 'go');
  for (const off of cleanups.reverse()) off();
});

test('the planner is pure so callers can decide how to apply it', () => {
  const args = { provider: 'magpie', model: 'dnq' };
  const planned = planDelegatedModelRoute(routeState, args);
  assert.deepEqual(planned, { before: 'dnq', provider: 'magpie', model: 'group/dnq' });
  assert.equal(args.model, 'dnq');
});
