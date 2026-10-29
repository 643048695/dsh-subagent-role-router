import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import fs from "node:fs";
import { buildWindowSlicedSeed as safeWindowSeed } from "./fork-window.js";
import z from "@deepseek-ai/schemastery";

/**
 * Optional trace sink.
 *
 * During development this plugin wrote its diagnostics to a path that was typed
 * into the source, which is wrong twice over for a published package: nobody
 * else can write there, and an always-on trace file grows without bound. The
 * sink is now off unless the user names a file in
 * `DSH_SUBAGENT_ROLE_ROUTER_LOG`; with it unset every call is a no-op.
 */
const TRACE_PATH = typeof process.env.DSH_SUBAGENT_ROLE_ROUTER_LOG === "string"
	? process.env.DSH_SUBAGENT_ROLE_ROUTER_LOG.trim()
	: "";

function trace(line) {
	if (TRACE_PATH === "") return;
	try {
		fs.appendFileSync(TRACE_PATH, "[" + new Date().toISOString() + "] " + line + String.fromCharCode(10));
	} catch (_e) {}
}

function createUserMessage(input) {
	return {
		...input,
		id: randomUUID(),
		role: "user"
	};
}

/**
 * dsh-subagent-role-router — default model(s) for subagent delegations.
 *
 * Host-plane plugin. It declares its configurable surface as the plugin's own
 * Cordis `Config` (DSH 0.1.7+ "settings model": a plugin's `Config` IS the
 * settings section). The host projects this `Config` into a settings form keyed
 * by the Loader entry id (`dsh-subagent-role-router`) and writes changes back
 * to the profile patch; volatile fields hot-reload without re-mounting the
 * plugin. This plugin then wraps the host `ctx.subagents` service
 * (`start` / `startContinuable`), so any delegation whose request carries no
 * explicit `agentOptions` (the stock `subagent` / `subagent_fork` tools and
 * every other tool that omits model/provider) creates the child with a
 * configured default model. Explicit per-call overrides (e.g.
 * `subagent_with_model`) always win; an absent or incomplete section keeps the
 * historical behavior: children inherit the parent session route.
 *
 * Multiple models are supported: the `models` list is picked from on every
 * delegation either round-robin (default) or at random (`strategy`), so a
 * batch of parallel subagents spreads across the configured models. The
 * selection is re-evaluated on every call (live Config reference + live picker
 * state), so configuration changes apply to the very next delegation.
 *
 * The wrap lives on the service, not on any tool, so it covers every
 * delegation path without touching the core `dsh-tool-subagent` package.
 *
 * Optional subagent-only error failover: with `failoverEnabled` on (the
 * default), this plugin hooks the agent loop's `agent/request-error` and
 * `agent/request` waterfalls (the same seams the community dsh-llm-fallback /
 * dsh-model-failover plugins use) and — when a SUBAGENT's own loop hits a
 * connection failure (rate limit, quota, server/transport error, empty
 * response) — transparently retries that request on another model from the
 * SAME `models` list, following the SAME `strategy` (round-robin advances
 * through the list as a queue; random picks any entry without checking whether
 * it was used before). The gate is `agent.session.header.origin ===
 * "subagent"` (the durable marker every subagent child session carries), so the
 * MAIN agent's loop is never touched: failover is strictly subagent-only by
 * construction. Per-subagent state is cleaned on `agent/disposed`, so a broken
 * subagent primary is not re-tried on every step of the same run.
 */

export const name = "dsh-subagent-role-router";

/**
 * Backend build marker. Bumped on every behavioural change to this module so a
 * running host can be asked WHICH version got loaded — cordis reloads silently,
 * and "did my edit actually take effect" is otherwise unanswerable. Probed
 * through `GET /subagent-role-router/route?childId=<nothing>`.
 */
export const ROUTER_BUILD = "2026-10-30.1";
// Do not hard-inject `subagents` at the plugin root: DSH may mount that
// service after this row. The settings surface is the declared `Config` (the
// host projects it independently of any service wave); `apply()` attaches the
// service wrapper through `ctx.inject()`.
//
// There is deliberately no settings-namespace constant here: on 0.1.7 the
// namespace IS this Loader entry id (`dsh-subagent-role-router`), and the
// host — not this plugin — owns that mapping. The client resolves the served
// namespace from the configForms mirror instead of guessing it.

/**
 * Mark a schema's field as volatile, on every schemastery build.
 *
 * The marker is NOT optional decoration: `@deepseek-ai/dsh-settings` derives the
 * settings surface from it in two places, and BOTH fail silently without it.
 *
 *   - `volatileForm(schema)` (dsh-settings `lib/index.js`) returns `undefined`
 *     when no field carries the marker, and `describe()` then DROPS the entry
 *     from the namespace directory (`if (form === void 0) return []`). The
 *     entry never reaches the client's describe mirror, so the settings card's
 *     forwarding scope never binds and every Save reports
 *     `notApplied:unavailable:writable=false` — a "the Host serves no settings
 *     store for this plugin" error for a plugin the Host is serving perfectly.
 *   - `isVolatilePath(schema, path)` refuses every edit whose path is not under
 *     a marked node, with `Config field "…" is not volatile`.
 *
 * `volatile()` is sugar introduced in schemastery 3.18.4 — upstream it is
 * literally `extra("volatile", true)` behind a double-marking guard. A stale or
 * hoisted 3.18.1 install is entirely reachable (observed: the vendored copy was
 * 3.18.1, so `volatile()` was absent and the marker was never applied — the
 * plugin loaded, the card rendered, and every Save failed with the message
 * above). `extra()` exists in both builds, so falling back to it keeps the exact
 * 3.18.4 semantics and also works where `volatile()` is missing; the declared
 * dependency floor is therefore 3.18.1. A schema offering neither method is
 * returned unchanged rather than breaking the plugin at module-eval time.
 *
 * @template T
 * @param {object} schema - a schemastery field.
 * @returns {object} the field, marked volatile whenever the build allows it.
 */
export function volatileField(schema) {
	if (typeof schema?.volatile === "function") return schema.volatile();
	// Pre-3.18.4 fallback: identical marker, no double-marking guard needed
	// because `extra` is a plain assignment of the same meta key.
	if (typeof schema?.extra === "function" && schema.meta?.volatile !== true) {
		return schema.extra("volatile", true);
	}
	return schema;
}

/** One model entry: a bare model id (uses the section `provider`) or an explicit `{provider, model}` pair. */
const MODEL_ENTRY = z.union([
	z.string(),
	z.object({
		provider: z.string(),
		model: z.string(),
		reasoningEffort: z.string()
	})
]);
/**
 * One entry of a ROLE candidate pool (the per-role spillover queues).
 *
 * Deliberately NOT `MODEL_ENTRY`: that one declares `reasoningEffort` as a
 * REQUIRED object key, while the settings UI serialises an entry that names no
 * effort without the key at all. Writing such an object through the settings
 * scope would then be rejected by the schema and the whole save would fail, so
 * the pool shape gives `reasoningEffort` a default and stays writable from the
 * UI. A bare string is still accepted for hand-edited configs and means "this
 * model id on the role's own provider".
 */
const POOL_ENTRY = z.union([
	z.string(),
	z.object({
		provider: z.string(),
		model: z.string(),
		reasoningEffort: z.string().default("")
	})
]);

/** Schema of the `subagent-default-model` settings section; an absent section keeps inheriting the parent route. */
// EVERY field MUST carry a `.default(...)`, including the string ones that
// would naturally be "absent when unset". The settings surface is built by
// `projectForm()` (`@deepseek-ai/dsh-settings`), which walks the form schema and
// DROPS any field whose resolved value is `undefined`:
//
//     return field === void 0 ? [] : [[key, projectForm(child, field)]];
//
// A bare `z.string()` with no default resolves to `undefined`, so such a field
// is absent from the descriptor the settings card reads AND writes against. The
// card then compares its draft (`provider: "workbuddy"`) to a descriptor that
// never mentions `provider`, and reports the misleading
// `notApplied:ready:writable=true`: the scope is ready and writable, and the
// field it wrote is simply not one this form can see. Declaring `""` as the
// default keeps the field present-and-empty, which is exactly the "inherit the
// parent route" state the rest of this plugin already treats as unset
// (`defaultModel()` tests `section.model.length > 0`).
const SUBAGENT_DEFAULT_MODEL_SETTINGS_SCHEMA = z.object({
	provider: volatileField(z.string().default("").description("Default provider for subagent runs without an explicit agentOptions")),
	model: volatileField(z.string().default("").description("Default model id; the single-model form, backward compatible")),
	models: volatileField(z.array(MODEL_ENTRY).default([]).description("Multi-model list; picked per strategy on every delegation")),
	strategy: volatileField(z.union([z.const("round-robin"), z.const("random")]).default("round-robin").description("How to pick from models")),
	failoverEnabled: volatileField(z.boolean().default(true).description("Retry a subagent request on another pool model after a connection failure")),
	injectRouteContext: volatileField(z.boolean().default(true).description("Inject the actually-used provider/model into each subagent context")),
	reasoningEffort: volatileField(z.string().default("").description("Reasoning effort for the single-model form (model)")),
	roleMode: volatileField(z.boolean().default(false).description("Enable 3-role routing (explore, plan, patch)")),
	exploreProvider: volatileField(z.string().default("")),
	exploreModel: volatileField(z.string().default("")),
	exploreEffort: volatileField(z.string().default("")),
	planProvider: volatileField(z.string().default("")),
	planModel: volatileField(z.string().default("")),
	planEffort: volatileField(z.string().default("")),
	patchProvider: volatileField(z.string().default("")),
	patchModel: volatileField(z.string().default("")),
	patchEffort: volatileField(z.string().default("")),
	// ── per-role candidate pools (spillover queues) ──────────────────────────
	// Each role may hold an ordered list of candidate models instead of the
	// single `*Provider`/`*Model`/`*Effort` triple above. The list is BOTH the
	// candidate set and the capacity plan: its length is how many "workstations"
	// that role has, so a user who wants 3 general-purpose lanes simply adds 3
	// rows. Selection fills the earliest free lane first and only then shares
	// work, which is the requested behaviour (lane 1 gets the extra task).
	//
	// The old single-value fields are KEPT and still read as a fallback, so an
	// existing profile keeps working untouched and a downgrade stays safe.
	exploreModels: volatileField(z.array(POOL_ENTRY).default([]).description("Explore-role candidate pool; length = number of lanes")),
	planModels: volatileField(z.array(POOL_ENTRY).default([]).description("Plan-role candidate pool; length = number of lanes")),
	patchModels: volatileField(z.array(POOL_ENTRY).default([]).description("General/patch-role candidate pool; length = number of lanes")),
	// How long a model that just failed stays out of the rotation. 0 disables
	// cooling (failures still fall through to the next candidate).
	roleSlotCooldownSeconds: volatileField(z.number().default(15).description("Seconds a failed candidate is skipped by new delegations; 0 disables")),
	// ── agent-teams members ─────────────────────────────────────────────────
	// The spawn_teammate tool has no model parameter (it passes the placeholder
	// providers "spawn"/"fork" and every member lands on the team default).
	// These three fields give members a birth model: when set, every team spawn
	// is rewritten to this route, exactly like routeDelegation does for plain
	// subagents — but WITHOUT lanes, cooldowns, or failover, so team semantics
	// stay untouched. Empty strings mean "leave the team default alone".
	teamModelProvider: volatileField(z.string().default("").description("Provider for agent-teams members at spawn; empty = team default")),
	teamModelName: volatileField(z.string().default("").description("Model id for agent-teams members at spawn; empty = team default")),
	teamModelEffort: volatileField(z.string().default("").description("Reasoning effort for agent-teams members at spawn; empty = provider default")),
	// ── plugin exemption list ────────────────────────────────────────────────
	// Some plugins spawn subagents for their own work (the EGM review goldfish,
	// for one). Every rule matches a child's BIRTH identity by exact prefix and
	// exempts it: no default-model injection, no role pool, no lanes, and no
	// automatic failover once it runs. A rule may optionally PIN a birth model
	// (provider+model, effort optional); an empty provider/model means the
	// router does not touch the model at all. Prefix semantics on purpose: the
	// egm preset id carries a version suffix (`egm-goldfish-0.2.0`) and its
	// one-shot review rooms are `mkdtemp` suffixed, so exact equality would
	// break on every plugin upgrade or new room.
	exemptRules: volatileField(z.array(z.object({
		name: z.string().default("").description("Free-form label for the rule"),
		match: z.union([z.const("label"), z.const("preset"), z.const("cwd")]).default("label").description("Which birth field the pattern matches"),
		pattern: z.string().default("").description("Exact prefix required to exempt; empty never matches"),
		provider: z.string().default("").description("Optional pinned birth provider; empty = leave the model untouched"),
		model: z.string().default("").description("Optional pinned birth model; empty = leave the model untouched"),
		effort: z.string().default("").description("Optional pinned reasoning effort; empty = provider default")
	})).default([]).description("Exempt plugin-spawned subagents whose birth request matches a rule")),
	forkWindowSlicing: volatileField(z.boolean().default(true).description("Enable Fork active window slicing (for BTW and subagent_fork)")),
	forkWindowTurns: volatileField(z.number().default(3).description("Number of recent turns to retain for fork")),
	showChatModelNotice: volatileField(z.boolean().default(false).description("Show model change notice in chat view"))
}).default({});

