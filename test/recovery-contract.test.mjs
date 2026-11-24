// RECOVERY CONTRACT — the host loop's own rules, and one end-to-end A→B run.
//
// WHY THIS FILE EXISTS: `test/failover-revert.test.mjs` drives the waterfall
// listeners directly, so it can prove what the plugin ASKS FOR but not what the
// host DOES with the answer. That gap is exactly where the old design was
// wrong: the hook answered `{ kind: "retry" }`, the tests asserted `retry`, and
// the retried attempt ran the SAME failing model, because the loop captures one
// selection per step and reuses it for every attempt.
//
// This file therefore:
//
//   1. PINS the decisive host behaviour against the INSTALLED harness source
//      (`dsh-agent-loop` 0.2.2-rc.5 as shipped in the desktop app.asar). If a
//      future host changes any of it, these assertions fail loudly instead of
//      letting the plugin's contract rot silently. They are skipped — with the
//      reason printed — on a machine without the desktop app.
//   2. Runs ONE real loop: a faithful re-implementation of the installed
//      `ReactLoopAgent` (frozen per-step selection, `while (true)` retry loop,
//      `cancel` aborting the phase, `send` re-classifying a waking message on
//      an aborted phase, `wakeRequested` latching) with the plugin's REAL
//      listeners wired in. A fails, B succeeds, and the assertions are about
//      what the loop actually served — not about what the plugin returned.
//   3. Keeps a CONTROL: the same loop with a hook that answers `retry` serves
//      the failing route twice. That is the empirical reason the plugin must
//      cut and resume instead of claiming a retry.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { apply, shouldFailover } from "../lib/index.js";
import {
  canSwitch,
  coolingRemaining,
  episodeOf,
  isPrepareConfigFailure,
  markCancelled,
  markDisposed,
  noteFailure,
  noteRealSuccess,
  noteSwitch,
  pickCandidate,
  resumeNow,
  routeKeyOf,
  switchNow
} from "../lib/recovery.js";

// ── 1. the installed host, pinned ───────────────────────────────────────────

/** Where the desktop build keeps its asar; nothing else in this suite reads it. */
function installedAsarPath() {
  if (process.platform !== "win32") return void 0;
  const local = process.env.LOCALAPPDATA;
  if (typeof local !== "string" || local === "") return void 0;
  const candidate = join(local, "Programs", "DeepSeek Harness", "resources", "app.asar");
  return existsSync(candidate) ? candidate : void 0;
}

/**
 * Extract one file out of an asar archive.
 *
 * The archive header is `{ size: 4, headerSize: 4, json }` followed by the
 * packed files, and every entry's `offset` is relative to the payload start.
 * Reading it directly keeps this suite free of an `asar` dev dependency.
 */
export function readFromAsar(asarPath, innerPath) {
  const buffer = readFileSync(asarPath);
  const headerSize = buffer.readUInt32LE(4);
  const json = buffer.subarray(16, 16 + headerSize).toString("utf8");
  const header = JSON.parse(json.slice(0, json.lastIndexOf("}") + 1));
  // The payload starts 8 bytes before the u32 that names its own size (the
  // archive's pickle framing is 4+4+4+4); verified by hashing a known entry.
  const payloadStart = 8 + headerSize;
  let node = header;
  for (const segment of innerPath.split("/").filter(Boolean)) {
    node = node?.files?.[segment];
    if (node === void 0) return void 0;
  }
  if (node.files !== void 0) return void 0;
  const start = payloadStart + Number(node.offset);
  return buffer.subarray(start, start + Number(node.size)).toString("utf8");
}

const LOOP_SOURCE = "/dsh/node_modules/@deepseek-ai/dsh-agent-loop/src/agent.ts";
const MODEL_SOURCE = "/dsh/node_modules/@deepseek-ai/dsh-agent/src/model-selection.ts";
const LOOP_PACKAGE = "/dsh/node_modules/@deepseek-ai/dsh-agent-loop/package.json";
const asar = installedAsarPath();
const loopSource = asar === void 0 ? void 0 : readFromAsar(asar, LOOP_SOURCE);
const modelSource = asar === void 0 ? void 0 : readFromAsar(asar, MODEL_SOURCE);
const loopPackage = asar === void 0 ? void 0 : readFromAsar(asar, LOOP_PACKAGE);
const hostSkip = loopSource === void 0
  ? "the installed DeepSeek Harness desktop app.asar was not found; host-contract assertions need it"
  : false;

test("host contract: the installed loop is the verified 0.2.2-rc.5 build", { skip: hostSkip }, () => {
  const version = JSON.parse(loopPackage)?.version;
  assert.equal(version, "0.2.2-rc.5", "these assertions describe this exact host build; re-verify before moving the pin");
});

/** Collapse whitespace so a formatting change inside the host does not fail us. */
const flat = (text) => text.replace(/\s+/g, " ");

