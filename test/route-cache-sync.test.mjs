import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Stage ① taught the client to follow the SERVER's route snapshot instead of
// fighting it: the adopt effect re-runs when the live check's `revision` moves even
// if provider/model/effort/override are identical, an override is remembered
// into the module-level pick cache while no override forgets it, and the
// directory rebuild path now handles a RESET (forget + paint the live actual
// route) instead of only adopting a non-null override.
//
// None of those functions are exported as components (`LiveRoutePicker` and
// `wrapDirectory` are module-private), so they are reached the way the other
// render tests reach their components: the picker through `apply`'s slot
// registration, the directory path through the exported `installSelectionShim`
// resolver wrap, and the cache itself through the exported
// rememberPicked/pickedFor/forgetPicked seams.
const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

// Values built inside the vm sandbox carry that realm's prototypes, which
// deepStrictEqual rejects; compare their JSON shape instead.
const plain = (value) => JSON.parse(JSON.stringify(value));

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

function loadClient() {
  let capturedModule = null;
  const session = { slots: [], cursor: 0, effects: [], dirty: false, schedule: () => {} };
  const timers = [];
  const intervals = [];
  let nextTimerId = 1;
  const fetchCalls = [];
  // The live-route poll reads everything through the sandbox `fetch`; each
  // test points `routeAnswer` at the envelope the next GET should return.
  let routeAnswer = null;

  const sandbox = {
    window: {
      innerWidth: 1280,
      innerHeight: 900,
      location: { href: "http://localhost/" },
      addEventListener() {},
      removeEventListener() {},
      __ModuleLoader__: {
        load(module) {
          capturedModule = module;
        }
      }
    },
    document: {
      hidden: false,
      body: { tag: "body" },
      activeElement: null,
      querySelector: () => null,
      querySelectorAll: () => [],
      getComputedStyle: () => ({}),
      createElement: () => ({ dataset: {}, setAttribute() {} }),
      head: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {}
    },
    console,
    fetch: async (path, init) => {
      fetchCalls.push({ path, method: init && init.method });
      if (String(path).indexOf("/route?") !== -1) {
        const answer = typeof routeAnswer === "function" ? routeAnswer() : routeAnswer;
        return { json: async () => answer };
      }
      return { json: async () => ({ ok: false, error: { code: "unmocked" } }) };
    },
    setTimeout: (fn, ms) => {
      const id = nextTimerId++;
      timers.push({ id, fn, ms });
      return id;
    },
    clearTimeout: (id) => {
      const at = timers.findIndex((t) => t.id === id);
      if (at !== -1) timers.splice(at, 1);
    },
    setInterval: (fn, ms) => {
      const id = nextTimerId++;
      intervals.push({ id, fn, ms });
      return id;
    },
    clearInterval: (id) => {
      const at = intervals.findIndex((t) => t.id === id);
      if (at !== -1) intervals.splice(at, 1);
    }
  };
  vm.runInNewContext(clientSource, sandbox, { filename: "client.js" });
  if (!capturedModule || typeof capturedModule.factory !== "function") {
    throw new Error("client.js failed to register with __ModuleLoader__");
  }

  const React = {
    Fragment: "Fragment",
    createElement(type, props, ...children) {
      const kids = [];
      for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false || child === true) continue;
        kids.push(child);
      }
      return { type, props: props || {}, children: kids };
    },
    createPortal(node, target) {
      return { portal: true, node, target };
    },
    useRef(init) {
      const at = session.cursor++;
      if (!session.slots[at]) session.slots[at] = { kind: "ref", current: init };
      return session.slots[at];
    },
    useState(init) {
      const at = session.cursor++;
      if (!session.slots[at]) session.slots[at] = { kind: "state", value: init };
      const slot = session.slots[at];
      const set = (next) => {
        const value = typeof next === "function" ? next(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        session.dirty = true;
        session.schedule();
      };
      return [slot.value, set];
    },
    useEffect(fn, deps) {
      const at = session.cursor++;
      session.effects.push({ at, fn, deps });
    },
    useMemo(fn) {
      return fn();
    }
  };

  const client = capturedModule.factory((id) => {
    if (id === "react") return React;
    if (id === "react-dom") return { createPortal: React.createPortal };
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return { Toast: function Toast() {} };
    return {};
  });

  // apply() registers the picker into the header/composer slots; the mock
  // context runs every effect synchronously, so the component is captured
  // before apply returns.
  const slotRegistrations = [];
  const slotComponents = [];
  // Stage ② dropped the 5s poll: the picker now re-checks when the host
  // sessions store changes, so the mock context serves a controllable store.
  const storeListeners = [];
  const sessionsFace = {
    getSnapshot: () => storeSnapshot,
    subscribe(fn) {
      storeListeners.push(fn);
      return () => {
        const at = storeListeners.indexOf(fn);
        if (at !== -1) storeListeners.splice(at, 1);
      };
    }
  };
  let storeSnapshot = { byId: {} };
  const ctx = {
    get(id) {
      if (id === "sessions") return { list: sessionsFace };
      return undefined;
    },
    effect(cb) {
      const cleanup = cb();
      return cleanup;
    },
    inject(deps, cb) {
      if (Array.isArray(deps) && deps.includes("configForms")) {
        cb({
          configForms: {
            describe() {
              return {
                getSnapshot: () => ({ view: { namespaces: [{ ns: "dsh-subagent-role-router" }] }, status: "ready" }),
                subscribe: () => () => {}
              };
            },
            get: () => undefined
          }
        });
      }
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
      register(opts, comp) {
        slotRegistrations.push(opts);
        slotComponents.push(comp);
        return () => {
          const at = slotRegistrations.indexOf(opts);
          if (at !== -1) {
            slotRegistrations.splice(at, 1);
            slotComponents.splice(at, 1);
          }
        };
      }
    },
    uiConversation: {
      events: { register: () => () => {} }
    }
  };
  client.apply(ctx);
  const pickerIndex = slotRegistrations.findIndex((opts) => opts.id === "subagent-router-live-route");
  if (pickerIndex === -1 || typeof slotComponents[pickerIndex] !== "function") {
    throw new Error("apply() did not register the live route picker");
  }
  const component = slotComponents[pickerIndex];

  function draw(props) {
    session.cursor = 0;
    session.effects = [];
    const tree = component(props);
    for (const effect of session.effects) {
      const slot = session.slots[effect.at] || (session.slots[effect.at] = { kind: "effect" });
      const deps = effect.deps;
      const changed = !slot.deps || !deps || deps.length !== slot.deps.length || deps.some((d, i) => !Object.is(d, slot.deps[i]));
      if (!changed) continue;
      if (typeof slot.cleanup === "function") slot.cleanup();
      slot.deps = deps ? Array.from(deps) : null;
      const cleanup = effect.fn();
      slot.cleanup = typeof cleanup === "function" ? cleanup : null;
    }
    return tree;
  }

  const harness = {
    client,
    fetchCalls,
    sessionsList: sessionsFace,
    act() {
      if (arguments.length && typeof arguments[0] === "function") arguments[0]();
      let guard = 0;
      while (session.dirty && guard < 100) {
        session.dirty = false;
        draw(harness.props);
      }
      return harness.current;
    },
    async render(props) {
      harness.props = props;
      harness.current = draw(props);
      harness.act();
      await flush();
      harness.act();
      await flush();
      harness.act();
      return harness.current;
    },
    /** Change the sessions-store snapshot and notify subscribers — the
     *  event-driven trigger that replaced the old poll timer. */
    async triggerStoreSync(childId) {
      const key = childId || "child-rev";
      const byId = Object.assign({}, storeSnapshot.byId);
      const prev = byId[key] || {};
      byId[key] = Object.assign({}, prev, { updatedAt: (prev.updatedAt || 0) + 1 });
      storeSnapshot = { byId };
      for (const fn of storeListeners.slice()) fn();
      await flush();
      harness.act();
      await flush();
      harness.act();
      return harness.current;
    },
    setRouteAnswer(next) {
      routeAnswer = next;
    },
    unmount() {
      for (const slot of session.slots) {
        if (slot && typeof slot.cleanup === "function") {
          slot.cleanup();
          slot.cleanup = null;
        }
      }
    }
  };
  return harness;
}

