/**
 * Model-callable route tools — `subagent_routes_inspect` / `subagent_routes_update`.
 *
 * These are thin adapters: every rule that decides whether a write is legal
 * lives in createRouteController (lib/index.js), the same object the HTTP
 * endpoints use. Registration is lazy on the host `tools` service so a headless
 * profile without the tool registry keeps the rest of the plugin working, and
 * `deps.defineTool` lets tests inject a stub instead of the real dsh-tools.
 */

import { createRouteController } from "./index.js";
import { createAgentTeamsAdapter } from "./agent-teams-adapter.js";
import { defineRouterTool } from "./tool-schema.js";

const TOOL_SOURCE = "dsh-subagent-role-router";

/** The caller's own session id — the only scope these tools may ever touch. */
function callerSessionId(exec) {
	const id = exec?.agent?.session?.header?.id;
	return typeof id === "string" && id !== "" ? id : "";
}

function requireCaller(exec) {
	if (exec?.agent === void 0 || exec?.agent === null) {
		throw new Error("subagent router tools require a calling agent (exec.agent was undefined)");
	}
	return exec.agent;
}

/** Compare two child ids ignoring the optional "session-" prefix. */
function sameChildId(left, right) {
	const strip = (value) => (typeof value === "string" && value.startsWith("session-") ? value.slice(8) : String(value ?? ""));
	return left === right || strip(left) === strip(right);
}

function catalogRow(entry) {
	return {
		provider: entry.provider,
		model: entry.model,
		display_name: entry.displayName ?? entry.model,
		capability_known: entry.capabilityKnown === true,
		efforts: (entry.efforts ?? []).map((effort) => ({
			id: effort.id,
			label: effort.label ?? effort.id,
			source: effort.source ?? "catalog"
		})),
		configured_efforts: entry.configuredEfforts ?? []
	};
}

const routeJson = { type: "json", description: "Route object or null." };

const targetRowFields = {
	target: { type: "string", required: true },
	kind: { type: "string", required: true },
	writable: { type: "boolean", required: true },
	reason: { type: "string" },
	label: { type: "string" },
	mode: { type: "string" },
	actual: { ...routeJson, description: "The route from the target's most recent request, or null when there is no request evidence yet (unknown, not default)." },
	override: { ...routeJson, description: "The fixed override in force, or null." },
	pending_route: { ...routeJson, description: "What the next request will use, or null when nothing is pending; an object without reasoningEffort means the effort clears to the model default." },
	pending: { type: "boolean", required: true },
	revision: { type: "integer", required: true }
};

const inspectOutput = {
	type: "object",
	properties: {
		parent_session_id: { type: "string", required: true },
		epoch: { type: "string", required: true },
		targets: { type: "array", required: true, items: { type: "object", properties: targetRowFields } },
		models: { type: "array", required: true, items: { type: "object", properties: {
			provider: { type: "string", required: true },
			model: { type: "string", required: true },
			display_name: { type: "string" },
			capability_known: { type: "boolean", required: true },
			efforts: { type: "array", items: { type: "object", properties: {
				id: { type: "string", required: true },
				label: { type: "string", required: true },
				source: { type: "string" }
			} } },
			configured_efforts: { type: "array", items: { type: "string" } }
		} } },
		teams: { type: "object", required: true, properties: {
			available: { type: "boolean", required: true },
			api_version: { type: "integer" },
			reason: { type: "string" }
		} },
		notes: { type: "array", required: true, items: { type: "string" } }
	}
};

const updateOutput = {
	type: "object",
	properties: {
		parent_session_id: { type: "string", required: true },
		epoch: { type: "string", required: true },
		action: { type: "string", required: true },
		results: { type: "array", required: true, items: { type: "object", properties: {
			target: { type: "string", required: true },
			kind: { type: "string", required: true },
			ok: { type: "boolean", required: true },
			status: { type: "string", required: true },
			route: routeJson,
			actual: routeJson,
			revision: { type: "integer" },
			error: { type: "json", description: "{code, message} for failed targets." }
		} } },
		summary: { type: "object", required: true, properties: {
			total: { type: "integer", required: true },
			ok: { type: "integer", required: true },
			failed: { type: "integer", required: true }
		} }
	}
};

