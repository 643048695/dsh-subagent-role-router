import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Load client.js in sandbox
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

// Harness to build mock Cordis context
function createMockContext(overrides = {}) {
  const effectCleanups = [];
  const slotInjections = [];
  const slotRegistrations = [];
  const slotComponents = [];

  const fakeScope = overrides.settingsScope ?? {
    status: "ready",
    value: overrides.settingsValue ?? { showChatModelNotice: true, forkWindowTurns: 5 },
    writable: true,
    getSnapshot() {
      return { status: this.status, value: this.value, writable: this.writable };
    },
    subscribe(fn) {
      this._sub = fn;
      return () => { this._sub = null; };
    },
    trigger(nextVal) {
      this.value = nextVal;
      if (this._sub) this._sub();
    }
  };

  const formsService = overrides.formsService ?? {
    describe() {
      return {
        getSnapshot: () => ({ view: { namespaces: [{ ns: "dsh-subagent-role-router" }] }, status: "ready" }),
        subscribe: (fn) => {
          this._mirrorSub = fn;
          return () => { this._mirrorSub = null; };
        }
      };
    },
    get(ns) {
      if (ns === "dsh-subagent-role-router") return fakeScope;
      return undefined;
    }
  };

  const formsEffects = [];
  const formsCtx = {
    configForms: formsService,
    effect(cb) {
      const cleanup = cb();
      if (typeof cleanup === "function") formsEffects.push(cleanup);
      return cleanup;
    }
  };

  const ctx = {
    get(key) {
      if (key === "remote.session") {
        return {
          async modelCatalog() {
            return { ok: true, value: { groups: [{ id: "mock", models: [{ id: "model-a" }] }] } };
          }
        };
      }
      return undefined;
    },
    effect(cb) {
      const cleanup = cb();
      if (typeof cleanup === "function") effectCleanups.push(cleanup);
      return cleanup;
    },
    inject(deps, cb) {
      if (deps.includes("configForms")) {
        cb(formsCtx);
      }
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key
    },
    slots: {
      inject(name, cb) {
        slotInjections.push(name);
        const res = cb();
        return () => {
          slotInjections.splice(slotInjections.indexOf(name), 1);
        };
      },
      register(opts, comp) {
        slotRegistrations.push(opts);
        slotComponents.push(comp);
        return () => {
          slotRegistrations.splice(slotRegistrations.indexOf(opts), 1);
          slotComponents.splice(slotComponents.indexOf(comp), 1);
        };
      }
    },
    uiConversation: {
      events: {
        register: (def) => () => {}
      }
    }
  };

  return {
    ctx,
    formsCtx,
    fakeScope,
    effectCleanups,
    formsEffects,
    slotInjections,
    slotRegistrations,
    slotComponents
  };
}

test("1. Cordis apply injection: apply.inject and exports conform to Cordis contract", () => {
  const client = loadClient();
  assert.ok(typeof client.apply === "function", "client must export apply");
  assert.ok(Array.isArray(client.inject), "client must export inject array");
  assert.deepEqual(Array.from(client.inject), ["slots", "locale", "uiConversation"], "inject should match expected services");
  assert.ok(Array.isArray(client.apply.inject), "apply function must carry inject property for direct Cordis usage");
  assert.deepEqual(Array.from(client.apply.inject), Array.from(client.inject), "apply.inject must match export inject");
});

test("2. forkWindowTurns validation: normalizeForkWindowTurns enforces bounds [1, 20] and integer types", () => {
  const client = loadClient();
  const norm = client.normalizeForkWindowTurns;
  assert.ok(typeof norm === "function", "normalizeForkWindowTurns must be exported");

  // Valid numbers
  assert.equal(norm(1), 1);
  assert.equal(norm(3), 3);
  assert.equal(norm(10), 10);
  assert.equal(norm(20), 20);

  // Valid numeric strings
  assert.equal(norm("1"), 1);
  assert.equal(norm(" 5 "), 5);
  assert.equal(norm("20"), 20);

  // Out of bounds -> fallback to default 3
  assert.equal(norm(0), 3, "0 must fallback to 3");
  assert.equal(norm(-1), 3, "-1 must fallback to 3");
  assert.equal(norm(21), 3, "21 must fallback to 3");
  assert.equal(norm("99"), 3, "'99' must fallback to 3");

  // Floats, NaN, invalid strings, objects -> fallback to 3
  assert.equal(norm(3.5), 3, "Float must fallback to 3");
  assert.equal(norm("3.5"), 3, "Float string must fallback to 3");
  assert.equal(norm("5abc"), 3, "Alphanumeric string must fallback to 3");
  assert.equal(norm(""), 3, "Empty string must fallback to 3");
  assert.equal(norm(null), 3, "null must fallback to 3");
  assert.equal(norm(undefined), 3, "undefined must fallback to 3");
  assert.equal(norm(NaN), 3, "NaN must fallback to 3");
  assert.equal(norm({}), 3, "Object must fallback to 3");
});