test("host contract: the step's model selection is captured once and reused for every attempt", { skip: hostSkip }, () => {
  const code = flat(loopSource);
  // `preStep` captures it …
  assert.match(code, /const selection = this\.model\.current\(\)/);
  // … and `step` passes the SAME `decision.selection` into every attempt.
  assert.match(code, /await this\.prepareRequest\(turn, step, decision\.selection, signal\)/);
  // The retry loop that makes "retry ≠ switch" true (the host source writes
  // TypeScript without statement semicolons, so neither does this pattern).
  assert.match(code, /let firstAttempt = true\s+while \(true\) \{/);
  // And a differing proposal is a hard error, so no waterfall can rewrite it:
  assert.match(code, /agent\/request proposed .* after step preparation fixed/);
});

test("host contract: cancel aborts the running phase and keeps the inbox on request", { skip: hostSkip }, () => {
  const code = flat(loopSource);
  assert.match(code, /if \(!options\.keepInbox\) this\.inbox\.clear\(\)/);
  assert.match(code, /if \(this\.phase\.kind !== 'idle'\) \{/);
  assert.match(code, /this\.phase\.abort\.abort\(cause\)/);
});

test("host contract: a waking message on an aborted phase is re-targeted and re-latched", { skip: hostSkip }, () => {
  const code = flat(loopSource);
  // `send()` — followup/steer/inject all funnel here.
  assert.match(code, /const wakingAfterAbort = wakeup && this\.phase\.kind !== 'idle' && this\.phase\.abort\.signal\.aborted/);
  assert.match(code, /const resolvedTarget = wakingAfterAbort \? 'next-turn' : target/);
  // `wakeDriver()` latches, and the driver's finally replays the latch.
  assert.match(code, /if \(reason\?\.kind !== 'disposed' && \(this\.phase\.kind === 'maintenance' \|\| wakeAfterAbort\)\) \{/);
  assert.match(code, /if \(wakeRequested && this\.inbox\.hasPending\) this\.wakeDriver\(\)/);
});

test("host contract: agent.model.select only records a durable selection", { skip: hostSkip }, () => {
  const code = flat(modelSource);
  // `select` is a LOGGED INTENT, never a request-time rewrite. It no-ops an
  // identical selection and appends `model/selection`; the loop's frozen
  // `decision.selection` is untouched.
  assert.match(code, /select\(selection: Readonly<ModelSelection>\): void \{/);
  assert.match(code, /sameModelSelection\(this\.recordedSelection\(\), selection\)/);
  assert.match(code, /this\.session\.append\('model\/selection'/);
  // `current()` is what `preStep` reads at the START of the next turn.
  assert.match(code, /current\(\): Readonly<ModelSelection> \| undefined/);
  assert.match(code, /return \{ \.\.\.recorded \}/);
});

// ── 2. a faithful loop, with the plugin's real listeners ────────────────────

/**
 * A minimal but faithful `ReactLoopAgent` driver.
 *
 * Every mechanic below is a direct transcription of the installed host (see
 * the pinned assertions above). Nothing here is a shortcut: the point of the
 * harness is that a WRONG plugin answer (retry, select-without-cut, an
 * unguarded followup) produces the host's real outcome rather than a
 * convenient one.
 */
class HostLoop {
  constructor({ id, route, gateway, plugin }) {
    this.id = id;
    this.gateway = gateway;
    this.plugin = plugin;
    this.status = "idle";
    this.attempts = [];
    this.commits = [];
    this.inbox = { nextTurn: [], nextStep: [] };
    this.served = { provider: route.provider, model: route.model };
    this.selection = { provider: route.provider, model: route.model };
    const host = this;
    this.agent = {
      id,
      get status() { return host.status; },
      session: {
        id,
        header: { origin: "subagent", label: id, parentSession: "parent-1" },
        requestContext: () => ({ provider: host.served.provider, model: host.served.model, contextWindow: 2000 }),
        requestHeader: () => ({ config: { ...host.served } }),
        snapshotEvents: () => host.commits,
        requestContextProvider: "loop"
      },
      model: {
        current() { return { ...host.selection }; },
        select(selection) {
          // Only a change is appended; the host no-ops an identical selection.
          if (host.selection.provider === selection.provider && host.selection.model === selection.model) return;
          host.selection = { provider: selection.provider, model: selection.model };
          host.plugin.emitSession(host.agent.session, {
            type: "model/selection",
            data: { provider: selection.provider, model: selection.model }
          });
        }
      },
      cancel(cause, options = {}) {
        if (!options.keepInbox) host.inbox = { nextTurn: [], nextStep: [] };
        host.cancels.push({ cause, options });
        if (host.phase !== "idle") {
          host.abortReason = cause;
          host.abortController.abort(cause);
        }
      },
      followup(message) { host.agent.send(message, "next-turn", true); },
      send(message, target, wakeup) {
        const wakingAfterAbort = wakeup && host.phase !== "idle" && host.abortController.signal.aborted;
        const resolved = wakingAfterAbort ? "next-turn" : target;
        host.followups.push(message);
        (resolved === "next-turn" ? host.inbox.nextTurn : host.inbox.nextStep).push(message);
        if (wakeup) host.wakeDriver(wakingAfterAbort);
      },
      options: { provider: "parent", model: "parent" }
    };
    this.cancels = [];
    this.followups = [];
    this.phase = "idle";
    this.abortController = new AbortController();
    this.wakeRequested = false;
    this.options = { provider: "parent", model: "parent" };
  }

  get hasPending() {
    return this.inbox.nextTurn.length > 0 || this.inbox.nextStep.length > 0;
  }

  /** `AgentModel.current()`: the durable selection, else the creation options. */
  current() {
    return { ...this.selection };
  }

  wakeDriver(wakeAfterAbort = false) {
    if (this.phase !== "idle") {
      const reason = this.abortReason;
      if ((reason?.kind !== "disposed") && (this.phase === "maintenance" || wakeAfterAbort)) {
        this.wakeRequested = true;
      }
      return;
    }
    this.driver = this.kick();
  }

  async kick() {
    this.phase = "running";
    this.abortController = new AbortController();
    this.abortReason = void 0;
    this.status = "running";
    try {
      for (let turn = 1; turn <= 8; turn += 1) {
        const more = await this.turn(turn);
        if (!more) break;
      }
    } catch (_error) {
      // The host contains a driver failure at its boundary.
    } finally {
      if (this.phase === "running") {
        this.phase = "idle";
        this.status = "idle";
        const latch = this.wakeRequested;
        this.wakeRequested = false;
        if (latch && this.hasPending) this.wakeDriver();
      }
    }
  }

  /** One turn: claim a batch, run steps until a terminal ending. */
  async turn(turn) {
    const signal = this.abortController.signal;
    const claimed = [...this.inbox.nextStep];
    this.inbox.nextStep = [];
    if (this.inbox.nextTurn.length > 0) claimed.push(this.inbox.nextTurn.shift());
    this.plugin.emitSession(this.agent.session, { type: "turn/start", data: { turn } });
    let ending;
    try {
      for (let step = 1; step <= 8; step += 1) {
        if (signal.aborted) throw signal.reason;
        // THE FROZEN SELECTION, read once per step — exactly as `preStep` does.
        const selection = this.current();
        const messages = step === 1 ? claimed : [];
        try {
          const outcome = await this.runStep(turn, step, selection, messages, signal);
          ending = outcome;
        } catch (error) {
          if (signal.aborted) {
            ending = { kind: "aborted", reason: this.abortReason };
          } else {
            ending = { kind: "error", error: { code: error?.code ?? "UNKNOWN", message: String(error?.message ?? error) } };
          }
          throw error;
        }
        if (this.inbox.nextStep.length === 0) break;
      }
    } catch (_error) {
      // Reported by the turn ending below.
    } finally {
      this.plugin.emitSession(this.agent.session, { type: "turn/end", data: { turn, reason: ending ?? { kind: "completed" } } });
    }
    if (!this.hasPending) return false;
    // A fresh controller makes the old latch stale: the live driver claims the
    // queue itself (host `turn()` tail).
    this.abortController = new AbortController();
    this.abortReason = void 0;
    this.wakeRequested = false;
    return true;
  }

  /** One model call, with the host's retry window around it. */
  async runStep(turn, step, selection, messages, signal) {
    const config = await this.plugin.request({ agent: this.agent, turn, step, signal }, { ...selection });
    // The host THROWS when a waterfall proposes a different route.
    if (config.provider !== selection.provider || config.model !== selection.model) {
      throw new Error(`agent "${this.id}": agent/request proposed "${config.provider}/${config.model}" after step preparation fixed "${selection.provider}/${selection.model}"; use agent.model.select() before step preparation`);
    }
    let firstAttempt = true;
    while (true) {
      if (signal.aborted) throw signal.reason;
      this.attempts.push(`${config.provider}/${config.model}`);
      // A prepare-phase failure happens BEFORE the request is committed, so
      // `requestContext()` still names the previous attempt.
      if (typeof this.gateway.prepare === "function") this.gateway.prepare(config);
      // A request that reaches the stream IS committed: the host logs the
      // request context/header before the first byte, even when the stream
      // then fails. Keep the fake on that side of the line.
      this.served = { provider: config.provider, model: config.model };
      const outcome = this.gateway.stream(config, { firstAttempt, messages, signal });
      firstAttempt = false;
      if (outcome.ok) {
        const message = { content: outcome.content, source: { provider: config.provider, model: config.model } };
        this.commits.push({ type: "assistant/message", data: { turn, step, message } });
        this.plugin.emitSession(this.agent.session, { type: "assistant/message", data: { turn, step, message } });
        return { kind: "completed" };
      }
      const action = await this.plugin.requestError({
        agent: this.agent,
        turn,
        step,
        provider: config.provider,
        failure: outcome.failure,
        signal
      }, undefined);
      if (signal.aborted) throw signal.reason;
      // THE POINT: a retry re-enters this loop with the SAME `config`, i.e. the
      // same route. It is not a switch.
      if (action?.kind === "retry") continue;
      throw Object.assign(new Error(outcome.failure?.message ?? "request failed"), { code: outcome.failure?.code ?? "UNKNOWN" });
    }
  }
}

/** Wire the plugin's REAL listeners into a controllable context. */
function pluginHarness(settings) {
  const listeners = new Map();
  const cleanups = [];
  const agents = new Map();
  const warnings = [];
  const ctx = {
    logger: { warn: (...args) => warnings.push(args.map(String).join(" ")), info: () => {} },
    on(name, fn) {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
      return () => {
        const at = list.indexOf(fn);
        if (at >= 0) list.splice(at, 1);
      };
    },
    effect(fn) {
      const off = fn();
      if (typeof off === "function") cleanups.push(off);
    },
    inject() {},
    get(key) {
      if (key === "agents") return { get: (id) => agents.get(id) };
      return void 0;
    }
  };
  apply(ctx, settings);
  const waterfall = (name) => async (payload, value) => {
    const list = listeners.get(name) ?? [];
    const run = (i) => (i === list.length ? Promise.resolve(value) : list[i](payload, () => run(i + 1)));
    return run(0);
  };
  return {
    warnings,
    agents,
    request: waterfall("agent/request"),
    requestError: waterfall("agent/request-error"),
    emitSession(session, event) {
      for (const fn of listeners.get("session/event") ?? []) fn(session, event);
    },
    dispose() {
      for (const fn of cleanups.reverse()) fn();
    }
  };
}

const settings = {
  roleMode: false,
  injectRouteContext: false,
  failoverEnabled: true,
  stallWatchdogEnabled: false,
  roleSlotCooldownSeconds: 0,
  models: [{ provider: "p", model: "a" }, { provider: "q", model: "b" }]
};

test("a real loop: A fails, the child is cut, B answers, and B is what served", async () => {
  const plugin = pluginHarness(settings);
  const gateway = {
    stream(config) {
      if (config.provider === "p" && config.model === "a") {
        return { ok: false, failure: { code: "SERVER", message: "A is down" } };
      }
      return { ok: true, content: [{ type: "text", text: "done on B" }] };
    }
  };
  const loop = new HostLoop({ id: "child-live", route: { provider: "p", model: "a" }, gateway, plugin });
  plugin.agents.set("child-live", loop.agent);

  loop.wakeDriver();
  await loop.driver;

  // Exactly two model calls, in order: the failing A once, then B. A is NOT
  // retried — that is the whole point of cutting instead of answering `retry`.
  assert.deepEqual(loop.attempts, ["p/a", "q/b"], plugin.warnings.join(" | "));
  // The plugin selected B AND cut the attempt AND queued the continuation.
  assert.equal(loop.cancels.length, 1);
  assert.deepEqual(loop.cancels[0].cause, { kind: "hook", reason: "error-switch" });
  assert.deepEqual(loop.cancels[0].options, { keepInbox: true });
  // The success was committed from B, so the durable transcript says B.
  const committed = loop.commits.filter((event) => event.type === "assistant/message");
  assert.equal(committed.length, 1);
  assert.deepEqual(committed[0].data.message.source, { provider: "q", model: "b" });
  assert.equal(plugin.warnings.filter((line) => line.includes("failover handler failed")).length, 0,
    `the plugin must handle its own switch without an internal error: ${plugin.warnings.join(" | ")}`);
  plugin.dispose();
});

test("a real loop: the continuation reaches the model on the new route", async () => {
  const plugin = pluginHarness(settings);
  const served = [];
  const gateway = {
    stream(config, { messages }) {
      served.push({ route: `${config.provider}/${config.model}`, messages });
      if (config.provider === "p" && config.model === "a") {
        return { ok: false, failure: { code: "SERVER", message: "A is down" } };
      }
      return { ok: true, content: [{ type: "text", text: "done on B" }] };
    }
  };
  const loop = new HostLoop({ id: "child-live", route: { provider: "p", model: "a" }, gateway, plugin });
  plugin.agents.set("child-live", loop.agent);
  loop.wakeDriver();
  await loop.driver;
  assert.deepEqual(served.map((entry) => entry.route), ["p/a", "q/b"], plugin.warnings.join(" | "));
  // The continuation is a normal user-role message with this plugin's source,
  // and it is the FIRST thing the new route sees.
  const second = served[1].messages;
  assert.equal(second.length, 1);
  assert.equal(second[0].role, "user");
  assert.equal(second[0].source.kind, "plugin:dsh-subagent-role-router");
  assert.equal(second[0].source.form, "failover-continuation");
  const text = second[0].content.map((part) => part.text).join("");
  assert.match(text, /q\/b/);
  assert.match(text, /继续/);
  plugin.dispose();
});

test("a real loop: a pool where every route fails surfaces the real error after one cut per route", async () => {
  const plugin = pluginHarness(settings);
  const gateway = {
    stream() { return { ok: false, failure: { code: "SERVER", message: "down" } }; }
  };
  const loop = new HostLoop({ id: "child-live", route: { provider: "p", model: "a" }, gateway, plugin });
  plugin.agents.set("child-live", loop.agent);
  loop.wakeDriver();
  await loop.driver;
  // One call per candidate, then the driver gives up: no route is burned twice.
  assert.deepEqual(loop.attempts, ["p/a", "q/b"], plugin.warnings.join(" | "));
  assert.equal(loop.cancels.length, 1, "the second failure has no untried candidate, so it is not cut");
  assert.equal(loop.status, "idle");
  plugin.dispose();
});

test("control: a hook that answers retry serves the failing route again, so retry is not a switch", async () => {
  // The OLD plugin behaviour, reproduced on purpose against the same faithful
  // loop. It proves the reason the current design cuts instead: `retry` re-runs
  // `config`, and `config` was frozen from the step's single selection, so the
  // retried attempt can never land anywhere else.
  const plugin = pluginHarness(settings);
  const gateway = {
    stream(config) {
      if (config.provider === "p" && config.model === "a") {
        return { ok: false, failure: { code: "SERVER", message: "A is down" } };
      }
      return { ok: true, content: [{ type: "text", text: "done on B" }] };
    }
  };
  const loop = new HostLoop({ id: "child-retry", route: { provider: "p", model: "a" }, gateway, plugin });
  plugin.agents.set("child-retry", loop.agent);
  // A hook that only selects and asks for a retry — the design this test exists
  // to rule out. Bounded to one retry, the way the real retry policy's budget is.
  let retries = 0;
  loop.plugin = {
    request: async (payload, seed) => seed,
    requestError: async () => {
      loop.agent.model.select({ provider: "q", model: "b" });
      retries += 1;
      return retries === 1 ? { kind: "retry" } : void 0;
    },
    emitSession() {}
  };
  loop.wakeDriver();
  await loop.driver;
  // A is SERVED TWICE even though the selection moved to B: the frozen config
  // is reused by the retry, and the turn finally ends in error.
  assert.deepEqual(loop.attempts, ["p/a", "p/a"]);
  plugin.dispose();
});

test("shouldFailover keeps a user stop out of the automatic path", () => {
  for (const code of ["ABORTED", "CANCELED", "CANCELLED", "USER_ABORT", "USER_CANCEL", "INTERRUPTED", "DISPOSED"]) {
    assert.equal(shouldFailover({ code }), false, `${code} must never switch`);
    assert.equal(shouldFailover({ code: code.toLowerCase() }), false, `${code} must not depend on spelling`);
  }
  assert.equal(shouldFailover({ code: "SERVER" }), true);
  assert.equal(shouldFailover({ code: "INVALID_REQUEST", message: "The request could not be completed." }), true);
});

// ── 3. the recovery ledger: bounded, cooling-aware, generation-checked ───────

const route = (provider, model) => ({ provider, model });

test("a route cooled by the plugin-wide table is actually seen as cooling", () => {
  // Regression: `coolingRemaining` used a NUL-separated key while
  // `noteCooldown` writes `provider/model` (slash). The look-up never matched,
  // so the picker re-chose a route the plugin had just cooled.
  const state = { cooldowns: new Map([["q/b", Date.now() + 60_000]]) };
  const view = { entries: [route("p", "a"), route("q", "b")] };
  assert.ok(coolingRemaining(state, view, route("q", "b"), undefined) > 0);
  assert.equal(coolingRemaining(state, view, route("p", "a"), undefined), 0);
  // The picker wired to that probe skips B for C even when B comes first.
  const picked = pickCandidate({
    entries: [route("p", "a"), route("q", "b"), route("r", "c")],
    strategy: "round-robin",
    failedRoute: route("p", "a"),
    triedKeys: new Set([routeKeyOf(route("p", "a"))]),
    cooling: (candidate) => coolingRemaining(state, view, candidate, undefined)
  });
  assert.equal(picked.route.model, "c", "B is cooling, so the ready untried C is selected");
});

test("candidates are bounded by the routes that actually failed", () => {
  const entries = [route("p", "a"), route("q", "b"), route("r", "c")];
  const first = pickCandidate({
    entries,
    strategy: "round-robin",
    failedRoute: route("p", "a"),
    triedKeys: new Set()
  });
  assert.equal(first.route.model, "b");
  // A failed, then B failed: only C remains.
  const second = pickCandidate({
    entries,
    strategy: "round-robin",
    failedRoute: route("q", "b"),
    triedKeys: new Set([routeKeyOf(route("p", "a")), routeKeyOf(route("q", "b"))])
  });
  assert.equal(second.route.model, "c");
  // All three failed: no candidate, so the caller surfaces the real error.
  const third = pickCandidate({
    entries,
    strategy: "round-robin",
    failedRoute: route("r", "c"),
    triedKeys: new Set(entries.map(routeKeyOf))
  });
  assert.equal(third, void 0, "a fully failed episode must not retry a known-dead route");
});

test("a route that is not in the pool starts the queue at entry 0", () => {
  const picked = pickCandidate({
    entries: [route("p", "a"), route("q", "b")],
    strategy: "round-robin",
    failedRoute: route("other", "inherited"),
    triedKeys: new Set()
  });
  assert.equal(picked.route.model, "a");
});

test("cooling routes are skipped while a ready untried route exists", () => {
  const entries = [route("p", "a"), route("q", "b"), route("r", "c")];
  const picked = pickCandidate({
    entries,
    strategy: "round-robin",
    failedRoute: route("p", "a"),
    triedKeys: new Set([routeKeyOf(route("p", "a"))]),
    cooling: (candidate) => (candidate.model === "b" ? 60_000 : 0)
  });
  assert.equal(picked.route.model, "c", "B is resting, C is ready and untried");
  // If every remaining route is cooling, a degraded route still beats stopping.
  const degraded = pickCandidate({
    entries,
    strategy: "round-robin",
    failedRoute: route("p", "a"),
    triedKeys: new Set([routeKeyOf(route("p", "a"))]),
    cooling: () => 60_000
  });
  assert.equal(degraded.route.model, "b");
});

test("a failed generation rejects late callbacks; a real success clears the episode", () => {
  const state = {};
  const first = episodeOf(state, "child-x").generation;
  assert.equal(canSwitch(state, "child-x", first), true);
  markCancelled(state, "child-x");
  assert.equal(canSwitch(state, "child-x", first), false, "a user stop invalidates the captured generation");
  assert.equal(noteFailure(state, "child-x", first, route("p", "a")), false, "a stale failure must not mutate the ledger");
  assert.equal(noteSwitch(state, "child-x", first), false);

  const fresh = episodeOf(state, "child-y");
  assert.equal(noteFailure(state, "child-y", fresh.generation, route("p", "a")), true);
  noteRealSuccess(state, "child-y", route("q", "b"));
  assert.equal(episodeOf(state, "child-y").failed.size, 0, "only a real assistant message resets the episode");
  assert.equal(canSwitch(state, "child-y", fresh.generation), true);

  markDisposed(state, "child-y");
  assert.equal(canSwitch(state, "child-y", fresh.generation), false, "disposal invalidates the captured generation");
  assert.equal(noteFailure(state, "child-y", fresh.generation, route("q", "b")), false);
});

test("switchNow cuts and resumes in one synchronous window", async () => {
  const order = [];
  let yielded = false;
  let followupBeforeYield = false;
  const agent = {
    status: "running",
    model: {
      select(selection) {
        order.push(`select:${selection.model}`);
        // The host's select appends to the session; a microtask is the first
        // possible yield. The followup must already be queued by then.
        queueMicrotask(() => { yielded = true; });
      }
    },
    cancel(cause, options) { order.push(`cancel:${cause.kind}`); },
    followup() {
      followupBeforeYield = !yielded;
      order.push("followup");
    }
  };
  const outcome = switchNow(agent, {
    target: route("q", "b"),
    continuation: { role: "user", content: [] },
    reason: "recovery-test"
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(order, ["select:b", "cancel:hook", "followup"]);
  assert.equal(followupBeforeYield, true, "there must be no await gap between cancel and followup");
  // And it must be synchronous end-to-end: the microtask has not run yet.
  assert.equal(yielded, false);
  await Promise.resolve();
  let cancelOptions;
  const second = {
    status: "running",
    model: { select() {} },
    cancel(_cause, options) { cancelOptions = options; },
    followup() {}
  };
  assert.equal(switchNow(second, { target: route("q", "b"), continuation: { role: "user" } }).ok, true);
  assert.deepEqual(cancelOptions, { keepInbox: true });
});

test("resumeNow refuses a non-idle child and can never cancel live work", () => {
  let cancelled = false;
  const busy = {
    status: "running",
    model: { select() {} },
    cancel() { cancelled = true; },
    followup() {}
  };
  const refused = resumeNow(busy, { target: route("q", "b"), continuation: { role: "user" } });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "not-idle");
  assert.equal(cancelled, false, "a deferred prepare recovery must not cut an unrelated live turn");
});

test("prepare-failure classification is narrow: config only, never a content bug", () => {
  assert.equal(isPrepareConfigFailure({ code: "NO_ADAPTER", message: "no adapter" }), true);
  assert.equal(isPrepareConfigFailure({ code: "UNKNOWN", message: "provider has no configured model" }), true);
  assert.equal(isPrepareConfigFailure({ code: "INVALID_REQUEST", message: "model [x] is not allowed for user type [free]" }), true);
  assert.equal(isPrepareConfigFailure({ code: "INVALID_REQUEST", message: "messages[3].content: expected string" }), false);
  assert.equal(isPrepareConfigFailure({ code: "SERVER", message: "upstream 502" }), false);
  assert.equal(isPrepareConfigFailure(void 0), false);
});

// ── 4. a prepare-call failure is recovered through the durable turn ending ────

/** Wait for the loop's own driver plus any followup-started driver to settle. */
async function settle(loop) {
  for (let round = 0; round < 6; round += 1) {
    const current = loop.driver;
    if (current === void 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (loop.driver === void 0) return;
      continue;
    }
    await current;
    if (loop.driver === current) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (loop.driver === void 0) return;
  }
}

test("a real loop: a known prepare failure resumes on the next candidate after idle", async () => {
  const plugin = pluginHarness(settings);
  const gateway = {
    prepare(config) {
      if (config.provider === "p" && config.model === "a") {
        // Prepare-phase failure: no request-error waterfall is reached at all.
        throw Object.assign(new Error('provider has no configured model for "p"'), { code: "UNKNOWN" });
      }
    },
    stream() {
      return { ok: true, content: [{ type: "text", text: "done on B" }] };
    }
  };
  const loop = new HostLoop({ id: "child-prepare", route: { provider: "p", model: "a" }, gateway, plugin });
  plugin.agents.set("child-prepare", loop.agent);
  loop.wakeDriver();
  await settle(loop);

  assert.deepEqual(loop.attempts, ["p/a", "q/b"]);
  assert.equal(loop.cancels.length, 0, "the failed turn is already over; there is nothing to cut");
  assert.equal(loop.followups.length, 1);
  assert.equal(loop.followups[0].source.form, "failover-continuation");
  const committed = loop.commits.filter((event) => event.type === "assistant/message");
  assert.equal(committed.length, 1);
  assert.deepEqual(committed[0].data.message.source, { provider: "q", model: "b" });
  plugin.dispose();
});

test("a real loop: a prepare failure after a switch blames the NEW selection, not the last served route", async () => {
  const plugin = pluginHarness({ ...settings, models: [{ provider: "p", model: "a" }, { provider: "q", model: "b" }, { provider: "r", model: "c" }] });
  const gateway = {
    prepare(config) {
      if (config.provider === "q" && config.model === "b") {
        // Prepare-phase failure on the model the failover just selected. It
        // happens before B's request context is committed, so the session still
        // reads A as its last served route.
        throw Object.assign(new Error("provider has no configured model"), { code: "UNKNOWN" });
      }
    },
    stream(config) {
      if (config.provider === "p" && config.model === "a") {
        return { ok: false, failure: { code: "SERVER", message: "A is down" } };
      }
      return { ok: true, content: [{ type: "text", text: "done on C" }] };
    }
  };
  const loop = new HostLoop({ id: "child-chain", route: { provider: "p", model: "a" }, gateway, plugin });
  plugin.agents.set("child-chain", loop.agent);
  loop.wakeDriver();
  await settle(loop);
  // `requestContext()` still says A (the last COMMITTED request). The failed
  // prepare belonged to B, the step's frozen selection. Marking A again would
  // select B a second time and burn the run.
  assert.deepEqual(loop.attempts, ["p/a", "q/b", "r/c"]);
  assert.equal(loop.cancels.length, 1, "only the A->B failure cut an in-flight attempt");
  assert.equal(loop.followups.length, 2, "A->B and B->C both resumed the same task");
  const committed = loop.commits.filter((event) => event.type === "assistant/message");
  assert.deepEqual(committed.at(-1).data.message.source, { provider: "r", model: "c" });
  plugin.dispose();
});

test("a real loop: an unknown terminal error is not recovered", async () => {
  const plugin = pluginHarness(settings);
  const gateway = {
    stream() { throw Object.assign(new Error("boom"), { code: "UNKNOWN" }); }
  };
  const loop = new HostLoop({ id: "child-unknown", route: { provider: "p", model: "a" }, gateway, plugin });
  plugin.agents.set("child-unknown", loop.agent);
  loop.wakeDriver();
  await settle(loop);
  assert.deepEqual(loop.attempts, ["p/a"]);
  assert.equal(loop.followups.length, 0);
  assert.equal(loop.status, "idle");
  plugin.dispose();
});

// ── 5. ownership: one-lane roles never escape, exemptions/teams stay out ──────

/**
 * Minimal spawn service: records the spec and returns a settled receipt so the
 * plugin's wrapper can stamp the child's role, exactly like the real host.
 */
function spawnHarness(overrides = {}) {
  const listeners = new Map();
  const cleanups = [];
  const seen = [];
  const agents = new Map();
  const warns = [];
  let seq = 0;
  const parent = { session: { snapshotEvents: () => [] }, options: { provider: "parent", model: "parent" } };
  const raw = {
    startActivation(spec) {
      seen.push(spec);
      const childId = `child-${++seq}`;
      return { childId, result: Promise.resolve({ status: "ok" }), dispose() {} };
    }
  };
  const ctx = {
    subagents: raw,
    logger: { warn: (...args) => warns.push(args.map(String).join(" ")) },
    on(name, fn) {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
      return () => {
        const at = list.indexOf(fn);
        if (at >= 0) list.splice(at, 1);
      };
    },
    effect(fn) {
      const off = fn();
      if (typeof off === "function") cleanups.push(off);
    },
    inject(names, fn) { if (names.includes("subagents")) fn(ctx); },
    get(key) {
      if (key === "agents") return { get: (id) => agents.get(id) };
      return void 0;
    }
  };
  apply(ctx, {
    roleMode: true,
    injectRouteContext: false,
    failoverEnabled: true,
    roleSlotCooldownSeconds: 0,
    models: [{ provider: "base", model: "base-a" }, { provider: "base", model: "base-b" }],
    ...overrides
  });
  return {
    raw, seen, warns, agents, parent,
    waterfall: async (name, payload, value) => {
      const list = listeners.get(name) ?? [];
      const run = (i) => (i === list.length ? Promise.resolve(value) : list[i](payload, () => run(i + 1)));
      return run(0);
    },
    dispose() { for (const fn of cleanups.reverse()) fn(); }
  };
}

function liveSpawnedChild(h, id, label, served, { withModelSelect = false } = {}) {
  const agent = {
    id,
    status: "running",
    session: {
      id,
      header: { origin: "subagent", label, parentSession: "parent-1" },
      requestContext: () => ({ provider: served.provider, model: served.model, contextWindow: 1000 }),
      requestHeader: () => ({ config: { ...served } }),
      snapshotEvents: () => []
    },
    cancel() { throw new Error("must not cancel"); },
    followup() { throw new Error("must not resume"); },
    options: { provider: "parent", model: "parent" }
  };
  if (withModelSelect) {
    agent.selects = [];
    agent.model = { select(selection) { agent.selects.push(selection); } };
    agent.cancel = function (cause, options) { this.cancels = (this.cancels ?? []).concat([{ cause, options }]); };
    agent.followup = function (message) { this.followups = (this.followups ?? []).concat([message]); };
  }
  h.agents.set(id, agent);
  return agent;
}

test("a role narrowed to ONE candidate never escapes onto the base pool", async () => {
  const h = spawnHarness({ patchModels: [{ provider: "p", model: "m1" }] });
  const receipt = await h.raw.startActivation({ provider: "spawn", label: "general task", request: { parent: h.parent, prompt: "work" } });
  assert.ok(receipt.childId, "the wrapper must return a receipt");
  const agent = liveSpawnedChild(h, receipt.childId, "general task", { provider: "p", model: "m1" });
  const sentinel = { kind: "surface" };
  const outcome = await h.waterfall("agent/request-error", { agent, turn: 1, step: 1, failure: { code: "TIMEOUT" } }, sentinel);
  assert.equal(outcome, sentinel, "one lane means no automatic switch");
  assert.equal(agent.cancels, void 0, "the base pool must not be borrowed");
  assert.equal(h.seen[0].request.agentOptions.model, "m1", "birth route stands; no escape at failover either");
  h.dispose();
});

test("the same role with TWO candidates switches inside its own pool", async () => {
  const h = spawnHarness({ patchModels: [{ provider: "p", model: "m1" }, { provider: "p", model: "m2" }] });
  const receipt = await h.raw.startActivation({ provider: "spawn", label: "general task", request: { parent: h.parent, prompt: "work" } });
  const agent = liveSpawnedChild(h, receipt.childId, "general task", { provider: "p", model: "m1" }, { withModelSelect: true });
  const outcome = await h.waterfall("agent/request-error", { agent, turn: 1, step: 1, failure: { code: "TIMEOUT" } }, undefined);
  assert.equal(outcome, undefined);
  assert.deepEqual(agent.selects, [{ provider: "p", model: "m2" }]);
  assert.equal(agent.followups.length, 1);
  h.dispose();
});

test("an exempt child and an agent-teams member never enter automatic failover", async () => {
  const exempt = spawnHarness({ exemptRules: [{ name: "goldfish", match: "label", pattern: "egm-goldfish" }] });
  const exemptChild = liveSpawnedChild(exempt, "exempt-1", "egm-goldfish-logic", { provider: "p", model: "m1" }, { withModelSelect: true });
  const sentinel = { kind: "surface" };
  assert.equal(await exempt.waterfall("agent/request-error", { agent: exemptChild, failure: { code: "TIMEOUT" } }, sentinel), sentinel);
  assert.equal(exemptChild.selects.length, 0);
  exempt.dispose();

  const team = spawnHarness();
  const member = liveSpawnedChild(team, "member-1", "agent-teams:team:member", { provider: "p", model: "m1" }, { withModelSelect: true });
  assert.equal(await team.waterfall("agent/request-error", { agent: member, failure: { code: "TIMEOUT" } }, sentinel), sentinel);
  assert.equal(member.selects.length, 0, "automatic failover stays outside agent-teams");
  team.dispose();
});