/** The plugin's Cordis Config — on DSH 0.1.7+ this IS the settings section. */
export const Config = SUBAGENT_DEFAULT_MODEL_SETTINGS_SCHEMA;

/** State retained on the raw host service while this plugin fiber is active. */
const WRAPPED = Symbol.for("dsh-subagent-role-router.wrapped");

// ── subagent-only error failover ─────────────────────────────────────────────

/**
 * Failure codes that count as "connection failed" (rate limit, quota, server /
 * transport errors, empty responses). Switching on these is safe because a
 * different model/provider may well succeed where the primary just failed.
 */
const FAILOVER_TRIGGER_CODES = ["RATE_LIMIT", "QUOTA", "SERVER", "TIMEOUT", "TRANSPORT", "EMPTY_RESPONSE"];

/**
 * Auth failures, handled SEPARATELY from the connection codes above.
 *
 * `AUTH` (HTTP 401/403 — a bad, expired, or unauthorised key) is not a
 * connectivity problem, so switching on it is only right when the pool entries
 * hold INDEPENDENT credentials. With per-provider keys — the normal setup — one
 * provider's key going bad must not kill the whole delegation while healthy
 * providers sit unused, which is what excluding AUTH entirely used to do.
 *
 * The reason AUTH was originally excluded still stands, though: silently
 * rerouting around a broken key HIDES a misconfiguration. So an AUTH switch is
 * always accompanied by a loud warning naming the provider whose credentials
 * were refused, and pool exhaustion still passes the real error through.
 * Observability replaces suppression.
 *
 * When several entries share ONE credential (e.g. the same env var), switching
 * cannot help — but it also cannot loop: every candidate is tried at most once
 * per run, and exhaustion surfaces the real error.
 */
const AUTH_FAILURE_CODES = ["AUTH", "INVALID_CREDENTIAL"];

/**
 * Failure codes that mean THIS CANDIDATE cannot serve the request at all —
 * not that the connection hiccuped.
 *
 * These matter because a candidate pool is a list of alternatives, and one of
 * them being unusable for this account is a permanent condition, not a blip:
 *
 *   - `UNKNOWN_MODEL` / `NO_ADAPTER` — the provider does not serve that model
 *     (a typo, or a model the gateway renamed).
 *   - `UNSUPPORTED_REASONING_EFFORT` — the route's own declared effort is
 *     rejected by that model, so it can never work as configured.
 *   - `INVALID_CONFIG` — the route itself is malformed.
 *
 * Skipping such a candidate is right, and cooling it down is right too: without
 * it the dead lane keeps winning its turn in the pool (it looks idle, because it
 * never runs long) and every delegation pays one failed round trip first.
 */
const CANDIDATE_UNUSABLE_CODES = ["UNKNOWN_MODEL", "NO_ADAPTER", "UNSUPPORTED_REASONING_EFFORT", "INVALID_CONFIG"];

/**
 * A 400 whose text names the MODEL as the problem — e.g. a gateway answering
 * `model [gpt-6.1-sol] is not allowed for user type [personal_free_user]`.
 *
 * Such a rejection is classified by the adapter as the generic `INVALID_REQUEST`,
 * which must NOT trigger failover on its own: a genuinely malformed request
 * would then burn every candidate before surfacing the real error. Matching the
 * model-naming wordings separates "this model is unavailable to you" (a dead
 * candidate — skip and cool it) from "your request is malformed" (a bug — fail
 * fast). This is a narrow, documented exception to "never route on message".
 */
const MODEL_UNAVAILABLE_PATTERN = /model\s*\[[^\]]*\]\s*(?:is\s+)?not\s+(?:allowed|available|permitted|supported|found)|no\s+such\s+model|unknown\s+model|knows\s+no\s+model|model\s+\S+\s+does\s+not\s+exist|is\s+not\s+allowed\s+for\s+user\s+type/i;

/** True when the failure says this candidate is unusable rather than unreachable. */
export function isUnusableCandidate(failure) {
	if (failure === void 0) return false;
	if (CANDIDATE_UNUSABLE_CODES.includes(failure.code)) return true;
	if (failure.code !== "INVALID_REQUEST") return false;
	return typeof failure.message === "string" && MODEL_UNAVAILABLE_PATTERN.test(failure.message);
}

/** Every failure code that may trigger a switch. */
const FAILOVER_ELIGIBLE_CODES = [...FAILOVER_TRIGGER_CODES, ...AUTH_FAILURE_CODES];

/** True when a failure code is an auth-class failure (picks the log wording). */
function isAuthFailure(code) {
	return AUTH_FAILURE_CODES.includes(code);
}

/** Resolve one model entry to `{provider, model}`, or undefined. */
function resolveEntry(section, entry) {
	if (typeof entry === "string") {
		if (entry.length === 0) return void 0;
		if (typeof section.provider !== "string" || section.provider.length === 0) return void 0;
		return { provider: section.provider, model: entry };
	}
	if (entry !== null && typeof entry === "object") {
		if (typeof entry.provider !== "string" || entry.provider.length === 0) return void 0;
		if (typeof entry.model !== "string" || entry.model.length === 0) return void 0;
		const resolved = { provider: entry.provider, model: entry.model };
		if (typeof entry.reasoningEffort === "string" && entry.reasoningEffort.length > 0) {
			resolved.reasoningEffort = entry.reasoningEffort;
		}
		return resolved;
	}
	return void 0;
}

/** Pick the next default model from the live settings section, or undefined to inherit the parent route. */
function defaultModel(state) {
	const section = state.getSection?.();
	if (section === void 0 || section === null) return void 0;

	// Multi-model list wins; pick per strategy.
	const entries = Array.isArray(section.models) ? section.models.filter((entry) => resolveEntry(section, entry) !== void 0) : [];
	if (entries.length > 0) {
		const picked = section.strategy === "random"
			? entries[Math.floor(Math.random() * entries.length)]
			: entries[state.rrCursor++ % entries.length];
		return resolveEntry(section, picked);
	}

	// Single-model form (backward compatible).
	if (typeof section.model === "string" && section.model.length > 0) {
		if (typeof section.provider !== "string" || section.provider.length === 0) return void 0;
		const result = { provider: section.provider, model: section.model };
		if (typeof section.reasoningEffort === "string" && section.reasoningEffort.length > 0) {
			result.reasoningEffort = section.reasoningEffort;
		}
		return result;
	}

	return void 0;
}


function extractPromptText(prompt) {
	if (typeof prompt === "string") return prompt;
	if (Array.isArray(prompt)) {
		return prompt.map((b) => (b && typeof b.text === "string" ? b.text : "")).join(" ");
	}
	return "";
}

function detectRole(label, prompt) {
	const text = (label || "") + " " + extractPromptText(prompt);
	const lower = text.toLowerCase();
	if (/\[\s*explore\s*\]|^explore\b|role\s*:\s*explore|【探索】|探索[:：]/.test(lower) || /\[\s*scout\s*\]|^scout\b/.test(lower)) return "explore";
	if (/\[\s*plan\s*\]|^plan\b|role\s*:\s*plan|【规划】|规划[:：]/.test(lower) || /\[\s*planner\s*\]|^planner\b/.test(lower)) return "plan";
	if (/\[\s*patch\s*\]|^patch\b|role\s*:\s*patch|【修补】|修补[:：]/.test(lower) || /\[\s*coder\s*\]|^coder\b/.test(lower)) return "patch";

	// BTW ("旁问") is read-only exploration / question answering
	if (label && label.startsWith("michengai-btw:")) return "explore";

	if (/\b(explore|scout|investigate|audit|explain|analyze|review)\b/.test(lower) || /探索|调研|排查|侦察|解释|不理解|怎么回事|分析|审查/.test(text)) return "explore";
	if (/\b(plan|architect|design)\b/.test(lower) || /规划|架构|方案|设计/.test(text)) return "plan";
	if (/\b(patch|implement|fix|refactor|write_code)\b/.test(lower) || /修补|编写|修改代码|实现|落地/.test(text)) return "patch";
	
	// In 3-role mode, all unclassified subagent tasks default to the General-purpose (patch) role!
	return "patch";
}

function getSafeDenyList(parent, desiredDeny) {
	try {
		const tools = parent?.ctx?.get?.("tools");
		if (tools && typeof tools.view === "function") {
			const restrictable = tools.view(parent)?.restrictableNames;
			if (restrictable && typeof restrictable.has === "function") {
				return desiredDeny.filter((name) => restrictable.has(name));
			}
		}
	} catch (_e) {}
	return [];
}

/** The per-role candidate-pool field names. */
const ROLE_POOL_FIELDS = {
	explore: "exploreModels",
	plan: "planModels",
	patch: "patchModels"
};

/** The legacy single-value field names per role: `[provider, model, effort]`. */
const ROLE_SINGLE_FIELDS = {
	explore: ["exploreProvider", "exploreModel", "exploreEffort"],
	plan: ["planProvider", "planModel", "planEffort"],
	patch: ["patchProvider", "patchModel", "patchEffort"]
};

/**
 * Resolve one role's ordered candidate list.
 *
 * Order of precedence:
 *   1. the `*Models` array (the new spillover pool) — filtered to usable entries
 *   2. the legacy single `*Provider`/`*Model`/`*Effort` triple, as a 1-item pool
 *   3. an empty list, which makes the caller fall back to the base model pool
 *
 * Returning an ARRAY (not a single route) is the whole point: the same function
 * serves a 1-lane role exactly like the old single-value form, so nothing
 * changes for a user who never touches the new fields.
 *
 * @param {object|undefined} section - the live settings section.
 * @param {string} role - `"explore" | "plan" | "patch"`.
 * @returns {Array<{provider: string, model: string, reasoningEffort?: string}>}
 */
export function resolveRolePool(section, role) {
	if (!section) return [];
	const field = ROLE_POOL_FIELDS[role];
	const declared = field === void 0 ? void 0 : section[field];
	if (Array.isArray(declared)) {
		const entries = declared.map((entry) => resolveEntry(section, entry)).filter((entry) => entry !== void 0);
		if (entries.length > 0) return entries;
	}
	// Legacy single-value fallback (also covers a pool whose rows are all blank).
	const single = resolveRoleRoute(section, role);
	return single === void 0 ? [] : [single];
}

function resolveRoleRoute(section, role) {
	if (!section) return void 0;
	let p = "", m = "", e = "";
	if (role === "explore") {
		p = section.exploreProvider;
		m = section.exploreModel;
		e = section.exploreEffort;
	} else if (role === "plan") {
		p = section.planProvider;
		m = section.planModel;
		e = section.planEffort;
	} else if (role === "patch") {
		p = section.patchProvider;
		m = section.patchModel;
		e = section.patchEffort;
	}
	if (!m) return void 0;
	const route = { model: m };
	if (p) route.provider = p;
	if (e) route.reasoningEffort = e;
	return route;
}

// ── role candidate pools: lanes, spillover, cooldowns ────────────────────────

/** Stable map key for one resolved route. */
function routeKey(route) {
	return `${route.provider}/${route.model}`;
}

