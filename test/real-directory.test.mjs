// Integration test against the REAL host class, not a fake of it.
//
// The unit tests can only prove that the shim calls what it thinks it calls.
// They cannot prove that the host's own ModelDirectory stops throwing, leaves
// "loading", and paints the picked model — that is exactly what kept breaking
// in the real UI, so this file loads the shipped model-selection bundle,
// builds a real ModelDirectory, and drives the real select() through the shim.
//
// The bundle is read from a local extraction of the installed app. When that
// extraction is missing (a fresh machine, CI), the file skips itself instead of
// pretending to pass.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const HOST_BUNDLE = process.env.DSH_MODEL_SELECTION_SRC
  ?? "C:/Users/A6430/Documents/deepseek-harness/default-workspace/_asar/inv/model-selection.js";

const skip = existsSync(HOST_BUNDLE) ? false : `host bundle not extracted at ${HOST_BUNDLE}`;

const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

/** A snapshot store with the three methods the host controller uses. */
function makeStore(initial) {
  let snapshot = { ...initial };
  const subscribers = new Set();
  const notify = () => {
    for (const callback of [...subscribers]) callback(snapshot);
  };
  return {
    getSnapshot: () => snapshot,
    set: (next) => {
      snapshot = { ...next };
      notify();
    },
    update: (mutate) => {
      const draft = { ...snapshot };
      mutate(draft);
      snapshot = draft;
      notify();
    },
    subscribe: (callback) => {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
  };
}

/** Anything the bundle touches that this test does not model. */
function anyStub() {
  const target = function () {};
  return new Proxy(target, {
    get: (obj, key) => {
      if (key === "toString") return () => "[stub]";
      if (key === Symbol.toPrimitive) return () => "[stub]";
      return anyStub();
    },
    apply: () => anyStub(),
    construct: () => ({}),
  });
}

class Service {
  constructor(ctx, name) {
    this.ctx = ctx;
    this.name = name;
  }
}

function loadClientModule() {
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (mod) => { captured = mod; } } },
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, style: {}, setAttribute() {}, appendChild() {} }),
      head: { appendChild() {} },
      body: { appendChild() {} },
      addEventListener() {}
    },
    console
  };
  vm.runInNewContext(clientSource, sandbox, { filename: "client.js" });
  assert.ok(captured && typeof captured.factory === "function", "client.js must register");
  return captured.factory((id) => {
    if (id === "react") {
      return {
        useState: (init) => [init, () => {}],
        useMemo: (fn) => fn(),
        useRef: (init) => ({ current: init }),
        useEffect: (fn) => fn(),
        createElement: () => ({})
      };
    }
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return { Toast: function Toast() {} };
    return {};
  });
}

function loadHostModule() {
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (mod) => { captured = mod; } } },
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, style: {}, setAttribute() {}, appendChild() {} }),
      head: { appendChild() {} },
      body: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {}
    },
    console,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(readFileSync(HOST_BUNDLE, "utf8"), sandbox, { filename: "model-selection.js" });
  assert.ok(captured && typeof captured.factory === "function", "host bundle must register");
  const exports = captured.factory((id) => {
    if (id === "@deepseek-ai/dsh-client-store") return { createSnapshotStore: makeStore };
    if (id === "@deepseek-ai/cordis") return { Service };
    return anyStub();
  });
  return exports;
}

const CATALOG_VALUE = {
  groups: [
    {
      id: "magpie",
      name: "Magpie",
      models: [
        { id: "group/dnq", name: "dnq", reasoning: { efforts: [{ id: "high", name: "High" }], defaultEffort: "high" } },
        { id: "workbuddy-ai/kimi-k3", name: "kimi", reasoning: { efforts: [{ id: "low", name: "Low" }], defaultEffort: "low" } }
      ]
    }
  ],
  failures: [],
  default: { provider: "magpie", model: "group/dnq" }
};

/** The resolver the shim wraps; each call builds a REAL host directory. */
function makeResolver(host, { available, calls, projection }) {
  return {
    directoryFor(sessionId) {
      const catalog = {
        store: makeStore({ value: CATALOG_VALUE, status: "ready", error: null }),
        load: async () => CATALOG_VALUE,
        reasoningFor: () => ({ efforts: [{ id: "high", name: "High" }], defaultEffort: "high" })
      };
      // `projection: "absent"` models a child session: it has no durable
      // model-selection event, so faceOf(...) hands back a face whose snapshot
      // is undefined. That single fact is what parks the host's own sync in
      // "loading" forever.
      const projected = {
        getSnapshot: () => (projection === "absent" ? void 0 : { next: void 0 }),
        subscribe: () => () => {}
      };
      const rpc = {
        selectModel: async (request) => {
          calls.push({ via: "rpc", ...request });
          return { ok: true, value: void 0 };
        }
      };
      return new host.ModelDirectory(
        rpc,
        sessionId,
        () => available(sessionId),
        catalog,
        projected,
        () => false,
        () => {}
      );
    }
  };
}

