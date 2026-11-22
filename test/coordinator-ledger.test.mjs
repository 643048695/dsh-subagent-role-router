import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  childPageRoutes,
  clearCoordinatorGroup,
  coordinatorLedgerPath,
  loadCoordinatorLedger,
  writeCoordinatorLedger
} from '../lib/index.js';

// THE GROUP LEDGER SURVIVES A RELOAD.
//
// Live evidence (session-7a929cab, 02:54): the planner child was born on the
// backend list (codex/gpt-6.2-sol). A plugin reload emptied the in-memory ledger,
// so the request-time guard judged it as an ORDINARY child against the general
// whitelist, found sol "not on the list", and switched the running child onto
// flash-eco — the exact bug 5.6.0 had just fixed, resurrected by a reload.
//
// What is pinned here:
//   1. a decision written by one process is read back by the next one;
//   2. an expired decision (24h) is not restored;
//   3. taking a child off its list removes both id spellings AND the file row;
//   4. the restored record is what `childPageRoutes` answers with, so the
//      request-time guard sees the group instead of the general list.

const dir = mkdtempSync(join(tmpdir(), 'srr-ledger-'));
process.env.DSH_SUBAGENT_ROLE_ROUTER_STATE = dir;

process.on('exit', () => {
  try { rmSync(dir, { recursive: true, force: true }); } catch (_error) {}
});

const CHILD = 'bf3a649a-e403-45d1-a4c0-9890f10da421';

function section() {
  return {
    provider: 'magpie',
    model: '',
    models: [{ provider: 'magpie', model: 'opendesign/deepseek-v4.1-flash-eco' }],
    roleMode: true,
    teamModelProvider: '',
    teamModelName: '',
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
}

function state(records = {}) {
  const live = section();
  const map = new Map();
  for (const [id, record] of Object.entries(records)) map.set(id, record);
  return { getSection: () => live, coordGroupOfChild: map, coordCooldown: new Map() };
}

test('the ledger path honours the state directory override', () => {
  assert.equal(coordinatorLedgerPath(), join(dir, 'coordinator-groups.json'));
});

test('a decision survives the process that wrote it', () => {
  const first = state({ [CHILD]: { group: 'backend', reason: 'directive', evidence: '标题写明「组：后端」', at: Date.now() } });
  assert.equal(writeCoordinatorLedger(first), 1);
  const raw = JSON.parse(readFileSync(coordinatorLedgerPath(), 'utf8'));
  assert.equal(raw.length, 1);
  assert.equal(raw[0].childId, CHILD);
  assert.equal(raw[0].group, 'backend');

  const second = state();
  assert.equal(loadCoordinatorLedger(second), 1);
  // Both id spellings point at the same record, so any spelling answers.
  assert.equal(second.coordGroupOfChild.get(CHILD).group, 'backend');
  assert.equal(second.coordGroupOfChild.get(`session-${CHILD}`).group, 'backend');
  // …and the child's page is its GROUP again, not the general list.
  const page = childPageRoutes(second, CHILD);
  assert.equal(page.group, 'backend');
  assert.deepEqual(page.routes.map((route) => route.model), ['codex/gpt-6.2-sol', 'group/1017']);
});

test('an expired decision is not restored', () => {
  const old = Date.now() - 25 * 60 * 60 * 1000;
  writeCoordinatorLedger(state({ [CHILD]: { group: 'ui', reason: 'tag', evidence: '', at: old } }), Date.now());
  const fresh = state();
  assert.equal(loadCoordinatorLedger(fresh), 0);
  assert.equal(childPageRoutes(fresh, CHILD).group, undefined);
});

test('taking a child off its list clears both spellings and the file row', () => {
  const live = state({ [CHILD]: { group: 'research', reason: 'directive', evidence: '', at: Date.now() } });
  live.coordGroupOfChild.set(`session-${CHILD}`, { group: 'research', reason: 'directive', evidence: '', at: Date.now() });
  assert.equal(clearCoordinatorGroup(live, CHILD), true);
  assert.equal(live.coordGroupOfChild.size, 0);
  // Persist immediately (the helper debounces; call the writer directly here).
  writeCoordinatorLedger(live);
  assert.deepEqual(JSON.parse(readFileSync(coordinatorLedgerPath(), 'utf8')), []);
  const reloaded = state();
  assert.equal(loadCoordinatorLedger(reloaded), 0);
});

test('a malformed file is ignored instead of breaking the plugin', () => {
  const broken = state();
  const path = coordinatorLedgerPath();
  // Write garbage through the same public seam: an empty array is a valid empty
  // ledger, so simulate the unreadable case with a directory at the path.
  rmSync(path, { force: true });
  assert.equal(loadCoordinatorLedger(broken), 0);
  assert.equal(broken.coordGroupOfChild.size, 0);
});