test("3. forkWindowTurns in serializeDefaultModels: accurately serialized and sanitized", () => {
  const client = loadClient();
  const serialize = client.serializeDefaultModels;

  const res1 = serialize({}, [], "round-robin", true, true, null, { forkWindowSlicing: true, forkWindowTurns: "7" }, true);
  assert.equal(res1.forkWindowTurns, 7);
  assert.equal(res1.forkWindowSlicing, true);
  assert.equal(res1.showChatModelNotice, true);

  const res2 = serialize({}, [], "round-robin", true, true, null, { forkWindowSlicing: false, forkWindowTurns: 999 }, false);
  assert.equal(res2.forkWindowTurns, 3, "Out of bounds forkWindowTurns must fallback to 3");
  assert.equal(res2.forkWindowSlicing, false);
  assert.equal(res2.showChatModelNotice, false);
});

test("4. notice toggle sync & unmount lifecycle", () => {
  const client = loadClient();
  const { ctx, effectCleanups, fakeScope } = createMockContext();

  // Initially notice is false
  assert.equal(client.isNoticeEnabled(), false, "Initial notice status must be false");

  // Call apply with initial config showChatModelNotice = false
  client.apply(ctx, { showChatModelNotice: false });

  // When settingsScope binds to fakeScope which has showChatModelNotice: true,
  // it must automatically synchronize to notice
  assert.equal(client.isNoticeEnabled(), true, "Notice must sync from settingsScope snapshot");

  // Trigger change from scope subscription to false
  fakeScope.trigger({ showChatModelNotice: false, forkWindowTurns: 3 });
  assert.equal(client.isNoticeEnabled(), false, "Notice must sync on scope update");

  // Trigger change back to true
  fakeScope.trigger({ showChatModelNotice: true, forkWindowTurns: 3 });
  assert.equal(client.isNoticeEnabled(), true, "Notice must sync on scope update to true");

  // Fiber teardown (effect cleanups)
  for (const cleanup of effectCleanups) {
    cleanup();
  }

  // After teardown, notice must be reset to false to avoid leaking across plugin reloads
  assert.equal(client.isNoticeEnabled(), false, "Notice must reset to false on fiber teardown");
});

test("5. settings subscription & cards slots cleanup on formsCtx dispose and fiber teardown", () => {
  const client = loadClient();
  const { ctx, formsEffects, effectCleanups, slotRegistrations } = createMockContext();

  client.apply(ctx);

  // Cards slots (3 items), the chat notice node (1) and the live route picker
  // (2 surfaces: session header + composer tool row) should be registered
  // (total 6). The picker lives on the fiber, not on the forms scope, because
  // it only needs `slots` + the model catalog.
  assert.equal(slotRegistrations.length, 6, "Settings cards, chat notice node and both live route picker surfaces must be registered in slots");
  assert.deepEqual(
    slotRegistrations.map((entry) => entry.name).sort(),
    [
      "conversation.chat.node",
      "conversation.input.right",
      "conversation.session.header.actions",
      "plugins.bundle.config",
      "plugins.item",
      "plugins.row.config"
    ],
    "every expected slot must be claimed exactly once"
  );

  // Verify formsCtx.effect cleanup executes without error and disposes resources
  assert.ok(formsEffects.length >= 2, "Forms effects must include settingsScope and cards slot disposers");

  // Run formsCtx teardown (e.g. settings plugin reload or route change)
  for (const cleanup of formsEffects) {
    cleanup();
  }

  // Verify settings cards slots (3 items) were unregistered; the notice row and
  // the picker are fiber-scoped, so they must survive a settings-only reload.
  assert.equal(slotRegistrations.length, 3, "The notice row and both live route picker surfaces must survive a formsCtx teardown");
  assert.deepEqual(
    slotRegistrations.map((entry) => entry.name).sort(),
    ["conversation.chat.node", "conversation.input.right", "conversation.session.header.actions"],
    "Remaining slots must be the chat notice row and both live route picker surfaces"
  );

  // Run full fiber teardown
  for (const cleanup of effectCleanups) {
    cleanup();
  }

  // Verify all slots (including notice) are completely unregistered
  assert.equal(slotRegistrations.length, 0, "All slots must be completely unregistered on full fiber teardown");
});

test("6. apply initial config: showChatModelNotice passed in config is active when settingsValue is unconfigured", () => {
  const client = loadClient();
  const { ctx, effectCleanups } = createMockContext({
    settingsValue: {}
  });

  // Call apply with config.showChatModelNotice = true
  client.apply(ctx, { showChatModelNotice: true });
  assert.equal(client.isNoticeEnabled(), true, "Notice must be enabled from config when settingsValue has no explicit boolean");

  // Fiber teardown
  for (const cleanup of effectCleanups) cleanup();
  assert.equal(client.isNoticeEnabled(), false, "Notice must reset to false after fiber teardown");
});

