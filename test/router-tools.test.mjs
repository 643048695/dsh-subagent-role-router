/**
 * Stage-1 route tools: subagent_routes_inspect / subagent_routes_update.
 * The tools must share every rule with the HTTP endpoints (they do, through
 * createRouteController), refuse out-of-scope targets, report per-target
 * results honestly, and degrade honestly when the agent-teams adapter is absent.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { installRouterTools } from "../lib/router-tools.js";
import { createAgentTeamsAdapter } from "../lib/agent-teams-adapter.js";
import { routeRevisionOf } from "../lib/index.js";

const PARENT = "session-parent-1";
const OTHER = "session-parent-2";

const CONFIG = {
	models: [
		{ provider: "p", model: "a" },
		{ provider: "p", model: "a", reasoningEffort: "high" },
		{ provider: "q", model: "b" }
	],
	exemptRules: [{ pattern: "keep-", match: "label" }]
};

const LLM = {
	listModels: async (provider) => (provider === "p"
		? [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }]
		: []),
	resolveModelInfo: async (provider, model) => {
		if (provider === "p" && model === "a") {
			return { reasoning: { efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }], defaultEffort: "low" } };
		}
		throw new Error(`no catalog info for ${provider}/${model}`);
	}
};

function makeChildAgent(childId, route = { provider: "p", model: "a", reasoningEffort: "low" }, label = "worker") {
	return {
		id: childId,
		session: {
			header: { origin: "subagent", id: childId, label },
			requestHeader: () => ({ config: { ...route } }),
			requestContext: () => ({ provider: route.provider, model: route.model, contextWindow: 1000 })
		}
	};
}

function makeHost({ rows = [], agents = new Map(), llm = LLM, config = CONFIG, teamsService } = {}) {
	const registered = [];
	const warnings = [];
	const services = {
		subagents: {
			listChildren: async (parent) => {
				if (parent === PARENT) return rows;
				throw new Error(`session "${parent}" not found`);
			}
		},
		agents,
		llm,
		...(teamsService !== void 0 ? { agentTeamsMemberRoutes: teamsService } : {}),
		tools: { register: (definition) => registered.push(definition) }
	};
	const ctx = {
		get: (name) => services[name],
		inject: (names, callback) => callback({ tools: services.tools }),
		logger: { warn: (message) => warnings.push(message) }
	};
	return { ctx, registered, warnings };
}

function makeState(config = CONFIG) {
	return {
		getSection: () => config,
		childRoutes: new Map(),
		routeRevisions: new Map(),
		routeEpoch: "test-epoch",
		modelCaps: null
	};
}

async function install({ host, state } = {}) {
	const h = host ?? makeHost();
	const s = state ?? makeState();
	const stub = (options) => ({ name: options.name, options });
	await installRouterTools(h.ctx, s, { defineTool: stub });
	return { h, s, byName: Object.fromEntries(h.registered.map((definition) => [definition.name, definition.options])) };
}

const standardRows = () => [
	{ id: "child-1", mode: "continuable", label: "worker" },
	{ id: "child-2", mode: "one-shot", label: "done" },
	{ id: "child-3", mode: "continuable", label: "keep-me" }
];

const standardAgents = () => new Map([
	["child-1", makeChildAgent("child-1")],
	["child-3", makeChildAgent("child-3", { provider: "p", model: "a", reasoningEffort: "low" }, "keep-me")]
]);

test("installRouterTools registers exactly the two tools once per state", async () => {
	const { h, byName, s } = await install();
	await installRouterTools(h.ctx, s, { defineTool: (options) => ({ name: options.name, options }) });
	assert.equal(h.registered.length, 2, "re-installing against the same state must not duplicate");
	assert.deepEqual(h.registered.map((definition) => definition.name).sort(), ["subagent_routes_inspect", "subagent_routes_update"]);
	assert.equal(typeof byName.subagent_routes_inspect.execute, "function");
	assert.equal(typeof byName.subagent_routes_update.execute, "function");
});

test("inspect lists children with revision, honest unknown actual, and models", async () => {
	const { byName } = await install({
		host: makeHost({ rows: standardRows(), agents: standardAgents() })
	});
	const value = await byName.subagent_routes_inspect.execute({}, { agent: { session: { header: { id: PARENT } } } });
	assert.equal(value.parent_session_id, PARENT);
	assert.equal(value.epoch, "test-epoch");
	assert.equal(value.targets.length, 3);
	const worker = value.targets.find((row) => row.target === "child-1");
	assert.equal(worker.writable, true);
	assert.deepEqual(worker.actual, { provider: "p", model: "a", reasoningEffort: "low" });
	assert.equal(worker.override, null);
	assert.equal(worker.revision, 0);
	const done = value.targets.find((row) => row.target === "child-2");
	assert.equal(done.writable, false);
	assert.equal(done.reason, "ended");
	assert.equal(done.actual, null, "one-shot child has no live request evidence");
	assert.equal(value.teams.available, false);
	assert.match(value.teams.reason, /not installed/);
	const alpha = value.models.find((entry) => entry.model === "a");
	assert.equal(alpha.capability_known, true);
	assert.deepEqual(alpha.efforts.map((effort) => effort.id), ["low", "high"]);
	assert.deepEqual(alpha.configured_efforts, ["high"], "the second p/a config entry pins high");
	const beta = value.models.find((entry) => entry.model === "b");
	assert.equal(beta.capability_known, false, "q/b has no catalog evidence");
	assert.deepEqual(beta.efforts.map((effort) => effort.id), [], "q/b has no configured effort in this fixture");
});

test("inspect child_ids filter reports misses in notes", async () => {
	const { byName } = await install({
		host: makeHost({ rows: standardRows(), agents: standardAgents() })
	});
	const value = await byName.subagent_routes_inspect.execute(
		{ child_ids: ["child-1", "ghost"] },
		{ agent: { session: { header: { id: PARENT } } } }
	);
	assert.deepEqual(value.targets.map((row) => row.target), ["child-1"]);
	assert.equal(value.notes.some((note) => note.includes("not found")), true);
});

test("select writes the override; live-mismatch reports pending", async () => {
	const host = makeHost({ rows: standardRows(), agents: standardAgents() });
	const { byName, s } = await install({ host });
	const exec = { agent: { session: { header: { id: PARENT } } } };
	const value = await byName.subagent_routes_update.execute(
		{ action: "select", targets: { child_ids: ["child-1"] }, provider: "p", model: "a", reasoning_effort: "high" },
		exec
	);
	assert.equal(value.summary.total, 1);
	assert.equal(value.summary.ok, 1);
	const row = value.results[0];
	assert.equal(row.ok, true);
	assert.equal(row.status, "pending", "live request ran p/a/low, so the change is pending");
	assert.deepEqual(row.route, { provider: "p", model: "a", reasoningEffort: "high" });
	assert.deepEqual(s.childRoutes.get("child-1"), { provider: "p", model: "a", reasoningEffort: "high" });
	assert.equal(routeRevisionOf(s, "child-1"), 1);
});

test("select without effort clears a previously pinned effort (model default)", async () => {
	const host = makeHost({ rows: standardRows(), agents: standardAgents() });
	const { byName, s } = await install({ host });
	const exec = { agent: { session: { header: { id: PARENT } } } };
	await byName.subagent_routes_update.execute(
		{ action: "select", targets: { child_ids: ["child-1"] }, provider: "p", model: "a", reasoning_effort: "high" },
		exec
	);
	const value = await byName.subagent_routes_update.execute(
		{ action: "select", targets: { child_ids: ["child-1"] }, provider: "p", model: "a" },
		exec
	);
	assert.deepEqual(s.childRoutes.get("child-1"), { provider: "p", model: "a" }, "no reasoningEffort key means model default");
	assert.equal(value.results[0].route.reasoningEffort, undefined);
});

test("keep_model changes only the effort of the target's current model", async () => {
	const { byName, s } = await install({
		host: makeHost({ rows: standardRows(), agents: standardAgents() })
	});
	const value = await byName.subagent_routes_update.execute(
		{ action: "select", targets: { child_ids: ["child-1"] }, keep_model: true, reasoning_effort: "high" },
		{ agent: { session: { header: { id: PARENT } } } }
	);
	assert.deepEqual(s.childRoutes.get("child-1"), { provider: "p", model: "a", reasoningEffort: "high" });
	assert.equal(value.results[0].ok, true);
});

test("keep_model without reasoning_effort is a contract error", async () => {
	const { byName } = await install({
		host: makeHost({ rows: standardRows(), agents: standardAgents() })
	});
	await assert.rejects(
		() => byName.subagent_routes_update.execute(
			{ action: "select", targets: { child_ids: ["child-1"] }, keep_model: true },
			{ agent: { session: { header: { id: PARENT } } } }
		),
		/keep_model needs reasoning_effort/
	);
});

test("reset clears the override and stays idempotent", async () => {
	const host = makeHost({ rows: standardRows(), agents: standardAgents() });
	const { byName, s } = await install({ host });
	const exec = { agent: { session: { header: { id: PARENT } } } };
	await byName.subagent_routes_update.execute(
		{ action: "select", targets: { child_ids: ["child-1"] }, provider: "q", model: "b" },
		exec
	);
	const first = await byName.subagent_routes_update.execute(
		{ action: "reset", targets: { child_ids: ["child-1"] } },
		exec
	);
	const second = await byName.subagent_routes_update.execute(
		{ action: "reset", targets: { child_ids: ["child-1"] } },
		exec
	);
	assert.equal(s.childRoutes.has("child-1"), false);
	assert.equal(first.results[0].ok, true);
	assert.equal(second.results[0].ok, true, "reset on an already-clear target is still a success");
	assert.equal(routeRevisionOf(s, "child-1"), 3, "select + reset + reset each bump the revision");
});

test("reset rejects route arguments instead of silently ignoring them", async () => {
	const { byName } = await install({
		host: makeHost({ rows: standardRows(), agents: standardAgents() })
	});
	await assert.rejects(
		() => byName.subagent_routes_update.execute(
			{ action: "reset", targets: { child_ids: ["child-1"] }, provider: "p", model: "a" },
			{ agent: { session: { header: { id: PARENT } } } }
		),
		/reset takes no provider/
	);
});

test("expected_revisions mismatch fails the target without writing", async () => {
	const host = makeHost({ rows: standardRows(), agents: standardAgents() });
	const { byName, s } = await install({ host });
	const value = await byName.subagent_routes_update.execute(
		{ action: "select", targets: { child_ids: ["child-1"] }, provider: "q", model: "b", expected_revisions: { "child-1": 99 } },
		{ agent: { session: { header: { id: PARENT } } } }
	);
	assert.equal(value.results[0].ok, false);
	assert.equal(value.results[0].error.code, "stale-revision");
	assert.equal(s.childRoutes.has("child-1"), false, "a stale CAS expectation must not overwrite");
});

test("targets outside this conversation are refused (not-owned)", async () => {
	const { byName } = await install({
		host: makeHost({ rows: standardRows(), agents: standardAgents() })
	});
	const value = await byName.subagent_routes_update.execute(
		{ action: "select", targets: { child_ids: ["child-1"] }, provider: "q", model: "b" },
		{ agent: { session: { header: { id: OTHER } } } }
	);
	assert.equal(value.summary.failed, 1);
	assert.equal(value.results[0].error.code, "catalog-unavailable", "another conversation's catalog is not visible here");
});

test("exempt children are refused", async () => {
	const { byName } = await install({
		host: makeHost({ rows: standardRows(), agents: standardAgents() })
	});
	const value = await byName.subagent_routes_update.execute(
		{ action: "select", targets: { child_ids: ["child-3"] }, provider: "q", model: "b" },
		{ agent: { session: { header: { id: PARENT } } } }
	);
	assert.equal(value.results[0].error.code, "exempt");
});

test("ended (one-shot) children are refused", async () => {
	const { byName } = await install({
		host: makeHost({ rows: standardRows(), agents: standardAgents() })
	});
	const value = await byName.subagent_routes_update.execute(
		{ action: "select", targets: { child_ids: ["child-2"] }, provider: "q", model: "b" },
		{ agent: { session: { header: { id: PARENT } } } }
	);
	assert.equal(value.results[0].error.code, "ended");
});

test("all_current expands to writable children only, at call time", async () => {
	const host = makeHost({ rows: standardRows(), agents: standardAgents() });
	const { byName, s } = await install({ host });
	const value = await byName.subagent_routes_update.execute(
		{ action: "select", targets: { all_current: true }, provider: "q", model: "b" },
		{ agent: { session: { header: { id: PARENT } } } }
	);
	assert.deepEqual(value.results.map((row) => row.target), ["child-1"], "child-2 ended, child-3 exempt");
	assert.deepEqual(s.childRoutes.get("child-1"), { provider: "q", model: "b" });
});

test("member_names without the adapter fail with an honest teams-unavailable error", async () => {
	const { byName } = await install({
		host: makeHost({ rows: standardRows(), agents: standardAgents() })
	});
	const value = await byName.subagent_routes_update.execute(
		{ action: "select", targets: { member_names: ["planner"] }, provider: "q", model: "b" },
		{ agent: { session: { header: { id: PARENT } } } }
	);
	assert.equal(value.results[0].ok, false);
	assert.equal(value.results[0].error.code, "teams-unavailable");
	assert.equal(value.summary.ok, 0);
});

test("member operations delegate to the teams service with the real caller", async () => {
	const calls = [];
	const teamsService = {
		apiVersion: 1,
		setOverride: async (payload) => {
			calls.push({ op: "set", payload });
			return { ok: true, status: "applied", route: { provider: "q", model: "b", reasoningEffort: "high" }, actual: null, revision: 5 };
		},
		clearOverride: async (payload) => {
			calls.push({ op: "clear", payload });
			return { ok: true, status: "applied", route: null, actual: null, revision: 6 };
		}
	};
	const { byName } = await install({
		host: makeHost({ rows: standardRows(), agents: standardAgents(), teamsService })
	});
	const exec = { agent: { session: { header: { id: PARENT } } } };
	const selected = await byName.subagent_routes_update.execute(
		{ action: "select", targets: { member_names: ["planner"] }, provider: "q", model: "b", reasoning_effort: "high" },
		exec
	);
	assert.equal(selected.results[0].ok, true);
	assert.equal(selected.results[0].kind, "member");
	assert.equal(selected.results[0].revision, 5);
	assert.equal(calls[0].payload.memberName, "planner");
	assert.equal(calls[0].payload.caller, exec.agent, "the real caller passes through untouched");
	const cleared = await byName.subagent_routes_update.execute(
		{ action: "reset", targets: { member_names: ["planner"] } },
		exec
	);
	assert.equal(cleared.results[0].ok, true);
	assert.equal(calls[1].op, "clear");
});

test("inspect surfaces a present teams adapter and its member rows", async () => {
	const teamsService = {
		apiVersion: 1,
		describe: async ({ memberNames }) => ({
			ok: true,
			members: memberNames.map((name) => ({
				name, childId: "member-child", writable: true, reason: "ok", mode: "continuable", label: name,
				actual: null, override: null, pendingRoute: null, pending: false, revision: 2
			}))
		})
	};
	const { byName } = await install({
		host: makeHost({ rows: standardRows(), agents: standardAgents(), teamsService })
	});
	const value = await byName.subagent_routes_inspect.execute(
		{ member_names: ["planner"] },
		{ agent: { session: { header: { id: PARENT } } } }
	);
	assert.equal(value.teams.available, true);
	assert.equal(value.teams.api_version, 1);
	const member = value.targets.find((row) => row.kind === "member");
	assert.equal(member.target, "planner");
	assert.equal(member.revision, 2);
});

test("an old adapter apiVersion is refused, not downgraded", async () => {
	const adapter = createAgentTeamsAdapter({ get: () => ({ apiVersion: 0 }) });
	const cap = adapter.capability();
	assert.equal(cap.available, false);
	assert.match(cap.reason, /apiVersion 0 is older/);
});

test("a failing catalog makes inspect throw with the catalog code", async () => {
	const { byName } = await install({ host: makeHost({ rows: [] }) });
	await assert.rejects(
		() => byName.subagent_routes_inspect.execute({}, { agent: { session: { header: { id: OTHER } } } }),
		/catalog unavailable/
	);
});

test("update without a caller session id throws instead of guessing scope", async () => {
	const { byName } = await install({
		host: makeHost({ rows: standardRows(), agents: standardAgents() })
	});
	await assert.rejects(
		() => byName.subagent_routes_update.execute(
			{ action: "reset", targets: { all_current: true } },
			{ agent: { session: { header: {} } } }
		),
		/could not resolve the calling session id/
	);
});
