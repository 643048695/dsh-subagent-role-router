import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Client-side performance regressions, measured through the real component /
// fetch harness rather than by inspecting source. Four contracts are pinned:
//   1. an SSE frame for another family produces ZERO new GETs;
//   2. same-key reads join one wire request, and a WRITE never lends its
//      pre-write promise to a later caller;
//   3. in-flight reads are aborted/released and bounded, with no stale URL map;
//   4. turning the critters switch off stops the network, and leaving rows do
//      not leave timer handles behind.
const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const PARENT = "session-parent";
const OTHER = "session-other";

const flush = async () => {
  for (let i = 0; i < 16; i += 1) await Promise.resolve();
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function loadClient(options = {}) {
  let captured = null;
  const calls = [];
  const timers = [];
  let nextTimer = 1;
  const eventSources = [];
  const onGet = options.onGet || null;
  const onPost = options.onPost || null;
  let onGetEnabled = false;

  function FakeAbortController() {
    this.signal = { aborted: false };
  }
  FakeAbortController.prototype.abort = function () { this.signal.aborted = true; };
  function FakeEventSource(url) {
    this.url = url;
    this.readyState = 0;
    this.closed = false;
    eventSources.push(this);
  }
  FakeEventSource.prototype.close = function () { this.closed = true; this.readyState = 2; };

  const sandbox = {
    window: {
      innerWidth: 1280,
      innerHeight: 900,
      location: { href: "http://localhost/" },
      addEventListener() {},
      removeEventListener() {},
      __ModuleLoader__: {
        load(module) { captured = module; }
      }
    },
    document: {
      hidden: false,
      body: { tag: "body" },
      querySelector: () => null,
      querySelectorAll: () => [],
      getComputedStyle: () => ({}),
      createElement: () => ({ dataset: {}, setAttribute() {}, textContent: "" }),
      head: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {}
    },
    console,
    AbortController: options.withoutAbortController ? undefined : FakeAbortController,
    EventSource: FakeEventSource,
    setTimeout: (fn, ms) => {
      const id = nextTimer++;
      timers.push({ id, fn, ms });
      return id;
    },
    clearTimeout: (id) => {
      const at = timers.findIndex((timer) => timer.id === id);
      if (at !== -1) timers.splice(at, 1);
    },
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async (path, init) => {
      const method = (init && init.method) || "GET";
      const call = { path: String(path), method, signal: init && init.signal ? init.signal : null };
      calls.push(call);
      if (onGetEnabled && onGet && method === "GET") {
        const answer = onGet(path, init);
        if (answer !== undefined) return { json: async () => answer };
      }
      if (method === "POST") {
        return { json: async () => (onPost ? onPost(path) : { ok: true, value: {} }) };
      }
      if (String(path).indexOf("subagent-role-router/activity?") !== -1) {
        return { json: async () => ({ ok: true, value: { active: [] } }) };
      }
      if (String(path).indexOf("subagent-role-router/batch?") !== -1) {
        return { json: async () => ({ ok: true, value: { children: [], models: [] } }) };
      }
      return { json: async () => ({ ok: false, error: { code: "unmocked" } }) };
    }
  };
  vm.runInNewContext(clientSource, sandbox, { filename: "client.js" });
  if (!captured || typeof captured.factory !== "function") throw new Error("client.js did not register");

  const session = { slots: [], cursor: 0, effects: [], dirty: false };
  const React = {
    Fragment: "Fragment",
    createElement(type, props, ...kids) {
      const children = kids.flat(Infinity).filter((kid) => kid !== null && kid !== undefined && kid !== false && kid !== true);
      return { type, props: props || {}, children };
    },
    createPortal(node, target) { return { portal: true, node, target }; },
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
      };
      return [slot.value, set];
    },
    useEffect(fn, deps) {
      const at = session.cursor++;
      session.effects.push({ at, fn, deps });
    },
    useMemo(fn) { return fn(); }
  };
  const client = captured.factory((id) => {
    if (id === "react") return React;
    if (id === "react-dom") return { createPortal: React.createPortal };
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return { Toast: function Toast() {} };
    return {};
  });

  const listeners = [];
  let store = { byId: {} };
  const sessionsList = {
    getSnapshot: () => store,
    subscribe(fn) {
      listeners.push(fn);
      return () => {
        const at = listeners.indexOf(fn);
        if (at !== -1) listeners.splice(at, 1);
      };
    }
  };
  const ctx = {
    get(id) {
      if (id === "sessions") return { list: sessionsList };
      if (id === "uiWorkspace") return { openSession() {} };
      return undefined;
    },
    effect(cb) { return cb(); },
    inject(deps, cb) {
      if (Array.isArray(deps) && deps.includes("configForms")) {
        cb({
          configForms: {
            describe: () => ({
              getSnapshot: () => ({ view: { namespaces: [] }, status: "ready" }),
              subscribe: () => () => {}
            }),
            get: () => undefined
          }
        });
      }
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject(name, cb) { cb(); return () => {}; },
      register(opts, comp) {
        registrations.push({ opts, comp });
        return () => {};
      }
    },
    uiConversation: { events: { register: () => () => {} } }
  };
  const registrations = [];
  client.apply(ctx);
  const found = registrations.find((entry) => entry.opts.id === "subagent-role-router-critters");
  if (!found) throw new Error("critters component was not registered");
  const component = found.comp;
  const props = Object.assign({}, found.opts.inject(PARENT), { useSessions: (selector) => selector(store) });

  function draw() {
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
    calls,
    timers,
    eventSources,
    enableOnGet() { onGetEnabled = true; },
    render() { harness.tree = draw(); harness.act(); return harness.tree; },
    act() {
      let guard = 0;
      while (session.dirty && guard < 50) {
        session.dirty = false;
        harness.tree = draw();
        guard += 1;
      }
      return harness.tree;
    },
    fs() { return harness.act(); },
    setState(nextById) {
      store = { byId: nextById };
      for (const fn of listeners.slice()) fn();
      harness.tree = draw();
      harness.act();
    },
    emitSse(event) {
      const es = eventSources[eventSources.length - 1];
      if (!es || typeof es.onmessage !== "function") throw new Error("no SSE stream");
      es.onmessage({ data: JSON.stringify(event) });
      harness.act();
    },
    fireTimer(ms) {
      const at = timers.findIndex((timer) => timer.ms === ms);
      if (at === -1) throw new Error("no timer with ms=" + ms);
      const timer = timers[at];
      timers.splice(at, 1);
      timer.fn();
      harness.act();
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

const row = (parentId, extra) => Object.assign({
  running: true,
  parentId,
  origin: "subagent",
  displayTitle: "worker"
}, extra || {});

test("an SSE frame for another family spends zero GETs; related and resync frames still refresh", async () => {
  const h = loadClient();
  h.setState({
    mine: row(PARENT, { displayTitle: "mine" }),
    theirs: row(OTHER, { displayTitle: "theirs" })
  });
  h.render();
  await flush();
  h.act();
  const count = (needle) => h.calls.filter((call) => call.method === "GET" && call.path.includes(needle)).length;
  const baselineActivity = count("subagent-role-router/activity?");
  const baselineBatch = count("subagent-role-router/batch?");
  assert.ok(baselineActivity >= 1 && baselineBatch >= 1, "mount seeds both legs");

  // The backend now declares the parent on activity frames: exact filter.
  h.emitSse({ type: "activity", action: "start", childId: "theirs", parentSessionId: OTHER });
  h.emitSse({ type: "route", childId: "theirs" }); // route frames carry only childId
  assert.equal(count("subagent-role-router/activity?"), baselineActivity, "no seed GET for an unrelated family");
  assert.equal(count("subagent-role-router/batch?"), baselineBatch, "no batch GET for an unrelated family");
  assert.equal(h.timers.filter((timer) => timer.ms === h.client.critterBatchRefreshMs).length, 0, "no debounce timer either");

  // A known child of THIS family must still wake both legs.
  h.emitSse({ type: "route", childId: "mine" });
  assert.equal(count("subagent-role-router/activity?"), baselineActivity + 1, "a related route frame refetches the seed");
  h.fireTimer(h.client.critterBatchRefreshMs);
  await flush();
  h.act();
  assert.equal(count("subagent-role-router/batch?"), baselineBatch + 1, "a related route frame refetches the batch");

  // Unknown ownership is conservative: re-query, never risk a missed change.
  const beforeUnknown = count("subagent-role-router/activity?");
  h.emitSse({ type: "route", childId: "session-catalog-only" });
  assert.equal(count("subagent-role-router/activity?"), beforeUnknown + 1, "unknown child triggers a safe re-query");
  await flush();
  h.act();

  // Resync (reconnect) invalidates every cached family picture.
  const beforeResync = count("subagent-role-router/activity?");
  h.emitSse({ type: "resync" });
  assert.equal(count("subagent-role-router/activity?"), beforeResync + 1, "resync always refreshes");
  h.unmount();
});

test("same-key GETs join one wire request; a write never reuses its pre-write promise", async () => {
  const first = deferred();
  const stale = deferred();
  const fresh = deferred();
  let wireGets = 0;
  const h = loadClient({
    onGet: () => {
      wireGets += 1;
      if (wireGets === 1) return first.promise;
      if (wireGets === 2) return shared.promise;
      if (wireGets === 3) return stale.promise;
      return fresh.promise;
    }
  });
  const path = "subagent-role-router/batch?parentSessionId=perf-direct";
  h.calls.length = 0;
  wireGets = 0;
  h.enableOnGet();

  const a = h.client.sharedGetJson(path);
  const b = h.client.sharedGetJson(path);
  assert.equal(h.calls.filter((call) => call.method === "GET").length, 1, "two callers share one GET");
  assert.equal(h.client.sharedGetStats().inflight, 1);

  first.resolve({ ok: true, value: { tag: "first" } });
  await flush();
  assert.deepEqual((await a.promise).value, { tag: "first" });
  assert.deepEqual((await b.promise).value, { tag: "first" }, "both callers see the same answer");
  a.release();
  b.release();
  assert.equal(h.client.sharedGetStats().inflight, 0, "settled handles leave no in-flight state");

  // One listener losing interest must not cancel the wire for the other.
  const shared = deferred();
  const c = h.client.sharedGetJson(path);
  const d = h.client.sharedGetJson(path);
  assert.equal(h.calls.filter((call) => call.method === "GET").length, 2, "same key still uses one GET");
  c.release();
  assert.equal(h.calls[h.calls.length - 1].signal.aborted, false, "the remaining consumer keeps the request");
  shared.resolve({ ok: true, value: { tag: "shared" } });
  assert.deepEqual((await d.promise).value, { tag: "shared" });
  d.release();

  // A pre-write GET is detached; the next caller MUST start a new wire read.
  const beforeWrite = h.calls.filter((call) => call.method === "GET").length;
  const oldHandle = h.client.sharedGetJson(path);
  assert.equal(h.calls.filter((call) => call.method === "GET").length, beforeWrite + 1, "old read started");
  h.client.batchPost("select", { parentSessionId: PARENT, selections: [] });
  const newHandle = h.client.sharedGetJson(path);
  assert.equal(h.calls.filter((call) => call.method === "GET").length, beforeWrite + 2, "the write started a NEW GET instead of joining the old one");
  stale.resolve({ ok: true, value: { tag: "stale" } });
  fresh.resolve({ ok: true, value: { tag: "fresh" } });
  assert.deepEqual((await oldHandle.promise).value, { tag: "stale" });
  assert.deepEqual((await newHandle.promise).value, { tag: "fresh" }, "the post-write answer wins");
  oldHandle.release();
  newHandle.release();
  assert.equal(h.client.sharedGetStats().inflight, 0);
});

test("in-flight GETs are bounded and abandoned reads are aborted", async () => {
  const h = loadClient({ onGet: () => new Promise(() => {}) });
  h.enableOnGet();
  const handles = [];
  for (let i = 0; i < h.client.sharedGetMax + 6; i += 1) {
    handles.push(h.client.sharedGetJson("subagent-role-router/batch?parentSessionId=session-" + i));
  }
  const stats = h.client.sharedGetStats();
  assert.equal(stats.inflight, h.client.sharedGetMax, "a burst cannot exceed the in-flight bound");
  assert.equal(stats.joined, h.client.sharedGetMax, "only live entries remain in the join index");
  const aborted = h.calls.filter((call) => call.method === "GET" && call.signal && call.signal.aborted);
  assert.ok(aborted.length >= 6, "evicted reads are aborted, not left on the wire");
  for (const handle of handles) handle.release();
  assert.equal(h.client.sharedGetStats().inflight, 0, "released reads are reclaimed");
});

test("a stalled GET times out and frees the wire", async () => {
  const h = loadClient({ onGet: () => new Promise(() => {}) });
  h.enableOnGet();
  const handle = h.client.sharedGetJson("subagent-role-router/batch?parentSessionId=stalled");
  assert.equal(h.client.sharedGetStats().inflight, 1);
  const at = h.timers.findIndex((timer) => timer.ms === h.client.sharedGetTimeoutMs);
  assert.ok(at !== -1, "a real browser arms a bounded timeout");
  const timer = h.timers[at];
  h.timers.splice(at, 1);
  timer.fn();
  await flush();
  assert.equal(await handle.promise, null, "a stalled read resolves null and releases its slot");
  assert.equal(h.client.sharedGetStats().inflight, 0);
  const stalledCall = h.calls.find((call) => call.path.includes("stalled"));
  assert.equal(stalledCall.signal.aborted, true, "the timeout aborts the request");
  handle.release();
});

test("a stalled GET still releases its slot without fetch cancellation support", async () => {
  const h = loadClient({ withoutAbortController: true, onGet: () => new Promise(() => {}) });
  h.enableOnGet();
  const handle = h.client.sharedGetJson("subagent-role-router/batch?parentSessionId=no-cancellation");
  assert.equal(h.client.sharedGetStats().inflight, 1);
  h.fireTimer(h.client.sharedGetTimeoutMs);
  await flush();
  assert.equal(await handle.promise, null);
  assert.equal(h.client.sharedGetStats().inflight, 0);
  handle.release();
});

test("switching critters off aborts background reads; every exit handle is reclaimed", async () => {
  const h = loadClient();
  h.setState({
    a: row(PARENT, { displayTitle: "alpha" }),
    b: row(PARENT, { displayTitle: "bravo" })
  });
  h.render();
  // Do NOT settle the mount reads: the switch must cut them while on the wire.
  const before = h.calls.filter((call) => call.method === "GET").length;
  assert.ok(before >= 2);
  h.client.updateCrittersEnabled(false);
  h.fireTimer(0); // deferred switch notification
  h.act();
  const aborted = h.calls.filter((call) => call.method === "GET" && call.signal && call.signal.aborted);
  assert.ok(aborted.length >= 2, "both background legs are aborted on disable");

  h.emitSse({ type: "resync" });
  assert.equal(h.calls.filter((call) => call.method === "GET").length, before, "no network while hidden");

  h.client.updateCrittersEnabled(true);
  h.fireTimer(0);
  h.act();
  await flush();
  h.act();
  assert.ok(h.calls.filter((call) => call.method === "GET").length > before, "re-enable resumes fresh reads");

  // Each leaving critter owns exactly one exit timer; it disappears on fire.
  h.setState({ a: row(PARENT, { displayTitle: "alpha" }) });
  const exits = h.timers.filter((timer) => timer.ms === h.client.critterExitMs);
  assert.equal(exits.length, 1, "one leave timer for the single departed child");
  h.fireTimer(h.client.critterExitMs);
  assert.equal(h.timers.filter((timer) => timer.ms === h.client.critterExitMs).length, 0, "the fired handle is removed");
  h.unmount();
  h.client.updateCrittersEnabled(true); // restore module default for other files
});