test("7. settingsScope timers and listeners cleanup via dispose", () => {
  const client = loadClient();
  let capturedInjected = null;
  const mockScope = {
    status: "ready",
    value: { showChatModelNotice: true },
    getSnapshot() { return { status: this.status, value: this.value }; },
    subscribe() { return () => {}; }
  };

  const { ctx, formsEffects } = createMockContext({
    settingsScope: mockScope
  });

  client.apply(ctx);

  // formsEffects should have settingsScope lifecycle effect registered
  assert.ok(formsEffects.length > 0, "formsEffects should have registered cleanup");

  // Running formsEffects should gracefully dispose settingsScope without throwing
  assert.doesNotThrow(() => {
    for (const cleanup of formsEffects) cleanup();
  }, "Teardown of settingsScope must execute cleanly");
});

test("8. edge cases of forkWindowTurns validation", () => {
  const client = loadClient();
  const norm = client.normalizeForkWindowTurns;

  // Extreme edge cases
  assert.equal(norm("  10  "), 10);
  assert.equal(norm("003"), 3);
  assert.equal(norm("000"), 3);
  assert.equal(norm("-0"), 3);
  assert.equal(norm(1.0), 1, "Integer represented as double is valid");
  assert.equal(norm(1.0000001), 3, "Non-integer float must fallback to 3");
  assert.equal(norm(Number.MAX_SAFE_INTEGER), 3, "Number above 20 must fallback to 3");
  assert.equal(norm(Number.MIN_SAFE_INTEGER), 3, "Number below 1 must fallback to 3");
  assert.equal(norm(Infinity), 3);
  assert.equal(norm(-Infinity), 3);
  assert.equal(norm([5]), 3, "Array must fallback to 3");
  assert.equal(norm(true), 3, "Boolean must fallback to 3");
});

// ── role candidate pools: form shape invariants ─────────────────────────────

// client.js runs in its OWN vm realm, so values it builds carry that realm's
// Object.prototype and `deepStrictEqual` rejects them as "same structure but not
// reference-equal". Compare the plain JSON projection instead.
const plain = (value) => JSON.parse(JSON.stringify(value));

test("9. normalizeRoleRoutes: pool array first, legacy single value second, always one row", () => {
  const client = loadClient();
  const norm = client.normalizeRoleRoutes;

  // The stored pool wins over the legacy triple.
  assert.deepEqual(
    plain(norm({ patchProvider: "old", patchModel: "oldm", patchModels: [{ provider: "p", model: "m1" }, { provider: "q", model: "m2", reasoningEffort: "high" }] }, "patch")),
    [{ provider: "p", model: "m1", reasoningEffort: "" }, { provider: "q", model: "m2", reasoningEffort: "high" }]
  );

  // An empty pool falls back to the legacy single route.
  assert.deepEqual(
    plain(norm({ patchProvider: "legacy", patchModel: "legacy-model", patchEffort: "low", patchModels: [] }, "patch")),
    [{ provider: "legacy", model: "legacy-model", reasoningEffort: "low" }]
  );

  // A bare-string entry takes the role's own provider.
  assert.deepEqual(
    plain(norm({ exploreProvider: "p", exploreModels: ["bare"] }, "explore")),
    [{ provider: "p", model: "bare", reasoningEffort: "" }]
  );

  // Nothing configured at all: exactly one blank row, so the card can render
  // and the user has something to fill in.
  assert.deepEqual(plain(norm({}, "plan")), [{ provider: "", model: "", reasoningEffort: "" }]);
  assert.deepEqual(plain(norm(undefined, "plan")), [{ provider: "", model: "", reasoningEffort: "" }]);
});

test("10. serializeRolePool drops blank spare lanes but keeps half-filled ones out of the document", () => {
  const client = loadClient();
  const serialize = client.serializeRolePool;

  assert.deepEqual(plain(serialize([
    { provider: "p", model: "m1", reasoningEffort: "" },
    { provider: "", model: "", reasoningEffort: "" },
    { provider: "q", model: "m2", reasoningEffort: "high" }
  ])), [
    { provider: "p", model: "m1" },
    { provider: "q", model: "m2", reasoningEffort: "high" }
  ], "blank rows must be dropped and an empty effort must not be written");

  assert.deepEqual(plain(serialize([])), []);
  assert.deepEqual(plain(serialize(null)), []);
});