/**
 * Pick one entry from a role's candidate pool.
 *
 * The selection rule, in order:
 *
 *   1. Drop every entry whose cooldown has not expired — a model that just
 *      failed (rate limit, quota, transport, auth…) should not be handed the
 *      next task straight away.
 *   2. If that leaves NOTHING, ignore the cooldowns rather than refusing the
 *      delegation. A degraded route beats a dead subagent, and the warning
 *      makes the degradation visible instead of silent.
 *   3. Among the survivors, take the smallest in-flight count — i.e. fill the
 *      free lanes before sharing work.
 *   4. Break ties by the ORIGINAL index, so the extra task lands on lane 1 and
 *      not on a later lane that happens to look equally idle. This is what
 *      turns "3 lanes, 4 concurrent tasks" into 2/1/1 instead of 1/1/2.
 *
 * @param {object} state - the plugin state holding `slots` and `cooldowns`.
 * @param {Array<object>} entries - resolved candidate routes, in declared order.
 * @returns {{entry: object, index: number}|undefined} the pick.
 */
function pickPoolEntry(state, entries) {
	if (!Array.isArray(entries) || entries.length === 0) return void 0;
	const now = Date.now();
	const usable = entries
		.map((entry, index) => ({ entry, index }))
		.filter(({ entry }) => (state.cooldowns.get(routeKey(entry)) ?? 0) <= now);

	let candidates = usable;
	if (candidates.length === 0) {
		// Everything is cooling down. Keep serving, but say so.
		state.onCoolingExhausted?.();
		candidates = entries.map((entry, index) => ({ entry, index }));
	}

	let best = candidates[0];
	for (const candidate of candidates) {
		const load = state.slots.get(routeKey(candidate.entry)) ?? 0;
		const bestLoad = state.slots.get(routeKey(best.entry)) ?? 0;
		if (load < bestLoad || (load === bestLoad && candidate.index < best.index)) best = candidate;
	}
	return best;
}

/**
 * Reserve one lane of a role pool and produce the lease that gives it back.
 *
 * Lane accounting has to survive every exit path of a delegation:
 *
 *   - the normal one: the returned receipt carries a `result` promise, which
 *     settles when the child finishes; the count is released there.
 *   - the failing one: `startActivation` may throw before any receipt exists,
 *     so the caller releases immediately instead of leaking a lane forever.
 *
 * A leaked lane would be worse than a crash: after `maxActiveSubagents`
 * failures the pool would look permanently full and every later task would be
 * spread evenly instead of filling the first free lane.
 *
 * @param {object} state - plugin state.
 * @param {object} entry - the reserved route.
 * @param {string} role - the role this lane belongs to.
 * @returns {{release: () => void, bind: (receipt?: object) => void, entry: object}} the lease.
 */
function acquireLane(state, entry, role) {
	const key = routeKey(entry);
	state.slots.set(key, (state.slots.get(key) ?? 0) + 1);
	let released = false;
	const give = () => {
		if (released) return;
		released = true;
		const left = (state.slots.get(key) ?? 1) - 1;
		if (left > 0) state.slots.set(key, left);
		else state.slots.delete(key);
	};
	return {
		entry,
		/**
		 * Hold the lane until the child settles, then give it back.
		 *
		 * `subagent/end` is emit-only and cannot be awaited from a plugin, so the
		 * receipt's `result` promise is the one settle signal available. A child
		 * that never settles keeps its lane occupied — by design: that lane IS
		 * busy, and the pool then shares work across the remaining lanes instead
		 * of pretending the stuck model is free.
		 *
		 * @param {object} receipt - the value returned by startActivation.
		 */
		bind(receipt) {
			if (receipt?.childId !== void 0) state.roleOfChild.set(receipt.childId, role);
			const result = receipt?.result;
			if (result === void 0 || result === null || typeof result.then !== "function") {
				// No settle signal: give the lane back at once rather than leak it.
				give();
				return;
			}
			Promise.resolve(result).then(give, give);
		},
		/** Give the lane back immediately (dispatch threw before a receipt existed). */
		release() {
			give();
		}
	};
}

/**
 * Route one delegation request onto a role candidate pool.
 *
 * Returns the request to dispatch plus, when a lane was reserved, the lease
 * that returns it. Everything that must NOT take a lane leaves `lease`
 * undefined: agent-teams members, and requests that already name a model
 * (those are explicit user choices, not pool traffic).
 *
 * @param {object} state - plugin state.
 * @param {object} request - the delegation request.
 * @param {string} [label] - the delegation label (role detection input).
 * @param {boolean} [reserve] - reserve a lane (default true). Pass `false` for
 *   callers that cannot observe settlement — a fork/BTW branch, for example,
 *   hands back no receipt, so reserving a lane there would leak it.
 * @returns {{request: object, lease?: object}} routed request and optional lease.
 */
function routeDelegation(state, request, label, reserve = true) {
	if (!request || teamIdentity(label || request.label, request.persona)) return { request };
	// Token/depth controls alone are not an explicit model selection.
	const explicit = request.agentOptions;
	if (explicit?.model || explicit?.provider) return { request };

	const section = state.getSection?.();
	const role = detectRole(label || request.label, request.prompt);
	const pool = section?.roleMode === true ? resolveRolePool(section, role) : [];
	const picked = pool.length > 0 ? pickPoolEntry(state, pool) : void 0;
	if (picked === void 0) {
		// Base pool / single-model form: unchanged behaviour, no lane involved.
		const route = defaultModel(state);
		if (!route) return { request };
		return { request: { ...request, agentOptions: { ...explicit, ...route } } };
	}
	const lease = reserve ? acquireLane(state, picked.entry, role) : void 0;
	const routed = { ...request, agentOptions: { ...explicit, ...picked.entry } };
	return { request: routed, lease };
}

/** Inject the default model or role-specific route into one delegation request unless it already names one. */
function applyDefaultModel(state, request, label) {
	return routeDelegation(state, request, label).request;
}


// ── subagent-only error failover ─────────────────────────────────────────────

/** Read the live failover view: the switch pool and the strategy. */
function failoverView(state, agent) {
	const section = state.getSection?.();
	if (section === void 0 || section === null) return void 0;
	if (section.failoverEnabled === false) return void 0;
	// An exempt plugin child runs on whatever it was born with (or on the route
	// its plugin pinned): switching it mid-run would break exactly the promise
	// the exemption list makes.
	if (agent !== void 0 && isExemptAgent(state, agent)) return void 0;
	// An explicit pick from the Web UI wins over the automatic switch. Silently
	// rerouting a model the user just named is the exact complaint this feature
	// exists to fix, and the cooldown bookkeeping would then blame the candidate
	// the user chose for a failure that belongs to the route being left behind.
	if (agent !== void 0 && state.childRoutes.has(agent.id)) return void 0;
	// A subagent that was placed on a ROLE pool must fail over INSIDE that pool:
	// its lanes are the alternatives the user actually chose for this kind of
	// work. Falling back to the base pool here would silently drag a general-
	// purpose task onto an unrelated model that the role was configured to avoid.
	const role = agent === void 0 ? void 0 : state.roleOfChild.get(agent.id);
	const rolePool = section.roleMode === true && role !== void 0 ? resolveRolePool(section, role) : [];
	const entries = rolePool.length >= 2
		? rolePool
		: (Array.isArray(section.models)
			? section.models.map((entry) => resolveEntry(section, entry)).filter((entry) => entry !== void 0)
			: []);
	// A pool of <2 models has nothing to switch to; keep the parent route.
	if (entries.length < 2) return void 0;
	return { entries, strategy: section.strategy === "random" ? "random" : "round-robin" };
}

/** True only for a SUBAGENT-origin agent (the durable session header marker). */
function teamIdentity(label, persona) {
	return (typeof label === "string" && label.startsWith("agent-teams:"))
		|| (typeof persona === "string" && (persona.includes("AgentTeams") || persona.includes("agent-teams")));
}

/**
 * Resolve the birth model for an agent-teams spawn, or undefined when unset.
 *
 * Kept deliberately separate from `routeDelegation`: team spawns never take
 * lanes, cooldowns, or failover — the birth model is the ONLY thing applied.
 */
export function teamBirthModel(state) {
	const section = state.getSection?.();
	if (!section) return void 0;
	const provider = typeof section.teamModelProvider === "string" ? section.teamModelProvider : "";
	const model = typeof section.teamModelName === "string" ? section.teamModelName : "";
	if (provider === "" || model === "") return void 0;
	const effort = typeof section.teamModelEffort === "string" ? section.teamModelEffort : "";
	return effort === "" ? { provider, model } : { provider, model, reasoningEffort: effort };
}

// ── native whitelist, derived from this page ────────────────────────────────
//
// DSH ships its own gate: `subagent-model-selection-settings` decides whether a
// child may name a model at all (its `provider`/`model`/`reasoning_effort`
// parameters vanish from the tool schema when it is off) and which routes it
// may name (`allowedModels`). Left alone it forces the same routes to be typed
// twice — once in this page's pools, once in that gate — and the two drift.
//
// So this page is the source of truth: every model configured here (base pool,
// the three role pools, the team birth model) is mirrored into the native
// whitelist. A route that is not on this page therefore stays unreachable for a
// child, which is exactly the guarantee we want — the child may choose *within*
// what the user approved, never outside it.
const NATIVE_WHITELIST_ID = "subagent-model-selection-settings";

/**
 * Every distinct `provider/model` this page configures, in page order.
 *
 * @param {object|undefined} section - the live settings section.
 * @returns {Array<{provider: string, model: string}>} deduplicated exact routes.
 */