const targetParameters = {
	type: "object",
	additionalProperties: false,
	description: "Exactly one of child_ids, member_names or all_current.",
	properties: {
		child_ids: { type: "array", items: { type: "string" }, description: "Direct child session ids of THIS conversation." },
		member_names: { type: "array", items: { type: "string" }, description: "Team member names of a team you captain (requires the agent-teams member route adapter)." },
		all_current: { type: "boolean", description: "Expand to every writable direct child at call time; not a saved preference." }
	}
};

function rowToTarget(row) {
	return {
		target: row.childId,
		kind: "child",
		writable: row.selectable === true,
		reason: row.reason ?? "",
		label: row.label ?? "",
		mode: row.mode ?? "",
		actual: row.actual ?? null,
		override: row.override ?? null,
		pending_route: row.pendingRoute ?? null,
		pending: row.pending === true,
		revision: row.revision ?? 0
	};
}

function childErrorResult(childId, error) {
	return {
		target: childId,
		kind: "child",
		ok: false,
		status: "failed",
		error: { code: error?.code ?? "failed", message: error?.message ?? String(error ?? "unknown") }
	};
}

/**
 * Apply one select/reset to one direct child through the shared controller.
 * Per-target failures never throw — they become {ok:false,status:"failed"} rows.
 */
async function applyChild(controller, parentSessionId, action, childId, args, expectedRevisions) {
	const expected = expectedRevisions?.[childId];
	if (expected !== void 0) {
		const current = controller.revisionOf(childId);
		if (Number(expected) !== current) {
			return childErrorResult(childId, {
				code: "stale-revision",
				message: `route revision moved (expected ${expected}, current ${current}); re-read with subagent_routes_inspect`
			});
		}
	}
	if (action === "reset") {
		const result = await controller.clear(parentSessionId, childId);
		if (result.ok !== true) return childErrorResult(childId, result.error);
		return {
			target: childId,
			kind: "child",
			ok: true,
			status: result.pending === true ? "pending" : "applied",
			route: null,
			actual: result.actual ?? null,
			revision: result.revision ?? 0
		};
	}
	const keepModel = args.keep_model === true;
	const rawEffort = typeof args.reasoning_effort === "string" ? args.reasoning_effort.trim() : "";
	const effort = rawEffort === "" || rawEffort.toLowerCase() === "default" ? "" : rawEffort;
	const selection = keepModel
		? { childId, keepModel: true, reasoningEffort: effort }
		: { childId, provider: String(args.provider).trim(), model: String(args.model).trim(), reasoningEffort: effort };
	const result = await controller.select(parentSessionId, selection);
	if (result.ok !== true) return childErrorResult(childId, result.error);
	return {
		target: childId,
		kind: "child",
		ok: true,
		status: result.pending === true ? "pending" : "applied",
		route: result.route ?? null,
		actual: result.actual ?? null,
		revision: result.revision ?? 0
	};
}

/** Delegate one member operation to the teams-side service; never throws. */
async function applyMember(adapter, exec, action, memberName, args, expectedRevisions) {
	const fail = (code, message) => ({
		target: memberName,
		kind: "member",
		ok: false,
		status: "failed",
		error: { code, message }
	});
	const cap = adapter.capability();
	if (cap.available !== true) {
		return fail("teams-unavailable", cap.reason);
	}
	const caller = adapter.caller(exec);
	if (caller === void 0) return fail("no-caller", "the calling agent handle was missing");
	const expected = expectedRevisions?.[memberName];
	try {
		const payload = action === "reset"
			? await cap.service.clearOverride({ caller, memberName, expectedRevision: expected })
			: await cap.service.setOverride({
				caller,
				memberName,
				provider: String(args.provider ?? "").trim(),
				model: String(args.model ?? "").trim(),
				reasoningEffort: args.reasoning_effort,
				keepModel: args.keep_model === true,
				expectedRevision: expected
			});
		if (payload?.ok !== true) {
			return fail(payload?.error?.code ?? "teams-error", payload?.error?.message ?? "agent-teams member route service refused the change");
		}
		return {
			target: memberName,
			kind: "member",
			ok: true,
			status: payload.status ?? "applied",
			route: payload.route ?? null,
			actual: payload.actual ?? null,
			revision: payload.revision ?? 0
		};
	} catch (error) {
		return fail("teams-error", String(error?.message ?? error));
	}
}

