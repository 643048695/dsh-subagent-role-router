import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

// THE WHOLE FEATURE, DRIVEN THROUGH ITS REAL SEAMS.
//
// Unit tests build section objects by hand; this one goes through `apply()` with
// a real config, lets a spawn cross the wrapped subagents service, and reads the
// answers back off the plugin's own HTTP surface. It is the only place that
// proves the three layers agree: schema field → getSection view → routing.

function harness(overrides = {}) {
	let spawnSeq = 0;
	const listens = new Map();
	const cleanups = [];
	const routes = [];
	const specs = [];

	const config = {
		roleMode: false,
		injectRouteContext: false,
		failoverEnabled: false,
		models: [{ provider: "magpie", model: "general-a" }],
		exemptRules: [],
		coordinatorEnabled: true,
		coordinatorPresetPrefix: "dsh-orchestrator-worker",
		coordinatorUiModels: [
			{ provider: "magpie", model: "ui-a" },
			{ provider: "magpie", model: "ui-b" }
		],
		coordinatorResearchModels: [{ provider: "magpie", model: "research-a" }],
		coordinatorBackendModels: [{ provider: "magpie", model: "be-a" }],
		coordinatorCooldownPreset: "medium",
		coordinatorCooldownSteps: [],
		coordinatorCooldownCap: 0,
		coordinatorNoFallback: false,
		...overrides
	};

	const subagents = {
		startActivation(spec) {
			specs.push(spec);
			spawnSeq += 1;
			return { childId: `child-${spawnSeq}`, result: new Promise(() => {}) };
		}
	};

	const ctx = {
		logger: { warn: () => {}, info: () => {} },
		subagents,
		on(name, fn) {
			const list = listens.get(name) ?? [];
			list.push(fn);
			listens.set(name, list);
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
							return () => {};
						}
					}
				});
			}
			if (names.includes("subagents")) fn({ ...ctx, subagents });
		},
		get() {
			return undefined;
		}
	};

	apply(ctx, config);

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
		await route.handler({ method: "GET", url: path, socket: { remoteAddress: "127.0.0.1" } }, res);
		return captured;
	}

	function spawn(request, specExtra = {}) {
		return subagents.startActivation({ provider: "spawn", label: request.label, request, ...specExtra });
	}

	function spawnFlat(request) {
		// rc.3 shape: every field is top-level on the activation spec.
		return subagents.startActivation({ provider: "spawn", ...request });
	}

	return { config, subagents, specs, routes, get, spawn, spawnFlat, cleanups };
}

const routeOf = (spec) => spec?.agentOptions ?? spec?.request?.agentOptions ?? {};

test("a visual task is born on the first UI-list entry", async () => {
	const h = harness();
	h.spawn({ prompt: "画个图标", label: "【UI】画个图标", parent: { id: "session-p" }, agentPreset: "dsh-orchestrator-worker" });
	assert.equal(routeOf(h.specs[0]).model, "ui-a", "the first entry of the UI list serves");
});

test("a backend task is born on the backend list, never the general pool", async () => {
	const h = harness();
	h.spawn({ prompt: "修接口", label: "【后端】修接口", parent: { id: "session-p" }, agentPreset: "dsh-orchestrator-worker" });
	assert.equal(routeOf(h.specs[0]).model, "be-a");
});

test("an ordinary spawn stays on the general list and cannot borrow a reserved route", async () => {
	const h = harness();
	h.spawn({ prompt: "画个图标", label: "【UI】画个图标", parent: { id: "session-p" }, agentPreset: "standard" });
	const picked = routeOf(h.specs[0]);
	assert.equal(picked.model, "general-a", "reserved routes are removed from the general pool");
});

test("the diagnostic endpoint reports all three lists, the reserved set and what is left", async () => {
	const h = harness();
	const answer = await h.get("/subagent-role-router/coordinator");
	assert.equal(answer.status, 200);
	assert.equal(answer.body.value.enabled, true);
	assert.deepEqual(answer.body.value.groups.ui.routes.map((row) => row.model), ["ui-a", "ui-b"]);
	assert.equal(answer.body.value.groups.ui.routes[0].defaulted, true);
	assert.deepEqual(answer.body.value.groups.backend.routes.map((row) => row.model), ["be-a"]);
	assert.deepEqual(answer.body.value.groups.research.routes.map((row) => row.model), ["research-a"]);
	assert.deepEqual(answer.body.value.general.map((row) => row.model), ["general-a"], "the general list keeps only unreserved routes");
	assert.deepEqual(answer.body.value.gate.map((row) => row.model).sort(), ["be-a", "general-a", "research-a", "ui-a", "ui-b"], "the host gate receives the union");
});