const PICKER_PROPS = (sid, sessionsList) => (
  sessionsList
    ? { sessionId: sid, useSessions: () => true, sessionsList }
    : { sessionId: sid, useSessions: () => true }
);

test("1. a revision-only route change re-runs the adopt effect and rewrites the cache", async () => {
  const h = loadClient();
  const sid = "child-rev";
  const override = { provider: "p2", model: "m2", reasoningEffort: "high" };
  const route = (revision) => ({
    ok: true,
    value: { provider: "p1", model: "m1", reasoningEffort: "", override, revision }
  });

  h.setRouteAnswer(route(1));
  await h.render(PICKER_PROPS(sid, h.sessionsList));
  assert.deepEqual(plain(h.client.pickedFor(sid)), { provider: "p2", model: "m2", reasoningEffort: "high" });

  // Sabotage the cache with a value nothing else will fix: only a re-run of
  // the adopt effect (keyed on the signature that now includes revision) can
  // restore the override. Before the patch the identical provider/model/
  // override produced an identical signature, the effect never re-ran, and
  // the stale value survived.
  h.client.rememberPicked(sid, { provider: "stale", model: "stale" });
  assert.equal(plain(h.client.pickedFor(sid)).provider, "stale");

  h.setRouteAnswer(route(2));
  await h.triggerStoreSync(sid);

  assert.deepEqual(plain(h.client.pickedFor(sid)), { provider: "p2", model: "m2", reasoningEffort: "high" }, "revision change must re-run the adopt effect");
  assert.deepEqual(plain(h.client.pickedFor("session-" + sid)), { provider: "p2", model: "m2", reasoningEffort: "high" }, "the prefixed id spelling must be restored too");
  h.unmount();
});