test("real ModelDirectory: the shim lifts the gate, loads and reroutes select", { skip }, async () => {
  const host = loadHostModule();
  const client = loadClientModule();
  assert.equal(typeof host.ModelDirectory, "function", "the host bundle must still export ModelDirectory");
  assert.equal(typeof client.installSelectionShim, "function", "the shim must be exported for tests");

  const rpcCalls = [];
  const routed = [];
  const children = new Set(["child-1"]);
  const resolver = makeResolver(host, { available: (sid) => !children.has(sid), calls: rpcCalls });
  const sessions = {
    subagentAddress: (sid) => (children.has(sid) ? { parentSessionId: "parent-1", childSessionId: sid } : void 0),
    getSnapshot: () => ({ byId: {} })
  };

  // Before the shim: this is the state the user saw — the gate throws, so the
  // host's own seat dies on click and the label never leaves its initial value.
  const plain = resolver.directoryFor("child-1");
  assert.throws(() => plain.assertAvailable(), /unavailable for addressed subagent/);
  assert.equal(plain.store.getSnapshot().status, "ready", "a loaded catalog must not sit in loading");

  const handle = client.installSelectionShim(
    { get: (name) => (name === "modelDirectories" ? resolver : void 0) },
    {
      resolver,
      sessions: () => sessions,
      select: async (request) => {
        routed.push(request);
        return { ok: true, value: void 0 };
      },
      sleep: async () => {}
    }
  );
  assert.equal(await handle.whenReady, true, "the shim must report it installed");

  const dir = resolver.directoryFor("child-1");
  assert.doesNotThrow(() => dir.assertAvailable(), "the gate must be lifted for the picker to work");

  await dir.load();
  const loaded = dir.store.getSnapshot();
  assert.equal(loaded.status, "ready", "load must leave the directory ready");
  assert.equal(loaded.current.model, "group/dnq", "the catalog default must be painted");

  const outcome = await dir.select({ provider: "magpie", model: "workbuddy-ai/kimi-k3", reasoningEffort: "low" });
  // The objects come from the vm realm, so compare fields, not prototypes.
  assert.equal(outcome.ok, true, "a rerouted select must report success");
  assert.equal(outcome.value, void 0);
  assert.equal(routed.length, 1, "the child's select must be rerouted, not sent as an agent RPC");
  assert.equal(routed[0].childId, "child-1", "the endpoint needs the child id, not undefined");
  assert.equal(routed[0].model, "workbuddy-ai/kimi-k3");
  assert.equal(rpcCalls.length, 0, "the host RPC path must not be touched for a child");

  const painted = dir.store.getSnapshot();
  assert.equal(painted.status, "ready");
  assert.equal(painted.current.provider, "magpie");
  assert.equal(painted.current.model, "workbuddy-ai/kimi-k3", "the pick must show up immediately");
  assert.equal(painted.error, null);

  // A parent session must keep the host path untouched.
  const parent = resolver.directoryFor("parent-1");
  await parent.select({ provider: "magpie", model: "group/dnq" });
  assert.equal(rpcCalls.length, 1, "parents must still go through the host RPC");
  assert.equal(rpcCalls[0].sessionId, "parent-1");
  assert.equal(routed.length, 1, "parents must never be rerouted to the plugin endpoint");

  handle.dispose();
  const afterDispose = resolver.directoryFor("child-1");
  assert.throws(() => afterDispose.assertAvailable(), /unavailable for addressed subagent/, "dispose must restore the gate");
});

test("real ModelDirectory: a child with no projection is settled out of loading", { skip }, async () => {
  const host = loadHostModule();
  const client = loadClientModule();

  const children = new Set(["child-9"]);
  const resolver = makeResolver(host, {
    available: (sid) => !children.has(sid),
    calls: [],
    projection: "absent"
  });
  const sessions = {
    subagentAddress: (sid) => (children.has(sid) ? { parentSessionId: "parent-1", childSessionId: sid } : void 0),
    getSnapshot: () => ({ byId: {} })
  };

  // Without the shim the host parks this directory in "loading" for good: its
  // projection face has no snapshot, so syncInputs takes the catalog-only
  // branch and never paints a current selection.
  const plain = resolver.directoryFor("child-9");
  assert.equal(plain.store.getSnapshot().status, "loading", "the host leaves a projection-less child loading");
  assert.equal(plain.store.getSnapshot().current, null);

  const handle = client.installSelectionShim(
    { get: () => resolver },
    { resolver, sessions: () => sessions, select: async () => ({ ok: true, value: void 0 }), sleep: async () => {} }
  );
  assert.equal(await handle.whenReady, true);

  const dir = resolver.directoryFor("child-9");
  await dir.load();
  const settled = dir.store.getSnapshot();
  assert.equal(settled.status, "ready", "the shim must settle the loading state");
  assert.equal(settled.current.model, "group/dnq", "the catalog default is the best available answer");
  assert.equal(settled.routable, true, "the default must be marked routable so the picker enables");

  // The child's own choice still wins over the default on the next sync.
  await dir.select({ provider: "magpie", model: "workbuddy-ai/kimi-k3", reasoningEffort: "low" });
  dir.syncInputs();
  const afterPick = dir.store.getSnapshot();
  assert.equal(afterPick.current.model, "workbuddy-ai/kimi-k3", "the pick must survive a host re-sync");
  assert.equal(afterPick.status, "ready");

  handle.dispose();
});
