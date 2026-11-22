import test from 'node:test';
import assert from 'node:assert/strict';
import { childPageRoutes, pickPageRoute, pickWhitelistRoute, hostWhitelistModels } from '../lib/index.js';

// ONE CHILD, ONE LIST — for the MODEL PICKER too.
//
// Live evidence (session-7a929cab, child 4b3a34b9-…): the picker on a
// coordinator child already showed only its group (「按「后端处理」组 · 3 个
// 模型」), but `/select` judged the pick against the GENERAL list, which by
// design excludes every coordinator route. Picking a group model therefore
// looked unapproved and the backend substituted the general list's first route
// — the child was switched onto flash-eco, the one model its page never offered.
// What is pinned here:
//
//   1. A coordinator child's page is its group, and every group model is approved;
//   2. an outside pick substitutes INSIDE the group (same provider first);
//   3. an ordinary child keeps the general behaviour — no regression;
//   4. an emptied group falls back to the general list instead of dead-ending.

const CHILD = '4b3a34b9-0691-480e-9495-699762d5570a';

function section(extra = {}) {
  return {
    provider: 'magpie',
    model: '',
    models: [{ provider: 'magpie', model: 'opendesign/deepseek-v4.1-flash-eco' }],
    roleMode: true,
    exploreModels: [],
    planModels: [],
    patchModels: [],
    teamModelProvider: '',
    teamModelName: '',
    coordinatorEnabled: true,
    coordinatorPresetPrefix: 'dsh-orchestrator-worker',
    coordinatorUiModels: [{ provider: 'magpie-anthropic', model: 'agy-cli/gemini-4-hydrogen' }],
    coordinatorResearchModels: [{ provider: 'magpie', model: 'group/dnq' }],
    coordinatorBackendModels: [
      { provider: 'magpie-responses', model: 'codex/gpt-6.2-sol' },
      { provider: 'magpie', model: 'group/1017' },
      { provider: 'magpie', model: 'group/dnq' }
    ],
    coordinatorCooldownPreset: 'medium',
    coordinatorCooldownSteps: [],
    coordinatorCooldownCap: 0,
    coordinatorNoFallback: false,
    ...extra
  };
}

/** A live-ish state whose ledger already holds this child on `group`. */
function state(group = 'backend', extra = {}) {
  const live = section(extra);
  const ledger = new Map();
  if (group !== null) ledger.set(CHILD, { group, reason: 'readonly', evidence: '测试' });
  return { getSection: () => live, coordGroupOfChild: ledger, coordCooldown: new Map(), childRoutes: new Map(), roleOfChild: new Map() };
}

test('the general list really does exclude every coordinator route', () => {
  assert.deepEqual(hostWhitelistModels(section()).map((route) => route.model), ['opendesign/deepseek-v4.1-flash-eco']);
});

test("a coordinator child's page is its own group", () => {
  const page = childPageRoutes(state('backend'), CHILD);
  assert.equal(page.group, 'backend');
  assert.deepEqual(page.routes.map((route) => route.model), ['codex/gpt-6.2-sol', 'group/1017', 'group/dnq']);
  const ordinary = childPageRoutes(state(null), CHILD);
  assert.equal(ordinary.group, undefined);
  assert.deepEqual(ordinary.routes.map((route) => route.model), ['opendesign/deepseek-v4.1-flash-eco']);
});

test('a group model is approved on a coordinator child (the live bug)', () => {
  const st = state('backend');
  // codex/gpt-6.2-sol is on the group and NOT on the general list: the old code
  // read that as "unapproved" and switched the child onto flash-eco.
  assert.equal(pickPageRoute(st, CHILD, { provider: 'magpie-responses', model: 'codex/gpt-6.2-sol' }), null);
  assert.equal(pickPageRoute(st, CHILD, { provider: 'magpie', model: 'group/1017' }), null);
  assert.equal(pickPageRoute(st, CHILD, { provider: 'magpie', model: 'group/dnq' }), null);
});

test('an outside pick on a coordinator child lands INSIDE its group', () => {
  const st = state('backend');
  // Same provider exists in the group -> stay on the provider.
  assert.deepEqual(
    pickPageRoute(st, CHILD, { provider: 'magpie', model: 'opendesign/deepseek-v4.1-flash-eco' }),
    { provider: 'magpie', model: 'group/1017' }
  );
  // No such provider in the group -> the group's first route, never the general one.
  assert.deepEqual(
    pickPageRoute(st, CHILD, { provider: 'magpie-anthropic', model: 'agy-cli/gemini-4-hydrogen' }),
    { provider: 'magpie-responses', model: 'codex/gpt-6.2-sol' }
  );
  const research = state('research');
  assert.deepEqual(
    pickPageRoute(research, CHILD, { provider: 'magpie', model: 'opendesign/deepseek-v4.1-flash-eco' }),
    { provider: 'magpie', model: 'group/dnq' }
  );
});

test('an ordinary child keeps the general behaviour', () => {
  const st = state(null);
  assert.equal(pickPageRoute(st, CHILD, { provider: 'magpie', model: 'opendesign/deepseek-v4.1-flash-eco' }), null);
  assert.deepEqual(
    pickPageRoute(st, CHILD, { provider: 'magpie-responses', model: 'codex/gpt-6.2-sol' }),
    { provider: 'magpie', model: 'opendesign/deepseek-v4.1-flash-eco' }
  );
});

test('an emptied group falls back to the general list instead of dead-ending', () => {
  const st = state('backend', { coordinatorBackendModels: [] });
  const page = childPageRoutes(st, CHILD);
  assert.equal(page.group, undefined);
  assert.equal(pickPageRoute(st, CHILD, { provider: 'magpie', model: 'opendesign/deepseek-v4.1-flash-eco' }), null);
});

test('pickWhitelistRoute still answers the two-argument callers', () => {
  // The exported API is used by the host gate sync too; an explicit route list
  // must be the only change in behaviour.
  const live = section();
  assert.equal(pickWhitelistRoute(live, { provider: 'magpie', model: 'opendesign/deepseek-v4.1-flash-eco' }), null);
  assert.deepEqual(
    pickWhitelistRoute(live, { provider: 'magpie', model: 'nope' }, { routes: [{ provider: 'magpie', model: 'group/dnq' }] }),
    { provider: 'magpie', model: 'group/dnq' }
  );
});