test("2. a route with an override is remembered under both id spellings", async () => {
  const h = loadClient();
  const sid = "child-adopt";
  h.setRouteAnswer({
    ok: true,
    value: { provider: "p1", model: "m1", reasoningEffort: "", override: { provider: "p2", model: "m2", reasoningEffort: "high" }, revision: 7 }
  });
  await h.render(PICKER_PROPS(sid));
  assert.deepEqual(plain(h.client.pickedFor(sid)), { provider: "p2", model: "m2", reasoningEffort: "high" });
  assert.deepEqual(plain(h.client.pickedFor("session-" + sid)), { provider: "p2", model: "m2", reasoningEffort: "high" });
  h.unmount();
});

test("3. a route without an override forgets the recorded pick", async () => {
  const h = loadClient();
  const sid = "child-forget";
  h.client.rememberPicked(sid, { provider: "p1", model: "m1" });
  assert.ok(h.client.pickedFor(sid), "precondition: the pick is cached");
  h.setRouteAnswer({
    ok: true,
    value: { provider: "p9", model: "m9", reasoningEffort: "", override: null, revision: 3 }
  });
  await h.render(PICKER_PROPS(sid));
  assert.equal(h.client.pickedFor(sid), null, "the bare id key must be dropped");
  assert.equal(h.client.pickedFor("session-" + sid), null, "the prefixed id key must be dropped");
  h.unmount();
});

// The directory rebuild path runs inside the exported selection shim (the
// resolver wrap calls the module-private wrapDirectory on every directory).
function makeDirectoryHarness({ value, sessionId = "child-dir" }) {
  const h = loadClient();
  const storeState = { status: "ready", pending: null, error: null, current: { provider: "old", model: "old", reasoningEffort: "" } };
  const dir = {
    sessionId,
    store: {
      update(fn) {
        fn(storeState);
      }
    },
    __srrCurrentSelection: null
  };
  const resolver = {
    directoryFor() {
      return dir;
    }
  };
  h.setRouteAnswer({ ok: true, value });
  const handle = h.client.installSelectionShim(null, {
    resolver,
    sessions: () => ({
      subagentAddress: (s) => (s === sessionId || s === "session-" + sessionId ? { parentSessionId: "p", childSessionId: sessionId } : undefined),
      getSnapshot: () => ({ byId: {} })
    }),
    select: async () => ({ ok: true, value: undefined }),
    sleep: async () => {}
  });
  return { h, handle, resolver, dir, storeState, sessionId };
}

test("4. wrapDirectory reset: forget the pick and paint the live actual route", async () => {
  const { h, handle, resolver, dir, storeState, sessionId } = makeDirectoryHarness({
    value: { override: null, actual: { provider: "p9", model: "m9", reasoningEffort: undefined } }
  });
  h.client.rememberPicked(sessionId, { provider: "p1", model: "m1" });
  assert.equal(await handle.whenReady, true);

  resolver.directoryFor(sessionId);
  await flush();

  assert.equal(h.client.pickedFor(sessionId), null, "the stale pick must be forgotten");
  assert.equal(h.client.pickedFor("session-" + sessionId), null);
  assert.deepEqual(plain(dir.__srrCurrentSelection), { provider: "p9", model: "m9" }, "the directory must show the route the child will actually use");
  assert.deepEqual(plain(storeState.current), { provider: "p9", model: "m9" });
  handle.dispose();
});

test("5. wrapDirectory reset with actual=null: cache cleared, current untouched", async () => {
  const { h, handle, resolver, dir, storeState, sessionId } = makeDirectoryHarness({
    value: { override: null, actual: null }
  });
  h.client.rememberPicked(sessionId, { provider: "p1", model: "m1" });
  assert.equal(await handle.whenReady, true);

  // The rebuild still seeds the directory from the recorded pick first; with
  // no actual route to paint, that seeded value must survive.
  resolver.directoryFor(sessionId);
  await flush();

  assert.equal(h.client.pickedFor(sessionId), null, "the stale pick must still be forgotten");
  assert.deepEqual(plain(dir.__srrCurrentSelection), { provider: "p1", model: "m1" }, "without an actual route the seeded current must not be overwritten");
  assert.deepEqual(plain(storeState.current), { provider: "p1", model: "m1" });
  handle.dispose();
});

test("6. wrapDirectory override branch: adopt into cache and store (regression)", async () => {
  const { h, handle, resolver, dir, storeState, sessionId } = makeDirectoryHarness({
    value: { override: { provider: "ov", model: "ovm", reasoningEffort: "low" }, actual: null }
  });
  assert.equal(await handle.whenReady, true);

  resolver.directoryFor(sessionId);
  await flush();

  assert.deepEqual(plain(h.client.pickedFor(sessionId)), { provider: "ov", model: "ovm", reasoningEffort: "low" });
  assert.deepEqual(plain(dir.__srrCurrentSelection), { provider: "ov", model: "ovm", reasoningEffort: "low" });
  assert.deepEqual(plain(storeState.current), { provider: "ov", model: "ovm", reasoningEffort: "low" });
  handle.dispose();
});