test("10b. exempt rules: normalize defaults, serialize drops pattern-less rows, halves block save", () => {
  const client = loadClient();

  // normalize: unknown/missing fields fall back to the documented defaults.
  assert.deepEqual(plain(client.normalizeExemptRules({})), []);
  assert.deepEqual(plain(client.normalizeExemptRules({
    exemptRules: [
      { pattern: "egm-goldfish-" },
      { name: "n", match: "cwd", pattern: "/ws/.egm", provider: "p", model: "m", effort: "high" },
      null,
      { match: "warp", pattern: "x" }
    ]
  })), [
    { name: "", match: "label", pattern: "egm-goldfish-", provider: "", model: "", effort: "" },
    { name: "n", match: "cwd", pattern: "/ws/.egm", provider: "p", model: "m", effort: "high" },
    { name: "", match: "label", pattern: "x", provider: "", model: "", effort: "" }
  ], "unknown match kinds normalize to label and junk rows keep their pattern for editing");

  // serialize: a pattern-less rule is meaningless (matches nothing) and is
  // dropped; a provider pin without a model degrades to a plain exemption
  // (the half-filled state itself is blocked from saving upstream).
  assert.deepEqual(plain(client.serializeExemptRules([
    { name: "kept", match: "preset", pattern: "egm-goldfish-", provider: "", model: "" },
    { name: "no pattern", match: "label", pattern: "  " },
    { name: "half pin", match: "label", pattern: "p-", provider: "only-provider", model: "" }
  ])), [
    { name: "kept", match: "preset", pattern: "egm-goldfish-", provider: "", model: "", effort: "" },
    { name: "half pin", match: "label", pattern: "p-", provider: "", model: "", effort: "" }
  ]);
  assert.deepEqual(plain(client.serializeExemptRules(null)), []);

  // A model pin without a provider blocks Save, exactly like a half-filled
  // role lane.
  assert.equal(client.exemptRuleIncomplete([{ provider: "p", model: "m" }]), false);
  assert.equal(client.exemptRuleIncomplete([{ provider: "p", model: "" }]), true);
  assert.equal(client.exemptRuleIncomplete([{ provider: "", model: "m" }]), true);
  assert.equal(client.exemptRuleIncomplete([]), false);
  assert.equal(client.exemptRuleIncomplete(null), false);
});

test("11. roleRouteIncomplete: blank lane is fine, half-filled lane is not", () => {
  const client = loadClient();
  const incomplete = client.roleRouteIncomplete;

  assert.equal(incomplete([{ provider: "", model: "" }]), false, "a spare blank lane is not an error");
  assert.equal(incomplete([{ provider: "p", model: "m" }]), false);
  assert.equal(incomplete([{ provider: "p", model: "" }]), true, "provider without model cannot be saved");
  assert.equal(incomplete([{ provider: "", model: "m" }]), true, "model without provider cannot be saved");
  assert.equal(incomplete([]), false);
  assert.equal(incomplete(null), false);
});

test("12. roleSlotCooldownSeconds: defaults to 15, 0 is a valid value, out of range falls back", () => {
  const client = loadClient();
  const norm = client.normalizeRoleCooldownSeconds;

  assert.equal(norm(undefined), 15);
  assert.equal(norm(null), 15);
  assert.equal(norm(0), 0, "0 must survive: it means 'do not cool down'");
  assert.equal(norm("0"), 0);
  assert.equal(norm(15), 15);
  assert.equal(norm("30"), 30);
  assert.equal(norm(3600), 3600);
  assert.equal(norm(3601), 15);
  assert.equal(norm(-1), 15);
  assert.equal(norm(1.5), 15);
  assert.equal(norm("abc"), 15);
});

test("12b. effortChoicesFor offers only declared efforts, never a guessed list", () => {
  const client = loadClient();
  const choices = client.effortChoicesFor;

  // A model that declares nothing must yield nothing: offering low/medium/high
  // here makes the host reject the next request with UNSUPPORTED_REASONING_EFFORT
  // (observed live with sensenova/kimi-k3).
  assert.deepEqual(Array.from(choices({ id: "m", reasoning: { efforts: [] } })), []);
  assert.deepEqual(Array.from(choices({ id: "m" })), []);
  assert.deepEqual(Array.from(choices(null)), []);
  assert.deepEqual(Array.from(choices(undefined)), []);

  const declared = choices({ id: "m", reasoning: { efforts: [{ id: "low" }, { id: "max" }] } });
  assert.deepEqual(declared.map((c) => c.id), ["low", "max"]);
});

test("13. serializeDefaultModels writes both the pool and its first lane as the legacy triple", () => {
  const client = loadClient();
  const serialize = client.serializeDefaultModels;

  const next = plain(serialize({}, [], "round-robin", true, true, {
    roleMode: true,
    rolePools: {
      explore: [{ provider: "e", model: "em", reasoningEffort: "" }],
      plan: [{ provider: "pl", model: "plm", reasoningEffort: "high" }, { provider: "pl2", model: "plm2", reasoningEffort: "" }],
      patch: [{ provider: "pa", model: "pam", reasoningEffort: "" }, { provider: "", model: "", reasoningEffort: "" }]
    },
    roleSlotCooldownSeconds: 45
  }, null, false));

  assert.deepEqual(next.exploreModels, [{ provider: "e", model: "em" }]);
  assert.deepEqual(next.planModels, [
    { provider: "pl", model: "plm", reasoningEffort: "high" },
    { provider: "pl2", model: "plm2" }
  ]);
  assert.deepEqual(next.patchModels, [{ provider: "pa", model: "pam" }], "the blank spare lane must not be stored");

  // Legacy triple mirrors lane 1, so an older build reads the same primary route.
  assert.equal(next.exploreProvider, "e");
  assert.equal(next.exploreModel, "em");
  assert.equal(next.planProvider, "pl");
  assert.equal(next.planModel, "plm");
  assert.equal(next.planEffort, "high");
  assert.equal(next.patchModel, "pam");
  assert.equal(next.roleSlotCooldownSeconds, 45);
});

