import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyCoordinatorTask,
  coordinatorAllRoutes,
  coordinatorGroupRoutes,
  coordinatorGroupStatus,
  coordinatorGroupForBirth,
  coordinatorWaitMinutes,
  hostGateModels,
  hostWhitelistModels,
  isCoordinatorRoute,
  noteCoordinatorFailure,
  pickCoordinatorRoute,
  resolveRolePool
} from '../lib/index.js';

// THE SECOND PAIR OF LISTS.
//
// One plugin (dsh-orchestrator by default) dispatches every unit of work as a
// child session whose title says what KIND of work it is. Visual work and
// backend work need different models, and neither may borrow from the other
// world. What is pinned here:
//
//   1. Classification: an explicit 【UI】/【后端】 tag wins; words decide when
//      there is no tag; a tie or no evidence falls back to BACKEND.
//   2. Isolation: a route either list reserves disappears from the general
//      whitelist, from every role pool, and from the gate's "ordinary" answer —
//      while the HOST gate still receives the union (it has only one list).
//   3. Order: the first entry serves; a failure cools it for the graded wait;
//      the next entry serves meanwhile; once the wait expires the first entry
//      is tried again.
//   4. Ownership: only a child born with the coordinator's preset (or nested
//      under one) is routed here — an ordinary child never is.

function section(extra = {}) {
  return {
    provider: 'magpie',
    model: '',
    models: [
      { provider: 'magpie', model: 'group/dnq' },
      { provider: 'magpie', model: 'group/1017' }
    ],
    roleMode: true,
    exploreModels: [],
    planModels: [],
    patchModels: [],
    exploreProvider: 'magpie',
    exploreModel: 'antigravity/gemini-3.8-flash',
    planProvider: '',
    planModel: '',
    patchProvider: '',
    patchModel: '',
    teamModelProvider: '',
    teamModelName: '',
    exemptRules: [],
    coordinatorEnabled: true,
    coordinatorPresetPrefix: 'dsh-orchestrator-worker',
    coordinatorUiModels: [
      { provider: 'magpie', model: 'ui-model-a' },
      { provider: 'magpie', model: 'ui-model-b' }
    ],
    coordinatorBackendModels: [{ provider: 'magpie', model: 'be-model-a' }],
    coordinatorCooldownPreset: 'medium',
    coordinatorCooldownSteps: [],
    coordinatorCooldownCap: 0,
    coordinatorNoFallback: false,
    ...extra
  };
}

function state(overrides = {}) {
  const live = section(overrides.section);
  return {
    getSection: () => live,
    coordGroupOfChild: new Map(),
    coordCooldown: new Map(),
    childRoutes: new Map(),
    roleOfChild: new Map()
  };
}

// ── 1. classification ────────────────────────────────────────────────────────

test('an explicit 【UI】 tag beats every keyword', () => {
  const result = classifyCoordinatorTask('【UI】顺手修一下数据库迁移', '');
  assert.equal(result.group, 'ui');
  assert.equal(result.reason, 'tag');
});

test('an explicit 【后端】 tag beats every keyword', () => {
  const result = classifyCoordinatorTask('【后端】画个 SVG 图标', '');
  assert.equal(result.group, 'backend');
  assert.equal(result.reason, 'tag');
});

test('without a tag the words decide, and the evidence names them', () => {
  const ui = classifyCoordinatorTask('给设置页画个 SVG 动画', '');
  assert.equal(ui.group, 'ui');
  assert.equal(ui.reason, 'keyword');
  assert.match(ui.evidence, /svg|动画/);
  const backend = classifyCoordinatorTask('修复数据库迁移脚本', '');
  assert.equal(backend.group, 'backend');
  assert.match(backend.evidence, /数据库|迁移/);
});

test('a tie or no evidence at all falls back to backend', () => {
  assert.equal(classifyCoordinatorTask('改一下 svg 的接口', '').group, 'backend');
  assert.equal(classifyCoordinatorTask('随便做点什么', '').group, 'backend');
  assert.equal(classifyCoordinatorTask('', '').reason, 'default');
});

test('a tag in the description body also counts', () => {
  const result = classifyCoordinatorTask('顺手修一下', '【UI】把按钮画出来');
  assert.equal(result.group, 'ui');
  assert.equal(result.reason, 'tag');
});

// ── 2. isolation ─────────────────────────────────────────────────────────────

