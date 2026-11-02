import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

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

	const subagents = {
		startActivation(spec) {
			return { childId: "child-abc", result: new Promise(() => {}) };
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
		get() {
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

	return { ctx, subagents, routes, emit, get, spawn: spawnSelf, cleanups };
}

test("a spawn reaches the activity route without a lane lease", async () => {
	const h = harness();

	h.spawn({ prompt: "look around", label: "explore", parent: { id: "session-p1" } });

	const mine = await h.get("/subagent-router/activity?parentSessionId=session-p1");
	assert.equal(mine.status, 200);
	assert.equal(mine.body.ok, true);
	assert.equal(mine.body.value.count, 1);
	assert.deepEqual(mine.body.value.active.map((row) => row.childId), ["child-abc"]);
	assert.equal(mine.body.value.active[0].label, "explore");
	assert.equal(typeof mine.body.value.active[0].ageMs, "number");

	const other = await h.get("/subagent-router/activity?parentSessionId=session-p2");
	assert.equal(other.body.value.count, 0);
});

test("disposal removes the child from the route", async () => {
	const h = harness();

	h.spawn({ prompt: "look around", label: "explore", parent: { id: "session-p1" } });
	assert.equal((await h.get("/subagent-router/activity?parentSessionId=session-p1")).body.value.count, 1);

	h.emit("agent/disposed", { agent: { id: "child-abc" } });

	assert.equal((await h.get("/subagent-router/activity?parentSessionId=session-p1")).body.value.count, 0);
});

test("an unfinished spawn is not left behind when the route answers without a filter", async () => {
	const h = harness();

	h.spawn({ prompt: "look around", label: "explore", parent: { id: "session-p1" } });

	const all = await h.get("/subagent-router/activity");
	assert.equal(all.body.ok, true);
	assert.equal(all.body.value.count, 1);
});

test("teardown unregisters the route and clears the ledger", async () => {
	const h = harness();

	h.spawn({ prompt: "look around", label: "explore", parent: { id: "session-p1" } });
	for (const cleanup of h.cleanups) cleanup();
	assert.equal(h.routes.length, 0);
});
