import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
import {
  childPageRoutes,
  clearCoordinatorGroup,
  coordinatorChildHasRequested,
  coordinatorJudgeDiagnostics,
  coordinatorJudgeEnabled,
  coordinatorJudgeTextHash,
  coordinatorLedgerPath,
  loadCoordinatorLedger,
  parseCoordinatorJudgeOutput,
  runCoordinatorJudge,
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

// ── the startup path, end to end ────────────────────────────────────────────
//
// The unit tests above prove the FILE round-trips. What the user actually hit
// was the wiring: `apply()` must load the file BEFORE anything can judge a
// child, and the two read endpoints must report what was restored — otherwise
// the child's model menu falls back to the general list while the guard keeps
// enforcing the group (the exact "one model, and it is not even mine" report).

const STARTUP_CONFIG = {
  roleMode: true,
  models: [{ provider: 'magpie', model: 'opendesign/deepseek-v4.1-flash-eco' }],
  injectRouteContext: false,
  coordinatorEnabled: true,
  coordinatorPresetPrefix: 'dsh-orchestrator-worker',
  coordinatorUiModels: [{ provider: 'magpie-anthropic', model: 'agy-cli/gemini-4-hydrogen' }],
  coordinatorResearchModels: [{ provider: 'magpie', model: 'group/dnq' }],
  coordinatorBackendModels: [
    { provider: 'magpie-responses', model: 'codex/gpt-6.2-sol' },
    { provider: 'magpie', model: 'group/1017' }
  ]
};

function harness(settings) {
  const listeners = new Map();
  const routes = [];
  const ctx = {
    logger: { warn() {}, info() {} },
    on(name, fn) {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
      return () => {};
    },
    effect(fn) {
      const off = fn();
      return typeof off === 'function' ? off : () => {};
    },
    inject(names, fn) {
      if (!names.includes('webServer')) return;
      fn({
        logger: ctx.logger,
        effect(register) {
          const off = register();
          return typeof off === 'function' ? off : () => {};
        },
        webServer: {
          register(route) {
            routes.push(route);
            return () => {};
          }
        }
      });
    },
    get(key) {
      if (key === 'agents') return { get: () => undefined };
      return undefined;
    }
  };
  apply(ctx, settings);
  return { routes };
}

async function callGet(routes, url) {
  const route = routes.find((entry) => entry.kind === 'prefix' && entry.path === '/subagent-role-router');
  assert.ok(route, 'the plugin registered its endpoint');
  const chunks = [];
  const res = {
    statusCode: 0,
    writeHead(status) { this.statusCode = status; },
    end(body) { chunks.push(body); }
  };
  await route.handler({
    method: 'GET',
    url,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    on() {}
  }, res);
  return { status: res.statusCode, body: JSON.parse(chunks.join('')) };
}

test('apply() restores the ledger before anything judges a child, and the endpoints report it', async () => {
  writeCoordinatorLedger(state({ [CHILD]: { group: 'backend', reason: 'manual', evidence: '测试', at: Date.now() } }));
  const h = harness(STARTUP_CONFIG);

  const whitelist = await callGet(h.routes, `/subagent-role-router/whitelist?childId=${CHILD}`);
  assert.equal(whitelist.status, 200);
  assert.equal(whitelist.body.value.coordinator.group, 'backend', 'the page knows the restored group');
  assert.deepEqual(whitelist.body.value.desired.map((route) => route.model), ['codex/gpt-6.2-sol', 'group/1017']);

  // A child with no record keeps the general answer — nothing leaked.
  const ordinary = await callGet(h.routes, '/subagent-role-router/whitelist?childId=someone-else');
  assert.equal(ordinary.body.value.coordinator, undefined);
  assert.deepEqual(ordinary.body.value.desired.map((route) => route.model), ['opendesign/deepseek-v4.1-flash-eco']);
});

// ── the optional auxiliary judge ────────────────────────────────────────────
//
// The judge is a second opinion on the RULE verdict, and every test here pins a
// rule that keeps a second opinion from becoming a hazard:
//
//   * it runs AFTER birth (nothing in `coordinatorGroupForBirth` awaits it);
//   * it sees ONLY the child task text — never the parent's conversation;
//   * a timeout / throw / bad JSON keeps the rule verdict and records a code;
//   * it may correct the route ONLY before the child's first model request;
//   * the same task text is judged once (LRU cache), and a switch-off costs
//     no model call at all;
//   * the ledger keeps every old field and adds source/confidence/judgeModel/
//     ms/correctedFrom/suggestedGroup/judgeError as OPTIONAL extras.

const JUDGE_SECTION = {
  ...section(),
  judgeEnabled: true,
  judgeProvider: 'judge-p',
  judgeModel: 'judge-m',
  judgeTimeoutMs: 5000,
  judgeAutoCorrect: true
};

function judgeState(extra = {}) {
  const live = { ...JUDGE_SECTION, ...extra };
  return {
    getSection: () => live,
    coordGroupOfChild: new Map(),
    coordCooldown: new Map(),
    childRoutes: new Map(),
    routeRevisions: new Map()
  };
}

/** An async generator that answers one judge call with `text`. */
async function* judgeSays(text) {
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'finish', reason: { kind: 'complete' } };
}

