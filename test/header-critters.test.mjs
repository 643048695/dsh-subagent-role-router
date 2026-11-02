import test from "node:test";
import assert from "node:assert/strict";
import { isLoopbackRequest, listActiveChildren } from "../lib/index.js";

// The header critters read ONE in-memory ledger. Everything that can go wrong
// there is invisible in the browser — a wrong filter shows another session's
// children, a broken TTL leaves a critter typing forever — so the pure part is
// locked down here instead.

const NOW = 1_800_000_000_000;

function entry(overrides) {
	return {
		childId: "child-1",
		parentSessionId: "session-parent-a",
		label: "explore",
		role: "explore",
		provider: "magpie",
		model: "group/dnq",
		startedAt: NOW - 5_000,
		...overrides
	};
}

function stateOf(...rows) {
	const activity = new Map();
	for (const row of rows) activity.set(row.childId, row);
	return { activity };
}

test("filters to one parent session", () => {
	const state = stateOf(
		entry({ childId: "a1" }),
		entry({ childId: "a2" }),
		entry({ childId: "b1", parentSessionId: "session-parent-b" })
	);
	const mine = listActiveChildren(state, "session-parent-a", NOW);
	assert.deepEqual(mine.map((row) => row.childId).sort(), ["a1", "a2"]);
});

test("matches both id spellings the host uses", () => {
	const prefixed = stateOf(entry({ childId: "c1", parentSessionId: "session-abc" }));
	assert.deepEqual(listActiveChildren(prefixed, "abc", NOW).map((row) => row.childId), ["c1"]);

	const bare = stateOf(entry({ childId: "c2", parentSessionId: "abc" }));
	assert.deepEqual(listActiveChildren(bare, "session-abc", NOW).map((row) => row.childId), ["c2"]);
});

test("one child is one row, even if it is written twice", () => {
	const state = stateOf(entry({ childId: "dup" }));
	state.activity.set("dup", entry({ childId: "dup", startedAt: NOW - 1_000 }));
	const rows = listActiveChildren(state, "session-parent-a", NOW);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].startedAt, NOW - 1_000);
});

test("entries with no known parent stay private to the unfiltered listing", () => {
	const state = stateOf(entry({ childId: "orphan", parentSessionId: null }));
	assert.deepEqual(listActiveChildren(state, "session-parent-a", NOW).map((row) => row.childId), [],
		"a stranger row must never show up in someone else's header");
	assert.deepEqual(listActiveChildren(state, undefined, NOW).map((row) => row.childId), ["orphan"],
		"the unfiltered listing (no parent asked) still sees it");
});

test("an entry older than the TTL is marked stale", () => {
	const state = stateOf(
		entry({ childId: "fresh", startedAt: NOW - 60_000 }),
		entry({ childId: "stuck", startedAt: NOW - 7 * 60 * 60 * 1000 })
	);
	const rows = listActiveChildren(state, "session-parent-a", NOW);
	assert.equal(rows.find((row) => row.childId === "fresh").stale, false);
	assert.equal(rows.find((row) => row.childId === "stuck").stale, true);
	assert.equal(rows.filter((row) => !row.stale).length, 1);
});

test("rows come back in start order, with an age", () => {
	const state = stateOf(
		entry({ childId: "later", startedAt: NOW - 1_000 }),
		entry({ childId: "earlier", startedAt: NOW - 9_000 })
	);
	const rows = listActiveChildren(state, "session-parent-a", NOW);
	assert.deepEqual(rows.map((row) => row.childId), ["earlier", "later"]);
	assert.equal(rows[0].ageMs, 9_000);
});

test("a missing ledger is an empty list, not a crash", () => {
	assert.deepEqual(listActiveChildren({}, "session-parent-a", NOW), []);
});

// The activity route is the only new surface that answers HTTP. It leaks who is
// running, so the loopback guard is asserted here rather than assumed: a curl
// from this machine always arrives from 127.0.0.1 and can never fail the check.
test("only loopback sockets reach the activity route", () => {
	assert.equal(isLoopbackRequest({ socket: { remoteAddress: "127.0.0.1" } }), true);
	assert.equal(isLoopbackRequest({ socket: { remoteAddress: "::1" } }), true);
	assert.equal(isLoopbackRequest({ socket: { remoteAddress: "::ffff:127.0.0.1" } }), true);
	assert.equal(isLoopbackRequest({ socket: { remoteAddress: "192.168.1.20" } }), false);
	assert.equal(isLoopbackRequest({ socket: { remoteAddress: "10.0.0.5" } }), false);
	assert.equal(isLoopbackRequest({}), false);
	assert.equal(isLoopbackRequest(undefined), false);
});