async function defineInspectTool(ctx, state, controller, adapter, defineTool) {
	return defineTool({
		name: "subagent_routes_inspect",
		description:
			"Inspect the model routing of the subagents that belong to THIS conversation (direct children, plus team members when the agent-teams adapter is installed). " +
			"Read-only: shows each target's actual route from its most recent request, the pending fixed override, and the configured model pool with provider-verified reasoning efforts. " +
			"actual is null when a target has no request evidence yet — that means unknown, not default. Never wakes or interrupts anyone.",
		parameters: {
			child_ids: { type: "array", items: { type: "string" }, description: "Optional filter: only these direct child sessions." },
			member_names: { type: "array", items: { type: "string" }, description: "Optional filter: only these team member names (requires the agent-teams member route adapter)." }
		},
		output: {
			schema: inspectOutput,
			render: (args, value) => [{
				type: "text",
				text: `${TOOL_SOURCE} routes for ${value.parent_session_id} (epoch ${value.epoch}): ` +
					value.targets.map((row) => {
						const route = row.actual === null ? "unknown" : `${row.actual.provider ?? "?"}/${row.actual.model ?? "?"}` +
							(row.actual.reasoningEffort ? ` @${row.actual.reasoningEffort}` : "");
						const fixed = row.override === null ? "" : ` · fixed ${row.override.provider}/${row.override.model}` +
							(row.override.reasoningEffort ? ` @${row.override.reasoningEffort}` : " @default") +
							(row.pending ? " (pending)" : "");
						return `${row.target}${row.writable ? "" : ` [${row.reason}]`}: ${route}${fixed} · rev ${row.revision}`;
					}).join("; ") || "no targets",
				},
				{
					type: "text",
					text: "Configured models: " + (value.models.map((entry) => `${entry.provider}/${entry.model}` +
						(entry.capability_known ? ` [${entry.efforts.map((effort) => effort.id).join("|")}]` : " [efforts unverified]")).join(", ") || "none"),
				},
				{
					type: "text",
					text: value.teams.available ? `Team member adapter present (api v${value.teams.api_version}).` : `Team member adapter absent: ${value.teams.reason}`,
				}
			].concat(value.notes.length > 0 ? [{ type: "text", text: `Notes: ${value.notes.join(" | ")}` }] : [])
		},
		async execute(args, exec) {
			const agent = requireCaller(exec);
			const parentSessionId = callerSessionId(exec);
			if (parentSessionId === "") {
				throw new Error("subagent_routes_inspect could not resolve the calling session id");
			}
			const notes = [];
			const listed = await controller.children(parentSessionId);
			if (listed.ok !== true) {
				throw new Error(`subagent catalog unavailable: ${listed.error?.code ?? "unknown"}`);
			}
			const childFilter = Array.isArray(args.child_ids) ? args.child_ids : void 0;
			const memberFilter = Array.isArray(args.member_names) ? args.member_names : void 0;
			const rows = listed.value
				.filter((row) => childFilter === void 0 || childFilter.length === 0 || childFilter.some((wanted) => sameChildId(wanted, row.childId)))
				.map(rowToTarget);
			if (childFilter !== void 0 && rows.length < childFilter.length) {
				notes.push("some child_ids were not found in this conversation's catalog");
			}
			const teams = adapter.capability();
			if (memberFilter !== void 0 && memberFilter.length > 0) {
				if (teams.available !== true) {
					notes.push(`team members unavailable: ${teams.reason}`);
				} else {
					try {
						const described = await teams.service.describe({ caller: agent, memberNames: memberFilter });
						if (described?.ok === true) {
							for (const member of described.members ?? []) {
								if (memberFilter.some((wanted) => wanted === member.name)) {
									rows.push({
										target: member.name,
										kind: "member",
										writable: member.writable === true,
										reason: member.reason ?? "",
										label: member.label ?? "",
										mode: member.mode ?? "",
										actual: member.actual ?? null,
										override: member.override ?? null,
										pending_route: member.pendingRoute ?? null,
										pending: member.pending === true,
										revision: member.revision ?? 0
									});
								}
							}
						} else {
							notes.push(`agent-teams describe failed: ${described?.error?.message ?? "unknown"}`);
						}
					} catch (error) {
						notes.push(`agent-teams describe threw: ${String(error?.message ?? error)}`);
					}
				}
			}
			const models = (await controller.catalog()).map(catalogRow);
			return {
				parent_session_id: parentSessionId,
				epoch: controller.epoch(),
				targets: rows,
				models,
				teams: teams.available === true
					? { available: true, api_version: teams.apiVersion }
					: { available: false, reason: teams.reason },
				notes
			};
		}
	});
}

