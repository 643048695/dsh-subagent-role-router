import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// The card is a React component, so "does it actually show the right thing" is
// testable without a browser: a three-hook mini renderer (useState / useRef /
// useEffect) drives the real component against a stubbed fetch. The stub routes
// by method and call order because the card talks to the directory three times
// in one lifetime — the hidden presence probe, the open-time read, and the fresh
// read taken at click time — and each may need a different answer.
const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

const PARENT = "session-parent";

function treeText(node) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(treeText).join("");
  if (node.portal) return treeText(node.node);
  return (node.children || []).map(treeText).join("");
}

function findAll(node, predicate, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((child) => findAll(child, predicate, out));
    return out;
  }
  if (node.portal) return findAll(node.node, predicate, out);
  if (predicate(node)) out.push(node);
  (node.children || []).forEach((child) => findAll(child, predicate, out));
  return out;
}

const byClass = (name) => (node) => typeof node.props?.className === "string" && node.props.className.split(/\s+/).includes(name);

function loadClient({ onGet, onPost } = {}) {
  let captured = null;
  const session = { slots: [], cursor: 0, effects: [], dirty: false, schedule: () => {} };
  const calls = [];

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
      // React refs expose .current, not .value: the card writes ref.current.
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

  let timers = [];
  let nextTimerId = 1;
  const stubSetTimeout = (fn, ms) => {
    const id = nextTimerId++;
    timers.push({ id, fn, ms });
    return id;
  };
  const stubClearTimeout = (id) => {
    timers = timers.filter((t) => t.id !== id);
  };

  const windowListeners = new Map();
  const sandbox = {
    window: {
      innerWidth: 1280,
      innerHeight: 900,
      addEventListener(type, fn) {
        if (!windowListeners.has(type)) windowListeners.set(type, new Set());
        windowListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        if (windowListeners.has(type)) windowListeners.get(type).delete(fn);
      },
      __ModuleLoader__: {
        load(module) {
          captured = module;
        }
      }
    },
    document: {
      body: { tag: "body" },
      activeElement: null,
      querySelector: () => null,
      createElement: () => ({ dataset: {}, setAttribute() {} }),
      head: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {}
    },
    console,
    setTimeout: stubSetTimeout,
    clearTimeout: stubClearTimeout,
    fetch: async (path, init) => {
      const method = init && init.method ? init.method : "GET";
      const body = init && typeof init.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ method, path, body });
      const payload = method === "POST"
        ? (onPost
          ? onPost(path, body)
          : writeOk(body && Array.isArray(body.selections) ? body.selections.map((row) => row.childId) : []))
        : (onGet ? onGet(path) : batchOk());
      return { json: async () => payload };
    }
  };
  vm.runInNewContext(clientSource, sandbox, { filename: "client.js" });
  if (!captured) throw new Error("client.js failed to register");
  const client = captured.factory((id) => {
    if (id === "react") return React;
    if (id === "react-dom") return { createPortal: React.createPortal };
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return { Toast: function Toast() {} };
    return {};
  });

  function draw(props) {
    session.cursor = 0;
    session.effects = [];
    const tree = client.BatchSwitchEntry(props);
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

  return {
    client,
    session,
    calls,
    get timers() { return timers; },
    get windowListeners() { return windowListeners; },
    async advanceTimer() {
      const pending = timers.slice();
      timers = [];
      for (const t of pending) {
        t.fn();
      }
      await flush();
      return this.act();
    },
    triggerFocus() {
      const set = windowListeners.get("focus");
      if (set) {
        for (const fn of Array.from(set)) fn();
      }
    },
    /** Apply something outside React (a click, a resolved promise) and settle. */
    act(fn) {
      if (fn) fn();
      let guard = 0;
      while (session.dirty && guard < 100) {
        session.dirty = false;
        this.current = draw(this.props);
      }
      return this.current;
    },
    async render(props) {
      this.props = props;
      this.current = draw(props);
      this.act();
      await flush();
      return this.act();
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
}

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

const childrenPayload = [
  {
    childId: "session-a",
    label: "alpha",
    mode: "continuable",
    live: true,
    selectable: true,
    reason: "ok",
    provider: "dnq",
    model: "deepseek-v4",
    reasoningEffort: "high",
    actual: { provider: "dnq", model: "deepseek-v4", reasoningEffort: "high" },
    pending: false,
    pendingRoute: null
  },
  {
    childId: "session-b",
    label: "bravo",
    mode: "continuable",
    live: false,
    selectable: true,
    reason: "ok",
    provider: "dnq",
    model: "deepseek-flash",
    reasoningEffort: "",
    actual: null,
    pending: true,
    pendingRoute: { provider: "local", model: "mystery", reasoningEffort: "deep" }
  },
  {
    childId: "session-c",
    label: "charlie",
    mode: "one-shot",
    live: false,
    selectable: false,
    reason: "ended",
    provider: "",
    model: "",
    reasoningEffort: "",
    actual: null,
    pending: false,
    pendingRoute: null
  }
];

const modelsPayload = [
  {
    provider: "dnq",
    model: "deepseek-v4",
    displayName: "DeepSeek V4",
    sources: ["base", "role:plan"],
    configuredEfforts: ["high"],
    capabilityKnown: true,
    efforts: [{ id: "high", label: "High", source: "catalog" }]
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

const listing = (children) => ({
  ok: true,
  value: { parentSessionId: PARENT, children, models: modelsPayload }
});

const batchOk = () => listing(childrenPayload);

const writeOk = (childIds) => ({
  ok: true,
  value: {
    parentSessionId: PARENT,
    summary: { total: childIds.length, ok: childIds.length, failed: 0 },
    results: childIds.map((childId) => ({
      childId,
      ok: true,
      route: { provider: "local", model: "mystery", reasoningEffort: "deep" },
      override: { provider: "local", model: "mystery", reasoningEffort: "deep" },
      pending: true
    }))
  }
});

const postedWrites = (calls) => calls.filter((call) => call.method === "POST" && call.path.endsWith("/batch/select"));

/** The card must be genuinely usable before a test is allowed to click apply. */
function assertCardReady(tree) {
  const panel = findAll(tree, byClass("dsm-batch-panel"))[0];
  assert.ok(panel, "the card is open");
  const selects = findAll(tree, (node) => node.type === "select");
  assert.equal(selects.length, 2, "model and effort selects");
  assert.ok(selects[0].children.length >= 2, "the model list has finished loading");
  const apply = findAll(tree, byClass("dsm-batch-apply"))[0];
  assert.ok(apply, "the apply button is mounted");
  assert.equal(apply.props.disabled, false, "the apply button is enabled on a usable card");
  return { panel, selects, apply };
}

/** Open the card, wait for the directory read, pick a model, and prove it is usable. */
async function openAndPick(driver, tree, modelKey) {
  const entry = findAll(tree, byClass("dsm-batch-entry"))[0];
  assert.ok(entry, "the entry must be visible before it can be clicked");
  driver.act(() => entry.props.onClick());
  await flush();
  tree = driver.act();
  const selects = findAll(tree, (node) => node.type === "select");
  assert.equal(selects.length, 2, "model and effort selects");
  driver.act(() => selects[0].props.onChange({ target: { value: modelKey } }));
  tree = driver.act();
  assertCardReady(tree);
  return tree;
}

test("1. the entry renders closed and opens the card above the composer", async () => {
  const driver = loadClient();
  let tree = await driver.render({ sessionId: PARENT });

  const entry = findAll(tree, byClass("dsm-batch-entry"))[0];
  assert.ok(entry, "the composer entry must render");
  assert.equal(entry.type, "button");
  assert.equal(entry.props["aria-expanded"], "false");
  assert.equal(treeText(entry), "⇄批量");
  assert.equal(findAll(tree, byClass("dsm-batch-panel")).length, 0, "the card stays unmounted while closed");

  driver.act(() => entry.props.onClick());
  await flush();
  tree = driver.act();

  const panel = findAll(tree, byClass("dsm-batch-panel"))[0];
  assert.ok(panel, "clicking the entry mounts the card");
  assert.equal(panel.props.style.position, "fixed", "the card escapes the composer's clipping");
  assert.ok(parseFloat(panel.props.style.width) >= 340 && parseFloat(panel.props.style.width) <= 380);
  assert.equal(panel.props.style.bottom !== "auto", true, "it opens upward from the trigger");

  const text = treeText(tree);
  assert.match(text, /子代理快捷切换/, "the card has a title");
  assert.match(text, /将作用于本对话 2 个活跃子代理/, "the ready line counts writable children only");
  assert.equal(findAll(tree, (node) => node.type === "checkbox").length, 0, "there are no checkboxes to tick");
  assert.equal(findAll(tree, (node) => node.type === "select").length, 2, "exactly model and effort selects");
  assert.match(text, /DeepSeek V4 · dnq/, "model options read name · provider");
  assert.doesNotMatch(text, /base、role:plan/, "sources stay out of the option labels");

  const apply = findAll(tree, byClass("dsm-batch-apply"))[0];
  assert.equal(apply.props.disabled, true, "applying is blocked until a model is picked");
});

test("2. applying targets a fresh read taken at click time, not the open-time preview", async () => {
  let freshChildren = childrenPayload;
  let gets = 0;
  const driver = loadClient({
    onGet: () => {
      gets += 1;
      // Probe and open see the listing from card-open time; everything after
      // the apply click sees whatever the conversation looks like then.
      return gets <= 2 ? batchOk() : listing(freshChildren);
    }
  });

  let tree = await driver.render({ sessionId: PARENT });
  tree = await openAndPick(driver, tree, driver.client.batchModelKey("local", "mystery"));
  assert.match(treeText(tree), /将作用于本对话 2 个活跃子代理/, "the preview counts the open-time directory");

  // A new child appears after the card was opened.
  freshChildren = childrenPayload.concat([{
    childId: "session-d",
    label: "delta",
    mode: "continuable",
    live: true,
    selectable: true,
    reason: "ok",
    provider: "dnq",
    model: "deepseek-v4",
    reasoningEffort: "",
    actual: null,
    pending: false,
    pendingRoute: null
  }]);

  driver.act(() => assertCardReady(tree).apply.props.onClick());
  await flush();
  tree = driver.act();

  const writes = postedWrites(driver.calls);
  assert.equal(writes.length, 1, "exactly one write");
  assert.deepEqual(writes[0].body.selections.map((row) => row.childId), ["session-a", "session-b", "session-d"],
    "the write set comes from the fresh read, including the child born after open");
  writes[0].body.selections.forEach((row) => {
    assert.deepEqual(row, { childId: row.childId, provider: "local", model: "mystery", reasoningEffort: "deep" });
  });
  assert.match(treeText(tree), /已应用到 3 个子代理，下轮请求生效/);
});

test("3. a fresh read with nothing writable blocks the POST and says so", async () => {
  let gets = 0;
  const driver = loadClient({
    onGet: () => {
      gets += 1;
      return gets <= 2 ? batchOk() : listing([childrenPayload[2]]);
    }
  });

  let tree = await driver.render({ sessionId: PARENT });
  tree = await openAndPick(driver, tree, driver.client.batchModelKey("local", "mystery"));
  assert.match(treeText(tree), /将作用于本对话 2 个活跃子代理/);

  driver.act(() => assertCardReady(tree).apply.props.onClick());
  await flush();
  tree = driver.act();

  assert.equal(postedWrites(driver.calls).length, 0, "nothing was written");
  assert.match(treeText(tree), /当前对话暂无活跃子代理/);
  assert.equal(findAll(tree, byClass("dsm-batch-apply"))[0].props.disabled, true,
    "the button locks once the fresh read proves there is nothing to write");
});

test("4. a failing fresh read blocks the POST and reports the failure", async () => {
  let gets = 0;
  const driver = loadClient({
    onGet: () => {
      gets += 1;
      return gets <= 2 ? batchOk() : { ok: false, error: { code: "catalog-unavailable" } };
    }
  });

  let tree = await driver.render({ sessionId: PARENT });
  tree = await openAndPick(driver, tree, driver.client.batchModelKey("local", "mystery"));

  driver.act(() => assertCardReady(tree).apply.props.onClick());
  await flush();
  tree = driver.act();

  assert.equal(postedWrites(driver.calls).length, 0, "no write on a failed read");
  assert.match(treeText(tree), /无法确认归属/, "an unanswered catalog is named as such");
});

test("5. switching conversations mid-read drops the write for the old one", async () => {
  let gets = 0;
  let applyReadStarted = false;
  let releaseRead;
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  const driver = loadClient({
    onGet: () => {
      gets += 1;
      if (gets === 3) {
        applyReadStarted = true; // probe = 1, open = 2, this is the apply-time read
        return gate;
      }
      return batchOk();
    }
  });

  let tree = await driver.render({ sessionId: PARENT });
  tree = await openAndPick(driver, tree, driver.client.batchModelKey("local", "mystery"));

  // Click apply: the fresh read now hangs on the gate.
  driver.act(() => assertCardReady(tree).apply.props.onClick());
  await flush();
  tree = driver.act();
  assert.equal(applyReadStarted, true, "the apply-time read really left the browser");
  assert.equal(postedWrites(driver.calls).length, 0, "and no write happens before it answers");

  // The user flips to another conversation while the read is in flight.
  await driver.render({ sessionId: "session-other" });
  await flush();

  releaseRead();
  await flush();
  tree = driver.act();

  assert.equal(postedWrites(driver.calls).length, 0,
    "a conversation flip between GET and POST must cancel the write");
  assert.doesNotMatch(treeText(tree), /已应用/, "the old conversation's result never lands on the new one");
  assert.doesNotMatch(treeText(tree), /应用中/, "the old conversation's busy state is not resurrected");
});

test("6. an unmounted card never writes, even after its in-flight read resolves", async () => {
  let gets = 0;
  let applyReadStarted = false;
  let releaseRead;
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  const driver = loadClient({
    onGet: () => {
      gets += 1;
      if (gets === 3) {
        applyReadStarted = true; // probe = 1, open = 2, this is the apply-time read
        return gate;
      }
      return batchOk();
    }
  });

  let tree = await driver.render({ sessionId: PARENT });
  tree = await openAndPick(driver, tree, driver.client.batchModelKey("local", "mystery"));

  // apply(): its fresh read now hangs on the gate.
  driver.act(() => assertCardReady(tree).apply.props.onClick());
  await flush();
  driver.act();
  assert.equal(applyReadStarted, true, "the apply-time read really left the browser");

  // Real teardown (host key-swap unmount), not a prop update.
  driver.unmount();

  releaseRead();
  await flush();

  assert.equal(postedWrites(driver.calls).length, 0,
    "an unmounted card must not complete the write");
});

test("7. a failed write reports the failure and stays retryable", async () => {
  let posts = 0;
  const driver = loadClient({
    onPost: (path, body) => {
      posts += 1;
      if (posts === 1) return { ok: false, error: { code: "not-owned" } };
      return writeOk(body.selections.map((row) => row.childId));
    }
  });

  let tree = await driver.render({ sessionId: PARENT });
  tree = await openAndPick(driver, tree, driver.client.batchModelKey("local", "mystery"));

  driver.act(() => assertCardReady(tree).apply.props.onClick());
  await flush();
  tree = driver.act();
  assert.match(treeText(tree), /应用失败：not-owned/, "the failure is named");
  assert.equal(findAll(tree, byClass("dsm-batch-apply"))[0].props.disabled, false, "retry stays possible");

  driver.act(() => assertCardReady(tree).apply.props.onClick());
  await flush();
  tree = driver.act();
  assert.match(treeText(tree), /已应用到 2 个子代理，下轮请求生效/);

  const writes = postedWrites(driver.calls);
  assert.equal(writes.length, 2, "two write attempts, no directory reads counted");
  writes.forEach((write) => {
    assert.deepEqual(write.body.selections.map((row) => row.childId), ["session-a", "session-b"],
      "each attempt writes the full current set");
  });
});

test("8. presence follows the store signature instead of a timer", async () => {
  let children = [childrenPayload[2]]; // only the ended child
  let catalog = [
    { id: "session-a", mode: "continuable" },
    { id: "session-b", mode: "continuable" },
    { id: "session-end", mode: "one-shot" }
  ];
  const byId = {
    "session-a": { id: "session-a", parentId: PARENT, origin: "subagent", running: true },
    "session-b": { id: "session-b", parentId: PARENT, origin: "subagent", running: true },
    "session-end": { id: "session-end", parentId: PARENT, origin: "subagent", running: false }
  };
  let listener = null;
  const sessionsList = {
    getSnapshot: () => ({ byId, projectionsBySession: { [PARENT]: { values: { subagentCatalog: catalog } } } }),
    subscribe: (fn) => { listener = fn; return () => { listener = null; }; }
  };

  const driver = loadClient({ onGet: () => listing(children) });

  let tree = await driver.render({ sessionId: PARENT, sessionsList });
  assert.equal(findAll(tree, byClass("dsm-batch-entry")).length, 0, "hidden while nothing is writable");
  assert.equal(driver.timers.length, 0, "no poll timer is armed — ever");
  const batchGets = () => driver.calls.filter((call) => call.method === "GET" && call.path.includes("/batch?")).length;
  assert.equal(batchGets(), 1, "exactly one verify on mount");

  catalog = catalog.concat([{ id: "session-c", mode: "continuable" }]);
  byId["session-c"] = { id: "session-c", parentId: PARENT, origin: "subagent", running: true };
  children = childrenPayload;
  listener();
  await flush();
  tree = driver.act();
  assert.ok(findAll(tree, byClass("dsm-batch-entry"))[0], "the entry appears once the store says a writable child exists");
  assert.equal(batchGets(), 2, "the store change triggered exactly one more verify");

  listener(); // unchanged snapshot: no new request
  await flush();
  tree = driver.act();
  assert.equal(batchGets(), 2, "an unchanged signature is a no-op");

  catalog = catalog.slice(0, 3); // the child is gone again
  delete byId["session-c"];
  children = [childrenPayload[2]];
  listener();
  await flush();
  tree = driver.act();
  assert.equal(findAll(tree, byClass("dsm-batch-entry")).length, 0, "hidden again when the last writable child is gone");

  driver.triggerFocus(); // focus re-verifies even when the signature looks unchanged
  await flush();
  tree = driver.act();
  assert.equal(findAll(tree, byClass("dsm-batch-entry")).length, 0, "focus re-probe keeps it hidden");
  assert.equal(driver.timers.length, 0, "still no timers after focus");
});

test("9. the probe coalesces focus bursts, arms no timers, and never wakes another conversation", async () => {
  // (a) A focus burst shares the in-flight verify, and no timer chain exists at all.
  let gets = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let children = [childrenPayload[2]];
  const catalog = [{ id: "session-a", mode: "continuable" }];
  const byId = { "session-a": { id: "session-a", parentId: PARENT, origin: "subagent", running: true } };
  let listener = null;
  const sessionsList = {
    getSnapshot: () => ({ byId, projectionsBySession: { [PARENT]: { values: { subagentCatalog: catalog } } } }),
    subscribe: (fn) => { listener = fn; return () => { listener = null; }; }
  };
  const driver = loadClient({
    onGet: () => {
      gets += 1;
      if (gets === 1) return firstGate; // the mount verify hangs
      return listing(children);
    }
  });

  await driver.render({ sessionId: PARENT, sessionsList });
  assert.equal(gets, 1, "mount starts exactly one verify");
  assert.equal(driver.timers.length, 0, "no timer is armed while a verify is in flight — or ever");

  driver.triggerFocus();
  driver.triggerFocus();
  await flush();
  assert.equal(gets, 1, "focus bursts coalesce into the in-flight verify instead of firing more requests");

  releaseFirst();
  await flush();
  driver.act();
  assert.equal(driver.timers.length, 0, "still zero timers after the verify settles");

  children = childrenPayload;
  catalog.push({ id: "session-b", mode: "continuable" }); // a real store change
  byId["session-b"] = { id: "session-b", parentId: PARENT, origin: "subagent", running: true };
  listener();
  await flush();
  const shown = driver.act();
  assert.equal(gets, 2, "a store change verifies exactly once");
  assert.ok(findAll(shown, byClass("dsm-batch-entry"))[0], "the entry appears once a writable child is proven");

  // (b) A late answer from conversation A must never wake conversation B.
  let getsB = 0;
  let releaseA;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  const otherFace = {
    getSnapshot: () => ({ byId: {}, projectionsBySession: {} }),
    subscribe: () => () => { }
  };
  const other = loadClient({
    onGet: () => {
      getsB += 1;
      if (getsB === 1) return gateA; // A's verify hangs
      return listing([childrenPayload[2]]); // B has nothing writable
    }
  });

  const treeA = await other.render({ sessionId: "session-a", sessionsList: otherFace });
  assert.equal(findAll(treeA, byClass("dsm-batch-entry")).length, 0, "A starts hidden");
  const treeB0 = await other.render({ sessionId: "session-b", sessionsList: otherFace }); // flip while A's verify is in flight
  await flush();

  releaseA(); // A answers "present" late
  await flush();
  const treeB = other.act();
  assert.equal(findAll(treeB, byClass("dsm-batch-entry")).length, 0,
    "a late presence answer from A must not wake B's entry");
});

test("10. unmount cancels the focus listener and leaves no timers", async () => {
  let gets = 0;
  let listener = null;
  const sessionsList = {
    getSnapshot: () => ({ byId: {}, projectionsBySession: {} }),
    subscribe: (fn) => { listener = fn; return () => { listener = null; }; }
  };
  const driver = loadClient({
    onGet: () => {
      gets += 1;
      return listing([childrenPayload[2]]);
    }
  });

  await driver.render({ sessionId: PARENT, sessionsList });
  assert.equal(gets, 1, "one verify on mount");
  assert.equal(driver.timers.length, 0, "no timer is armed after the verify");
  assert.equal(driver.windowListeners.get("focus").size, 1, "the card observes window focus");

  driver.unmount();
  assert.equal(driver.timers.length, 0, "unmount leaves nothing to cancel");
  assert.equal(driver.windowListeners.get("focus").size, 0, "unmount unsubscribes the focus listener");
  assert.equal(listener, null, "unmount unsubscribed from the session store");

  driver.triggerFocus();
  await flush();
  assert.equal(gets, 1, "focus does not verify after unmount");
});