test('a reserved route leaves the general whitelist but reaches the host gate', () => {
  const live = section();
  const general = hostWhitelistModels(live).map((route) => `${route.provider}/${route.model}`);
  assert.ok(!general.includes('magpie/ui-model-a'), 'a UI-list route must not be offered to ordinary children');
  assert.ok(general.includes('magpie/group/dnq'), 'unreserved routes stay');

  const gate = hostGateModels(live).map((route) => `${route.provider}/${route.model}`);
  assert.ok(gate.includes('magpie/ui-model-a'), 'the single global gate has to approve it for the coordinator child');
  assert.ok(gate.includes('magpie/group/dnq'));
});

test('a reserved route is dropped even when a role pool also names it', () => {
  const live = section({
    patchModels: [
      { provider: 'magpie', model: 'ui-model-a' },
      { provider: 'magpie', model: 'group/dnq' }
    ]
  });
  const pooled = resolveRolePool(live, 'patch').map((route) => route.model);
  assert.deepEqual(pooled, ['group/dnq'], 'the reservation wins over the role pool');
});

test('the old single-model role form is filtered too', () => {
  const live = section({ exploreModel: 'ui-model-b' });
  const pooled = resolveRolePool(live, 'explore').map((route) => route.model);
  assert.deepEqual(pooled, [], 'a legacy single route that is reserved is not handed out');
});

test('isCoordinatorRoute answers exactly for the two lists', () => {
  const live = section();
  assert.equal(isCoordinatorRoute(live, { provider: 'magpie', model: 'ui-model-a' }), true);
  assert.equal(isCoordinatorRoute(live, { provider: 'magpie', model: 'be-model-a' }), true);
  assert.equal(isCoordinatorRoute(live, { provider: 'magpie', model: 'group/dnq' }), false);
});

test('both lists resolve in page order, deduped', () => {
  const live = section({
    coordinatorUiModels: [
      { provider: 'magpie', model: 'a' },
      { provider: 'magpie', model: 'b' },
      { provider: 'magpie', model: 'a' }
    ]
  });
  assert.deepEqual(coordinatorGroupRoutes(live, 'ui').map((route) => route.model), ['a', 'b']);
  assert.deepEqual(coordinatorAllRoutes(live).map((route) => route.model), ['a', 'b', 'be-model-a']);
});

// ── 3. order, cooldown gradient, return to the first ─────────────────────────

test('the first entry serves while nothing is cooling', () => {
  const live = section();
  const st = state();
  const picked = pickCoordinatorRoute(st, 'ui');
  assert.equal(picked.model, 'ui-model-a');
});

test('a failed entry cools for the graded wait and the next one serves', () => {
  const live = section();
  const st = state();
  const first = { provider: 'magpie', model: 'ui-model-a' };

  const wait1 = noteCoordinatorFailure(st, 'ui', first, { code: 'SERVER' });
  assert.equal(wait1, 1, 'first failure in the medium preset waits one minute');
  assert.notEqual(pickCoordinatorRoute(st, 'ui').model, 'ui-model-a', 'the cooling entry steps aside');

  const wait2 = noteCoordinatorFailure(st, 'ui', first, { code: 'SERVER' });
  assert.equal(wait2, 5, 'a second failure escalates');

  const wait3 = noteCoordinatorFailure(st, 'ui', first, { code: 'SERVER' });
  assert.equal(wait3, 15, 'a third failure reaches the last step');

  const wait4 = noteCoordinatorFailure(st, 'ui', first, { code: 'SERVER' });
  assert.equal(wait4, 15, 'the last step repeats instead of growing forever');
});

test('a rate limit starts one step further into the gradient', () => {
  const live = section();
  const st = state();
  assert.equal(noteCoordinatorFailure(st, 'ui', { provider: 'magpie', model: 'ui-model-b' }, { code: 'RATE_LIMIT' }), 5);
});

test('the light and heavy presets hold their own ladders', () => {
  for (const [preset, expected] of [['light', [1, 3, 5]], ['heavy', [2, 10, 30]]]) {
    const live = section({ coordinatorCooldownPreset: preset });
    assert.deepEqual(expected.map((_v, index) => coordinatorWaitMinutes(live, index + 1)), expected);
  }
});

test('a custom ladder is honoured and capped', () => {
  const live = section({
    coordinatorCooldownPreset: 'custom',
    coordinatorCooldownSteps: [2, 4, 8],
    coordinatorCooldownCap: 6
  });
  assert.equal(coordinatorWaitMinutes(live, 1), 2);
  assert.equal(coordinatorWaitMinutes(live, 2), 4);
  assert.equal(coordinatorWaitMinutes(live, 3), 6, 'the cap wins over the last step');
});

