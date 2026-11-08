import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// The quick-switch card cannot be clicked from Node, so everything that can be
// decided without a DOM lives in pure helpers on the factory's export object and
// is pinned here: the write set, the payload shape, the stale-response guard, the
// effort states and the anchored geometry. What is left to the browser is layout.
const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

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
  vm.runInNewContext(clientSource, sandbox, { filename: "client.js" });
  if (!capturedModule || typeof capturedModule.factory !== "function") {
    throw new Error("client.js failed to register with __ModuleLoader__");
  }
  const fakeRequire = (id) => {
    if (id === "react") {
      return {
        useState: (init) => [init, () => {}],
        useMemo: (fn) => fn(),
        useRef: (init) => ({ current: init }),
        useEffect: (fn) => {
          const cleanup = fn();
          return typeof cleanup === "function" ? cleanup : () => {};
        },
        createElement: () => ({})
      };
    }
    if (id === "@deepseek-ai/dsh-client-ui-primitives") {
      return { Toast: function Toast() {} };
    }
    return {};
  };
  return capturedModule.factory(fakeRequire);
}

// Values built inside the vm sandbox carry that realm's prototypes, which
// deepStrictEqual rejects; compare their JSON shape instead.
const plain = (value) => JSON.parse(JSON.stringify(value));

function createMockContext() {
  const effectCleanups = [];
  const slotRegistrations = [];
  const fakeScope = {
    status: "ready",
    value: { showChatModelNotice: true, forkWindowTurns: 5 },
    writable: true,
    getSnapshot() {
      return { status: this.status, value: this.value, writable: this.writable };
    },
    subscribe() {
      return () => {};
    }
  };
  const formsService = {
    describe() {
      return {
        getSnapshot: () => ({ view: { namespaces: [{ ns: "dsh-subagent-role-router" }] }, status: "ready" }),
        subscribe: () => () => {}
      };
    },
    get(ns) {
      return ns === "dsh-subagent-role-router" ? fakeScope : undefined;
    }
  };
  const formsCtx = {
    configForms: formsService,
    effect(cb) {
      const cleanup = cb();
      return cleanup;
    }
  };
  const ctx = {
    get() {
      return undefined;
    },
    effect(cb) {
      const cleanup = cb();
      if (typeof cleanup === "function") effectCleanups.push(cleanup);
      return cleanup;
    },
    inject(deps, cb) {
      if (Array.isArray(deps) && deps.includes("configForms")) cb(formsCtx);
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key
    },
    slots: {
      inject(name, cb) {
        cb();
        return () => {};
      },
      register(opts) {
        slotRegistrations.push(opts);
        return () => {
          slotRegistrations.splice(slotRegistrations.indexOf(opts), 1);
        };
      }
    },
    uiConversation: {
      events: { register: () => () => {} }
    }
  };
  return { ctx, effectCleanups, slotRegistrations };
}

// A model catalog as the backend builds it: `efforts` only ever lists real
// catalog levels, `configuredEfforts` is what this page pinned, and
// `capabilityKnown` says whether the catalog actually answered.
const MODELS = [
  {
    provider: "dnq",
    model: "deepseek-v4",
    displayName: "DeepSeek V4",
    sources: ["base", "role:plan"],
    configuredEfforts: ["high"],
    capabilityKnown: true,
    efforts: [
      { id: "high", label: "High", source: "catalog" },
      { id: "max", label: "Max", source: "catalog" }
    ]
  },
  {
    provider: "local",
    model: "mystery",
    displayName: "Mystery",
    sources: ["team"],
    configuredEfforts: ["deep"],
    capabilityKnown: false,
    efforts: []
  }
];

const keyOf = (client, provider, model) => client.batchModelKey(provider, model);

test("1. the entry is registered on the composer's left row, order 5", () => {
  const client = loadClient();
  const { ctx, slotRegistrations } = createMockContext();
  client.apply(ctx);

  const entry = slotRegistrations.find((opts) => opts.id === "subagent-role-router-batch");
  assert.ok(entry, "the quick-switch entry must claim a slot");
  assert.equal(entry.name, "conversation.input.left", "it belongs on the composer's left row");
  assert.equal(entry.order, 5, "order 5 keeps it left of the widget docks");
  assert.ok(typeof entry.inject === "function", "the entry needs a session id from the slot");
  const injected = entry.inject({ sessionId: "session-abc" });
  assert.deepEqual(Object.keys(injected), ["sessionId", "sessionsList"],
    "the entry carries the host session-list face for signature-driven presence");
  assert.equal(injected.sessionId, "session-abc");
});

