import test from "node:test";
import assert from "node:assert/strict";
import { apply, listActiveChildren, pruneStaleActivity } from "../lib/index.js";

// End-to-end over the plugin's OWN HTTP surface: a spawn goes in through the
// subagents service, and what the header critters will poll comes out of the
// activity route. The wrapper/ledger/route seam is exactly where the first
// design draft was wrong (it hung the ledger off `lease`, which only exists for
// pooled delegations), so it is worth driving for real instead of unit-testing
// the pure filter alone.

const config = {
	roleMode: false,
	injectRouteContext: false,
	failoverEnabled: false,
	models: []
};

function harness(settings = config) {
	const listeners = new Map();
	const cleanups = [];
	const routes = [];

	const emit = (name, payload) => {
		for (const fn of listeners.get(name) ?? []) fn(payload);
	};

	const agents = new Map();
	let spawned = 0;
	const subagents = {
		startActivation(spec) {
			const n = ++spawned;
			const childId = n === 1 ? "child-abc" : `child-${n}`;
			return { childId, result: new Promise(() => {}) };
		}
	};

	const ctx = {
		logger: { warn: () => {}, info: () => {} },
		subagents,
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
		inject(names, fn) {
			if (names.includes("webServer")) {
				fn({
					logger: ctx.logger,
					effect(register) {
						const off = register();
						if (typeof off === "function") cleanups.push(off);
					},
					webServer: {
						register(route) {
							routes.push(route);
							return () => {
								const at = routes.indexOf(route);
								if (at >= 0) routes.splice(at, 1);
							};
						}
					}
				});
			}
			if (names.includes("subagents")) {
				fn({ ...ctx, subagents });
			}
		},
		get(name) {
			// The activity ledger asks the host's own registry whether a row is
			// still a live resident child; ages alone must never decide that.
			if (name === "agents") return { get: (id) => agents.get(id) };
			return undefined;
		}
	};

	apply(ctx, settings);

	/** Call the plugin's route handler the way the web server would. */
	async function get(path) {
		const route = routes.find((entry) => path.startsWith(entry.path));
		assert.ok(route, `no route registered for ${path}`);
		const captured = { status: 0, body: null };
		const res = {
			writeHead(status) {
				captured.status = status;
			},
			end(body) {
				captured.body = JSON.parse(body);
			}
		};
		await route.handler(
			{ method: "GET", url: path, socket: { remoteAddress: "127.0.0.1" } },
			res
		);
		return captured;
	}

	/** Spawn through the wrapped surface the way the host does. */
	function spawnSelf(request) {
		return subagents.startActivation({ provider: "spawn", label: request.label, request });
	}

	return { ctx, subagents, agents, routes, emit, get, spawn: spawnSelf, cleanups };
}

test("a spawn reaches the activity route without a lane lease", async () => {
	const h = harness();

	h.spawn({ prompt: "look around", label: "explore", parent: { id: "session-p1" } });

	const mine = await h.get("/subagent-role-router/activity?parentSessionId=session-p1");
	assert.equal(mine.status, 200);
	assert.equal(mine.body.ok, true);
	assert.equal(mine.body.value.count, 1);
	assert.deepEqual(mine.body.value.active.map((row) => row.childId), ["child-abc"]);
	assert.equal(mine.body.value.active[0].label, "explore");
	assert.equal(typeof mine.body.value.active[0].ageMs, "number");

	const other = await h.get("/subagent-role-router/activity?parentSessionId=session-p2");
	assert.equal(other.body.value.count, 0);
	for (const cleanup of h.cleanups) cleanup();
});

test("disposal removes the child from the route", async () => {
	const h = harness();

	h.spawn({ prompt: "look around", label: "explore", parent: { id: "session-p1" } });
	assert.equal((await h.get("/subagent-role-router/activity?parentSessionId=session-p1")).body.value.count, 1);

	h.emit("agent/disposed", { agent: { id: "child-abc" } });

	assert.equal((await h.get("/subagent-role-router/activity?parentSessionId=session-p1")).body.value.count, 0);
	for (const cleanup of h.cleanups) cleanup();
});

test("an unfinished spawn is not left behind when the route answers without a filter", async () => {
	const h = harness();

	h.spawn({ prompt: "look around", label: "explore", parent: { id: "session-p1" } });

	const all = await h.get("/subagent-role-router/activity");
	assert.equal(all.body.ok, true);
	assert.equal(all.body.value.count, 1);
	for (const cleanup of h.cleanups) cleanup();
});

test("teardown unregisters the route and clears the ledger", async () => {
	const h = harness();

	h.spawn({ prompt: "look around", label: "explore", parent: { id: "session-p1" } });
	for (const cleanup of h.cleanups) cleanup();
	assert.equal(h.routes.length, 0);
});

test("the row cap never evicts a child the host still reports running", async () => {
	const h = harness();
	// The first spawn is a verified resident runner; every later row is an
	// unreported ghost. The cap fills, and the runner must survive the churn.
	h.agents.set("child-abc", { id: "child-abc", status: "running" });
	for (let index = 0; index < 70; index += 1) {
		h.spawn({ prompt: `task ${index}`, label: "explore", parent: { id: "session-p1" } });
	}
	const all = await h.get("/subagent-role-router/activity");
	assert.ok(all.body.value.active.some((row) => row.childId === "child-abc"), "the running child survives the cap");
	assert.ok(all.body.value.count <= 64, "the ledger stays bounded");
	for (const cleanup of h.cleanups) cleanup();
});

test("TTL is a ghost reaper: a long-running resident child is never stale", () => {
	const now = 10_000_000;
	const old = now - 7 * 60 * 60 * 1000; // older than the 6-hour TTL
	const entry = (childId) => ({
		childId,
		parentSessionId: "session-p1",
		label: null,
		role: null,
		provider: null,
		model: null,
		startedAt: old
	});
	const state = {
		activity: new Map([["runner", entry("runner")], ["ghost", entry("ghost")]]),
		liveAgents: {
			get(id) { return id === "runner" ? { id, status: "running" } : { id, status: "idle" }; }
		}
	};
	const rows = listActiveChildren(state, "session-p1", now);
	const runner = rows.find((row) => row.childId === "runner");
	assert.equal(runner.stale, false, "age alone cannot make a live runner stale");
	assert.ok(runner.ageMs > 6 * 60 * 60 * 1000);
	const fresh = pruneStaleActivity(state, rows);
	assert.deepEqual(fresh.map((row) => row.childId), ["runner"],
		"only the non-running ghost is pruned");
	assert.equal(state.activity.has("runner"), true);
	assert.equal(state.activity.has("ghost"), false);
});

test("TTL still reaps a stale row the host cannot verify", () => {
	const now = 10_000_000;
	const state = {
		activity: new Map([["ghost", {
			childId: "ghost",
			parentSessionId: "session-p1",
			label: null,
			role: null,
			provider: null,
			model: null,
			startedAt: now - 7 * 60 * 60 * 1000
		}]])
	};
	const rows = listActiveChildren(state, "session-p1", now);
	assert.equal(rows[0].stale, true);
	assert.deepEqual(pruneStaleActivity(state, rows), []);
	assert.equal(state.activity.size, 0);
});