test('expired cooldowns return the first entry to the front', () => {
  const live = section();
  const st = state();
  const first = { provider: 'magpie', model: 'ui-model-a' };
  noteCoordinatorFailure(st, 'ui', first, { code: 'SERVER' });
  // Simulate the wait being over.
  for (const entry of st.coordCooldown.values()) entry.until = Date.now() - 1;
  assert.equal(pickCoordinatorRoute(st, 'ui').model, 'ui-model-a', 'the wait is over: entry one is tried again');
  assert.equal(st.coordCooldown.size, 0, 'the expired record is dropped, so the ladder restarts from the bottom');
});

test('when every entry is cooling the soonest one is used anyway', () => {
  const st = state();
  st.coordCooldown.set('ui\u0000magpie/ui-model-a', { until: Date.now() + 60_000, strikes: 1 });
  st.coordCooldown.set('ui\u0000magpie/ui-model-b', { until: Date.now() + 10_000, strikes: 1 });
  assert.equal(pickCoordinatorRoute(st, 'ui').model, 'ui-model-b', 'a degraded route beats no route');
});

test('a nested delegation stays in the same list as its parent', () => {
  const live = section();
  const st = state();
  st.coordGroupOfChild.set('parent-1', { group: 'ui', reason: 'tag', evidence: '标题命中【UI】' });
  const nested = coordinatorGroupForBirth(st, { label: '就算标题写的是后端也无所谓' }, {
    agentPreset: 'dsh-orchestrator-worker',
    parent: { id: 'parent-1' },
    cwd: '/tmp/x'
  });
  assert.equal(nested.group, 'ui', 'the parent list wins over the words');
});

// ── 4. ownership ─────────────────────────────────────────────────────────────

test('only the coordinator preset reaches these lists', () => {
  const st = state();
  const ordinary = coordinatorGroupForBirth(st, { label: '【UI】画个图' }, {
    agentPreset: 'standard',
    cwd: '/tmp/x'
  });
  assert.equal(ordinary, undefined, 'an ordinary child is never routed here');

  const coordinator = coordinatorGroupForBirth(st, { label: '【UI】画个图' }, {
    agentPreset: 'dsh-orchestrator-worker',
    cwd: '/tmp/x'
  });
  assert.equal(coordinator.group, 'ui');
});

test('switching the feature off leaves everything to the general lists', () => {
  const st = state({ section: { coordinatorEnabled: false } });
  assert.equal(coordinatorGroupForBirth(st, { label: '【UI】画个图' }, { agentPreset: 'dsh-orchestrator-worker' }), undefined);
  assert.equal(hostWhitelistModels(st.getSection()).length > 0, true, 'nothing is reserved when the feature is off');
});

test('an empty reservation makes the general list whole again', () => {
  const live = section({ coordinatorUiModels: [], coordinatorBackendModels: [] });
  const general = hostWhitelistModels(live).map((route) => route.model);
  assert.ok(general.includes('group/dnq'));
  assert.equal(hostGateModels(live).length, general.length);
});

test('the status view reports order, default and cooldown per route', () => {
  const live = section();
  const st = state();
  noteCoordinatorFailure(st, 'ui', { provider: 'magpie', model: 'ui-model-a' }, { code: 'SERVER' });
  const rows = coordinatorGroupStatus(st, 'ui');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].defaulted, true);
  assert.equal(rows[0].cooling, true);
  assert.equal(rows[1].cooling, false);
});

test('getSection exposes every coordinator field (a schema field missing there is invisible)', () => {
  // getSection() is an explicit field-by-field view of the live config. A field
  // present in the schema but missing from that view reads as `undefined` on a
  // real profile while every unit test built from a hand-written section object
  // still passes — the exact way this feature first shipped "working" and empty.
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  for (const field of [
    'coordinatorEnabled',
    'coordinatorPresetPrefix',
    'coordinatorUiModels',
    'coordinatorBackendModels',
    'coordinatorCooldownPreset',
    'coordinatorCooldownSteps',
    'coordinatorCooldownCap',
    'coordinatorNoFallback'
  ]) {
    assert.ok(source.includes(field + ': unwrap(raw.' + field + ')'), 'getSection must expose ' + field);
  }
});


test('the two lists use the pool entry schema, not the strict one', () => {
  // MODEL_ENTRY declares `reasoningEffort` as a REQUIRED key; a hand-written
  // config (and the card's own save) omits it whenever no effort was picked. The
  // array would then fail validation and silently resolve to `[]` -- the list
  // reads as empty on a real profile while every unit test still passes. That is
  // exactly what happened on the first live run of this feature.
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.match(source, /coordinatorUiModels: volatileField\(z\.array\(POOL_ENTRY\)/);
  assert.match(source, /coordinatorBackendModels: volatileField\(z\.array\(POOL_ENTRY\)/);
});