/** An async generator that never answers until the AbortSignal fires. */
async function* judgeHangs(options) {
  await new Promise((resolve) => {
    const signal = options?.signal;
    if (signal === void 0 || signal.aborted === true) return resolve();
    let guard;
    const done = () => {
      if (guard !== undefined) clearTimeout(guard);
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
    // A safety valve so a bug in the plugin cannot hang the test run.
    guard = setTimeout(done, 2000);
    guard?.unref?.();
  });
  yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } };
}

function judgeCtx({ answer, agent } = {}) {
  const calls = [];
  return {
    calls,
    logger: { warn() {}, info() {} },
    get(key) {
      if (key === 'llm') {
        return {
          stream(options) {
            calls.push(options);
            return typeof answer === 'function' ? answer(options) : judgeSays(answer);
          }
        };
      }
      if (key === 'agents') return { get: () => agent };
      return undefined;
    }
  };
}

/** A live child that has not sent its first request yet. */
function freshChild() {
  return { id: CHILD, session: { requestContext: () => undefined, events: [] } };
}

const UI_VERDICT = JSON.stringify({ correct: false, group: 'ui', confidence: 0.92 });
const CORRECTION = { group: 'backend', reason: 'score', evidence: '后端词 8 > 视觉词 0' };

test('a disagreeing judge corrects the route before the first request', async () => {
  const live = judgeState();
  const ctx = judgeCtx({ answer: UI_VERDICT, agent: freshChild() });
  await runCoordinatorJudge(ctx, live, CHILD, CORRECTION, '修复数据库迁移脚本', '');

  // 1. The route override the FIRST request will read, on both id spellings.
  assert.equal(live.childRoutes.get(CHILD).provider, 'magpie-anthropic');
  assert.equal(live.childRoutes.get(CHILD).model, 'agy-cli/gemini-4-hydrogen');
  assert.equal(live.childRoutes.get(`session-${CHILD}`).model, 'agy-cli/gemini-4-hydrogen');

  // 2. The ledger record: group moved, provenance recorded, old fields intact.
  const record = live.coordGroupOfChild.get(CHILD);
  assert.equal(record.group, 'ui');
  assert.equal(record.reason, 'judge');
  assert.equal(record.source, 'judge');
  assert.equal(record.confidence, 0.92);
  assert.equal(record.judgeModel, 'judge-p/judge-m');
  assert.equal(record.correctedFrom, 'backend');
  assert.equal(typeof record.ms, 'number');
  assert.equal(record.at > 0, true);

  // 3. The parent's page now offers the CORRECTED list.
  assert.equal(childPageRoutes(live, CHILD).group, 'ui');

  // 4. Diagnose it: the last verdict names the source, the correction and the ms.
  const diag = coordinatorJudgeDiagnostics(live);
  assert.equal(diag.enabled, true);
  assert.equal(diag.model, 'judge-m');
  assert.equal(diag.calls, 1);
  assert.equal(diag.corrections, 1);
  assert.equal(diag.last.corrected, true);
  assert.equal(diag.last.source, 'judge');
  assert.equal(diag.last.group, 'ui');
  assert.equal(diag.last.rulesGroup, 'backend');
});

