import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// THE COORDINATOR CARD'S PURE HALF.
//
// The card itself is React; what can be pinned without a browser is the part
// that carries the contract: the two ordered lists round-trip, a reorder really
// reorders, and the graded cooldown text round-trips. Plus two source-level
// guarantees that a normal unit test cannot reach:
//
//   * the save path writes every coordinator field (a field missing from that
//     list is silently DROPPED on save — the exact bug class this card could
//     introduce), and
//   * the picker asks the backend about THIS page (childId), so a coordinator
//     child sees its own list rather than the general one.
const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function loadClient() {
  let capturedModule = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(module) {
          capturedModule = module;
        }
      }
    },
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, setAttribute() {} }),
      head: { appendChild() {} }
    },
    console
  };
  vm.runInNewContext(clientSource, sandbox, { filename: 'client.js' });
  if (!capturedModule || typeof capturedModule.factory !== 'function') {
    throw new Error('client.js failed to register with __ModuleLoader__');
  }
  const fakeRequire = (id) => {
    if (id === 'react') {
      return {
        createElement: () => null,
        useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
        useEffect: () => {},
        useMemo: (fn) => fn(),
        useRef: (value) => ({ current: value }),
        useCallback: (fn) => fn
      };
    }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      return { Toast: function Toast() {} };
    }
    return {};
  };
  return capturedModule.factory(fakeRequire);
}

const api = loadClient();

// Values built inside the vm carry that realm's prototypes, which deepStrictEqual
// rejects even when every field matches. JSON copies compare the DATA.
const plain = (value) => JSON.parse(JSON.stringify(value));

function section(extra = {}) {
  return {
    provider: 'magpie',
    coordinatorUiModels: [
      { provider: 'magpie', model: 'ui-a' },
      { provider: 'magpie', model: 'ui-b', reasoningEffort: 'high' }
    ],
    coordinatorBackendModels: ['be-a'],
    ...extra
  };
}

test('the two lists round-trip in order, bare strings use the section provider', () => {
  const value = section();
  const ui = api.normalizeCoordinatorRoutes(value, 'ui');
  const backend = api.normalizeCoordinatorRoutes(value, 'backend');
  assert.deepEqual(plain(ui.map((row) => row.model)), ['ui-a', 'ui-b']);
  assert.equal(ui[1].reasoningEffort, 'high');
  assert.deepEqual(plain(backend), [{ provider: 'magpie', model: 'be-a', reasoningEffort: '' }]);
});

test('an empty list stays empty — it is a real state, not a blank lane', () => {
  assert.deepEqual(plain(api.normalizeCoordinatorRoutes({}, 'ui')), []);
  assert.deepEqual(plain(api.normalizeCoordinatorRoutes({ coordinatorUiModels: [] }, 'ui')), []);
});

test('saving drops half-filled rows but keeps the order of complete ones', () => {
  const rows = [
    { provider: 'magpie', model: 'b', reasoningEffort: '' },
    { provider: 'magpie', model: '', reasoningEffort: '' },
    { provider: 'magpie', model: 'a', reasoningEffort: 'high' }
  ];
  const saved = api.serializeRolePool(rows);
  assert.deepEqual(plain(saved), [
    { provider: 'magpie', model: 'b' },
    { provider: 'magpie', model: 'a', reasoningEffort: 'high' }
  ]);
});

test('a reorder really moves the row and out-of-range is a no-op copy', () => {
  const rows = [{ model: '1' }, { model: '2' }, { model: '3' }];
  assert.deepEqual(plain(api.moveRouteInList(rows, 0, 1).map((r) => r.model)), ['2', '1', '3']);
  assert.deepEqual(plain(api.moveRouteInList(rows, 2, -1).map((r) => r.model)), ['1', '3', '2']);
  assert.deepEqual(plain(api.moveRouteInList(rows, 0, -1).map((r) => r.model)), ['1', '2', '3']);
  assert.deepEqual(plain(api.moveRouteInList(rows, 2, 1).map((r) => r.model)), ['1', '2', '3']);
  assert.deepEqual(plain(rows.map((r) => r.model)), ['1', '2', '3'], 'the input array is never mutated');
});

test('the cooldown ladder text round-trips and ignores junk', () => {
  assert.deepEqual(plain(api.parseCoordinatorSteps('1, 5, 15')), [1, 5, 15]);
  assert.deepEqual(plain(api.parseCoordinatorSteps('1，5 15')), [1, 5, 15]);
  assert.deepEqual(plain(api.parseCoordinatorSteps('1, x, 0, -2, 4')), [1, 4]);
  assert.deepEqual(plain(api.parseCoordinatorSteps('99999')), [1440], 'a step is clamped to a day');
  assert.equal(api.formatCoordinatorSteps([1, 5, 15]), '1, 5, 15');
  assert.equal(api.formatCoordinatorSteps([]), '');
});

test('the save path writes every coordinator field', () => {
  // A field missing here is silently dropped on save, so this list is the
  // contract between the card and the section.
  for (const field of [
    'coordinatorEnabled',
    'coordinatorPresetPrefix',
    'coordinatorUiModels',
    'coordinatorBackendModels',
    'coordinatorResearchModels',
    'coordinatorCooldownPreset',
    'coordinatorCooldownSteps',
    'coordinatorCooldownCap',
    'coordinatorNoFallback'
  ]) {
    assert.ok(clientSource.includes(`["${field}"`), `the save path must write ${field}`);
    assert.ok(clientSource.includes(field), `the card must mention ${field}`);
  }
});

test('the picker asks about this page so a coordinator child sees its own list', () => {
  assert.ok(
    clientSource.includes('?childId=" + encodeURIComponent(sessionId)'),
    'the whitelist request must carry the page session id'
  );
  assert.ok(clientSource.includes('value.coordinator'), 'the picker must read the coordinator answer');
});

test('the research list round-trips like the other two', () => {
  const rows = api.normalizeCoordinatorRoutes({ coordinatorResearchModels: [{ provider: 'magpie', model: 'r-a' }] }, 'research');
  assert.deepEqual(plain(rows), [{ provider: 'magpie', model: 'r-a', reasoningEffort: '' }]);
});