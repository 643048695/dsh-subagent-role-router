import test from 'node:test';
import assert from 'node:assert/strict';
import { strictChildrenOf } from '../lib/index.js';

// THE HOST MOVED THE CHILD LIST, TWICE.
//
//   old service method : subagents.listChildren(parentId)
//   current            : subagents.listDescendants(rootId)   (recursive; row.parentId says the owner)
//   projection only    : sessionQuery.observeSession(parentId).projections.values.subagentCatalog
//
// The plugin kept asking the first one, got "no such method", and the batch card
// hid itself because it could not verify a single child — the "batch button is
// gone" report. What is pinned here:
//
//   1. A host with only `listDescendants` lists the DIRECT children (a grandchild
//      of another conversation must never leak in).
//   2. A host with only the old service method keeps working unchanged.
//   3. A host with only `sessionQuery` (projection) still lists children.
//   4. Precedence: old method → descendants → projection, so an exposing host
//      keeps its exact previous behaviour.
//   5. No leg at all: an explicit catalog-unavailable error, never a guess.
//   6. A throwing leg falls through to the next one instead of failing the card.

const config = { models: [{ provider: 'p', model: 'a' }], roleMode: false, exemptRules: [] };

function harness({ service, query }) {
  const cleanups = [];
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on() { return () => {}; },
    effect(fn) {
      const off = fn();
      if (typeof off === 'function') cleanups.push(off);
    },
    inject() {},
    get(key) {
      if (key === 'subagents') return service;
      if (key === 'sessionQuery') return query;
      if (key === 'agents') return { get: () => undefined };
      return undefined;
    }
  };
  const state = {
    getSection: () => config,
    childRoutes: new Map(),
    roleOfChild: new Map(),
    routeEpoch: 0,
    routeRevisions: new Map()
  };
  return { ctx, state, dispose: () => { for (const off of cleanups.splice(0)) off(); } };
}

const catalogEntry = (id, mode = 'continuable') => ({ id, label: id, mode });
const descendant = (id, parentId, depth = 1) => ({ ...catalogEntry(id), parentId, depth });

test('a host that renamed the method to listDescendants yields the direct children only', async () => {
  const asked = [];
  const service = {
    async listDescendants(rootId) {
      asked.push(rootId);
      // The host walks the whole tree: a grandchild (owned by c1) and a child of
      // an unrelated conversation both come back, and neither may be shown.
      return [
        descendant('c1', rootId),
        descendant('c1-grandchild', 'c1', 2),
        descendant('c2', rootId),
        descendant('stranger', 'session-other')
      ];
    }
  };
  const h = harness({ service, query: undefined });
  const result = await strictChildrenOf(h.ctx, h.state, 'session-parent');
  assert.equal(result.ok, true, 'the renamed host API must be understood');
  assert.deepEqual(result.value.map((row) => row.childId), ['c1', 'c2'], 'only the parent own children survive the filter');
  assert.deepEqual(asked, ['session-parent'], 'the parent id is what the walk starts from');
  h.dispose();
});

test('a host with only the old service method is unchanged', async () => {
  const service = { async listChildren(id) { return [catalogEntry('legacy-' + id)]; } };
  const h = harness({ service, query: undefined });
  const result = await strictChildrenOf(h.ctx, h.state, 'session-parent');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.map((row) => row.childId), ['legacy-session-parent']);
  h.dispose();
});

test('a host that only serves the projection still lists children', async () => {
  const asked = [];
  const query = {
    async observeSession(parentId) {
      asked.push(parentId);
      return {
        projections: { values: { subagentCatalog: [catalogEntry('c1'), catalogEntry('c2')] } },
        dispose() { asked.push('disposed:' + parentId); }
      };
    }
  };
  const h = harness({ service: {}, query });
  const result = await strictChildrenOf(h.ctx, h.state, 'session-parent');
  assert.equal(result.ok, true, 'the projection-only host shape must be understood');
  assert.deepEqual(result.value.map((row) => row.childId), ['c1', 'c2']);
  assert.ok(asked.includes('session-parent'), 'the parent id is handed to observeSession');
  assert.ok(asked.includes('disposed:session-parent'), 'the observation is released after the read');
  h.dispose();
});

test('an exposing old method wins over the newer legs', async () => {
  const order = [];
  const service = {
    async listChildren() { order.push('service'); return [catalogEntry('svc')]; },
    async listDescendants() { order.push('descendants'); return [descendant('deep', 'session-parent')]; }
  };
  const query = {
    async observeSession() { order.push('query'); return { projections: { values: { subagentCatalog: [catalogEntry('proj')] } } }; }
  };
  const h = harness({ service, query });
  const result = await strictChildrenOf(h.ctx, h.state, 'session-parent');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.map((row) => row.childId), ['svc'], 'an exposing service keeps its exact old behaviour');
  assert.deepEqual(order, ['service'], 'no newer leg is consulted once one can answer');
  h.dispose();
});

test('the renamed API is asked before the projection', async () => {
  const order = [];
  const service = {
    async listDescendants() { order.push('descendants'); return [descendant('deep', 'session-parent')]; }
  };
  const query = {
    async observeSession() { order.push('query'); return { projections: { values: { subagentCatalog: [catalogEntry('proj')] } } }; }
  };
  const h = harness({ service, query });
  const result = await strictChildrenOf(h.ctx, h.state, 'session-parent');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.map((row) => row.childId), ['deep']);
  assert.deepEqual(order, ['descendants'], 'the projection is the last resort, not the first');
  h.dispose();
});

test('a host with no leg at all reports catalog-unavailable instead of guessing', async () => {
  const h = harness({ service: {}, query: undefined });
  const result = await strictChildrenOf(h.ctx, h.state, 'session-parent');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'catalog-unavailable');
  h.dispose();
});

test('a retired method that still exists but rejects falls through to the projection', async () => {
  const service = { async listChildren() { throw new Error('listChildren is not a function'); } };
  const query = {
    async observeSession() { return { projections: { values: { subagentCatalog: [catalogEntry('c9')] } } }; }
  };
  const h = harness({ service, query });
  const result = await strictChildrenOf(h.ctx, h.state, 'session-parent');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.map((row) => row.childId), ['c9']);
  h.dispose();
});
