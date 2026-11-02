import assert from "node:assert/strict";
import test from "node:test";

import { pruneStaleActivity } from "../lib/index.js";

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