test("a coordinator child's page is offered its own list, an ordinary page the general one", async () => {
	const h = harness();
	h.spawn({ prompt: "画个图标", label: "【UI】画个图标", parent: { id: "session-p" }, agentPreset: "dsh-orchestrator-worker" });
	const childId = h.specs[0] ? "child-1" : "child-1";

	const own = await h.get(`/subagent-role-router/whitelist?childId=${childId}`);
	assert.deepEqual(own.body.value.desired.map((row) => row.model), ["ui-a", "ui-b"]);
	assert.equal(own.body.value.coordinator.group, "ui");
	assert.match(own.body.value.coordinator.evidence, /UI/);

	const plain = await h.get("/subagent-role-router/whitelist");
	assert.deepEqual(plain.body.value.desired.map((row) => row.model), ["general-a"]);
	assert.equal(plain.body.value.coordinator, undefined);
});

test("the route endpoint names the list a child was put on", async () => {
	const h = harness();
	h.spawn({ prompt: "修接口", label: "【后端】修接口", parent: { id: "session-p" }, agentPreset: "dsh-orchestrator-worker" });
	// The route endpoint needs a live child; only the coordinator record can be
	// checked without one, so assert the record through the whitelist answer.
	const answer = await h.get("/subagent-role-router/whitelist?childId=child-1");
	assert.equal(answer.body.value.coordinator.group, "backend");
	assert.equal(answer.body.value.coordinator.reason, "tag");
});

test("switching the feature off returns the general routing", async () => {
	const h = harness({ coordinatorEnabled: false });
	h.spawn({ prompt: "画个图标", label: "【UI】画个图标", parent: { id: "session-p" }, agentPreset: "dsh-orchestrator-worker" });
	assert.equal(routeOf(h.specs[0]).model, "general-a");
	const answer = await h.get("/subagent-role-router/coordinator");
	assert.equal(answer.body.value.enabled, false);
});

test("a preset on the spec (the rc.3 shape) is what the orchestrator actually sends", async () => {
	const h = harness();
	// dsh-orchestrator puts agentPreset on the activation SPEC, not in the request.
	h.spawn({ prompt: "画个图标", label: "【UI】画个图标", parent: { id: "session-p" } }, { agentPreset: "dsh-orchestrator-worker" });
	assert.equal(routeOf(h.specs[0]).model, "ui-a");
});
test("a read-only research task is born on the research list", async () => {
	const h = harness();
	h.spawn({ prompt: "读一下源码怎么调用", label: "【查阅】读一下源码", parent: { id: "session-p" } }, { agentPreset: "dsh-orchestrator-worker" });
	assert.equal(routeOf(h.specs[0]).model, "research-a");
});

test("a FLAT activation spec is routed at birth (rc.3 puts every field on the spec)", async () => {
	const h = harness();
	// No `request` wrapper at all: this is what the host's startActivation really
	// receives on rc.3, and what dsh-orchestrator sends.
	h.spawnFlat({
		label: "【UI】画个图标",
		prompt: "画个图标",
		parent: { id: "session-p" },
		agentPreset: "dsh-orchestrator-worker"
	});
	const spec = h.specs[0];
	assert.equal(spec.request, void 0, "the spec carries no nested request");
	assert.equal(spec.agentOptions && spec.agentOptions.model, "ui-a", "the birth route lands on the spec itself");
});

test("a flat spec from an ordinary child gets the general route at birth too", async () => {
	const h = harness();
	h.spawnFlat({ label: "随便做点什么", prompt: "随便做点什么", parent: { id: "session-p" } });
	const spec = h.specs[0];
	assert.equal(spec.agentOptions && spec.agentOptions.model, "general-a");
});
