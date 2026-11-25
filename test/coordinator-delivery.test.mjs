import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCoordinatorTask,
  coordinatorAllRoutes,
  coordinatorGroupForBirth,
  coordinatorGroupRoutes,
  hostGateModels,
  hostWhitelistModels,
  isCoordinatorRoute,
  pickCoordinatorRoute
} from '../lib/index.js';

// THE FOURTH LIST: 交付执行 (delivery).
//
// It exists because a packaging/upload job is not a code change: the goal is
// already decided, the steps are known, and what proves the work is a receipt.
// Running those on the backend models priced every upload like a refactor.
//
// Pinned here:
//   1. What belongs on the delivery list, and the three boundaries that keep it
//      from swallowing the other lists (audit of a release stays research; a
//      read-then-upload chain stays backend; a delivery FAILURE investigation
//      stays backend).
//   2. An empty delivery list is not a hole: it follows the backend list, which
//      is where those jobs ran before the split.
//   3. Delivery routes are reserved exactly like the other three lists.

function section(extra = {}) {
  return {
    provider: 'magpie',
    model: '',
    models: [{ provider: 'magpie', model: 'group/dnq' }],
    roleMode: false,
    exploreModels: [],
    planModels: [],
    patchModels: [],
    exploreProvider: '',
    exploreModel: '',
    planProvider: '',
    planModel: '',
    patchProvider: '',
    patchModel: '',
    teamModelProvider: '',
    teamModelName: '',
    exemptRules: [],
    coordinatorEnabled: true,
    coordinatorPresetPrefix: 'dsh-orchestrator-worker',
    coordinatorUiModels: [{ provider: 'magpie', model: 'ui-model-a' }],
    coordinatorResearchModels: [{ provider: 'magpie', model: 'research-a' }],
    coordinatorDeliveryModels: [
      { provider: 'magpie', model: 'deliver-a' },
      { provider: 'magpie', model: 'deliver-b' }
    ],
    coordinatorBackendModels: [{ provider: 'magpie', model: 'be-model-a' }],
    coordinatorCooldownPreset: 'medium',
    coordinatorCooldownSteps: [],
    coordinatorCooldownCap: 0,
    coordinatorNoFallback: false,
    ...extra
  };
}

function state(extra = {}) {
  const live = section(extra.section);
  return {
    getSection: () => live,
    coordGroupOfChild: new Map(),
    coordCooldown: new Map(),
    childRoutes: new Map(),
    roleOfChild: new Map()
  };
}

test('chores go to the delivery list', () => {
  const delivery = [
    '打包上传 5.99 到线上',
    '发布 5.99',
    '构建并签名安装包',
    '重跑回归测试并回执',
    '清理旧安装包',
    '截图取证',
    '批量重命名表盘文件',
    '把 5.99 包传上去',
    '导出这一周的构建日志'
  ];
  for (const label of delivery) {
    assert.equal(classifyCoordinatorTask(label, '').group, 'delivery', label);
  }
});

test('an audit of the release process is still an audit', () => {
  assert.equal(classifyCoordinatorTask('审计发布流程的合规缺口', '').group, 'research');
  assert.equal(classifyCoordinatorTask('盘点表盘内容供给', '').group, 'research');
  assert.equal(classifyCoordinatorTask('排查线上报错原因', '').group, 'research');
});

test('a change that ends in an upload stays backend, not two lists', () => {
  assert.equal(classifyCoordinatorTask('修复打包脚本的上传超时', '').group, 'backend');
  assert.equal(classifyCoordinatorTask('改造发布流程并上线', '').group, 'backend');
});

test('a delivery FAILURE investigation needs a decision, so it goes to backend', () => {
  assert.equal(classifyCoordinatorTask('构建失败的深度排查', '').group, 'backend');
  assert.equal(classifyCoordinatorTask('排查上传卡住的原因', '').group, 'backend');
});

test('the coordinator can name the delivery list, and a tag works too', () => {
  const named = classifyCoordinatorTask('组：交付执行 把包传上去', '');
  assert.equal(named.group, 'delivery');
  assert.equal(named.reason, 'directive');
  const english = classifyCoordinatorTask('whatever', 'group: delivery');
  assert.equal(english.group, 'delivery');
  const tagged = classifyCoordinatorTask('【交付】清理缓存并重跑', '');
  assert.equal(tagged.group, 'delivery');
  assert.equal(tagged.reason, 'tag');
  // The other lists' directives still name themselves.
  assert.equal(classifyCoordinatorTask('check this', 'group: backend').group, 'backend');
  assert.equal(classifyCoordinatorTask('看下配色', '组：UI 绘制').group, 'ui');
});

test('a child born with a packaging title lands on the delivery list', () => {
  const decided = coordinatorGroupForBirth(state(), { label: '打包上传 5.99 到线上' }, { agentPreset: 'dsh-orchestrator-worker' });
  assert.equal(decided.group, 'delivery');
  // An ordinary child (no coordinator preset) is never touched.
  assert.equal(coordinatorGroupForBirth(state(), { label: '打包上传' }, {}), undefined);
});

test('an empty delivery list follows the backend list', () => {
  const empty = section({ coordinatorDeliveryModels: [] });
  assert.deepEqual(coordinatorGroupRoutes(empty, 'delivery'), [{ provider: 'magpie', model: 'be-model-a' }]);
  // A configured list keeps its own order and top entry.
  const own = section();
  assert.deepEqual(coordinatorGroupRoutes(own, 'delivery').map((route) => route.model), ['deliver-a', 'deliver-b']);
  assert.equal(pickCoordinatorRoute({ getSection: () => own, coordCooldown: new Map() }, 'delivery').model, 'deliver-a');
});

test('delivery routes are reserved like the other three lists', () => {
  const live = section();
  assert.ok(coordinatorAllRoutes(live).some((route) => route.model === 'deliver-a'));
  assert.equal(isCoordinatorRoute(live, { provider: 'magpie', model: 'deliver-a' }), true);
  // Ordinary children cannot be given a delivery route...
  assert.ok(!hostWhitelistModels(live).some((route) => route.model === 'deliver-a'));
  // ...while the host's single gate still receives it for the coordinator's child.
  assert.ok(hostGateModels(live).some((route) => route.model === 'deliver-a'));
});
