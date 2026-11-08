import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// The critters are the only always-visible trace of running subagents, so the
// launch surface is pinned here, through the real component:
//
//   1. Clicking (or keyboard-activating) a critter jumps straight to that
//      subagent's conversation — without opening the panel first.
//   2. Each critter carries a persistent short title derived from the host
//      label, cleaned of lane prefixes and team paths.
//   3. The panel opens on hover intent (not a toggle button), closes on
//      leave/Esc, and its rows show the same real short titles.
//   4. On a child session's own page the strip anchors to the family's main
//      conversation (stations + "↩ 主对话" chip); the main conversation's
//      page keeps its exact old picture with no chip.
//
// The host hook (`useSessions`) is modelled on its real contract: a store
// notification re-runs the selector and only schedules a re-render when the
// selected value is not Object.is-equal to the committed one.
const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

const plain = (value) => JSON.parse(JSON.stringify(value));

function loadCritters(opts) {
  let capturedModule = null;
  let capturedCss = "";
  const storeListeners = [];
  let storeSnapshot = { byId: {} };
  const openCalls = [];
  let openError = null;
  const uiWorkspace = {
    openSession(id) {
      if (openError) {
        const error = openError;
        openError = null;
        throw error;
      }
      openCalls.push(id);
    }
  };
  const session = {
    cursor: 0,
    hookCursor: 0,
    effects: [],
    slots: [],
    dirty: false,
    renders: 0,
    timers: [],
    intervals: [],
    fetchCalls: []
  };
  let nextTimerId = 1;

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
    fetch: async (path, init) => {
      session.fetchCalls.push({ path, method: init && init.method });
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

  const slotRegistrations = [];
  const slotComponents = [];
  const ctx = {
    get(id) {
      if (id === "sessions") return { list: sessionsFace };
      if (id === "uiWorkspace") return opts && opts.noNav ? undefined : uiWorkspace;
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
  const injected = registration.inject((opts && opts.sid) || "session-parent");
  const props = Object.assign({}, injected, { useSessions });

  function draw() {
    session.cursor = 0;
    session.hookCursor = 0;
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
    openCalls,
    throwOpen(error) {
      openError = error;
    },
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
    publish(nextById, projections) {
      storeSnapshot = { byId: nextById, projectionsBySession: projections };
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
    unmount() {
      for (const slot of session.slots) {
        if (slot && typeof slot.cleanup === "function") {
          slot.cleanup();
          slot.cleanup = null;
        }
      }
    },
    // A real slot remount gives the component fresh hook/state slots while
    // module-level mirrors (crittersUi) survive — exactly what this models.
    remount() {
      harness.unmount();
      session.slots.length = 0;
      session.cursor = 0;
      session.hookCursor = 0;
      hookEntries.length = 0;
      session.effects = [];
      session.dirty = false;
      return harness.render();
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

function firstWith(tree, match) {
  let found = null;
  walk(tree, (el) => {
    if (!found && match(el)) found = el;
  });
  return found;
}

const rootOf = (tree) => firstWith(tree, (el) => el.type === "span" && el.props && el.props.className === "dsm-critters");
const stripOf = (tree) => firstWith(tree, (el) => el.type === "span" && el.props && el.props.className === "dsm-critters-btn");
const moreOf = (tree) => firstWith(tree, (el) => el.type === "button" && el.props && el.props.className === "dsm-critters-more");

const clickEvent = () => ({ preventDefault() {}, stopPropagation() {} });

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

test("1. critterShortTitle cleans lane prefixes, team paths and length", () => {
  const h = loadCritters();
  const title = (label) => h.client.critterShortTitle({ childId: "child-short", label });

  assert.equal(h.client.critterTitleMax, 14);
  assert.equal(
    title("[agent:delegated review] Bounded sweep of the installer"),
    "Bounded sweep…",
    "lane prefix goes, the rest truncates to the cap"
  );
  assert.equal(title("agent-teams:watchface-wave1-prod:build-2"), "build-2", "team path collapses to the member");
  assert.equal(title("  short   label  "), "short label", "whitespace squeezes");
  assert.equal(title("abcdefghijklmn"), "abcdefghijklmn", "14 chars stay whole");
  assert.equal(title("abcdefghijklmno"), "abcdefghijklm…", "15 chars truncate under the cap");
  assert.ok(h.client.critterPhrases.includes(title(undefined)), "no label falls back to the phrase");
  assert.ok(h.client.critterPhrases.includes(title("")), "empty label falls back to the phrase");
  assert.ok(h.client.critterPhrases.includes(title("[agent:fork]")), "label that empties falls back to the phrase");
  h.unmount();
});

test("2. the tag under each critter shows the short title and follows renames", () => {
  const h = loadCritters();
  h.publish({ a: child(PARENT, { displayTitle: "first task" }) });
  h.render();

  let stations = stationsOf(h.tree);
  assert.equal(stations.length, 1);
  assert.equal(stations[0].props["data-critter-title"], "first task");
  const tag = stations[0].children[1];
  assert.equal(tag.props.className, "dsm-critters-tag");
  assert.equal(tag.children[0], "first task");

  h.publish({ a: child(PARENT, { displayTitle: "second task" }) });
  stations = stationsOf(h.tree);
  assert.equal(stations[0].children[1].children[0], "second task", "a rename rides the membership key");
  h.unmount();
});

test("3. clicking a critter jumps to that child, panel stays shut", () => {
  const h = loadCritters();
  h.publish({ a: child(PARENT, { displayTitle: "alpha task" }), b: child(PARENT, { displayTitle: "beta task" }) });
  const tree = h.render();
  const stations = stationsOf(tree);
  assert.equal(stations.length, 2);

  stations[1].props.onClick(clickEvent());
  assert.deepEqual(
    h.openCalls.map(function (call) { return { parentSessionId: call.parentSessionId, childSessionId: call.childSessionId, mode: call.mode }; }),
    [{ parentSessionId: PARENT, childSessionId: "b", mode: "continuable" }],
    "click jumps with the host's own address object"
  );
  assert.equal(h.intervals.length, 0, "no panel, no ticker");
  assert.doesNotMatch(textsOf(h.tree).join(" "), /正在运行/);

  stations[0].props.onKeyDown({ key: "Enter", preventDefault() {} });
  stations[0].props.onKeyDown({ key: " ", preventDefault() {} });
  assert.deepEqual(h.openCalls.map(function (call) { return { parentSessionId: call.parentSessionId, childSessionId: call.childSessionId, mode: call.mode }; }), [
    { parentSessionId: PARENT, childSessionId: "b", mode: "continuable" },
    { parentSessionId: PARENT, childSessionId: "a", mode: "continuable" },
    { parentSessionId: PARENT, childSessionId: "a", mode: "continuable" }
  ], "keyboard activation jumps too");

  // A throwing navigation service must not take the header down — and must
  // not leave a dead click: the panel opens as the fallback surface.
  h.throwOpen(new Error("navigation gone"));
  stations[0].props.onClick(clickEvent());
  assert.deepEqual(h.openCalls.length, 3);
  h.act();
  assert.equal(stationsOf(h.tree).length, 2, "header still renders after the failure");
  assert.match(textsOf(h.tree).join(" "), /正在运行 2 个子代理/, "failed jump falls back to the panel");
  h.unmount();
});

test("4. hover intent opens the panel; leave, Esc and unmount close or clean it", () => {
  const h = loadCritters();
  h.publish({ a: child(PARENT), b: child(PARENT) });
  h.render();
  assert.equal(h.intervals.length, 0, "closed header has no ticker");

  openPanelByHover(h);
  assert.match(textsOf(h.tree).join(" "), /正在运行 2 个子代理/);
  assert.equal(h.intervals.length, 1, "open panel runs exactly one ticker");

  closePanelByHover(h);
  assert.doesNotMatch(textsOf(h.tree).join(" "), /正在运行/);
  assert.equal(h.intervals.length, 0, "closing the panel clears the ticker");

  openPanelByHover(h);
  rootOf(h.tree).props.onKeyDown({ key: "Escape" });
  h.act();
  assert.doesNotMatch(textsOf(h.tree).join(" "), /正在运行/, "Esc closes the panel");

  rootOf(h.tree).props.onMouseEnter();
  assert.ok(h.session.timers.some((t) => t.ms === h.client.critterHoverOpenMs), "re-entering schedules a new open timer");
  h.unmount();
  // The mount path legitimately leaves its own retry/census timers behind
  // (pre-existing); the hover timer specifically must not survive unmount.
  assert.ok(!h.session.timers.some((t) => t.ms === h.client.critterHoverOpenMs), "unmount clears the pending hover timer");
});

test("5. '+N' opens the panel and rows show real short titles", () => {
  const h = loadCritters();
  h.publish({
    a: child(PARENT, { displayTitle: "alpha task" }),
    b: child(PARENT, { displayTitle: "beta task" }),
    c: child(PARENT, { displayTitle: "gamma task" }),
    d: child(PARENT, { displayTitle: "delta task" }),
    e: child(PARENT, { displayTitle: "epsilon task" })
  });
  h.render();
  assert.equal(stationsOf(h.tree).length, 3, "only the first three stations render");

  const more = moreOf(h.tree);
  assert.ok(more, "the overflow chip exists");
  assert.equal(more.children[0], "+2");
  more.props.onClick(clickEvent());
  h.act();

  const joined = textsOf(h.tree).join(" | ");
  assert.match(joined, /正在运行 5 个子代理/);
  for (const label of ["alpha task", "beta task", "gamma task", "delta task", "epsilon task"]) {
    assert.ok(joined.includes(label), "panel row shows the real title: " + label);
  }
  h.unmount();
});

test("6. structure: strip is a span, stations are buttons, none nest", () => {
  const h = loadCritters();
  h.publish({ a: child(PARENT, { displayTitle: "alpha task" }), b: child(PARENT, { displayTitle: "beta task" }) });
  const tree = h.render();

  const root = rootOf(tree);
  assert.ok(root, "the root is a span");
  const strip = stripOf(tree);
  assert.ok(strip, "the strip is a span (no toggle button anymore)");

  const nested = [];
  walk(tree, (el) => {
    if (el.type !== "button") return;
    walk({ type: "fragment", props: {}, children: el.children }, (inner) => {
      if (inner !== el && inner.type === "button") nested.push(el);
    });
  });
  assert.deepEqual(nested, [], "no button may contain a button");

  for (const station of stationsOf(tree)) {
    assert.equal(station.children[0].type, "svg", "art first");
    assert.equal(station.children[1].props.className, "dsm-critters-tag", "tag second");
    assert.match(station.props["aria-label"], /打开.+的对话/);
    assert.match(station.props.title, /点击打开/);
  }
  h.unmount();
});

test("7. the jump address carries the real catalog mode when the projection has it", () => {
  const h = loadCritters();
  h.publish(
    { a: child(PARENT, { displayTitle: "solo task" }) },
    { [PARENT]: { values: { subagentCatalog: [{ id: "a", mode: "one-shot" }] } } }
  );
  h.render();
  stationsOf(h.tree)[0].props.onClick(clickEvent());
  assert.deepEqual(
    h.openCalls.map(function (call) { return { parentSessionId: call.parentSessionId, childSessionId: call.childSessionId, mode: call.mode }; }),
    [{ parentSessionId: PARENT, childSessionId: "a", mode: "one-shot" }],
    "mode comes from the parent's subagentCatalog projection"
  );
  h.unmount();
});

test("8. without a navigation service the click still opens the panel", () => {
  const h = loadCritters({ noNav: true });
  h.publish({ a: child(PARENT, { displayTitle: "solo task" }) });
  h.render();

  stationsOf(h.tree)[0].props.onClick(clickEvent());
  h.act();
  assert.deepEqual(h.openCalls, [], "nothing to navigate to");
  assert.match(textsOf(h.tree).join(" "), /正在运行 1 个子代理/, "the click still surfaces the panel");
  h.unmount();
});

test("9. hover intent and open state survive a slot remount", () => {
  const h = loadCritters();
  h.publish({ a: child(PARENT, { displayTitle: "solo task" }) });
  h.render();

  rootOf(h.tree).props.onMouseEnter();
  h.unmount();
  assert.ok(
    !h.session.timers.some((t) => t.ms === h.client.critterHoverOpenMs),
    "the remount cleared the pending timer with the old mount"
  );

  h.remount();
  assert.ok(
    h.session.timers.some((t) => t.ms === h.client.critterHoverOpenMs),
    "the remount re-arms the open timer while the pointer rests on the strip"
  );
  fireHoverTimer(h, h.client.critterHoverOpenMs);
  h.act();
  assert.match(textsOf(h.tree).join(" "), /正在运行 1 个子代理/);

  h.remount();
  assert.match(
    textsOf(h.tree).join(" "),
    /正在运行 1 个子代理/,
    "an open panel is restored immediately after a remount"
  );
  h.unmount();
});

// A child page's family: the top-level parent plus its running children,
// "me" being the session whose page we are ON.
const familyById = () => ({
  [PARENT]: { running: false, displayTitle: "main conversation", origin: "user" },
  a: child(PARENT, { displayTitle: "sibling one" }),
  b: child(PARENT, { displayTitle: "sibling two" }),
  me: child(PARENT, { displayTitle: "my own task" })
});

const backChipOf = (tree) =>
  firstWith(tree, (el) => el.type === "button" && el.props && el.props.className === "dsm-critters-back");

test("10. a child session's page shows its parent family and a way back", () => {
  const h = loadCritters({ sid: "me" });
  h.publish(familyById());
  const tree = h.render();

  assert.equal(stationsOf(tree).length, 3, "the family (this child included) renders on the child page");
  const back = backChipOf(tree);
  assert.ok(back, "the back chip exists on a child page");
  assert.equal(back.children[0], "↩ 主对话");
  const seedCall = h.session.fetchCalls.find((call) => String(call.path).indexOf("parentSessionId=") !== -1);
  assert.ok(seedCall, "a seed fetch happened");
  assert.match(seedCall.path, /parentSessionId=session-parent/, "the seed fetch targets the family's parent");

  back.props.onClick(clickEvent());
  assert.deepEqual(h.openCalls, [PARENT], "back jumps to the main conversation by bare top-level id");

  stationsOf(h.tree)[1].props.onClick(clickEvent());
  assert.equal(h.openCalls.length, 2);
  assert.deepEqual(
    {
      parentSessionId: h.openCalls[1].parentSessionId,
      childSessionId: h.openCalls[1].childSessionId,
      mode: h.openCalls[1].mode
    },
    { parentSessionId: PARENT, childSessionId: "b", mode: "continuable" },
    "a sibling jump addresses the anchor as the parent, not the page we sit on"
  );
  h.unmount();
});

test("11. on a child page the jump mode comes from the parent's catalog", () => {
  const h = loadCritters({ sid: "me" });
  h.publish(
    familyById(),
    { [PARENT]: { values: { subagentCatalog: [{ id: "b", mode: "one-shot" }] } } }
  );
  h.render();

  stationsOf(h.tree)[1].props.onClick(clickEvent());
  assert.deepEqual(
    h.openCalls.map((call) => ({ parentSessionId: call.parentSessionId, childSessionId: call.childSessionId, mode: call.mode })),
    [{ parentSessionId: PARENT, childSessionId: "b", mode: "one-shot" }],
    "both the parent and the mode come from the anchor family's projection"
  );
  h.unmount();
});

test("12. the main conversation's page has no back chip", () => {
  const h = loadCritters();
  h.publish({ a: child(PARENT, { displayTitle: "alpha task" }) });
  h.render();

  assert.equal(stationsOf(h.tree).length, 1);
  assert.equal(backChipOf(h.tree), null, "no way back when we are already at the family's root");
  h.unmount();
});