test("14. savedFormFingerprint covers the role pools, and seedFromSavedForm round-trips them", () => {
  const client = loadClient();
  const fingerprint = client.savedFormFingerprint;
  const seed = client.seedFromSavedForm;

  const section = {
    provider: "base", model: "base-a",
    models: [{ provider: "base", model: "base-a" }],
    roleMode: true,
    exploreModels: [{ provider: "e", model: "em" }],
    planModels: [{ provider: "p1", model: "m1" }, { provider: "p2", model: "m2" }],
    patchModels: [{ provider: "g", model: "gm" }],
    roleSlotCooldownSeconds: 30
  };
  const held = fingerprint(section);

  // Two sections that differ ONLY in a role pool must not share a fingerprint:
  // otherwise a lagging mirror would resurrect the old candidate list.
  const changedPool = JSON.parse(JSON.stringify(section));
  changedPool.patchModels = [{ provider: "g", model: "other" }];
  assert.notEqual(fingerprint(changedPool), held);

  const changedCooldown = JSON.parse(JSON.stringify(section));
  changedCooldown.roleSlotCooldownSeconds = 31;
  assert.notEqual(fingerprint(changedCooldown), held);

  const rebuilt = seed(held, {});
  assert.deepEqual(plain(rebuilt.exploreModels), [{ provider: "e", model: "em", reasoningEffort: "" }]);
  assert.deepEqual(plain(rebuilt.planModels), [
    { provider: "p1", model: "m1", reasoningEffort: "" },
    { provider: "p2", model: "m2", reasoningEffort: "" }
  ]);
  assert.deepEqual(plain(rebuilt.patchModels), [{ provider: "g", model: "gm", reasoningEffort: "" }]);
  assert.equal(rebuilt.roleSlotCooldownSeconds, 30);
  assert.deepEqual(plain(client.normalizeDefaultModels(rebuilt)), [{ provider: "base", model: "base-a", reasoningEffort: "" }]);

  // A fingerprint of the rebuilt section must match the original exactly.
  assert.equal(fingerprint(rebuilt), held);

  // Defensive: garbage and the old bare-array shape must not throw.
  assert.deepEqual(plain(seed("{not json", { fallback: true })), { fallback: true });
  assert.equal(seed(null, { fallback: true }).fallback, true);
  assert.deepEqual(plain(client.normalizeDefaultModels(seed(JSON.stringify([{ provider: "x", model: "y" }]), {}))),
    [{ provider: "x", model: "y", reasoningEffort: "" }]);
});

test("15. the team birth model serializes and survives the fingerprint round-trip", () => {
  const client = loadClient();

  const serialized = client.serializeDefaultModels({}, [{ provider: "b", model: "bm" }], "round-robin", true, true, {
    roleMode: false,
    teamModel: { provider: "tp", model: "tm", effort: "high" }
  }, {}, false);
  assert.equal(serialized.teamModelProvider, "tp");
  assert.equal(serialized.teamModelName, "tm");
  assert.equal(serialized.teamModelEffort, "high");

  // Empty effort means "the provider's default" and must stay empty — a half
  // value would be sent to the provider and rejected.
  const noEffort = client.serializeDefaultModels({}, [], "round-robin", true, true, {
    teamModel: { provider: "tp", model: "tm", effort: "" }
  }, {}, false);
  assert.equal(noEffort.teamModelProvider, "tp");
  assert.equal(noEffort.teamModelEffort, "");

  // Fingerprints must differ when only the birth model differs, else a lagging
  // mirror resurrects the old model after a save (same rule as the pools).
  const base = { models: [], teamModelProvider: "", teamModelName: "", teamModelEffort: "" };
  const withTeam = { models: [], teamModelProvider: "tp", teamModelName: "tm", teamModelEffort: "" };
  assert.notEqual(client.savedFormFingerprint(withTeam), client.savedFormFingerprint(base));

  const rebuilt = client.seedFromSavedForm(client.savedFormFingerprint(withTeam), {});
  assert.equal(rebuilt.teamModelProvider, "tp");
  assert.equal(rebuilt.teamModelName, "tm");
  assert.equal(rebuilt.teamModelEffort, "");
  assert.equal(client.savedFormFingerprint(rebuilt), client.savedFormFingerprint(withTeam));
});

// ── selection shim: directoryFor wrap + subagent-vs-parent routing ──────────
// The shim makes theme/host model seats functional on subagent pages by
// wrapping the host's ModelDirectoryResolver.directoryFor: every directory it
// returns gets (1) the assertAvailable gate lifted on its prototype and (2) an
// instance-level select() that reroutes subagent sessions to the plugin
// endpoint while parents pass through untouched. All of it must restore on
// dispose.