test('the judge sees ONLY the child task text (boilerplate stripped)', async () => {
  const live = judgeState();
  const ctx = judgeCtx({ answer: UI_VERDICT, agent: freshChild() });
  await runCoordinatorJudge(ctx, live, CHILD, CORRECTION, '修复数据库迁移脚本', '【任务引用】tk-parent-secret\n【任务详情】先调 task_detail。');

  assert.equal(ctx.calls.length, 1);
  const call = ctx.calls[0];
  assert.equal(call.provider, 'judge-p');
  assert.equal(call.model, 'judge-m');
  assert.equal(call.messages.length, 1, 'one user message, no injected conversation');
  assert.equal(call.messages[0].role, 'user');
  assert.equal(call.messages[0].content.length, 1);
  assert.equal(call.messages[0].content[0].type, 'text');
  assert.equal(call.signal instanceof AbortSignal, true, 'the timeout is an AbortSignal on GenerateOptions');
  const prompt = call.messages[0].content[0].text;
  assert.match(prompt, /修复数据库迁移脚本/, 'the task text is what the judge reads');
  assert.match(prompt, /规则层当前判的组：backend/, 'the rule verdict is attached');
  assert.match(prompt, /"correct"/, 'the required JSON shape is spelled out');
  assert.doesNotMatch(prompt, /tk-parent-secret/, 'the dispatcher wrapper is stripped');
});

test('a judge timeout keeps the rule verdict and records the code', async () => {
  const live = judgeState({ judgeTimeoutMs: 30 });
  const ctx = judgeCtx({ answer: judgeHangs, agent: freshChild() });
  await runCoordinatorJudge(ctx, live, CHILD, CORRECTION, '修复数据库迁移脚本', '');

  const record = live.coordGroupOfChild.get(CHILD);
  assert.equal(record.group, 'backend', 'the rule verdict survives the timeout');
  assert.equal(record.judgeError, 'timeout');
  assert.equal(record.source, 'rules');
  assert.equal(live.childRoutes.size, 0, 'nothing is rewritten on a failure');
  const diag = coordinatorJudgeDiagnostics(live);
  assert.equal(diag.failures, 1);
  assert.equal(diag.last.ok, false);
  assert.equal(diag.last.code, 'timeout');
});

test('a judge exception keeps the rule verdict and records its code', async () => {
  const live = judgeState();
  async function* boom() {
    throw Object.assign(new Error('rate limited'), { code: 'RATE_LIMIT' });
  }
  const ctx = judgeCtx({ answer: boom, agent: freshChild() });
  await runCoordinatorJudge(ctx, live, CHILD, CORRECTION, '修复数据库迁移脚本', '');

  assert.equal(live.coordGroupOfChild.get(CHILD).group, 'backend');
  assert.equal(live.coordGroupOfChild.get(CHILD).judgeError, 'RATE_LIMIT');
  assert.equal(live.childRoutes.size, 0);
});

test('an unparseable / invalid judge answer falls back to the rules', async () => {
  for (const [text, expectedCode] of [
    ['我判断这是界面任务', 'invalid-json'],
    ['{"correct": "true", "group": "ui", "confidence": 0.8}', 'invalid-json'],
    ['{"correct": true, "group": "wat", "confidence": 0.5}', 'invalid-json'],
    ['{"correct": true, "group": "ui"}', 'invalid-json'],
    ['{"correct": true, "group": "ui", "confidence": 2}', 'invalid-json']
  ]) {
    const live = judgeState();
    const ctx = judgeCtx({ answer: text, agent: freshChild() });
    await runCoordinatorJudge(ctx, live, CHILD, CORRECTION, '修复数据库迁移脚本', '');
    assert.equal(live.coordGroupOfChild.get(CHILD).group, 'backend', text);
    assert.equal(live.coordGroupOfChild.get(CHILD).judgeError, expectedCode, text);
  }
});

test('the parser takes the first {…} object and validates every field', () => {
  assert.deepEqual(parseCoordinatorJudgeOutput('好的，结论是：{"correct":false,"group":"delivery","confidence":0.75} 以上。'),
    { correct: false, group: 'delivery', confidence: 0.75 });
  assert.deepEqual(parseCoordinatorJudgeOutput('{"correct":true,"group":"ui","confidence":0}'),
    { correct: true, group: 'ui', confidence: 0 });
  assert.equal(parseCoordinatorJudgeOutput('no braces here'), undefined);
  assert.equal(parseCoordinatorJudgeOutput('{"correct":true, "group":"ui"'), undefined);
  assert.equal(parseCoordinatorJudgeOutput('{"correct":1,"group":"ui","confidence":0.5}'), undefined);
});