async function defineUpdateTool(ctx, state, controller, adapter, defineTool) {
	return defineTool({
		name: "subagent_routes_update",
		description:
			"Change or clear the fixed model route of the subagents that belong to THIS conversation (direct children, plus team members when the agent-teams adapter is installed). " +
			"action 'select' writes a fixed provider/model (and optionally a reasoning effort); action 'reset' clears the override and restores the previous routing strategy. " +
			"reasoning_effort omitted or 'default' means the model default; keep_model changes only the effort of each target's current model. " +
			"Per-target results with partial success reported; a target already running a request reports status 'pending' — the change applies from its next model request, never mid-request. " +
			"Targets outside this conversation, exempt, ended, or not locatable are refused, not silently widened.",
		parameters: {
			action: { type: "string", required: true, enum: ["select", "reset"], description: "select writes a fixed route; reset clears the override." },
			targets: targetParameters,
			provider: { type: "string", description: "Full provider id. Required for select unless keep_model is true; forbidden for reset." },
			model: { type: "string", description: "Full model id (what llm.listModels returns, e.g. \"group/dnq\", not a display name). Required for select unless keep_model is true; forbidden for reset." },
			reasoning_effort: { type: "string", description: "Reasoning effort id. Omit or \"default\" to clear back to the model default." },
			keep_model: { type: "boolean", description: "Keep each target's effective model and change only the effort; requires reasoning_effort." },
			expected_revisions: { type: "object", description: "Optional childId (or member name) → expected route revision from subagent_routes_inspect; a mismatch fails that target with stale-revision instead of overwriting a newer change." }
		},
		output: {
			schema: updateOutput,
			render: (args, value) => [{
				type: "text",
				text: `${TOOL_SOURCE} ${value.action} on ${value.parent_session_id}: ${value.summary.ok}/${value.summary.total} accepted` +
					(value.summary.failed > 0 ? `, ${value.summary.failed} failed` : "") + ". " +
					value.results.map((row) => {
						if (row.ok !== true) return `${row.target}: FAILED ${row.error?.code ?? "failed"} (${row.error?.message ?? "?"})`;
						const route = row.route === null ? "override cleared" : `${row.route.provider}/${row.route.model}` +
							(row.route.reasoningEffort ? ` @${row.route.reasoningEffort}` : " @model default");
						return `${row.target}: ${row.status} — ${route}`;
					}).join("; ") +
					(value.summary.failed === 0 && value.summary.total > 0 ? ". An in-flight request is not interrupted; pending targets switch on their next model request." : "")
			}]
		},
		async execute(args, exec) {
			requireCaller(exec);
			const parentSessionId = callerSessionId(exec);
			if (parentSessionId === "") {
				throw new Error("subagent_routes_update could not resolve the calling session id");
			}
			const action = args.action;
			const targets = args.targets ?? {};
			const specified = ["child_ids", "member_names", "all_current"].filter((key) => {
				const value = targets[key];
				return key === "all_current" ? value === true : Array.isArray(value) && value.length > 0;
			});
			if (specified.length !== 1) {
				throw new Error("targets must specify exactly one of child_ids, member_names, all_current");
			}
			if (action === "reset") {
				for (const key of ["provider", "model", "reasoning_effort", "keep_model"]) {
					if (args[key] !== void 0) throw new Error(`reset takes no ${key}`);
				}
			} else {
				const hasPair = typeof args.provider === "string" && args.provider.trim() !== "" &&
					typeof args.model === "string" && args.model.trim() !== "";
				const keepModel = args.keep_model === true;
				if (hasPair && keepModel) throw new Error("give provider+model or keep_model, not both");
				if (!hasPair && !keepModel) throw new Error("select needs provider and model (or keep_model: true to keep each target's model)");
				if (keepModel && (typeof args.reasoning_effort !== "string" || args.reasoning_effort.trim() === "")) {
					throw new Error("keep_model needs reasoning_effort (omitting it would be a no-op)");
				}
			}
			const expectedRevisions = args.expected_revisions ?? void 0;
			const results = [];
			let childIds = [];
			let memberNames = [];
			if (specified[0] === "child_ids") {
				childIds = targets.child_ids.map((value) => String(value).trim()).filter(Boolean);
			} else if (specified[0] === "member_names") {
				memberNames = targets.member_names.map((value) => String(value).trim()).filter(Boolean);
			} else {
				const listed = await controller.children(parentSessionId);
				if (listed.ok !== true) {
					throw new Error(`subagent catalog unavailable: ${listed.error?.code ?? "unknown"}`);
				}
				childIds = listed.value.filter((row) => row.selectable === true).map((row) => row.childId);
			}
			for (const childId of childIds) {
				results.push(await applyChild(controller, parentSessionId, action, childId, args, expectedRevisions));
			}
			for (const memberName of memberNames) {
				results.push(await applyMember(adapter, exec, action, memberName, args, expectedRevisions));
			}
			return {
				parent_session_id: parentSessionId,
				epoch: controller.epoch(),
				action,
				results,
				summary: {
					total: results.length,
					ok: results.filter((row) => row.ok === true).length,
					failed: results.filter((row) => row.ok !== true).length
				}
			};
		}
	});
}

