import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  createRouteController,
  flushBirthSeen,
  isExemptAgent,
  isTeamAgent,
  noteBirthSeen,
  pruneStaleActivity,
  setBirthSeenPath
} from "../lib/index.js";

// The header's "running subagents" count comes from an in-memory ledger. Two
// things used to make it lie and make every poll expensive: a finished child
// was only filtered, never removed (so it rode along in every response), and
// the ledger had no upper bound. These pin the cleanup rules.
function entry(childId, ageMs, parentSessionId = "session-parent") {
  return {
    childId,
    parentSessionId,
    label: "worker",
    role: "explore",
    provider: "magpie",
    model: "group/dnq",
    startedAt: Date.now() - ageMs
  };
}

test("a stale activity row is removed from the ledger in both id spellings", () => {
  const activity = new Map();
  activity.set("session-old", entry("session-old", 7 * 60 * 60 * 1000));
  activity.set("old", entry("session-old", 7 * 60 * 60 * 1000));
  activity.set("session-fresh", entry("session-fresh", 1000));
  const state = { activity };

  const rows = [
    { childId: "session-old", stale: true },
    { childId: "session-fresh", stale: false }
  ];
  const fresh = pruneStaleActivity(state, rows);

  assert.deepEqual(fresh.map((row) => row.childId), ["session-fresh"]);
  assert.equal(activity.has("session-old"), false, "the prefixed spelling must be gone");
  assert.equal(activity.has("old"), false, "the bare spelling must be gone");
  assert.equal(activity.has("session-fresh"), true, "a live child must survive pruning");
});

test("pruning is idempotent and tolerates a missing ledger", () => {
  const state = { activity: new Map() };
  assert.deepEqual(pruneStaleActivity(state, []), []);
  assert.deepEqual(pruneStaleActivity(state, [{ childId: "session-gone", stale: true }]), []);
  assert.equal(state.activity.size, 0);
  assert.deepEqual(pruneStaleActivity({}, [{ childId: "session-x", stale: false }]).length, 1);
});

// ── identity reads in a long session ─────────────────────────────────────────

function sessionWithEvents(events, boundary) {
  let scans = 0;
  const session = {
    header: { origin: "subagent" },
    inheritedEventCount: boundary,
    snapshotEvents() {
      scans += 1;
      return events;
    }
  };
  return { session, scans: () => scans };
}

test("birth identity is read once per session, from the child's own descriptor only", () => {
  const events = [
    { type: "subagent/descriptor", data: { label: "inherited-team", persona: "AgentTeams" } },
    { type: "user/message" },
    { type: "subagent/descriptor", data: { label: "egm-goldfish-runtime", persona: "AgentTeams" } }
  ];
  const { session, scans } = sessionWithEvents(events, 1);
  const agent = { session };
  const state = { getSection: () => ({ exemptRules: [{ match: "label", pattern: "egm-goldfish-" }] }) };

  assert.equal(isTeamAgent(agent), true, "the inherited descriptor is not trusted");
  assert.equal(isExemptAgent(state, agent), true, "the same projected label serves the exemption rule");
  for (let i = 0; i < 12; i += 1) {
    assert.equal(isTeamAgent(agent), true);
    assert.equal(isExemptAgent(state, agent), true);
  }
  assert.equal(scans(), 1, "repeated identity checks do not re-scan the session log");

  // A descriptor that lands later invalidates the cache; a negative "no own
  // descriptor yet" result is deliberately never cached.
  const laterEvents = [{ type: "user/message" }];
  const later = sessionWithEvents(laterEvents, 0);
  const laterAgent = { session: later.session };
  assert.equal(isTeamAgent(laterAgent), false);
  assert.equal(isTeamAgent(laterAgent), false);
  assert.equal(later.scans(), 1, "an unchanged no-descriptor tail costs no rescan");
  laterEvents.push({ type: "subagent/descriptor", data: { label: "late", persona: "agent-teams" } });
  assert.equal(isTeamAgent(laterAgent), true);
  assert.equal(later.scans(), 2, "only the new tail is folded when the descriptor lands");
});