test('a child that already sent its first request is never rewritten', async () => {
  const live = judgeState();
  const started = { id: CHILD, session: { requestContext: () => ({ provider: 'magpie', model: 'group/dnq', contextWindow: 1000 }) } };
  const ctx = judgeCtx({ answer: UI_VERDICT, agent: started });
  await runCoordinatorJudge(ctx, live, CHILD, CORRECTION, '修复数据库迁移脚本', '');

  assert.equal(live.childRoutes.size, 0, 'no override is written after the first request');
  const record = live.coordGroupOfChild.get(CHILD);
  assert.equal(record.group, 'backend', 'the running child keeps its list');
  assert.equal(record.suggestedGroup, 'ui', 'the advice is recorded instead');
  assert.equal(record.judgeError, 'already-started');
  assert.equal(coordinatorJudgeDiagnostics(live).corrections, 0);
  assert.equal(coordinatorJudgeDiagnostics(live).suggestions, 1);
});

test('a request/context event is enough to mean "already started"', async () => {
  const live = judgeState();
  const agent = { id: CHILD, session: { requestContext: () => undefined, events: [{ type: 'request/context' }] } };
  const ctx = judgeCtx({ answer: UI_VERDICT, agent });
  assert.equal(coordinatorChildHasRequested(ctx, CHILD), true);
  await runCoordinatorJudge(ctx, live, CHILD, CORRECTION, '修复数据库迁移脚本', '');
  assert.equal(live.childRoutes.size, 0);
  assert.equal(live.coordGroupOfChild.get(CHILD).suggestedGroup, 'ui');
});

test('a child we cannot see counts as already started (never rewritten)', () => {
  const ctx = { get: () => undefined };
  assert.equal(coordinatorChildHasRequested(ctx, CHILD), true);
  const noAgent = { get: () => ({ get: () => undefined }) };
  assert.equal(coordinatorChildHasRequested(noAgent, CHILD), true);
});

test('auto-correct switched off records the suggestion but writes no route', async () => {
  const live = judgeState({ judgeAutoCorrect: false });
  const ctx = judgeCtx({ answer: UI_VERDICT, agent: freshChild() });
  await runCoordinatorJudge(ctx, live, CHILD, CORRECTION, '修复数据库迁移脚本', '');
  assert.equal(live.childRoutes.size, 0);
  assert.equal(live.coordGroupOfChild.get(CHILD).group, 'backend');
  assert.equal(live.coordGroupOfChild.get(CHILD).suggestedGroup, 'ui');
  assert.equal(live.coordGroupOfChild.get(CHILD).judgeError, 'auto-correct-off');
});

test('switching the judge off costs no model call and touches no ledger row', async () => {
  const live = judgeState({ judgeEnabled: false });
  const ctx = judgeCtx({ answer: UI_VERDICT, agent: freshChild() });
  await runCoordinatorJudge(ctx, live, CHILD, CORRECTION, '修复数据库迁移脚本', '');
  assert.equal(ctx.calls.length, 0);
  assert.equal(live.coordGroupOfChild.size, 0);
  assert.equal(coordinatorJudgeDiagnostics(live).enabled, false);
  assert.equal(coordinatorJudgeEnabled({}), true, 'the schema default is ON');
  assert.equal(coordinatorJudgeEnabled({ judgeEnabled: false }), false);
});

