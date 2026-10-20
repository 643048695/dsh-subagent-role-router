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
        return () => {
          slotRegistrations.splice(slotRegistrations.indexOf(opts), 1);
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
    slotRegistrations
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

  // Cards slots (3 items) and notice slot (1 item) should be registered (total 4)
  assert.equal(slotRegistrations.length, 4, "Settings cards and chat notice node must be registered in slots");

  // Verify formsCtx.effect cleanup executes without error and disposes resources
  assert.ok(formsEffects.length >= 2, "Forms effects must include settingsScope and cards slot disposers");

  // Run formsCtx teardown (e.g. settings plugin reload or route change)
  for (const cleanup of formsEffects) {
    cleanup();
  }

  // Verify settings cards slots (3 items) were unregistered, only notice slot remains
  assert.equal(slotRegistrations.length, 1, "Only chat notice slot should remain after formsCtx teardown");
  assert.equal(slotRegistrations[0].name, "conversation.chat.node", "Remaining slot must be conversation.chat.node");

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
