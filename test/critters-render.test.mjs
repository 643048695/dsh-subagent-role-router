import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// The header critters are decorative, so every render they cause is pure
// overhead for the rest of the client. Two regressions are pinned here, both
// measured through the real component rather than through a helper:
//
//   1. A sessions-store flush that does not change WHICH children run under
//      this parent (a token tick, a timing tick, an unrelated session's
//      projection) must not execute the component at all — the narrow
//      membership selector is what the host's hook compares by identity.
//   2. Numbers (duration, tokens) are panel-only state: the closed header
//      never derives them, and an open panel refreshes through one shared
//      1s ticker instead of one interval per row.
//
// The host hook (`useSessions`) is modelled on its real contract: a store
// notification re-runs the selector and only schedules a re-render when the
// selected value is not Object.is-equal to the committed one.
const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

const plain = (value) => JSON.parse(JSON.stringify(value));

function loadCritters(opts) {
  let capturedModule = null;
  let capturedCss = "";
  const storeListeners = [];
  let storeSnapshot = { byId: {} };
  // The host's `useSessionStatus` map: `ui-session` publishes it from the
  // remote status stream, so it can know a child is running before (or after)
  // the list row says so. The component must follow it first.
  let statusSnapshot = new Map();
  const batchChildren = opts && Array.isArray(opts.batchChildren) ? opts.batchChildren : null;
  const session = {
    cursor: 0,
    hookCursor: 0,
    statusCursor: 0,
    effects: [],
    slots: [],
    dirty: false,
    renders: 0,
    timers: [],
    intervals: [],
    fetchCalls: []
  };
  let nextTimerId = 1;
  // The page-level route stream. The strip subscribes to it for activity and
  // route frames; tests deliver frames through the captured instance.
  const eventSources = [];
  function FakeEventSource(url) {
    this.url = url;
    this.readyState = 0;
    this.closed = false;
    eventSources.push(this);
  }
  FakeEventSource.prototype.close = function () { this.readyState = 2; this.closed = true; };

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
      querySelector: () => null,
      querySelectorAll: () => [],
      getComputedStyle: () => ({}),
      createElement: () => ({ dataset: {}, setAttribute() {}, textContent: "" }),
      head: {
        appendChild(el) {
          if (el && typeof el.textContent === "string") capturedCss += el.textContent;
        }
      },
      addEventListener() {},
      removeEventListener() {}
    },
    console,
    EventSource: FakeEventSource,
    fetch: async (path, init) => {
      session.fetchCalls.push({ path, method: init && init.method });
      if (batchChildren && String(path).indexOf("subagent-role-router/batch?") !== -1) {
        return { json: async () => ({ ok: true, value: { children: batchChildren } }) };
      }
      return { json: async () => ({ ok: false, error: { code: "unmocked" } }) };
    },
    setTimeout: (fn, ms) => {
      const id = nextTimerId++;
      session.timers.push({ id, fn, ms });
      return id;
    },
    clearTimeout: (id) => {
      const at = session.timers.findIndex((t) => t.id === id);
      if (at !== -1) session.timers.splice(at, 1);
    },
    setInterval: (fn, ms) => {
      const id = nextTimerId++;
      session.intervals.push({ id, fn, ms });
      return id;
    },
    clearInterval: (id) => {
      const at = session.intervals.findIndex((t) => t.id === id);
      if (at !== -1) session.intervals.splice(at, 1);
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

  // One entry per `useSessions` call site, in render order — the same slot
  // discipline a real hook uses.
  const hookEntries = [];
  function useSessions(selector) {
    const at = session.hookCursor++;
    let entry = hookEntries[at];
    if (!entry) {
      entry = { selector, value: selector(storeSnapshot) };
      hookEntries[at] = entry;
    } else {
      entry.selector = selector;
    }
    return entry.value;
  }

  const statusHookEntries = [];
  function useSessionStatus(selector) {
    const at = session.statusCursor++;
    let entry = statusHookEntries[at];
    if (!entry) {
      entry = { selector, value: selector(statusSnapshot), seeded: true };
      statusHookEntries[at] = entry;
    } else {
      entry.selector = selector;
      // A real selector hook recomputes during render against the current
      // store; the narrow selector must keep its identity for an equal key.
      entry.value = selector(statusSnapshot);
    }
    return entry.value;
  }

  const slotRegistrations = [];
  const slotComponents = [];
  const ctx = {
    get(id) {
      if (id === "sessions") return { list: sessionsFace };
      if (id === "uiWorkspace") return { openSession() {} };
      return undefined;
    },
    effect(cb) {
      return cb();
    },
    inject(deps, cb) {
      if (Array.isArray(deps) && deps.includes("configForms")) {
        cb({
          configForms: {
            describe() {
              return {
                getSnapshot: () => ({ view: { namespaces: [] }, status: "ready" }),
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
        return () => {};
      }
    },
    uiConversation: { events: { register: () => () => {} } }
  };
  client.apply(ctx);
  const at = slotRegistrations.findIndex((opts) => opts.id === "subagent-role-router-critters");
  if (at === -1) throw new Error("apply() did not register the header critters");
  const registration = slotRegistrations[at];
  const component = slotComponents[at];
  const injected = registration.inject("session-parent");
  // The standard `useSessionStatus` is a global scope prop; a host that only
  // hands the injected `ctx.uiSession.sessionStatus` observable renders it as
  // `useSessionStatusRoot`. Either spelling must reach the same logic.
  const props = Object.assign({}, injected, { useSessions },
    opts && opts.statusAsRoot ? { useSessionStatusRoot: useSessionStatus } : { useSessionStatus });

  function draw() {
    session.cursor = 0;
    session.hookCursor = 0;
    session.statusCursor = 0;
    session.effects = [];
    session.renders += 1;
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

  function act() {
    let guard = 0;
    while (session.dirty && guard < 50) {
      session.dirty = false;
      harness.tree = draw();
      guard += 1;
    }
    return harness.tree;
  }

  const harness = {
    client,
    css: () => capturedCss,
    session,
    props,
    tree: null,
    get renders() {
      return session.renders;
    },
    get intervals() {
      return session.intervals;
    },
    act,
    render() {
      harness.tree = draw();
      act();
      return harness.tree;
    },
    /** Push a new store snapshot exactly the way the host does: notify every
     *  subscriber; a listener whose selected value moved schedules a render. */
    publish(nextById) {
      storeSnapshot = { byId: nextById };
      let changed = false;
      for (const entry of hookEntries) {
        const next = entry.selector(storeSnapshot);
        if (!Object.is(next, entry.value)) {
          entry.value = next;
          changed = true;
        }
      }
      for (const fn of storeListeners.slice()) fn();
      if (changed) {
        session.dirty = true;
        act();
      }
      return harness.tree;
    },
    tick() {
      for (const interval of session.intervals.slice()) interval.fn();
      act();
      return harness.tree;
    },
    /** Publish a host Session-status map exactly like `ui-session` does. */
    publishStatus(next) {
      statusSnapshot = next;
      let changed = false;
      for (const entry of statusHookEntries) {
        const value = entry.selector(statusSnapshot);
        if (!Object.is(value, entry.value)) {
          entry.value = value;
          changed = true;
        }
      }
      if (changed) {
        session.dirty = true;
        act();
      }
      return harness.tree;
    },
    /** Deliver one page-level route-stream frame. */
    emitSse(event) {
      const es = eventSources[eventSources.length - 1];
      if (!es || typeof es.onmessage !== "function") throw new Error("no critter route stream");
      es.onmessage({ data: JSON.stringify(event) });
    },
    /** Run the pending timer with this delay. */
    fireTimer(ms) {
      const at = session.timers.findIndex((timer) => timer.ms === ms);
      if (at === -1) throw new Error("no timer with ms=" + ms);
      const timer = session.timers[at];
      session.timers.splice(at, 1);
      timer.fn();
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

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function textsOf(node) {
  const out = [];
  walk(node, (el) => {
    for (const child of el.children || []) {
      if (typeof child === "string") out.push(child);
    }
  });
  return out;
}

function stationsOf(tree) {
  const out = [];
  walk(tree, (el) => {
    if (el.type === "button" && el.props && el.props.className === "dsm-critters-station") out.push(el);
  });
  return out;
}

function rootOf(tree) {
  let found = null;
  walk(tree, (el) => {
    if (!found && el.type === "span" && el.props && el.props.className === "dsm-critters") found = el;
  });
  return found;
}

// The panel opens on hover intent now: entering the strip schedules the open
// timer (client.critterHoverOpenMs), leaving schedules the close one. These
// helpers drive that exact path; the old toggle button is gone.
function fireHoverTimer(h, ms) {
  const at = h.session.timers.findIndex((t) => t.ms === ms);
  if (at === -1) throw new Error("no hover timer with ms=" + ms);
  const timer = h.session.timers[at];
  h.session.timers.splice(at, 1);
  timer.fn();
}

function openPanelByHover(h) {
  const root = rootOf(h.tree);
  if (!root) throw new Error("critters root not found");
  root.props.onMouseEnter();
  fireHoverTimer(h, h.client.critterHoverOpenMs);
  h.act();
  return root;
}

function closePanelByHover(h) {
  const root = rootOf(h.tree);
  if (!root) throw new Error("critters root not found");
  root.props.onMouseLeave();
  fireHoverTimer(h, h.client.critterHoverCloseMs);
  h.act();
  return root;
}

const child = (parentId, extra) => Object.assign({
  running: true,
  parentId,
  displayTitle: "kid",
  origin: "subagent",
  projectionValues: {
    subagentTiming: { active: { since: 1700000000000 }, settledMs: 0 },
    tokenUsage: { uncachedInputTokens: 500, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 }
  }
}, extra || {});

const PARENT = "session-parent";

test("1. the membership key ignores token/timing movement and unrelated sessions", () => {
  const h = loadCritters();
  const base = { byId: { a: child(PARENT), b: child(PARENT), other: child("session-elsewhere") } };
  const key1 = h.client.crittersMembersKey(base, PARENT);

  const tokenTick = plain(base);
  tokenTick.byId.a.projectionValues.tokenUsage.outputTokens = 999999;
  tokenTick.byId.a.projectionValues.subagentTiming.settledMs = 60000;
  tokenTick.byId.a.updatedAt = 42;
  assert.equal(h.client.crittersMembersKey(tokenTick, PARENT), key1);

  const unrelated = plain(base);
  unrelated.byId.other.projectionValues.tokenUsage.outputTokens += 1;
  assert.equal(h.client.crittersMembersKey(unrelated, PARENT), key1);

  assert.notEqual(h.client.crittersMembersKey({ byId: { a: child(PARENT) } }, PARENT), key1);
  assert.equal(h.client.crittersMembersKey({ byId: {} }, PARENT), "none");
  assert.equal(h.client.crittersMembersKey(null, PARENT), "none");
  assert.equal(h.client.crittersMembersKey(base, ""), "none");
});

test("2. metrics carry the panel numbers for this parent only", () => {
  const h = loadCritters();
  const byId = {
    a: child(PARENT, {
      projectionValues: {
        subagentTiming: { active: { since: 1700000000123 }, settledMs: 4500 },
        tokenUsage: { uncachedInputTokens: 10000, outputTokens: 20000, cacheReadTokens: 30000, cacheWriteTokens: 0 }
      }
    }),
    other: child("session-elsewhere")
  };
  const metrics = plain(h.client.deriveCritterMetrics(byId, PARENT));
  assert.deepEqual(Object.keys(metrics), ["a"]);
  assert.equal(metrics.a.since, 1700000000123);
  assert.equal(metrics.a.settledMs, 4500);
  assert.equal(metrics.a.tokens, 60000);
  assert.deepEqual(plain(h.client.deriveCritterMetrics(byId, "session-nobody")), {});
});

test("3. a token flush does not execute the closed header", () => {
  const h = loadCritters();
  h.publish({ a: child(PARENT), b: child(PARENT) });
  const tree = h.render();
  assert.equal(stationsOf(tree).length, 2);
  const baseline = h.renders;

  // Same membership, more tokens: the selector string is unchanged, so the
  // host hook does not schedule a render and the component body never runs.
  const tick = plain({ a: child(PARENT), b: child(PARENT) });
  tick.a.projectionValues.tokenUsage.outputTokens = 123456;
  tick.a.projectionValues.subagentTiming.settledMs = 90000;
  tick.a.updatedAt = 7;
  h.publish(tick);
  h.publish(plain({ a: child(PARENT), b: child(PARENT), noise: child("session-elsewhere") }));
  assert.equal(h.renders, baseline);
});

test("4. a membership change does render, and reuses the cached art", () => {
  const h = loadCritters();
  h.publish({ a: child(PARENT) });
  const first = h.render();
  const firstStation = stationsOf(first)[0];
  assert.ok(firstStation);

  h.publish({ a: child(PARENT), b: child(PARENT) });
  const grown = h.tree;
  assert.equal(stationsOf(grown).length, 2);

  // A parent-driven re-render (what an unrelated header update does) must hand
  // back the very same <svg> descriptors instead of rebuilding three trees.
  const again = h.render();
  const before = stationsOf(grown);
  const after = stationsOf(again);
  assert.equal(after.length, before.length);
  for (let i = 0; i < after.length; i += 1) {
    assert.equal(after[i].children[0], before[i].children[0]);
  }
  assert.equal(firstStation.children[0], after[0].children[0]);
});

test("5. the open panel refreshes numbers from one 1s ticker only", () => {
  const h = loadCritters();
  h.publish({ a: child(PARENT, { projectionValues: {
    subagentTiming: { active: { since: Date.now() - 23000 }, settledMs: 0 },
    tokenUsage: { uncachedInputTokens: 100000, outputTokens: 100000, cacheReadTokens: 3000, cacheWriteTokens: 0 }
  } }) });
  h.render();
  assert.equal(h.intervals.length, 0, "closed header must not start a ticker");

  openPanelByHover(h);
  h.act();
  assert.equal(h.intervals.length, 1);
  assert.equal(h.intervals[0].ms, 1000);

  const openTree = h.tick();
  const joined = textsOf(openTree).join(" | ");
  assert.match(joined, /tokens/);
  assert.match(joined, /20\.3万|20万/);

  closePanelByHover(h);
  h.act();
  assert.equal(h.intervals.length, 0, "closing the panel must clear the ticker");
  h.unmount();
});

test("6. real Session status outranks the scoped row, in both directions", () => {
  const h = loadCritters();
  // An addressable child whose list row still says running: false but whose
  // host status says true must have a critter.
  h.publish({ a: child(PARENT, { running: false }) });
  h.publishStatus(new Map([["a", { running: true }]]));
  h.render();
  assert.equal(stationsOf(h.tree).length, 1, "status true must draw the child the row calls idle");

  // The converse is the idle/history ghost: status says stopped while the row
  // still says running. Nothing may remain in the header.
  h.publishStatus(new Map([["a", { running: false }]]));
  h.act();
  assert.equal(rootOf(h.tree), null, "a status-stopped child must leave at once");
  h.unmount();
});

test("7. rows riding the exit animation are not counted as running", () => {
  const h = loadCritters();
  h.publish({ a: child(PARENT, { displayTitle: "alpha" }), b: child(PARENT, { displayTitle: "beta" }) });
  h.render();
  openPanelByHover(h);
  h.act();
  assert.match(textsOf(h.tree).join(" "), /正在运行 2 个子代理/);

  // b has left; its art may still play the leaving stretch until the timer
  // fires, but the header and the panel already report one running child.
  h.publish({ a: child(PARENT, { displayTitle: "alpha" }) });
  h.act();
  const root = rootOf(h.tree);
  assert.ok(root, "the live child keeps the strip");
  assert.equal(root.props["data-count"], 1, "the header data-count counts live rows only");
  assert.match(root.props.title, /正在运行 1 个子代理/, "the header title counts live rows only");
  assert.match(textsOf(h.tree).join(" "), /正在运行 1 个子代理/, "the panel title counts live rows only");
  assert.equal(stationsOf(h.tree).length >= 1, true);
  h.unmount();
});

test("8. a stale metric map cannot resurrect a child that already left", () => {
  const h = loadCritters();
  h.publish({ a: child(PARENT), b: child(PARENT) });
  h.render();
  openPanelByHover(h);
  h.act();
  const before = stationsOf(h.tree).length;
  h.publish({ a: child(PARENT) });
  // b walks out with the exit animation, then disappears on its timer.
  for (const timer of h.session.timers.slice()) {
    timer.fn();
  }
  h.act();
  assert.ok(before >= 2);
  const rows = textsOf(h.tree).join(" ");
  assert.doesNotMatch(rows, /正在运行 2 个子代理/);
  h.unmount();
});

test("9. the root sessionStatus observable works as the fallback hook", () => {
  const h = loadCritters({ statusAsRoot: true });
  h.publish({ a: child(PARENT, { running: false, displayTitle: "addressable" }) });
  h.publishStatus(new Map([["a", { running: true }]]));
  h.render();
  assert.equal(stationsOf(h.tree).length, 1, "useSessionStatusRoot must be consulted like the standard prop");
  h.unmount();
});

test("10. a route SSE frame refreshes the activity seed and the batch leg", async () => {
  const h = loadCritters();
  h.publish({ a: child(PARENT, { displayTitle: "worker", provider: "p1", model: "m1" }) });
  h.render();
  // Let the mount reads finish: a new SSE frame that arrives while the SAME
  // URL is still on the wire joins that read instead of spending a second GET.
  await flush();
  h.act();
  const calls = (needle) => h.session.fetchCalls.filter((call) => String(call.path).indexOf(needle) !== -1).length;
  assert.equal(calls("subagent-role-router/activity?"), 1, "mount seeded once");
  assert.equal(calls("subagent-role-router/batch?"), 1, "mount fetched the batch once");

  h.emitSse({ type: "route", childId: "a" });
  assert.equal(calls("subagent-role-router/activity?"), 2, "a route frame refreshes the seed immediately");
  h.fireTimer(h.client.critterBatchRefreshMs);
  await flush();
  h.act();
  assert.equal(calls("subagent-role-router/batch?"), 2, "the route frame also refreshes the batch leg");
  h.unmount();
});

test("11. an unrelated status flush does not execute the closed header", () => {
  const h = loadCritters();
  h.publish({ a: child(PARENT) });
  h.render();
  const baseline = h.renders;
  h.publishStatus(new Map([["session-elsewhere", { running: true }]]));
  assert.equal(h.renders, baseline, "only the anchor family's status is subscribed");

  h.publishStatus(new Map([["a", { running: false }]]));
  assert.ok(h.renders > baseline, "this child's flip still re-renders");
  h.unmount();
});

test("12. a model change on a live child re-renders the critter tag", () => {
  const h = loadCritters();
  h.publish({ a: child(PARENT, { displayTitle: "worker", provider: "p1", model: "m1" }) });
  h.render();
  const baseline = h.renders;
  h.publish({ a: child(PARENT, { displayTitle: "worker", provider: "p1", model: "m2" }) });
  assert.ok(h.renders > baseline, "the membership key carries the route pair");
  const tag = stationsOf(h.tree)[0].children[1];
  assert.equal(tag.props.className, "dsm-critters-tag");
  assert.equal(tag.children[0], "m2");
  h.unmount();
});

test("13. the batch endpoint's verified pair outranks the store row", async () => {
  const h = loadCritters({
    batchChildren: [{ childId: "a", live: true, activity: "running", label: "worker", provider: "p-batch", model: "m-batch" }]
  });
  // The store row claims an older pair; the batch read is the route controller's
  // current answer and must paint instead.
  h.publish({ a: child(PARENT, { displayTitle: "worker", provider: "p-store", model: "m-store" }) });
  h.render();
  await flush();
  h.act();
  await flush();
  h.act();
  const tag = stationsOf(h.tree)[0].children[1];
  assert.equal(tag.children[0], "m-batch", "the server-verified batch pair wins");
  h.unmount();
});
