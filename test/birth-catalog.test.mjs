import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

// BIRTH-TIME EXISTENCE CHECK — the failure that motivated it (2026-11-24,
// session-7a929cab): two coordinator children were created and died instantly
// with `pi-ai provider "magpie-responses" has no configured model
// "codex/gpt-6.2-sol"` because the gateway had retired that model while the
// page still named it first. No request was ever made, so neither failover nor
// the stall watchdog could see it.
//
// The check is synchronous at birth (startActivation hands back its receipt
// synchronously), so it reads a warm cache filled in the background:
//   1. a row the provider provably no longer serves is skipped, next used;
//   2. "cannot verify" (no llm service / provider absent from the catalog /
//      fetch failed) keeps the old behaviour — a catalog outage must never
//      look like a dead config;
//   3. the skip is logged.

const config = {
  roleMode: false,
  injectRouteContext: false,
  failoverEnabled: true,
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
  const warns = [];
  const spawns = [];
  const parent = { id: 'session-parent', session: { snapshotEvents: () => [] }, options: { provider: 'parent', model: 'parent' } };

  const ctx = {
    logger: { warn: (...args) => warns.push(args.join(' ')), info: () => {} },
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
      // The spawn wrapper only installs on the `subagents` fiber; without this
      // the harness would happily "pass" while nothing rewrote the spawn.
      if (names.includes('subagents')) fn(ctx);
    },
    get(key) {
      if (key === 'llm' && options.catalog) {
        return {
          async listModels(provider) {
            if (options.catalogFail) throw new Error('catalog unavailable');
            return options.catalog[provider] ?? [];
          }
        };
      }
      if (key === 'agents') return { get: () => undefined };
      return undefined;
    },
    subagents: {
      async startActivation(spec) {
        spawns.push(spec);
        return { childId: 'child-x', spec };
      },
      async start(request) {
        spawns.push(request);
        return request;
      },
      async startContinuable(spec) {
        spawns.push(spec);
        return { spec };
      }
    }
  };

  apply(ctx, settings);
  return {
    ctx,
    warns,
    spawns,
    parent,
    async flush() {
      // Let the background catalog refresh settle.
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    },
    dispose() { for (const fn of cleanups.reverse()) fn(); }
  };
}

const catalogWith = (models) => ({ 'magpie-responses': models });

test('birth routes a coordinator child onto a model the provider still serves', async () => {
  const h = harness(config, { catalog: catalogWith([{ id: 'codex/gpt-6.1-sol' }]) });
  await h.flush();
  await h.ctx.subagents.startActivation({
    label: 'table watch batch convert',
    agentPreset: 'dsh-orchestrator-worker',
    parent: h.parent,
    prompt: '做一个批量转换脚本'
  });
  const spec = h.spawns.at(-1);
  assert.deepEqual(spec.agentOptions, { provider: 'magpie', model: 'group/1017' });
  assert.ok(h.warns.some((line) => line.includes('does not serve this model')), 'the skip must be visible in the log');
  h.dispose();
});

test('a dead row when the catalog cannot tell keeps the old behaviour', async () => {
  // No llm service at all: nothing can be verified, so the configured head runs.
  const h = harness(config, {});
  await h.flush();
  await h.ctx.subagents.startActivation({
    label: 'table watch batch convert',
    agentPreset: 'dsh-orchestrator-worker',
    parent: h.parent,
    prompt: '做一个批量转换脚本'
  });
  assert.deepEqual(h.spawns.at(-1).agentOptions, { provider: 'magpie-responses', model: 'codex/gpt-6.2-sol' });
  h.dispose();
});

test('a catalog that answers for a provider but not the model means skip; failing catalog means keep', async () => {
  const known = harness(config, { catalog: { magpie: [{ id: 'group/1017' }], 'magpie-responses': [] } });
  await known.flush();
  await known.ctx.subagents.startActivation({
    label: 'table watch batch convert',
    agentPreset: 'dsh-orchestrator-worker',
    parent: known.parent,
    prompt: '做一个批量转换脚本'
  });
  // magpie-responses answered with an empty list = "serves nothing", which is
  // not usable as proof; only a non-empty answer counts as knowledge. So the
  // configured head stays and the next route is NOT silently chosen.
  assert.deepEqual(known.spawns.at(-1).agentOptions, { provider: 'magpie-responses', model: 'codex/gpt-6.2-sol' });
  known.dispose();

  const broken = harness(config, { catalog: catalogWith([{ id: 'codex/gpt-6.1-sol' }]), catalogFail: true });
  await broken.flush();
  await broken.ctx.subagents.startActivation({
    label: 'table watch batch convert',
    agentPreset: 'dsh-orchestrator-worker',
    parent: broken.parent,
    prompt: '做一个批量转换脚本'
  });
  assert.deepEqual(broken.spawns.at(-1).agentOptions, { provider: 'magpie-responses', model: 'codex/gpt-6.2-sol' });
  broken.dispose();
});