test("selection shim reroutes subagent directory selects and passes parents through", async () => {
  const client = loadClient();
  const routed = [];
  const passthrough = [];
  const painted = [];
  class FakeDirectory {
    constructor(sid) {
      this.sessionId = sid;
      this.store = {
        update(fn) {
          const s = { status: "", pending: null, error: null, current: { provider: "old", model: "old", reasoningEffort: "high" } };
          fn(s);
          painted.push(s);
        }
      };
      this.synced = 0;
    }
    assertAvailable() { throw new Error("model selection is unavailable for addressed subagent sessions"); }
    syncInputs() { this.synced += 1; }
    async select(selection) { passthrough.push(selection); return { ok: true, value: undefined }; }
  }
  const directories = {};
  const resolver = {
    directoryFor(sid) { return directories[sid] ??= new FakeDirectory(sid); }
  };
  const sessions = {
    subagentAddress: (sid) => (sid === "child-1" ? { parentSessionId: "p", childSessionId: sid } : undefined),
    getSnapshot: () => ({ byId: {} })
  };
  const handle = client.installSelectionShim(null, {
    resolver: () => resolver,
    sessions: () => sessions,
    select: async (request) => {
      routed.push(request);
      return { ok: true, value: undefined };
    },
    sleep: () => Promise.resolve(),
    attempts: 2
  });
  assert.equal(await handle.whenReady, true);

  // Subagent: rerouted to the endpoint with the childId mapping; the RPC is
  // never reached; the gate is lifted on the shared prototype.
  const sub = resolver.directoryFor("child-1");
  const out = await sub.select({ provider: "magpie", model: "m1", reasoningEffort: "high" });
  assert.equal(out.ok, true);
  assert.equal(routed.length, 1);
  assert.equal(routed[0].childId, "child-1");
  assert.equal(routed[0].provider, "magpie");
  assert.equal(routed[0].model, "m1");
  assert.equal(routed[0].reasoningEffort, "high");
  assert.equal(passthrough.length, 0);
  sub.assertAvailable();
  assert.equal(painted[painted.length - 1].status, "ready");
  assert.equal(painted[painted.length - 1].current.model, "m1");

  // Parent: straight through to the real select.
  const main = resolver.directoryFor("main-1");
  await main.select({ provider: "magpie", model: "m2" });
  assert.equal(passthrough.length, 1);
  assert.equal(routed.length, 1);

  // Dispose unwraps the instance select, the gate and the resolver.
  handle.dispose();
  assert.throws(() => sub.assertAvailable(), /unavailable/);
  await sub.select({ provider: "x", model: "y" });
  assert.equal(passthrough.length, 2);
  assert.equal(routed.length, 1);
});

test("selection shim stays dormant while the resolver service never appears", async () => {
  const client = loadClient();
  const handle = client.installSelectionShim(null, {
    resolver: () => undefined,
    sessions: () => ({}),
    select: async () => ({ ok: true, value: undefined }),
    sleep: () => Promise.resolve(),
    attempts: 3
  });
  assert.equal(await handle.whenReady, false);
  handle.dispose();
});

test("selection shim waits for a late-mounted resolver, then wraps it", async () => {
  const client = loadClient();
  let resolver = null;
  class FakeDirectory {
    assertAvailable() { throw new Error("gate"); }
    async select() { return { ok: true, value: undefined }; }
  }
  const handle = client.installSelectionShim(null, {
    resolver: () => resolver,
    sessions: () => ({ getSnapshot: () => ({ byId: {} }) }),
    select: async () => ({ ok: true, value: undefined }),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 2)),
    attempts: 40
  });
  await new Promise((resolve) => setTimeout(resolve, 12));
  resolver = { directoryFor: () => new FakeDirectory() };
  assert.equal(await handle.whenReady, true);
  handle.dispose();
});

test("a picked model survives the directory the host rebuilds for a child", () => {
  const client = loadClient();
  const pick = { provider: "magpie", model: "workbuddy-ai/kimi-k3", reasoningEffort: "high" };

  // Recorded under every id spelling the two halves of the app disagree on.
  // (Field-by-field: the client lives in another vm realm, so deepEqual on
  // the object would fail on prototype identity rather than on content.)
  client.rememberPicked("session-abc", pick);
  assert.equal(client.pickedFor("session-abc").model, "workbuddy-ai/kimi-k3");
  assert.equal(client.pickedFor("abc").reasoningEffort, "high");

  // A later session does not overwrite the first.
  client.rememberPicked("def", { provider: "magpie", model: "group/dnq" });
  assert.equal(client.pickedFor("session-abc").model, "workbuddy-ai/kimi-k3");

  // Re-picking replaces the record; an incomplete selection is refused
  // rather than stored as a half-written current.
  client.rememberPicked("session-abc", { provider: "magpie", model: "group/dnq", reasoningEffort: "low" });
  assert.equal(client.pickedFor("abc").reasoningEffort, "low");
  assert.equal(client.rememberPicked("abc", { provider: "", model: "x" }), null);
  assert.equal(client.pickedFor("abc").model, "group/dnq");
  assert.equal(client.rememberPicked(undefined, pick), null);

  // Reset forgets it under every spelling.
  client.forgetPicked("abc");
  assert.equal(client.pickedFor("session-abc"), null);
  assert.equal(client.pickedFor("abc"), null);
  assert.equal(client.pickedFor(undefined), null);
});