test("2. batchText: host translation wins, Chinese fallback fills the rest, {vars} interpolate", () => {
  const client = loadClient();
  const passthrough = (key) => key;
  assert.equal(client.batchText(passthrough, "batch.title"), "子代理快捷切换");
  assert.equal(client.batchText(passthrough, "batch.apply"), "应用到当前对话");
  assert.equal(client.batchText(passthrough, "batch.targets", { n: 3 }), "将作用于本对话 3 个活跃子代理");
  assert.equal(client.batchText(passthrough, "batch.applyDone", { n: 2 }), "已应用到 2 个子代理，下轮请求生效");
  assert.equal(client.batchText((key) => (key === "batch.title" ? "Quick switch" : key), "batch.title"), "Quick switch");
  assert.equal(client.batchText(passthrough, "batch.unknown.key"), "batch.unknown.key");
  // A throwing translator must not break rendering.
  assert.equal(client.batchText(() => { throw new Error("no locale"); }, "batch.apply"), "应用到当前对话");
});

test("3. model keys round-trip and malformed keys are rejected", () => {
  const client = loadClient();
  const key = client.batchModelKey("dnq", "deepseek-v4");
  assert.deepEqual(plain(client.batchSplitModelKey(key)), { provider: "dnq", model: "deepseek-v4" });
  assert.equal(client.batchSplitModelKey(""), null);
  assert.equal(client.batchSplitModelKey("dnq-only"), null);
  assert.equal(client.batchSplitModelKey("\u0000model"), null);
  assert.equal(client.batchSplitModelKey("provider\u0000"), null);
});

test("4. a response is dropped when a newer request or another conversation won", () => {
  const client = loadClient();
  assert.equal(client.batchRequestStale(3, "session-a", 3, "session-a"), false);
  assert.equal(client.batchRequestStale(3, "session-a", 4, "session-a"), true, "newer request wins");
  assert.equal(client.batchRequestStale(3, "session-a", 3, "session-b"), true, "conversation flip wins");
});

test("5. the write set is every writable direct child, and nothing else", () => {
  const client = loadClient();
  const rows = [
    { childId: "session-a", selectable: true },
    { childId: "session-b", selectable: false, reason: "ended" },
    { childId: "session-c", selectable: true },
    { childId: "session-d", selectable: false, reason: "exempt" }
  ];
  assert.deepEqual(plain(client.batchTargets(rows)), ["session-a", "session-c"]);
  assert.deepEqual(plain(client.batchTargets([])), []);
  assert.deepEqual(plain(client.batchTargets(null)), []);
  assert.deepEqual(plain(client.batchTargets([{ selectable: true }])), [], "a row without an id cannot be written");
});

test("6. a known catalog is authoritative; an unknown one only offers this page's pins", () => {
  const client = loadClient();
  const known = client.batchEffortPlan(MODELS, keyOf(client, "dnq", "deepseek-v4"));
  assert.deepEqual(plain(known.choices.map((c) => c.id)), ["high", "max"]);
  assert.deepEqual(plain(known.choices.map((c) => c.source)), ["catalog", "catalog"]);
  assert.equal(known.known, true);
  assert.equal(known.hintKey, "");

  // A model the catalog knows but without levels offers no concrete strength.
  const none = client.batchEffortPlan(
    [{ provider: "dnq", model: "plain", configuredEfforts: ["deep"], capabilityKnown: true, efforts: [] }],
    keyOf(client, "dnq", "plain")
  );
  assert.deepEqual(plain(none.choices), []);
  assert.equal(none.known, true, "the catalog answered, it just has nothing to offer");
  assert.equal(none.hintKey, "batch.effortNone");

  // No model chosen yet: the card asks instead of guessing.
  const unpicked = client.batchEffortPlan(MODELS, "");
  assert.deepEqual(plain(unpicked.choices), []);
  assert.equal(unpicked.hintKey, "batch.pickModel");
  const missing = client.batchEffortPlan(MODELS, keyOf(client, "dnq", "nope"));
  assert.equal(missing.hintKey, "batch.pickModel");
});

test("7. an unknown capability only offers this page's pins and is flagged", () => {
  const client = loadClient();
  const plan = client.batchEffortPlan(MODELS, keyOf(client, "local", "mystery"));
  assert.deepEqual(plain(plan.choices.map((c) => c.id)), ["deep"]);
  assert.deepEqual(plain(plan.choices.map((c) => c.source)), ["config"]);
  assert.equal(plan.known, false, "an unanswered catalog is not evidence");
  assert.equal(plan.hintKey, "batch.effortUnverified");

  const bare = client.batchEffortPlan(
    [{ provider: "local", model: "mystery", configuredEfforts: [], capabilityKnown: false, efforts: [] }],
    keyOf(client, "local", "mystery")
  );
  assert.deepEqual(plain(bare.choices), [], "no pins and no catalog means no concrete level");
  assert.equal(bare.hintKey, "batch.effortUnverified");
});