// The host package is NOT imported here: a plugin that only ships lib/ cannot
// resolve it at runtime, and the failure used to be silent (no tools at all).
// ./tool-schema.js compiles the same authoring subset into the same
// registry-ready shape the tools service validates.

/**
 * Register both tools on the host `tools` service. Lazy and non-blocking: a
 * host without the registry simply never runs the callback (the fiber never
 * pends on it, mirroring how the agent-teams plugin treats its commands).
 */
export async function installRouterTools(ctx, state, deps = {}) {
	try {
		if (state.routerToolsInstalled === true) return;
		const defineTool = deps.defineTool ?? defineRouterTool;
		if (typeof defineTool !== "function") {
			throw new Error("defineTool unavailable");
		}
		const controller = createRouteController(ctx, state);
		const adapter = createAgentTeamsAdapter(ctx);
		const definitions = [
			await defineInspectTool(ctx, state, controller, adapter, defineTool),
			await defineUpdateTool(ctx, state, controller, adapter, defineTool)
		];
		// "Installed" now means "the registry accepted it", not "we built it".
		// The old flag was set before the inject callback ran, so the diagnostic
		// endpoint reported two tools that had never been registered.
		ctx.inject(["tools"], (toolsCtx) => {
			const registered = [];
			for (const definition of definitions) {
				try {
					// The service lives ON the context: `ctx.tools.register`, not `ctx.register`.
					toolsCtx.tools.register(definition);
					registered.push(definition?.name);
				} catch (error) {
					state.routerToolsError = String(error?.message ?? error);
					ctx?.logger?.warn?.(`[subagent-router] could not register ${definition?.name}: ${String(error?.message ?? error)}`);
				}
			}
			state.routerToolsInstalled = registered.length === definitions.length;
			state.routerToolsRegistered = registered;
		});
		state.routerToolsBuilt = true;
	} catch (error) {
		state.routerToolsInstalled = false;
		state.routerToolsError = String(error?.message ?? error);
		try {
			ctx?.logger?.warn?.(`[subagent-router] model-callable tools unavailable: ${String(error?.message ?? error)}`);
		} catch {
			/* logging must never break the plugin */
		}
	}
}