test("claimModelControl marks the composer card, never the whole document", () => {
  const client = loadClient();
  const attrs = {};
  const card = {
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    setAttribute: (n, v) => { attrs[n] = v; },
    removeAttribute: (n) => { delete attrs[n]; }
  };
  // The picker's root sits inside a composer card; `closest` finds it.
  const insideCard = { closest: (sel) => (sel === "[data-composer-card]" ? card : null) };
  // A picker rendered outside any composer card (header surface).
  const outsideCard = { closest: () => null };

  // Inactive: nothing is claimed.
  const noop = client.claimModelControl(false, insideCard);
  assert.equal(card.getAttribute("data-dsm-live-route"), null);
  noop();

  // Active: the mark lands on the composer card, so a parent conversation
  // rendered beside this pane keeps its own seat.
  const release = client.claimModelControl(true, insideCard);
  assert.equal(card.getAttribute("data-dsm-live-route"), "1");
  release();
  assert.equal(card.getAttribute("data-dsm-live-route"), null);

  // A pre-existing value is restored, not blindly deleted.
  card.setAttribute("data-dsm-live-route", "kept");
  const releaseKept = client.claimModelControl(true, insideCard);
  assert.equal(card.getAttribute("data-dsm-live-route"), "1");
  releaseKept();
  assert.equal(card.getAttribute("data-dsm-live-route"), "kept");

  // No DOM at all must not throw (the client also loads in a bare sandbox),
  // and an anchor outside every composer card claims nothing.
  for (const anchor of [null, undefined, outsideCard]) {
    const safe = client.claimModelControl(true, anchor);
    assert.equal(typeof safe, "function");
    safe();
  }
});

test("selection shim treats unknown sessions as parents, never reroutes them", async () => {
  const client = loadClient();
  const routed = [];
  const passthrough = [];
  class Dir {
    constructor(sid) {
      this.sessionId = sid;
      this.store = { update() {} };
    }
    assertAvailable() {}
    async select(selection) { passthrough.push(selection); return { ok: true, value: { passed: selection.model } }; }
  }
  const dirs = {};
  const resolver = { directoryFor: (sid) => (dirs[sid] ??= new Dir(sid)) };
  // No subagentAddress helper at all: only the snapshot origin may classify.
  const sessions = {
    getSnapshot: () => ({ byId: { "known-child": { origin: "subagent" } } })
  };
  const handle = client.installSelectionShim(null, {
    resolver: () => resolver,
    sessions: () => sessions,
    select: async (request) => {
      routed.push(request);
      return { ok: true, value: undefined };
    },
    sleep: () => Promise.resolve()
  });
  await handle.whenReady;
  const known = resolver.directoryFor("known-child");
  await known.select({ provider: "a", model: "b" });
  assert.equal(routed.length, 1);              // snapshot origin fallback caught it
  assert.equal(routed[0].childId, "known-child");
  const stranger = await resolver.directoryFor("who-is-this").select({ provider: "a", model: "b" });
  assert.equal(stranger.value.passed, "b");
  assert.equal(routed.length, 1);
  handle.dispose();
});

// ── the captured context: helpers that render outside apply() ──────────────
// resolveCurrentSessionId and hostSaysSubagent run in the picker's render path
// and in the shim's late probes, i.e. outside apply(). They used to read a bare
// `ctx`, which is not in scope at module level — `typeof ctx` is "undefined"
// there and every lookup silently failed, so no session id ever resolved and no
// subagent was ever recognised. These tests pin the captured-context contract.

test("service lookups outside apply go through the captured context", () => {
  const client = loadClient();
  const sessions = {
    subagentAddress: (sid) => (sid === "child-7" ? { parentSessionId: "p", childSessionId: sid } : void 0),
    list: { getSnapshot: () => ({ current: "child-7", byId: { "child-7": { origin: "subagent" } } }) }
  };
  const ctx = {
    get: (name) => (name === "sessions" ? sessions : name === "uiSession" ? { current: { value: { key: "child-7" } } } : void 0)
  };
  client.setPluginCtx(ctx);

  // No override argument: the helper must reach the captured context by itself.
  assert.equal(client.hostSaysSubagent("child-7"), true);
  assert.equal(client.hostSaysSubagent("parent-1"), false);
  assert.equal(client.resolveCurrentSessionId(undefined), "child-7");
  assert.equal(client.resolveCurrentSessionId("explicit"), "explicit", "an explicit id always wins");

  // A context whose services are absent must answer "not a child", never throw.
  client.setPluginCtx({ get: () => void 0 });
  assert.equal(client.hostSaysSubagent("child-7"), false);
  client.setPluginCtx(null);
  assert.equal(client.hostSaysSubagent("child-7"), false);
});