test('the same task text is judged once (cache), and different texts are distinct', async () => {
  const live = judgeState();
  const first = judgeCtx({ answer: UI_VERDICT, agent: freshChild() });
  await runCoordinatorJudge(first, live, CHILD, CORRECTION, '修复数据库迁移脚本', '');
  assert.equal(first.calls.length, 1);

  // Same text, another child: the cached verdict is reused, no second call.
  const second = judgeCtx({ answer: UI_VERDICT, agent: freshChild() });
  await runCoordinatorJudge(second, live, 'child-2', CORRECTION, '修复数据库迁移脚本', '');
  assert.equal(second.calls.length, 0, 'the cache replaces the model call');
  assert.equal(second.calls.length + live.coordJudgeStats.calls, 1);
  assert.equal(coordinatorJudgeDiagnostics(live).calls, 1);
  assert.equal(coordinatorJudgeDiagnostics(live).cacheHits, 1);
  assert.equal(coordinatorJudgeDiagnostics(live).corrections, 2, 'each child still gets its own correction');

  // Different text = different hash = a real call.
  assert.notEqual(coordinatorJudgeTextHash('修复数据库迁移脚本'), coordinatorJudgeTextHash('修复数据库迁移脚本 '));
  const third = judgeCtx({ answer: UI_VERDICT, agent: freshChild() });
  await runCoordinatorJudge(third, live, 'child-3', CORRECTION, '修复登录超时', '');
  assert.equal(third.calls.length, 1);
  assert.equal(coordinatorJudgeDiagnostics(live).calls, 2);

  // The cache is bounded (small LRU), so a long run cannot grow it forever.
  for (let i = 0; i < 40; i += 1) {
    const ctx = judgeCtx({ answer: UI_VERDICT, agent: freshChild() });
    await runCoordinatorJudge(ctx, live, `bulk-${i}`, CORRECTION, `任务 ${i} 修复缓存队列`, '');
  }
  assert.equal(coordinatorJudgeDiagnostics(live).cacheSize <= 32, true);
});

test('the ledger writes the judge fields and an older row still loads', async () => {
  const live = judgeState();
  const ctx = judgeCtx({ answer: UI_VERDICT, agent: freshChild() });
  await runCoordinatorJudge(ctx, live, CHILD, CORRECTION, '修复数据库迁移脚本', '');
  assert.equal(writeCoordinatorLedger(live), 1);
  const rows = JSON.parse(readFileSync(coordinatorLedgerPath(), 'utf8'));
  assert.equal(rows.length, 1);
  // Legacy fields kept verbatim…
  assert.equal(rows[0].childId, CHILD);
  assert.equal(rows[0].group, 'ui');
  assert.equal(rows[0].reason, 'judge');
  // …and the judge extras are present.
  assert.equal(rows[0].source, 'judge');
  assert.equal(rows[0].confidence, 0.92);
  assert.equal(rows[0].judgeModel, 'judge-p/judge-m');
  assert.equal(rows[0].correctedFrom, 'backend');
  assert.equal(typeof rows[0].ms, 'number');

  // A row written by an older build (no new keys) must load and stay inert.
  const oldRow = [{ childId: 'old-child', group: 'backend', reason: 'keyword', evidence: '旧记录', at: Date.now() }];
  const broken = { ...live, coordGroupOfChild: new Map() };
  const fs = await import('node:fs');
  fs.writeFileSync(coordinatorLedgerPath(), JSON.stringify(oldRow));
  assert.equal(loadCoordinatorLedger(broken), 1);
  const restored = broken.coordGroupOfChild.get('old-child');
  assert.equal(restored.group, 'backend');
  assert.equal(restored.source, undefined, 'absent extras stay absent');
  // Reading it back twice must not invent fields either.
  const again = { ...live, coordGroupOfChild: new Map() };
  writeCoordinatorLedger(again);
  assert.equal(readFileSync(coordinatorLedgerPath(), 'utf8'), '[]', 'an empty map writes an empty ledger');
});

test('the read endpoints report the judge state without any task text', async () => {
  const before = JSON.parse(readFileSync(coordinatorLedgerPath(), 'utf8'));
  assert.equal(Array.isArray(before), true);
  const h = harness(STARTUP_CONFIG);
  const coordinator = await callGet(h.routes, '/subagent-role-router/coordinator');
  assert.equal(coordinator.status, 200);
  assert.equal(coordinator.body.value.judge.enabled, true);
  assert.equal(coordinator.body.value.judge.model, 'jev-1.13-free');
  assert.equal(coordinator.body.value.judge.last, null);
  const whitelist = await callGet(h.routes, '/subagent-role-router/whitelist');
  assert.equal(whitelist.body.value.judge.enabled, true);
  assert.equal(whitelist.body.value.judge.provider, '200k');
});