export function hostWhitelistModels(section) {
	if (!section) return [];
	const out = [];
	const seen = new Set();
	const add = (entry) => {
		if (!entry || typeof entry.provider !== "string" || typeof entry.model !== "string") return;
		const provider = entry.provider.trim();
		const model = entry.model.trim();
		if (provider === "" || model === "") return;
		const key = `${provider}\u0000${model}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ provider, model });
	};
	if (Array.isArray(section.models)) {
		for (const entry of section.models) add(resolveEntry(section, entry));
	}
	if (typeof section.provider === "string" && typeof section.model === "string") {
		add({ provider: section.provider, model: section.model });
	}
	for (const role of ["explore", "plan", "patch"]) {
		for (const entry of resolveRolePool(section, role)) add(entry);
	}
	add(teamBirthModel({ getSection: () => section }));
	return out;
}

/**
 * Compare two route lists as sets (the native gate keeps its own order).
 *
 * @param {Array<{provider?: string, model?: string}>|undefined} left - current gate routes.
 * @param {Array<{provider: string, model: string}>} right - desired routes.
 * @returns {boolean} true when both describe the same set of exact routes.
 */
export function sameWhitelist(left, right) {
	const keyOf = (entry) => (entry === null || typeof entry !== "object" ? "" : `${String(entry.provider ?? "")}\u0000${String(entry.model ?? "")}`);
	const a = new Set(Array.isArray(left) ? left.map(keyOf) : []);
	const b = new Set(right.map(keyOf));
	if (a.size !== b.size) return false;
	for (const key of b) if (!a.has(key)) return false;
	return true;
}

/**
 * Mirror this page's models into the native subagent whitelist.
 *
 * Idempotent and cheap in the steady state: it reads the gate first and writes
 * only when the enabled flag or the route set actually differs, so a spawn does
 * not rewrite the profile on every delegation.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} state - the plugin state (for `getSection`).
 * @returns {Promise<{synced: boolean, reason?: string, models?: Array<object>}>} outcome.
 */
export async function syncHostWhitelist(ctx, state) {
	const desired = hostWhitelistModels(state?.getSection?.());
	if (desired.length === 0) return { synced: false, reason: "no-models" };
	const get = (name) => {
		try {
			return typeof ctx?.get === "function" ? ctx.get(name, false) : void 0;
		} catch (_error) {
			return void 0;
		}
	};
	let current;
	try {
		current = get("subagentModelSelection")?.current?.();
	} catch (_error) {
		// `current()` throws when the gate is enabled with an empty list; treat
		// that as "not in sync yet" and write the real value.
		current = void 0;
	}
	if (current && current.enabled === true && sameWhitelist(current.allowedModels, desired)) {
		return { synced: false, reason: "in-sync" };
	}
	const settings = get("settings");
	if (!settings || typeof settings.update !== "function") return { synced: false, reason: "no-settings" };
	await settings.update(NATIVE_WHITELIST_ID, { enabled: true, allowedModels: desired });
	return { synced: true, models: desired };
}

/**
 * Fire-and-forget wrapper: a settings write must never delay or fail a spawn.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} state - the plugin state.
 * @param {(error: unknown) => void} [onError] - optional reporter.
 * @returns {void}
 */
function syncHostWhitelistSoon(ctx, state, onError) {
	// Remember the last attempt so `/subagent-role-router/whitelist` can explain a
	// silent failure (the host logger is not always visible while developing).
	const record = (outcome, error) => {
		state.lastWhitelistSync = {
			at: new Date().toISOString(),
			outcome,
			error: error === void 0 ? void 0 : String(error?.message ?? error)
		};
	};
	try {
		const pending = syncHostWhitelist(ctx, state);
		if (pending !== null && typeof pending === "object" && typeof pending.catch === "function") {
			pending.then(
				(outcome) => record(outcome),
				(error) => {
					record(void 0, error);
					if (onError) onError(error);
				}
			);
		}
	} catch (error) {
		record(void 0, error);
		if (onError) onError(error);
	}
}

// ── delegated model names: display name vs model id ─────────────────────────
//
// A provider's catalog has TWO strings per model: the id the runtime accepts
// (`group/dnq`) and the display name a human reads (`dnq`, shown in the picker
// as "dnq · routing group"). A parent Agent that was told "use dnq" naturally
// sends `model: "dnq"`, and then the delegation tool's preflight asks the
// adapter for that exact id, gets "no such model", and the call fails before a
// child exists. The tool cannot see the mistake; the human only sees a refusal.
//
// So repair the arguments on the way in: a bare display name that matches
// exactly ONE configured route (by its id tail) is rewritten to that route.
// Unique-only on purpose — an ambiguous short name is left alone so the real
// error still surfaces instead of a silent wrong pick.

/** Tools that take a child `provider`/`model` pair. */
const DELEGATION_TOOLS = new Set(["subagent", "subagent_fork", "spawn_teammate"]);

/** True when this tool call may carry a child route. */
function isDelegationTool(name) {
	return typeof name === "string" && (DELEGATION_TOOLS.has(name) || name.startsWith("subagent"));
}

/**
 * Decide the exact model id a short (display) name refers to.
 *
 * Pure on purpose: the callers below apply the result, because the scheduler
 * may hand us a frozen arguments object that silently refuses writes.
 *
 * @param {object} state - the plugin state (for `getSection`).
 * @param {object} args - the tool arguments (read only).
 * @returns {{before: string, provider: string, model: string}|undefined} the resolved route, if unambiguous.
 */
export function planDelegatedModelRoute(state, args) {
	if (args === null || typeof args !== "object") return void 0;
	const rawModel = typeof args.model === "string" ? args.model.trim() : "";
	if (rawModel === "" || rawModel.includes("/")) return void 0;
	const rawProvider = typeof args.provider === "string" ? args.provider.trim() : "";
	const routes = hostWhitelistModels(state?.getSection?.());
	if (routes.length === 0) return void 0;
	const wanted = rawModel.toLowerCase();
	const matches = routes.filter((route) => {
		if (rawProvider !== "" && route.provider !== rawProvider) return false;
		const id = route.model.toLowerCase();
		return id === wanted || id.endsWith(`/${wanted}`);
	});
	if (matches.length !== 1) return void 0;
	const target = matches[0];
	if (args.model === target.model && args.provider === target.provider) return void 0;
	return { before: rawModel, provider: target.provider, model: target.model };
}

/**
 * Apply {@link planDelegatedModelRoute} to an arguments object in place.
 *
 * @param {object} state - the plugin state.
 * @param {object} args - the tool arguments, mutated when repaired.
 * @returns {{before: string, after: string, provider: string}|undefined} the repair, if any.
 */
export function repairDelegatedModelName(state, args) {
	const planned = planDelegatedModelRoute(state, args);
	if (planned === void 0) return void 0;
	args.model = planned.model;
	args.provider = planned.provider;
	return { before: planned.before, after: planned.model, provider: planned.provider };
}

/**
 * Install the argument repair on the tool dispatch waterfall.
 *
 * `tools/execute` hands the mutable execution to every listener before the tool
 * body runs, which is the last point where a wrong model name is still cheap to
 * fix — after this the host has already looked the model up (or refused the
 * route against the Session policy).
 *
 * @param {object} ctx - the plugin context.
 * @param {object} state - the plugin state.
 * @returns {void}
 */
function installDelegationArgumentRepair(ctx, state) {
	ctx.effect(() => ctx.on("tools/execute", (exec, next) => {
		try {
			if (exec && isDelegationTool(exec.name) && exec.arguments !== null && typeof exec.arguments === "object") {
				const args = exec.arguments;
				const planned = planDelegatedModelRoute(state, args);
				state.routeSeen = Array.isArray(state.routeSeen) ? state.routeSeen : [];
				state.routeSeen.push({ name: String(exec.name), provider: args.provider ?? null, model: args.model ?? null, planned: planned === void 0 ? null : planned.model });
				if (state.routeSeen.length > 8) state.routeSeen.shift();
				if (planned !== void 0) {
					// Replace the whole object first: the scheduler may freeze it, and a
					// silent failed write would let the host reject a name we could have
					// translated.
					try {
						exec.arguments = { ...args, provider: planned.provider, model: planned.model };
					} catch (_error) {
						// Fall back to in-place mutation for a non-writable execution.
					}
					try {
						exec.arguments.provider = planned.provider;
						exec.arguments.model = planned.model;
					} catch (_error) {
						// Best effort only; the replacement above is the real fix.
					}
					ctx.logger.info(`[dsh-subagent-role-router] used model id "${planned.model}" for the short name "${planned.before}"`);
				}
			}
		} catch (_error) {
			// A repair must never fail a tool call it was not asked to touch.
		}
		return next();
	}));
}

// ── plugin exemption list ────────────────────────────────────────────────────
//
// The identity fields a SPAWN carries (see dsh-egm's goldfish dispatch):
//
//     startActivation({ provider: "spawn", label: "egm-goldfish-logic",
//       request: { parent, prompt, agentPreset: "egm-goldfish-0.2.0", cwd: "…\.egm\review-XXXX" } })
//
// `label` reaches the wrapper as `spec.label`; `agentPreset` and `cwd` ride on
// `spec.request`. All three are read at the same seam that already decides
// lanes and roles, so exemption costs no extra hooking. At REQUEST time the
// only durable identity is the label (SessionHeader or the child's own
// `subagent/descriptor` event — the same two sources `isTeamAgent` reads), so
// failover exemption matches on the label rules alone.

/** True when one rule's pattern is a prefix of the identity field it names. */
export function ruleMatches(rule, identity) {
	const pattern = typeof rule?.pattern === "string" ? rule.pattern.trim() : "";
	if (pattern === "") return false;
	const kind = rule?.match === "preset" || rule?.match === "cwd" ? rule.match : "label";
	const value = identity?.[kind];
	return typeof value === "string" && value.startsWith(pattern);
}

/** Collect the birth identity a spawn wrapper can see for one request. */
function birthIdentity(spec, request) {
	return {
		label: (spec && typeof spec.label === "string" && spec.label) || (request && typeof request.label === "string" && request.label) || "",
		preset: request?.agentPreset,
		cwd: request?.cwd
	};
}

/** The first exemption rule matching this spawn's birth identity, or undefined. */
export function exemptRuleForBirth(state, spec, request) {
	const section = state.getSection?.();
	const rules = section && Array.isArray(section.exemptRules) ? section.exemptRules : [];
	if (rules.length === 0) return void 0;
	const identity = birthIdentity(spec, request);
	for (const rule of rules) {
		if (ruleMatches(rule, identity)) return rule;
	}
	return void 0;
}

/** The optional birth model a matched rule pins; undefined = leave the model alone. */
export function exemptBirthModel(rule) {
	if (!rule) return void 0;
	const provider = typeof rule.provider === "string" ? rule.provider : "";
	const model = typeof rule.model === "string" ? rule.model : "";
	if (provider === "" || model === "") return void 0;
	const effort = typeof rule.effort === "string" ? rule.effort : "";
	return effort === "" ? { provider, model } : { provider, model, reasoningEffort: effort };
}

// ── observed birth identities: the point-and-pick source for exempt rules ──
//
// Every spawn crosses the wrapper, so the plugin SEES each child's birth
// identity. Recording them (persisted across restarts) lets the settings
// editor offer real prefixes to pick from instead of asking the user to type
// one. Labels are kept verbatim; preset ids embed a version
// (egm-goldfish-0.2.0), so the suggestion strips it — the version-less prefix
// keeps matching after a plugin upgrade.
const birthSeen = new Map();
let birthSeenPath = join(process.env.USERPROFILE || process.env.HOME || "", ".dsh", "subagent-role-router-candidates.json");
const BIRTH_SEEN_LIMIT = 200;

/** Test seam: point the persistence file somewhere disposable. */
export function setBirthSeenPath(next) {
	birthSeenPath = typeof next === "string" && next !== "" ? next : birthSeenPath;
}

function persistBirthSeen() {
	try {
		fs.writeFileSync(birthSeenPath, JSON.stringify([...birthSeen.values()]));
	} catch (_e) {}
}

/** Record one spawn's birth identity for the editor's candidate list. */
export function noteBirthSeen(spec, request) {
	const identity = birthIdentity(spec, request);
	for (const kind of ["label", "preset", "cwd"]) {
		const value = identity[kind];
		if (typeof value !== "string" || value.trim() === "") continue;
		const key = kind + "|" + value;
		const prior = birthSeen.get(key);
		birthSeen.set(key, { kind, value, count: (prior?.count ?? 0) + 1, lastSeen: Date.now() });
	}
	while (birthSeen.size > BIRTH_SEEN_LIMIT) {
		let oldest = null;
		for (const item of birthSeen.values()) {
			if (oldest === null || item.lastSeen < oldest.lastSeen) oldest = item;
		}
		if (oldest === null) break;
		birthSeen.delete(oldest.kind + "|" + oldest.value);
	}
	persistBirthSeen();
}

function loadBirthSeen() {
	try {
		const raw = JSON.parse(fs.readFileSync(birthSeenPath, "utf8"));
		if (!Array.isArray(raw)) return;
		for (const item of raw) {
			if (!item || typeof item.kind !== "string" || typeof item.value !== "string") continue;
			if (item.kind !== "label" && item.kind !== "preset" && item.kind !== "cwd") continue;
			birthSeen.set(item.kind + "|" + item.value, {
				kind: item.kind,
				value: item.value,
				count: Number(item.count) || 0,
				lastSeen: Number(item.lastSeen) || 0
			});
		}
	} catch (_e) {}
}
loadBirthSeen();

/** Deduped, ranked suggestions for the editor's pick list (cap 50). */
export function birthSeenSuggestions() {
	const versionless = (value) => value.replace(/-\d+(\.\d+)*$/, "");
	const merged = new Map();
	for (const item of birthSeen.values()) {
		const value = item.kind === "preset" ? versionless(item.value) : item.value;
		if (value === "") continue;
		const key = item.kind + "|" + value;
		const prior = merged.get(key);
		merged.set(key, {
			kind: item.kind,
			value,
			count: (prior?.count ?? 0) + item.count,
			lastSeen: Math.max(item.lastSeen, prior?.lastSeen ?? 0)
		});
	}
	return [...merged.values()]
		.sort((a, b) => b.lastSeen - a.lastSeen || b.count - a.count)
		.slice(0, 50);
}

/** The durable label of a live child: its header, else its own descriptor event. */
function childExemptLabel(agent) {
	const session = agent?.session;
	if (!session) return void 0;
	const headerLabel = session.header?.label;
	if (typeof headerLabel === "string" && headerLabel !== "") return headerLabel;
	const events = session.snapshotEvents?.();
	if (!Array.isArray(events)) return void 0;
	const boundary = session.inheritedEventCount ?? session.header?.inheritedEventCount ?? 0;
	for (let i = events.length - 1; i >= boundary; i--) {
		if (events[i]?.type === "subagent/descriptor") {
			const label = events[i].data?.label;
			if (typeof label === "string" && label !== "") return label;
		}
	}
	return void 0;
}

/** True when a RUNNING child's own label matches a label-kind exemption rule. */
export function isExemptAgent(state, agent) {
	const section = state.getSection?.();
	if (!section || !Array.isArray(section.exemptRules) || section.exemptRules.length === 0) return false;
	const label = childExemptLabel(agent);
	if (typeof label !== "string" || label === "") return false;
	for (const rule of section.exemptRules) {
		if (ruleMatches(rule, { label })) return true;
	}
	return false;
}

function isTeamAgent(agent) {
	const session = agent?.session;
	if (!session) return false;
	if (teamIdentity(session.header?.label, session.header?.persona)) return true;
	// Labels live in the child's own descriptor, not in SessionHeader.
	const events = session.snapshotEvents?.();
	if (!Array.isArray(events)) return false;
	const boundary = session.inheritedEventCount ?? session.header?.inheritedEventCount ?? 0;
	for (let i = events.length - 1; i >= boundary; i--) {
		if (events[i]?.type === "subagent/descriptor") {
			return teamIdentity(events[i].data?.label, events[i].data?.persona);
		}
	}
	return false;
}

function isSubagentAgent(agent) {
	if (agent === void 0 || agent === null || agent.session?.header?.origin !== "subagent") return false;
	// Exempt agent-teams from failover and prompt injection
	if (isTeamAgent(agent)) return false;
	return true;
}

/**
 * True for ANY child created by the subagents service — plain subagents AND
 * agent-teams members (they spawn through the same `startActivation` with
 * `delivery: "parent"`, so their sessions carry the same `origin`). The
 * live-route override serves both: a teammate is just another child the user
 * may want to re-route mid-run, and the automatic failover/cooldown machinery
 * keeps excluding teams via `isSubagentAgent` above.
 */
function isChildAgent(agent) {
	return agent !== void 0 && agent !== null && agent.session?.header?.origin === "subagent";
}


/**
 * Pick the next pool index for one failed subagent request.
 *
 * - round-robin: the next entry after the currently-served model, wrapping
 *   around the list (the "queue"), skipping entries this run already tried so a
 *   single bad candidate is not re-selected while an untried one remains.
 * - random: any entry, without checking whether it was used before — a random
 *   pick may repeat the failing model, which is fine by design (simplest).
 */
function nextFailoverIndex(view, agent, current) {
	const { entries, strategy } = view;
	if (strategy === "random") {
		return Math.floor(Math.random() * entries.length);
	}
	const tried = current?.tried;
	if (current !== void 0) {
		// Advance from the last pick, taking the first entry this run has not used.
		for (let step = 1; step <= entries.length; step += 1) {
			const candidate = (current.index + step) % entries.length;
			if (tried === void 0 || !tried.has(candidate)) return candidate;
		}
		return (current.index + 1) % entries.length;
	}
	// First failure: locate the served route in the pool and move to the next.
	const served = agent.session?.requestContext?.();
	const found = served === void 0 ? -1 : entries.findIndex((entry) =>
		entry.provider === served.provider && entry.model === served.model
	);
	if (found < 0) return 0;
	// Start after the served entry, preferring one this run has not used.
	for (let step = 1; step <= entries.length; step += 1) {
		const candidate = (found + step) % entries.length;
		if (tried === void 0 || !tried.has(candidate)) return candidate;
	}
	return (found + 1) % entries.length;
}

/**
 * Put the route a subagent just failed on into cooldown.
 *
 * The route is read from the agent's own request context rather than from the
 * failure payload, because the payload names only the provider — and a
 * cooldown has to be per provider+model to be useful (two models on the same
 * provider rarely fail together).
 *
 * `roleSlotCooldownSeconds <= 0` disables cooling entirely: failures still fall
 * through to the next candidate, they just do not remove the failed model from
 * later rotations. That is the documented "0 = off" setting, not an edge case.
 *
 * @param {object} ctx - plugin context (logger).
 * @param {object} state - plugin state (cooldowns, settings).
 * @param {object} agent - the failing subagent.
 * @param {object} failure - `{ code, message }` from the loop.
 */
function noteCooldown(ctx, state, agent, failure) {
	const seconds = Number(state.getSection?.()?.roleSlotCooldownSeconds ?? 15);
	if (!Number.isFinite(seconds) || seconds <= 0) return;
	const served = agent?.session?.requestContext?.();
	if (served === void 0 || served === null) return;
	if (typeof served.provider !== "string" || typeof served.model !== "string") return;
	const route = { provider: served.provider, model: served.model };
	state.cooldowns.set(routeKey(route), Date.now() + seconds * 1000);
	ctx.logger.warn(
		`[dsh-subagent-role-router] %s/%s failed with %s; skipping it for new delegations for %ds`,
		route.provider,
		route.model,
		failure?.code ?? "(unknown)",
		seconds
	);
}

/**
 * Install the subagent-only failover waterfalls. Both listeners no-op for the
 * main agent (origin gate) and for subagents whose failure code is not a
 * connection failure, so a broken subagent primary is re-tried on the next
 * pool model without ever touching the parent loop. State is keyed per
 * subagent run (`agent.id`) and cleaned on `agent/disposed`, so a persistently
 * broken primary is not re-tried on every step of the same run.
 */
function installFailover(ctx, state) {
	const pending = new Map();

	// After a model failure on a subagent loop: advance the pool index and ask
	// the loop to rebuild the request (`{ kind: "retry" }`). When every pool
	// entry has been tried, let the real error surface untouched.
	const disposeRequestError = ctx.on("agent/request-error", (payload, next) => {
		const { agent, turn, step, failure, signal } = payload;
		if (signal?.aborted) return next();
		if (!isSubagentAgent(agent)) return next();
		if (failure === void 0) return next();
		// Two ways in: the route was unreachable (rate limit, quota, transport…)
		// or the route cannot serve this request at all (model not allowed for
		// this account, unknown model, unsupported effort). The second class is
		// skipped-and-cooled exactly like the first — see CANDIDATE_UNUSABLE_CODES.
		if (!FAILOVER_ELIGIBLE_CODES.includes(failure.code) && !isUnusableCandidate(failure)) return next();
		// An exempt plugin child must not even COOL its route down: its failure
		// says nothing about the model's health for everyone else, and a cooldown
		// recorded here would silently skew the next ordinary delegation.
		if (isExemptAgent(state, agent)) return next();
		// Cool the failing route down BEFORE deciding whether anything can be
		// switched to: a role pool with a single lane cannot fail over at all,
		// yet its model still deserves to be skipped by the NEXT delegation
		// instead of being handed the next task while it is still rate-limited.
		noteCooldown(ctx, state, agent, failure);
		const view = failoverView(state, agent);
		if (view === void 0) return next();
		const current = pending.get(agent.id);
		// The primary already failed (that triggered the first switch), so the
		// remaining candidates are the other pool entries: at most
		// `entries.length - 1` switches, then let the real error surface.
		if (current !== void 0 && current.count >= view.entries.length - 1) return next(); // pool exhausted
		const index = nextFailoverIndex(view, agent, current);
		// Remember every pool entry this run has already been switched to, so a
		// candidate that fails again is not selected a second time.
		const tried = new Set(current?.tried ?? []);
		tried.add(index);
		pending.set(agent.id, {
			index,
			tried,
			count: (current?.count ?? 0) + 1
		});
		ctx.logger.warn(
			`[dsh-subagent-role-router] subagent %s failed with %s on turn %d step %d; switching to %s/%s (attempt %d/%d, strategy=%s)`,
			agent.id,
			failure.code,
			turn,
			step,
			view.entries[index].provider,
			view.entries[index].model,
			(current?.count ?? 0) + 1,
			view.entries.length,
			view.strategy
		);
		// An auth switch is called out explicitly: the point of allowing it is
		// resilience, and the risk it introduces is that a broken credential
		// becomes invisible. This line is what keeps it visible — without it,
		// silently rerouting around a bad key would hide a real misconfiguration.
		if (isAuthFailure(failure.code)) {
			ctx.logger.warn(
				`[dsh-subagent-role-router] the credentials for the failing provider ${payload.provider ?? "(unknown)"} were refused (%s). This is NOT a connection problem: that provider's API key is likely invalid, expired, or unauthorised. Failover is switching the subagent to %s/%s — verify that provider's key, because the failure will keep recurring until it is fixed.`,
				failure.code,
				view.entries[index].provider,
				view.entries[index].model
			);
		}
		// An unusable candidate is a CONFIGURATION problem, and unlike a rate
		// limit it will not heal by itself. Say so once per failure, with the
		// offending route named, so the dead row can be fixed or removed instead
		// of quietly burning a slot forever.
		if (isUnusableCandidate(failure)) {
			ctx.logger.warn(
				`[dsh-subagent-role-router] the candidate route %s/%s cannot serve this request (%s: %s). It is cooling down and the subagent is switching to %s/%s — remove or fix that row in the role candidate list, because this failure will repeat on every run.`,
				payload.provider ?? "(unknown)",
				agent?.session?.requestContext?.()?.model ?? "(unknown)",
				failure.code,
				failure.message ?? "(no message)",
				view.entries[index].provider,
				view.entries[index].model
			);
		}
		return { kind: "retry" };
	});

	// On the rebuilt request for that subagent: swap the seed route for the
	// pending pool entry, carrying the target's OWN request controls.
	//
	// The inherited `reasoningEffort` is dropped because it belongs to the route
	// that just failed. The failure this fixes: without re-applying the target's
	// declared effort, the fallback is dispatched with the previous route's
	// thinking mode, and a provider whose thinking level must agree with the
	// effort rejects it with e.g. "invalid thinking type, only be disabled when
	// reasoning effort is none ...". That error is NOT retryable, so the
	// failover burns every remaining candidate on a request that can never
	// succeed — the subagent dies even though a healthy model was available.
	//
	// When the target declares no effort, sending the key as `undefined` is the
	// correct dispatch: the adapter then resolves the model's own
	// `defaultEffort` (or omits the reasoning option entirely), instead of
	// inheriting a level the target may not support.
	const disposeRequest = ctx.on("agent/request", async (payload, next) => {
		const { agent } = payload;
		if (!isSubagentAgent(agent)) return next();
		const current = pending.get(agent.id);
		if (current === void 0) return next();
		const view = failoverView(state, agent);
		if (view === void 0) return next();
		const target = view.entries[current.index];
		if (target === void 0) return next();
		const seed = await next();
		if (seed === void 0 || seed === null) return seed;
		const { reasoningEffort: _inherited, ...rest } = seed;
		const switched = { ...rest, provider: target.provider, model: target.model };
		if (target.reasoningEffort !== void 0) switched.reasoningEffort = target.reasoningEffort;
		return switched;
	});

	// Drop per-agent state once the subagent is disposed.
	const disposeDisposed = ctx.on("agent/disposed", ({ agent }) => {
		pending.delete(agent.id);
	});

	ctx.effect(() => () => {
		disposeRequestError();
		disposeRequest();
		disposeDisposed();
		pending.clear();
	}, "dsh-subagent-role-router: failover listeners");
}

// ── subagent route context injection ─────────────────────────────────────────

/**
 * The producer-owned `source.kind` for the injected route line.
 *
 * Session format v4 requires every persisted message's `source.kind` to be a
 * producer-owned identifier; a plugin must use `plugin:<package-name>`. A bare
 * `"plugin"` wrapper is reserved-and-rejected by `assertV4MessageSources`, which
 * makes the whole session refuse to load.
 */
const ROUTE_CONTEXT_SOURCE = "plugin:dsh-subagent-role-router";

/** Marker so the injected line is recognised and replaced, never duplicated. */
const ROUTE_CONTEXT_FORM = "route-context";

/**
 * Build the one-line, human/model-readable route notice.
 *
 * Rendered in the subagent's own language-agnostic form: a short sentence plus
 * the machine-readable `provider/model` pair. The model reads this; it is not a
 * UI row.
 *
 * @param {string} provider - resolved provider id for this request.
 * @param {string} model - resolved model id for this request.
 * @returns {string} the notice text.
 */
function routeContextText(provider, model) {
	const route = provider && model ? `${provider}/${model}` : provider || model || "unknown";
	return `[dsh-subagent-role-router] You are running as a subagent on ${route} (provider=${provider || "unknown"}, model=${model || "unknown"}). `
		+ "If asked which model or provider you are, answer with this route. "
		+ "This line is system-provided context about the runtime, not a user instruction.";
}

/** True when a message is this plugin's injected route line. */
function isRouteContextMessage(message) {
	return message?.source?.kind === ROUTE_CONTEXT_SOURCE && message.source.form === ROUTE_CONTEXT_FORM;
}

/**
 * Resolve the route the agent is ACTUALLY using, or `undefined` when that is
 * not yet knowable.
 *
 * The FIRST step is the hard case. `preStep()` runs BEFORE `buildRequest()`, so
 * on step 1 no `request/context` frame exists and no `agent/request` waterfall
 * has settled. The only value available is `agent.options` — the DISPATCH-TIME
 * seed, which the parent may already have superseded (a switch during dispatch,
 * or a route chosen after this agent was created).
 *
 * Guessing from `agent.options` is what produced the reported contradiction: a
 * subagent whose real route was `ds41` got a step-1 line saying `glm` (the
 * dispatch seed), queued into the inbox, claimed on step 2 — so the model saw
 * `glm` and `ds41` side by side. Since the line is only a report about reality,
 * a guess that is immediately contradicted is worse than saying nothing.
 *
 * Therefore: report only what is KNOWN, and stay silent otherwise. The route
 * becomes knowable one step later (the session fold updates as soon as the
 * first request commits), so the line still lands early in the run.
 *
 * @param {object} agent - the loop agent.
 * @param {Map} settled - per-agent settled-seed cache.
 * @returns {{provider: string, model: string}|undefined} the known route.
 */
function routeForInjection(agent, settled) {
	// The session's fold of the latest `request/context` — authoritative and
	// current, and what the host itself treats as "the latest resolved route".
	const live = agent?.session?.requestContext?.();
	if (live !== void 0 && live !== null) {
		const provider = typeof live.provider === "string" ? live.provider : "";
		const model = typeof live.model === "string" ? live.model : "";
		if (provider !== "" || model !== "") return { provider, model };
	}
	// A request already built by this plugin's own waterfall: still authoritative
	// for that request, and normally identical to the fold above.
	const captured = settled.get(agent.id);
	if (captured !== void 0) return captured;
	// Nothing has committed yet. Deliberately do NOT fall back to
	// `agent.options`: that is the dispatch seed and is exactly the stale guess
	// this function exists to avoid.
	return void 0;
}

/**
 * Install the subagent route-context injector.
 *
 * WHY THIS EXISTS: the route is chosen by the PARENT (this plugin's dispatch
 * wrapper, an explicit `agentOptions`, or plain inheritance) and by failover
 * switches made mid-run. None of that reaches the child's prompt, so a subagent
 * literally cannot answer "which model are you?" — it only sees the parent's
 * conversation. This injects one line stating the route the child is ACTUALLY
 * using.
 *
 * SOURCE OF TRUTH: see `routeForInjection` — the session's own live route first.
 *
 * Injected on every step whose route differs from the line already present, so
 * a failover switch or a route change is reflected immediately; an unchanged
 * route re-injects nothing, so a long run does not accumulate duplicates.
 *
 * Subagent-only by the same `origin === "subagent"` gate as failover: the main
 * agent's context is never touched.
 */
function installRouteContextInjector(ctx, state) {
	/** Settled route per agent id, captured after `agent/request` resolves. */
	const resolvedRoute = new Map();

	// Capture the SETTLED route once a request has actually been built. Runs
	// AFTER `next()` so it observes the final seed — including this plugin's own
	// failover swap and any other plugin's rewrite.
	const disposeRequest = ctx.on("agent/request", async (payload, next) => {
		const seed = await next();
		const { agent } = payload;
		if (!isSubagentAgent(agent)) return seed;
		if (seed === void 0 || seed === null) return seed;
		const provider = typeof seed.provider === "string" ? seed.provider : "";
		const model = typeof seed.model === "string" ? seed.model : "";
		if (provider === "" && model === "") return seed;
		resolvedRoute.set(agent.id, { provider, model });
		return seed;
	});

	// Inject on the pre-step, where the message list for the step about to run
	// is still mutable and the agent's own route is already known.
	//
	// DEDUPE MUST BE OUT-OF-BAND, NOT "is a copy still pending?".
	// The loop calls `inbox.claim()` at the TOP of `preStep()` — BEFORE this
	// waterfall — and `claim()` DRAINS `next-step`
	// (`mutate("next-step", 0, this.nextStep.length, [], false)`). So by the time
	// this listener runs, the pending list is always empty and a "does a route
	// line already exist in the inbox?" test is structurally always false. An
	// earlier build did exactly that and re-injected on EVERY step: a real
	// 29-step subagent ended up with 28 identical route lines, which also made
	// the reported route churn between turns. Track what was last injected for
	// this agent instead.
	const injectedRoute = new Map();

	const disposePreStep = ctx.on("agent/pre-step", async ({ agent, messages }, next) => {
		const decision = await next();
		if (decision === void 0 || decision === null || decision.kind === "reject") return decision;
		if (state.getSection()?.injectRouteContext === false) return decision;
		if (!isSubagentAgent(agent)) return decision;

		// The live session route wins; see `routeForInjection` for why the
		// dispatch-time `agent.options` must NOT be preferred.
		const route = routeForInjection(agent, resolvedRoute);
		if (route === void 0) return decision;
		// Defensive: only the loop's live Agent exposes an inbox. A test double
		// or a future agent shape without one must not break the step.
		if (agent.inbox === void 0 || !Array.isArray(agent.inbox.nextStep)) return decision;

		const wanted = routeContextText(route.provider, route.model);
		// Same route as last time => the line already placed in this session is
		// still accurate; inject nothing (no duplicate, no churn).
		if (injectedRoute.get(agent.id)?.text === wanted) return decision;

		// Route moved (failover / config change): drop any not-yet-claimed copy so
		// the stale route does not linger beside the fresh one.
		for (const message of agent.inbox.nextStep.filter(isRouteContextMessage)) {
			agent.inbox.remove(message.id);
		}

		const message = createUserMessage({
			content: [{ type: "text", text: wanted }],
			source: { kind: ROUTE_CONTEXT_SOURCE, form: ROUTE_CONTEXT_FORM }
		});
		agent.inbox.prepend("next-step", message);
		injectedRoute.set(agent.id, { text: wanted });
		return decision;
	});

	const disposeDisposed = ctx.on("agent/disposed", ({ agent }) => {
		resolvedRoute.delete(agent.id);
		injectedRoute.delete(agent.id);
	});

	ctx.effect(() => () => {
		disposeRequest();
		disposePreStep();
		disposeDisposed();
		resolvedRoute.clear();
		injectedRoute.clear();
	}, "dsh-subagent-role-router: route context injector");
}

// ── live per-child route override ────────────────────────────────────────────

/**
 * The HTTP prefix this plugin owns on the host web server.
 *
 * WHY A PLUGIN-OWNED PATH instead of the official RPC surface: the host's
 * `session/selectModel` REFUSES subagent sessions outright —
 * `dsh-api-session-controller` short-circuits on
 * `session.header.origin === "subagent"` with `session/agent-busy`
 * ("use subagent delivery for this child session"). That is a deliberate host
 * boundary, not a bug, so a child's model cannot be changed through the normal
 * model-selection RPC. The remaining options were: reuse the typert decorator
 * stack (not importable from an external plugin — the profile only ships
 * `schemastery`/`cosmokit`), register a second `/api` interceptor (rejected:
 * `connection` allows exactly one interceptor per channel), or own a private
 * path. The last one is what several shipped plugins already do
 * (`dsh-client-ui-git-graph` owns `/git`, `dsh-email` owns its own prefix).
 */
const OVERRIDE_PATH = "/subagent-role-router";

/** Bounded request body: this endpoint only ever receives a tiny JSON object. */
const OVERRIDE_MAX_BODY = 8 * 1024;

/**
 * True when the request came from this machine.
 *
 * The route mutates which model a running child talks to, so it must never be
 * reachable from a paired device or the LAN. Same fence as `dsh-git-graph`:
 * a loopback peer address only. `::ffff:127.0.0.1` is the IPv4-mapped form Node
 * reports on dual-stack listeners.
 */
function isLoopbackRequest(req) {
	const address = req?.socket?.remoteAddress;
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function writeJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store"
	});
	res.end(body);
}

function readJsonBody(req) {
	return new Promise((resolve) => {
		let size = 0;
		const chunks = [];
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > OVERRIDE_MAX_BODY) {
				finish(void 0);
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (chunks.length === 0) return finish(void 0);
			try {
				finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				finish(void 0);
			}
		});
		req.on("error", () => finish(void 0));
	});
}

/** Resolve a live subagent agent by its child session id, or undefined. */
function liveSubagent(agents, childId) {
	if (typeof childId !== "string" || childId === "") return void 0;
	const agent = agents?.get?.(childId)
		|| (childId.startsWith("session-") ? agents?.get?.(childId.slice(8)) : agents?.get?.("session-" + childId));
	if (agent === void 0 || agent === null) return void 0;
	return isChildAgent(agent) ? agent : void 0;
}

/**
 * The route a child is actually on, and where that answer came from.
 *
 * `requestContext()` is the session's own fold of the last committed request —
 * the same authoritative source `routeForInjection` uses. An override that has
 * not been applied yet (the child is idle) therefore reports the route the child
 * WILL leave, which is why `override` is reported separately from the live pair.
 */
function describeChildRoute(state, childOrId, maybeAgent) {
	const agent = typeof childOrId === "object" && childOrId !== null ? childOrId : maybeAgent;
	const childId = typeof childOrId === "string" ? childOrId : (agent?.id ?? "");
	const override = state.childRoutes.get(childId)
		|| (typeof childId === "string" && childId.startsWith("session-") ? state.childRoutes.get(childId.slice(8)) : state.childRoutes.get("session-" + childId));
	// READ THE ROUTE FROM THE SAME PLACE THE HOST READS IT.
	//
	// `requestHeader().config` is the header of the request this agent is
	// actually building: provider + model + reasoningEffort. `requestContext()`
	// is only the session's fold of the last COMMITTED request and carries
	// `{provider, model, contextWindow}` — no effort at all. Reading the effort
	// from the fold therefore reported every child as "Default" even while it
	// was really running at `high`, which is exactly the contradiction that was
	// reported back ("I picked an effort in the settings, the call is default").
	const header = agent?.session?.requestHeader?.();
	const config = header?.config;
	const live = agent?.session?.requestContext?.();
	const pick = (key) => {
		const fromHeader = config?.[key];
		if (typeof fromHeader === "string" && fromHeader !== "") return fromHeader;
		const fromLive = live?.[key];
		if (typeof fromLive === "string" && fromLive !== "") return fromLive;
		return "";
	};
	const provider = pick("provider") || (override?.provider ?? "");
	const model = pick("model") || (override?.model ?? "");
	return {
		childId,
		label: typeof agent?.session?.header?.label === "string" ? agent.session.header.label : "",
		provider,
		model,
		reasoningEffort: pick("reasoningEffort") || (override?.reasoningEffort ?? ""),
		override: override === void 0
			? null
			: {
				provider: override.provider,
				model: override.model,
				...(override.reasoningEffort === void 0 ? {} : { reasoningEffort: override.reasoningEffort })
			}
	};
}

/**
 * Install the live route override.
 *
 * WHY A SEPARATE LISTENER, AND WHY IT IS INSTALLED FIRST: cordis waterfalls run
 * listeners in registration order and each one's post-`next()` code unwinds in
 * REVERSE order — so the FIRST registered listener has the LAST word. An
 * explicit pick from the user must beat the automatic failover swap (the user
 * named a model; silently rerouting it would be exactly the "I clicked and
 * nothing happened" complaint this exists to fix), so this listener is
 * registered before `installFailover`. `failoverView` additionally returns
 * undefined while an override is live, so no cooldown/lane churn happens behind
 * the user's back either.
 */
function installChildRouteOverride(ctx, state) {
	const disposeRequest = ctx.on("agent/request", async (payload, next) => {
		const seed = await next();
		const { agent } = payload;
		// Broad child gate on purpose: plain subagents AND agent-teams members
		// can be re-routed mid-run (teams are excluded from the AUTOMATIC
		// failover by `isSubagentAgent`; an explicit user pick is not automatic).
		if (!isChildAgent(agent)) return seed;
		const id = agent?.id;
		const override = typeof id === "string"
			? (state.childRoutes.get(id) || (id.startsWith("session-") ? state.childRoutes.get(id.slice(8)) : state.childRoutes.get("session-" + id)))
			: void 0;
		if (override === void 0) return seed;
		if (seed === void 0 || seed === null) return seed;
		// Drop the inherited effort: it belongs to the route being replaced, and a
		// provider whose thinking level must agree with the effort rejects the
		// mismatch outright (see the same note in `installFailover`).
		const { reasoningEffort: _inherited, ...rest } = seed;
		const switched = { ...rest, provider: override.provider, model: override.model };
		if (override.reasoningEffort !== void 0) switched.reasoningEffort = override.reasoningEffort;
		return switched;
	});

	const disposeDisposed = ctx.on("agent/disposed", ({ agent }) => {
		if (typeof agent?.id === "string") {
			state.childRoutes.delete(agent.id);
			if (agent.id.startsWith("session-")) state.childRoutes.delete(agent.id.slice(8));
			else state.childRoutes.delete("session-" + agent.id);
		}
	});

	ctx.effect(() => () => {
		disposeRequest();
		disposeDisposed();
	}, "dsh-subagent-role-router: child route override");
}

/**
 * Serve the override over HTTP for the Web UI.
 *
 * Routes (all under `/subagent-role-router`):
 *   GET  route?childId=…            → { childId, provider, model, override }
 *   POST select {childId, provider, model, reasoningEffort?}
 *   POST clear  {childId}
 *
 * POST requires `content-type: application/json` on purpose: cross-site forms
 * cannot send that without a CORS preflight, so it doubles as CSRF hardening for
 * a same-origin-only client.
 */
function installOverrideEndpoint(ctx, state) {
	// Look up `agents` dynamically per request so late-mounting does not permanently
	// blind the resolution helper. If the child is idle/waiting for user input, check
	// the session directory so teammates can still have their model picked between turns.
	const resolve = (childId) => {
		if (typeof childId !== "string" || childId === "") return void 0;
		const agents = typeof ctx.get === "function" ? ctx.get("agents", false) : void 0;
		const live = liveSubagent(agents, childId);
		if (live !== void 0) return live;
		// If an agent exists for this id but is NOT a child (e.g. main agent), explicitly forbid it
		const raw = agents?.get?.(childId)
			|| (childId.startsWith("session-") ? agents?.get?.(childId.slice(8)) : agents?.get?.("session-" + childId));
		if (raw !== void 0 && !isChildAgent(raw)) return void 0;
		// Check on-disk session existence for detached/idle subagent members
		try {
			const home = process.env.USERPROFILE || process.env.HOME || "";
			const sDir = join(home, ".dsh", "sessions");
			if (fs.existsSync(sDir)) {
				const stripped = childId.startsWith("session-") ? childId.slice(8) : childId;
				const wsDirs = fs.readdirSync(sDir);
				for (const ws of wsDirs) {
					const target = join(sDir, ws, stripped);
					if (fs.existsSync(target)) {
						return {
							id: childId,
							session: {
								header: { origin: "subagent", label: stripped },
								requestContext: () => undefined
							}
						};
					}
				}
			}
		} catch (_e) {}
		return void 0;
	};
	ctx.inject(["webServer"], (webCtx) => {
		const handler = async (req, res) => {
			if (!isLoopbackRequest(req)) {
				writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "loopback-only" } });
				return;
			}
			const url = new URL(req.url ?? "/", "http://x");
			const pathname = url.pathname;
			// ── stopping a child the host lookup forgot ──────────────────────
			//
			// The composer's stop button sends a child's cancel through
			// `subagents.interruptByParent`, which looks the child up in the host's
			// resident-activation table and RETURNS SILENTLY when it is not found
			// (or when the activation is already closing): the UI reports
			// "accepted", the child keeps running, and nothing explains why. This
			// route re-attempts the same interrupt through every id form and both
			// authority shapes, so a child the first lookup missed can still be
			// stopped — and so a refusal is visible instead of silent.
			if (req.method === "POST" && pathname === `${OVERRIDE_PATH}/stop`) {
				const body = await readJsonBody(req);
				const stopId = typeof body?.childId === "string" ? body.childId.trim() : "";
				if (stopId === "") {
					writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "childId is required" } });
					return;
				}
				const parent = typeof body?.parentSessionId === "string" ? body.parentSessionId.trim() : "";
				const result = interruptChildNow(ctx, stopId, parent);
				trace(`STOP ${stopId} parent=${parent === "" ? "(none)" : parent} ok=${result.ok} ${JSON.stringify(result.attempts)}`);
				writeJson(res, 200, { ok: true, build: ROUTER_BUILD, value: result });
				return;
			}
			if (req.method === "GET" && pathname === `${OVERRIDE_PATH}/route`) {
				const childId = String(url.searchParams.get("childId") ?? "").trim();
				if (childId === "") {
					writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "childId query parameter required" } });
					return;
				}
				const agent = resolve(childId);
				if (agent === void 0) {
					writeJson(res, 200, { ok: false, build: ROUTER_BUILD, error: { code: "not-live", message: "no live subagent with that id" } });
					return;
				}
				writeJson(res, 200, { ok: true, build: ROUTER_BUILD, value: describeChildRoute(state, childId, agent) });
				return;
			}
			if (req.method === "POST" && pathname === OVERRIDE_PATH + "/debug") {
				const raw = await readJsonBody(req);
				trace("DEBUG " + (typeof raw === "string" ? raw : JSON.stringify(raw)));
				// `logged` is false when nobody asked for a trace file: the client half
				// posts here unconditionally, so an honest answer beats a silent 200.
				writeJson(res, 200, { ok: true, build: ROUTER_BUILD, logged: TRACE_PATH !== "" });
				return;
			}
			if (req.method === "GET" && pathname === `${OVERRIDE_PATH}/exempt-candidates`) {
				writeJson(res, 200, { ok: true, build: ROUTER_BUILD, value: { candidates: birthSeenSuggestions() } });
				return;
			}
			// Diagnostic: what the native gate holds versus what this page asks
			// for, plus the reason a sync was skipped or rejected.
			if (req.method === "GET" && pathname === `${OVERRIDE_PATH}/whitelist`) {
				const desired = hostWhitelistModels(state.getSection?.());
				let current;
				try {
					current = ctx.get("subagentModelSelection", false)?.current?.();
				} catch (error) {
					current = { error: String(error?.message ?? error) };
				}
				let outcome;
				try {
					outcome = await syncHostWhitelist(ctx, state);
				} catch (error) {
					outcome = { synced: false, reason: "error", message: String(error?.message ?? error) };
				}
				writeJson(res, 200, { ok: true, build: ROUTER_BUILD, value: { desired, current, outcome, last: state.lastWhitelistSync ?? null, routes: state.routeSeen ?? [] } });
				return;
			}
			if (req.method !== "POST") {
				writeJson(res, 405, { ok: false, error: { code: "method", message: "POST required" } });
				return;
			}
			const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
			if (!contentType.startsWith("application/json")) {
				writeJson(res, 415, { ok: false, error: { code: "content-type", message: "application/json required" } });
				return;
			}
			const body = await readJsonBody(req);
			if (body === void 0 || body === null || typeof body !== "object") {
				writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "a JSON object body is required" } });
				return;
			}
			const action = pathname === `${OVERRIDE_PATH}/clear`
				? "clear"
				: pathname === `${OVERRIDE_PATH}/select` ? "select" : void 0;
			// Resolve the path before the child: an unknown route is a 404 no matter
			// what the body says, otherwise a typo in the client reports "no live
			// subagent" and sends the reader hunting for the wrong problem.
			if (action === void 0) {
				writeJson(res, 404, { ok: false, error: { code: "not-found", message: `unknown route ${pathname}` } });
				return;
			}
			const childId = typeof body.childId === "string" ? body.childId.trim() : "";
			if (childId === "") {
				writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "childId is required" } });
				return;
			}
			const agent = resolve(childId);
			if (agent === void 0) {
				trace(`REJECT_NOT_LIVE ${childId}`);
				writeJson(res, 200, { ok: false, build: ROUTER_BUILD, error: { code: "not-live", message: "no live subagent with that id" } });
				return;
			}
			if (action === "clear") {
				state.childRoutes.delete(childId);
				if (childId.startsWith("session-")) state.childRoutes.delete(childId.slice(8));
				else state.childRoutes.delete("session-" + childId);
				webCtx.logger?.info?.(`[dsh-subagent-role-router] cleared the route override for subagent ${childId}`);
				writeJson(res, 200, { ok: true, build: ROUTER_BUILD, value: describeChildRoute(state, childId, agent) });
				return;
			}
			const provider = typeof body.provider === "string" ? body.provider.trim() : "";
			const model = typeof body.model === "string" ? body.model.trim() : "";
			if (provider === "" || model === "") {
				writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "provider and model are required" } });
				return;
			}
			const effort = typeof body.reasoningEffort === "string" && body.reasoningEffort !== ""
				? body.reasoningEffort
				: void 0;
			const route = {
				provider,
				model,
				...(effort === void 0 ? {} : { reasoningEffort: effort })
			};
			state.childRoutes.set(childId, route);
			if (childId.startsWith("session-")) state.childRoutes.set(childId.slice(8), route);
			else state.childRoutes.set("session-" + childId, route);
			trace(`SET_OVERRIDE ${childId} -> ${provider}/${model} (effort: ${effort})`);
			webCtx.logger?.info?.(
				`[dsh-subagent-role-router] subagent ${childId} will use ${provider}/${model}${effort === void 0 ? "" : ` effort=${effort}`} from its next request on (set from the Web UI)`
			);
			writeJson(res, 200, { ok: true, build: ROUTER_BUILD, value: describeChildRoute(state, childId, agent) });
		};
		const dispose = webCtx.webServer.register({ kind: "prefix", path: OVERRIDE_PATH, handler });
		webCtx.effect(() => () => {
			if (typeof dispose === "function") dispose();
		}, "dsh-subagent-role-router: route override endpoint");
	});
}

/** The id spellings the host may key one child session by. */
function childIdForms(childId) {
	const out = [childId];
	if (childId.startsWith("session-")) out.push(childId.slice(8));
	else out.push("session-" + childId);
	return out;
}

/**
 * Interrupt one child through every id form and authority the host accepts.
 *
 * Exported for the tests: it is the only place that knows the host's interrupt
 * surface, and a wrong shape here is invisible in production (the host's own
 * interrupt swallows a miss), so it must be exercised directly.
 *
 * @param {object} ctx - the plugin context.
 * @param {string} childId - the child session id from the UI address.
 * @param {string} parentSessionId - its parent session id, when known.
 * @returns {{ok: boolean, attempts: Array<object>}} whether any call was accepted.
 */
export function interruptChildNow(ctx, childId, parentSessionId) {
	const attempts = [];
	let accepted = false;
	const service = typeof ctx.get === "function" ? ctx.get("subagents", false) : void 0;
	const target = typeof service?.interrupt === "function" ? service : service?.manager;
	if (target === void 0 || typeof target.interrupt !== "function") {
		return { ok: false, attempts: [{ reason: "no-subagents-service" }] };
	}
	const agents = typeof ctx.get === "function" ? ctx.get("agents", false) : void 0;
	const ancestors = [];
	if (typeof parentSessionId === "string" && parentSessionId !== "") {
		for (const form of childIdForms(parentSessionId)) {
			const agent = agents?.get?.(form);
			if (agent !== void 0 && agent !== null) ancestors.push(agent);
		}
	}
	for (const id of childIdForms(childId)) {
		const authorities = [];
		if (typeof parentSessionId === "string" && parentSessionId !== "") authorities.push({ kind: "user", parentSessionId });
		for (const agent of ancestors) authorities.push({ kind: "ancestor", agent });
		if (authorities.length === 0) {
			attempts.push({ id, reason: "no-parent-session" });
			continue;
		}
		for (const authority of authorities) {
			try {
				target.interrupt(id, authority);
				attempts.push({ id, authority: authority.kind, ok: true });
				accepted = true;
			} catch (error) {
				attempts.push({ id, authority: authority.kind, error: String(error?.message ?? error) });
			}
		}
	}
	return { ok: accepted, attempts };
}

const HOOKED_FORK = Symbol.for("dsh-subagent-role-router.fork-hooked");

function hookForkProvider(raw, state) {
	const fork = raw.getProvider?.("fork");
	if (!fork || fork[HOOKED_FORK]) return;
	const originalStart = fork.start;
	const originalPrepare = fork.prepareContinuable;
	const restore = [];
	const slice = (request, seed) => {
		const section = state.getSection?.() ?? {};
		if (section.forkWindowSlicing === false || state.delegation.getStore()?.team) return null;
		return safeWindowSeed(request.parent, section.forkWindowTurns, seed);
	};
	if (typeof originalPrepare === "function") {
		const wrapped = async function(request) {
			const prepared = await originalPrepare.call(this, request);
			if (!Array.isArray(prepared?.seed)) return prepared;
			const seed = slice(request, prepared.seed);
			return seed === null ? prepared : { ...prepared, seed };
		};
		fork.prepareContinuable = wrapped;
		restore.push(() => { if (fork.prepareContinuable === wrapped) fork.prepareContinuable = originalPrepare; });
	}
	if (typeof originalStart === "function") {
		const wrapped = async function(request) {
			if (teamIdentity(request?.label, request?.persona) || state.delegation.getStore()?.team) {
				return originalStart.call(this, request);
			}
			// A fork branch hands back no receipt, so a lane reserved here could
			// never be returned. Route it through the pool but do not occupy a lane.
			request = routeDelegation(state, request, request?.label, false).request;
			const seed = slice(request);
			if (seed !== null) {
				// Load the host's own driver lazily; external plugin resolution must
				// never turn an optional optimization into a boot-time crash.
				const driver = nativeForkDriver(state);
				if (driver) return driver(request, { seed });
			}
			return originalStart.call(this, request);
		};
		fork.start = wrapped;
		restore.push(() => { if (fork.start === wrapped) fork.start = originalStart; });
	}
	fork[HOOKED_FORK] = state;
	state.forkCleanups.push(() => {
		for (const cleanup of restore) cleanup();
		if (fork[HOOKED_FORK] === state) delete fork[HOOKED_FORK];
	});
}

function nativeForkDriver(state) {
	if (state.driverLoaded) return state.driver;
	state.driverLoaded = true;
	const bases = [import.meta.url];
	if (process.resourcesPath) bases.push(join(process.resourcesPath, "app.asar", "dsh", "package.json"));
	bases.push(join(dirname(process.execPath), "resources", "app.asar", "dsh", "package.json"));
	for (const base of bases) {
		try {
			const driver = createRequire(base)("@deepseek-ai/dsh-subagent-in-process-driver").startInProcessRun;
			if (typeof driver === "function") return state.driver = driver;
		} catch { /* Optional host export; fall back to the native provider. */ }
	}
	console.warn("[dsh-subagent-role-router] Fork driver unavailable; one-shot fork retains native history.");
	return void 0;
}

function installSubagentWrapper(ctx, state) {
	const raw = ctx.subagents?.[Symbol.for("cordis.original")] ?? ctx.subagents;
	if (!raw || raw[WRAPPED]) return;
	const restorers = [];
	hookForkProvider(raw, state);
	const off = ctx.on("subagent/provider-added", (provider) => {
		if (provider?.name === "fork") hookForkProvider(raw, state);
	});
	for (const key of ["start", "startContinuable", "startActivation"]) {
		const original = raw[key];
		if (typeof original !== "function") continue;
		const wrapped = function(...args) {
			const spec = key === "start" ? null : args[0];
			const request = key === "start" ? args[1] : spec?.request;
			const label = spec?.label || request?.label;
			if (request) noteBirthSeen(spec, request);
			// Keep the native "a child may pick a model" gate in step with this
			// page before the child is built: the tool schema only carries
			// provider/model/reasoning_effort while that gate is enabled, and it
			// only accepts routes listed there.
			if (request) syncHostWhitelistSoon(ctx, state);
			const team = teamIdentity(label, request?.persona);
			let lease;
			if (request && !team) {
				// Exempt plugin children: recognized by their BIRTH identity
				// (label / agentPreset / cwd, exact-prefix rules). No lanes, no
				// role pools, no default-model injection — the rule may pin a
				// birth model, and an explicit agentOptions on the spawn still
				// wins over the pin.
				const exempt = exemptRuleForBirth(state, spec, request);
				if (exempt !== void 0) {
					const pinned = exemptBirthModel(exempt);
					if (pinned && !request.agentOptions?.model && !request.agentOptions?.provider) {
						const request0 = { ...request, agentOptions: { ...request.agentOptions, ...pinned } };
						if (key === "start") args[1] = request0;
						else args[0] = { ...spec, request: request0 };
					}
				} else {
					const routed = routeDelegation(state, request, label);
					lease = routed.lease;
					if (key === "start") args[1] = routed.request;
					else args[0] = { ...spec, request: routed.request };
				}
			} else if (request && team) {
				// Agent-teams spawn: no lanes, no failover — only the optional
				// birth model, mirroring how routeDelegation writes agentOptions
				// for plain subagents (an explicit agentOptions still wins).
				const birth = teamBirthModel(state);
				if (birth && !request.agentOptions?.model && !request.agentOptions?.provider) {
					const request0 = { ...request, agentOptions: { ...request.agentOptions, ...birth } };
					if (key === "start") args[1] = request0;
					else args[0] = { ...spec, request: request0 };
				}
			}
			let dispatched;
			try {
				dispatched = state.delegation.run({ team }, () => original.apply(this, args));
			} catch (error) {
				// Dispatch failed before any receipt existed: give the lane back now
				// instead of leaking it (a leaked lane would look like a permanently
				// busy model and skew every later spillover decision).
				lease?.release();
				throw error;
			}
			if (lease !== void 0) {
				// `startActivation` returns a receipt synchronously; `start` returns a
				// promise. Handle both without assuming either.
				if (dispatched !== null && typeof dispatched === "object" && typeof dispatched.then === "function") {
					Promise.resolve(dispatched).then(
						(receipt) => lease.bind(receipt),
						() => lease.release()
					);
				} else {
					lease.bind(dispatched);
				}
			}
			return dispatched;
		};
		raw[key] = wrapped;
		restorers.push(() => { if (raw[key] === wrapped) raw[key] = original; });
	}
	raw[WRAPPED] = state;
	ctx.effect(() => () => {
		off();
		for (const restore of restorers) restore();
		for (const cleanup of state.forkCleanups.splice(0)) cleanup();
		if (raw[WRAPPED] === state) delete raw[WRAPPED];
	});
}

export function apply(ctx, config) {
	const state = {
		delegation: new AsyncLocalStorage(),
		forkCleanups: [],
		rrCursor: 0,
		/** In-flight delegations per `provider/model` — the lane occupancy table. */
		slots: new Map(),
		/** `provider/model` → epoch ms before which new delegations skip it. */
		cooldowns: new Map(),
		/** child session id → role name, so failover switches inside the same pool. */
		roleOfChild: new Map(),
		/**
		 * child session id → `{ provider, model, reasoningEffort? }` picked in the
		 * Web UI. Lives only in memory on purpose: it describes what ONE running
		 * child should do next, not a durable preference. Restarting the host
		 * therefore forgets it and children fall back to their configured pool.
		 */
		childRoutes: new Map(),
		/** Called when every candidate of a pool is cooling down and one is used anyway. */
		onCoolingExhausted: () => {
			ctx.logger.warn(
				"[dsh-subagent-role-router] every candidate of the role pool is cooling down after failures; using one anyway instead of refusing the delegation"
			);
		},
		/**
		 * Resolve the live settings section. On DSH 0.1.7+ `config` is the
		 * plugin's resolved `Config`; volatile fields arrive as `{ get() }`
		 * live references (cosmokit Volatile), so unwrap each before reading.
		 * An absent/missing config falls back to the schema default (empty
		 * section) — children then inherit the parent route as before.
		 *
		 * @returns {object|undefined} the current section values.
		 */
		getSection: () => {
			const raw = config === void 0 || config === null ? void 0 : config;
			if (raw === void 0) return void 0;
			const unwrap = (value) => (value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value);
			const section = {
				provider: unwrap(raw.provider),
				model: unwrap(raw.model),
				models: unwrap(raw.models),
				strategy: unwrap(raw.strategy),
				failoverEnabled: unwrap(raw.failoverEnabled),
				injectRouteContext: unwrap(raw.injectRouteContext),
				// Read back too: the single-model form stores its effort here, so
				// dropping the key silently ignored the configured effort.
				reasoningEffort: unwrap(raw.reasoningEffort),
				roleMode: unwrap(raw.roleMode),
				exploreProvider: unwrap(raw.exploreProvider),
				exploreModel: unwrap(raw.exploreModel),
				exploreEffort: unwrap(raw.exploreEffort),
				planProvider: unwrap(raw.planProvider),
				planModel: unwrap(raw.planModel),
				planEffort: unwrap(raw.planEffort),
				patchProvider: unwrap(raw.patchProvider),
				patchModel: unwrap(raw.patchModel),
				patchEffort: unwrap(raw.patchEffort),
				exploreModels: unwrap(raw.exploreModels),
				planModels: unwrap(raw.planModels),
				patchModels: unwrap(raw.patchModels),
				roleSlotCooldownSeconds: unwrap(raw.roleSlotCooldownSeconds),
				teamModelProvider: unwrap(raw.teamModelProvider),
				teamModelName: unwrap(raw.teamModelName),
				teamModelEffort: unwrap(raw.teamModelEffort),
				exemptRules: unwrap(raw.exemptRules),
				forkWindowSlicing: unwrap(raw.forkWindowSlicing),
				forkWindowTurns: unwrap(raw.forkWindowTurns),
				showChatModelNotice: unwrap(raw.showChatModelNotice)
			};
			// Drop any field that resolved to undefined so downstream defaults apply.
			for (const key of Object.keys(section)) {
				if (section[key] === void 0) delete section[key];
			}
			return section;
		}
	};

	// Installed BEFORE installFailover on purpose: cordis waterfalls run listeners
	// in registration order and unwind in reverse, so the first registered
	// listener has the last word. A route the user picked in the Web UI must beat
	// the automatic failover swap.
	installChildRouteOverride(ctx, state);

	// Subagent-only failover hooks the agent loop, not the subagents service,
	// so it is installed unconditionally: listeners no-op when the `failover`
	// section is absent/disabled or when the failing agent is the main loop.
	installFailover(ctx, state);


	// Tell each subagent which route it is actually running on. Same gate as
	// failover (origin === "subagent"), so the main agent's context is untouched.
	installRouteContextInjector(ctx, state);

	// Repair a display name ("dnq") into the exact model id ("group/dnq") before
	// the host preflight asks the adapter for a model that does not exist.
	installDelegationArgumentRepair(ctx, state);

	// Serve the Web UI's model/effort picker for a running child.
	installOverrideEndpoint(ctx, state);


	// Attach the method wrapper only while the service exists. Cordis re-runs
	// this child fiber if the provider is replaced, while settings stay served.
	ctx.inject(["subagents"], (subagentCtx) => {
		installSubagentWrapper(subagentCtx, state);
	});

	// Mirror this page's models into the native subagent model gate. Retried a
	// few times because a profile reload mounts `settings` and the gate's own
	// config in an order we do not control; each attempt is idempotent, so a
	// reload that changes nothing writes nothing.
	ctx.effect(() => {
		const timers = [2000, 8000, 20000].map((delay) => setTimeout(() => {
			syncHostWhitelistSoon(ctx, state, (error) => {
				ctx.logger.warn("[dsh-subagent-role-router] could not sync the native subagent model whitelist:", error);
			});
		}, delay));
		return () => {
			for (const timer of timers) clearTimeout(timer);
		};
	});

	ctx.effect(() => () => {
		state.rrCursor = 0;
		// Drop every lane/cooldown/role record on unload: a hot reload must not
		// inherit stale occupancy, or the pool would look permanently busy.
		state.slots.clear();
		state.cooldowns.clear();
		state.roleOfChild.clear();
		state.childRoutes.clear();
	});
}