test("apply captures the plugin context so the picker can resolve a session", () => {
  const client = loadClient();
  const seen = [];
  const ctx = {
    get: (name) => (name === "uiSession" ? { current: { value: { key: "session-abc" } } } : void 0),
    effect: (fn) => { const off = fn(); return () => off?.(); },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: { inject: () => () => {}, register: () => () => {} },
    settings: { scope: () => ({ status: "ready", value: {}, writable: true, subscribe: () => () => {} }) }
  };
  // Only the capture side matters here; the rest of apply is exercised elsewhere.
  try { client.apply(ctx, {}); } catch (_e) { /* slots absent: capture already happened */ }
  seen.push(client.resolveCurrentSessionId(undefined));
  assert.equal(seen[0], "session-abc", "apply must publish its ctx to the module helpers");
});

test("settings card and row render without throwing (regression: an out-of-scope effect dep crashed the whole settings page)", () => {
  const client = loadClient();
  const { ctx, fakeScope, slotRegistrations, slotComponents } = createMockContext();
  client.apply(ctx);

  const bundleIndex = slotRegistrations.findIndex((entry) => entry.name === "plugins.bundle.config");
  assert.ok(bundleIndex >= 0, "plugins.bundle.config must be registered");
  const Card = slotComponents[bundleIndex];
  assert.equal(typeof Card, "function", "registration must carry the card component");

  const t = (key) => key;
  // The stub React runs effects synchronously, so a render-time or effect-time
  // ReferenceError (an out-of-scope identifier in a deps array, for example)
  // throws right here instead of being swallowed by the host error boundary.
  assert.doesNotThrow(() => {
    Card({ view: "page", t, settingsScope: fakeScope });
    Card({ view: "summary", t, settingsScope: fakeScope });
  }, "the card must render for both views");

  const Row = client.SubagentModelRow;
  assert.equal(typeof Row, "function", "SubagentModelRow must be exported as a test seam");
  assert.doesNotThrow(() => {
    Row({
      t,
      settingsScope: fakeScope,
      loadCatalog: () => Promise.resolve({ ok: true, value: { groups: [] } })
    });
  }, "the settings row must render");
});

// ── stop fallback: a stop that the host accepts but never applies ──────────
// The composer's stop button cancels through the host's interruptByParent,
// which returns silently when the child is not in its resident table: the UI
// reports success while the child keeps running. The plugin wraps the shared
// Conversation.cancel to measure the outcome and re-interrupt through its own
// endpoint when the child is still going.

test("stop fallback re-interrupts a child the host left running", async () => {
  const client = loadClient();
  const posts = [];
  const logs = [];
  const running = { "child-1": true };
  class FakeConversation {
    constructor(sid) { this.sessionId = sid; }
    async cancel() { return { ok: true, value: undefined }; }
  }
  const conversations = { "child-1": new FakeConversation("child-1"), "main-1": new FakeConversation("main-1") };
  const sessions = {
    scope: (sid) => ({ get: () => conversations[sid] }),
    subagentAddress: (sid) => (sid === "child-1" ? { mode: "continuable", parentSessionId: "p-1", childSessionId: "child-1" } : undefined),
    getSnapshot: () => ({ byId: { "child-1": { running: running["child-1"] === true }, "main-1": { running: false } } })
  };
  const handle = client.installStopFallback({
    sessions,
    post: async (action, payload) => { posts.push([action, payload]); return { ok: true, value: { ok: true } }; },
    sleep: () => Promise.resolve(),
    log: (tag, payload) => logs.push([tag, payload])
  });
  assert.equal(handle.installed, true);

  await conversations["child-1"].cancel();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(posts.length, 1);
  assert.equal(posts[0][0], "stop");
  assert.equal(posts[0][1].childId, "child-1");
  assert.equal(posts[0][1].parentSessionId, "p-1");
  assert.ok(logs.some(([tag]) => tag === "STOP_STILL_RUNNING"));
  assert.ok(logs.some(([tag]) => tag === "STOP_FALLBACK"));

  // A parent session has no address: nothing to re-interrupt.
  await conversations["main-1"].cancel();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(posts.length, 1);

  // Dispose puts the original cancel back.
  handle.dispose();
  assert.equal(conversations["child-1"].cancel, FakeConversation.prototype.cancel);
});

test("stop fallback stays quiet when the child really stopped", async () => {
  const client = loadClient();
  const posts = [];
  const running = { "child-2": true };
  class FakeConversation {
    constructor(sid) { this.sessionId = sid; }
    async cancel() { running[this.sessionId] = false; return { ok: true, value: undefined }; }
  }
  const conversations = { "child-2": new FakeConversation("child-2") };
  const handle = client.installStopFallback({
    sessions: {
      scope: (sid) => ({ get: () => conversations[sid] }),
      subagentAddress: (sid) => ({ parentSessionId: "p-2", childSessionId: sid }),
      getSnapshot: () => ({ byId: { "child-2": { running: running["child-2"] === true } } })
    },
    post: async (action, payload) => { posts.push([action, payload]); return { ok: true }; },
    sleep: () => Promise.resolve(),
    log: () => {}
  });
  await conversations["child-2"].cancel();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(posts.length, 0);
  handle.dispose();
});