test("seq-backed identity folds only new events in a long session", () => {
  const events = Array.from({ length: 10000 }, (_, index) => ({
    seq: index,
    type: index === 2 ? "subagent/descriptor" : "turn/start",
    data: index === 2 ? { label: "egm-original", persona: "AgentTeams" } : {}
  }));
  // An inherited descriptor before the boundary must never be projected.
  events.unshift({ seq: -1, type: "subagent/descriptor", data: { label: "inherited", persona: "AgentTeams" } });
  let eventAtCalls = 0;
  let snapshotCalls = 0;
  const session = {
    header: { origin: "subagent" },
    inheritedEventCount: 1,
    seq: 9999,
    eventAt(seq) {
      eventAtCalls += 1;
      return events[seq + 1];
    },
    snapshotEvents() {
      snapshotCalls += 1;
      return events;
    }
  };
  const agent = { session };
  const state = {
    getSection: () => ({ exemptRules: [
      { match: "label", pattern: "egm-" },
      { match: "label", pattern: "egm-new-" }
    ] })
  };

  assert.equal(isTeamAgent(agent), true, "the inherited descriptor is excluded");
  assert.equal(isExemptAgent(state, agent), true);
  assert.equal(snapshotCalls, 0, "seq mode never asks for the log snapshot");
  const coldReads = eventAtCalls;
  assert.ok(coldReads > 0 && coldReads < events.length, "cold projection folds forward from the boundary");

  const idle = eventAtCalls;
  for (let i = 0; i < 10; i += 1) {
    assert.equal(isTeamAgent(agent), true);
    assert.equal(isExemptAgent(state, agent), true);
  }
  assert.equal(eventAtCalls, idle, "an unchanged seq costs no event reads");

  let before = eventAtCalls;
  for (let i = 0; i < 20; i += 1) {
    const nextSeq = session.seq + 1;
    events.push({ seq: nextSeq, type: "turn/start", data: {} });
    session.seq = nextSeq;
    assert.equal(isTeamAgent(agent), true);
  }
  assert.equal(eventAtCalls - before, 20, "20 ordinary appends cost exactly 20 tail reads, not 20 x 10000");

  before = eventAtCalls;
  const nextSeq = session.seq + 1;
  events.push({ seq: nextSeq, type: "subagent/descriptor", data: { label: "egm-new-runtime", persona: "" } });
  session.seq = nextSeq;
  assert.equal(isExemptAgent(state, agent), true, "the newer descriptor updates the label");
  assert.equal(isTeamAgent(agent), false, "the newer descriptor's empty persona is authoritative");
  assert.equal(eventAtCalls - before, 1, "the new descriptor is folded once");
});

test("a seq-backed session with no descriptor yet catches the birth event later", () => {
  const events = [{ seq: 0, type: "turn/start", data: {} }];
  let reads = 0;
  const session = {
    header: { origin: "subagent" },
    inheritedEventCount: 0,
    seq: 0,
    eventAt(seq) {
      reads += 1;
      return events[seq];
    }
  };
  const agent = { session };
  assert.equal(isTeamAgent(agent), false);
  assert.equal(isTeamAgent(agent), false);
  assert.equal(reads, 1, "the no-descriptor tail cursor is not re-scanned");
  events.push({ seq: 1, type: "subagent/descriptor", data: { label: "late", persona: "agent-teams" } });
  session.seq = 1;
  assert.equal(isTeamAgent(agent), true);
  assert.equal(reads, 2, "only the newly appended descriptor is read");
});

// ── birth observation writes ─────────────────────────────────────────────────