test("8. the payload writes every target with one model; the model is mandatory", () => {
  const client = loadClient();
  const ids = ["session-a", "session-b"];
  assert.equal(client.batchSelectionsFrom(ids, "", "high"), null, "no model picked => refuses to build a payload");

  const key = keyOf(client, "dnq", "deepseek-v4");
  assert.deepEqual(plain(client.batchSelectionsFrom(ids, key, "")), [
    { childId: "session-a", provider: "dnq", model: "deepseek-v4", reasoningEffort: null },
    { childId: "session-b", provider: "dnq", model: "deepseek-v4", reasoningEffort: null }
  ]);
  assert.deepEqual(plain(client.batchSelectionsFrom(["session-a"], key, "max")), [
    { childId: "session-a", provider: "dnq", model: "deepseek-v4", reasoningEffort: "max" }
  ]);
  assert.deepEqual(plain(client.batchSelectionsFrom([], key, "max")), []);
});

test("9. the status line counts successes and surfaces the first failure code", () => {
  const client = loadClient();
  const allOk = client.batchResultSummary([
    { childId: "session-a", ok: true },
    { childId: "session-b", ok: true }
  ]);
  assert.deepEqual(plain(allOk), { total: 2, ok: 2, failed: 0, code: "", message: "unknown" });

  const partial = client.batchResultSummary([
    { childId: "session-a", ok: true },
    { childId: "session-b", ok: false, error: { code: "effort-unknown", message: "model cannot do that level" } }
  ]);
  assert.deepEqual(plain(partial), {
    total: 2,
    ok: 1,
    failed: 1,
    code: "effort-unknown",
    message: "model cannot do that level"
  });

  const none = client.batchResultSummary([{ childId: "session-a", ok: false, error: { code: "not-owned" } }]);
  assert.equal(none.ok, 0);
  assert.equal(none.failed, 1);
  assert.equal(none.code, "not-owned");
  assert.equal(none.message, "not-owned", "a code with no message is still reported");

  assert.deepEqual(plain(client.batchResultSummary(null)), { total: 0, ok: 0, failed: 0, code: "", message: "unknown" });
});

test("10. card opens upwards, flips down near the top, and stays inside the viewport", () => {
  const client = loadClient();
  const box = client.batchBoxFor({ left: 640, top: 840, bottom: 868 }, { width: 1280, height: 900 });
  assert.equal(box.placement, "up");
  assert.equal(box.width, 360, "default width sits in the 340-380 band");
  assert.equal(box.bottom, 900 - 840 + 8, "panel bottom is anchored 8px above the trigger");
  assert.equal(box.top, null);
  assert.equal(box.maxHeight, 520, "clamped to 520 even with a tall viewport");
  assert.ok(box.left >= 8 && box.left + box.width <= 1280 - 8, "panel stays inside the viewport");

  const nearEdge = client.batchBoxFor({ left: 1260, top: 600, bottom: 628 }, { width: 1280, height: 900 });
  assert.ok(nearEdge.left + nearEdge.width <= 1272, "right edge is pulled back into view");

  const shortGrowth = client.batchBoxFor({ left: 40, top: 300, bottom: 328 }, { width: 1280, height: 900 });
  assert.equal(shortGrowth.placement, "up");
  assert.ok(shortGrowth.maxHeight <= 292, "a low trigger keeps the panel above itself");

  // Trigger glued to the top: there is no room above, so the card flips below.
  const flipped = client.batchBoxFor({ left: 40, top: 6, bottom: 34 }, { width: 1280, height: 900 });
  assert.equal(flipped.placement, "down");
  assert.equal(flipped.top, 34 + 8, "flipped panel hangs below the trigger");
  assert.equal(flipped.bottom, null);
  assert.ok(flipped.maxHeight > 400, "a flip unlocks the space below");

  const narrow = client.batchBoxFor({ left: 4, top: 700, bottom: 728 }, { width: 320, height: 800 });
  assert.ok(narrow.width <= 304, "a narrow viewport shrinks the panel instead of overflowing");

  const noViewport = client.batchBoxFor({ left: 100, top: 500, bottom: 528 }, { width: 0, height: 0 });
  assert.equal(noViewport.width, 360, "unknown viewport keeps the default width");
  assert.ok(noViewport.maxHeight > 0);
  assert.equal(noViewport.placement, "up", "without a viewport height we never guess a flip");
});

test("11. batchPresence classifies empty vs present conservatively (hidden unless proven actionable)", () => {
  const client = loadClient();
  assert.equal(
    client.batchPresence({ ok: true, value: { children: [{ childId: "c1", selectable: true }] } }),
    "present"
  );
  assert.equal(client.batchPresence({ ok: true, value: { children: [] } }), "empty");
  assert.equal(
    client.batchPresence({
      ok: true,
      value: { children: [{ childId: "c1", selectable: false, reason: "ended" }, { childId: "c2", selectable: false, reason: "exempt" }] }
    }),
    "empty"
  );
  assert.equal(client.batchPresence(null), "empty");
  assert.equal(client.batchPresence({ ok: false }), "empty");
  assert.equal(client.batchPresence({ ok: true, value: null }), "empty");
});