test("a spawn burst coalesces into one atomic write and never blocks dispatch", async () => {
  const path = join(tmpdir(), `srr-birth-coalesce-${process.pid}.json`);
  setBirthSeenPath(path);
  const writeFiles = [];
  const syncWrites = [];
  const originalWrite = fs.promises.writeFile;
  const originalSync = fs.writeFileSync;
  fs.promises.writeFile = async (...args) => {
    writeFiles.push(String(args[0]));
    return originalWrite.apply(fs.promises, args);
  };
  fs.writeFileSync = (...args) => {
    syncWrites.push(String(args[0]));
    return originalSync.apply(fs, args);
  };
  try {
    for (let i = 0; i < 20; i += 1) noteBirthSeen({ label: `spawn-${i}` }, {});
    assert.equal(syncWrites.length, 0, "noteBirthSeen must not write on the dispatch path");
    assert.equal(writeFiles.length, 0, "spawns coalesce behind a debounced flush");

    await flushBirthSeen();
    assert.equal(writeFiles.length, 1, "20 notes become one temp-file write");
    assert.match(writeFiles[0], /\.tmp-\d+-[0-9a-f-]+$/i, "the write targets a private temp file for rename");
    const rows = JSON.parse(fs.readFileSync(path, "utf8"));
    assert.equal(rows.filter((row) => row.kind === "label" && row.value.startsWith("spawn-")).length, 20);

    noteBirthSeen({ label: "last-spawn" }, {});
    await flushBirthSeen();
    const after = JSON.parse(fs.readFileSync(path, "utf8"));
    assert.ok(after.some((row) => row.value === "last-spawn"), "the last update survives");
    assert.equal(writeFiles.length, 2);

    await flushBirthSeen();
    assert.equal(writeFiles.length, 2, "an idle flush has no dirty work and writes nothing");

    // A path change cannot redirect a queued write to the newer file.
    const other = join(tmpdir(), `srr-birth-other-${process.pid}.json`);
    setBirthSeenPath(other);
    noteBirthSeen({ label: "other-path" }, {});
    await flushBirthSeen();
    assert.ok(writeFiles.some((name) => name.startsWith(path + ".tmp-")), "the first path keeps its own write");
    assert.ok(writeFiles.some((name) => name.startsWith(other + ".tmp-")), "the new path gets a separate write");
    const leftovers = fs.readdirSync(dirname(path)).filter((name) =>
      name.startsWith(basename(path) + ".tmp-") || name.startsWith(basename(other) + ".tmp-"));
    assert.deepEqual(leftovers, [], "atomic rename leaves no temp files behind");
  } finally {
    fs.promises.writeFile = originalWrite;
    fs.writeFileSync = originalSync;
    await flushBirthSeen();
  }
});

// ── cold catalog fan-in ──────────────────────────────────────────────────────

test("concurrent cold catalog reads share one provider/model walk", async () => {
  const infoCalls = [];
  const listCalls = [];
  const llm = {
    async listModels(provider) {
      listCalls.push(provider);
      return [{ id: "a", name: "Alpha" }, { id: "b", name: "Bravo" }];
    },
    async resolveModelInfo(provider, model) {
      infoCalls.push(`${provider}/${model}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { reasoning: { efforts: [{ id: "low", name: "Low" }] } };
    }
  };
  const ctx = { get: (name) => (name === "llm" ? llm : void 0), logger: { warn() {}, info() {} } };
  const config = { models: [{ provider: "p", model: "a" }, { provider: "p", model: "b" }] };
  const state = {
    getSection: () => config,
    childRoutes: new Map(),
    routeRevisions: new Map(),
    routeEpoch: "test",
    modelCaps: null
  };
  const controller = createRouteController(ctx, state);
  const catalogs = await Promise.all([controller.catalog(), controller.catalog(), controller.catalog()]);
  assert.equal(catalogs.length, 3);
  assert.deepEqual(infoCalls.sort(), ["p/a", "p/b"], "three cold callers trigger one resolve per model");
  assert.deepEqual(listCalls, ["p"], "the provider list is fetched once as well");
  assert.deepEqual((await controller.catalog()).map((row) => row.model), ["a", "b"]);
  assert.equal(infoCalls.length, 2, "the completed cache serves the next read");
});
