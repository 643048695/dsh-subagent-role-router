import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import fs from "node:fs";
import { buildWindowSlicedSeed as safeWindowSeed } from "./fork-window.js";
import { installRouterTools } from "./router-tools.js";
import z from "@deepseek-ai/schemastery";

/**
 * Operational trace sink. The old build appended every override decision to a
 * hard-coded path under the author's home directory — invisible to everyone
 * else, and an always-on trace file grows without bound. The sink is off
 * unless the user names a file in `DSH_SUBAGENT_ROLE_ROUTER_LOG`; with it
 * unset every call is a no-op.
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
export const ROUTER_BUILD = "2026-11-23.19";
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
	// Stall watchdog: a route that never produces a single streamed byte is not
	// failing, it is hanging — and no event ever fires, so failover alone cannot
	// see it. Default 180s / on.
	stallWatchdogEnabled: volatileField(z.boolean().default(true).description("Move a subagent to its next candidate when a route produces no output for stallWatchdogSeconds")),
	stallWatchdogSeconds: volatileField(z.number().default(180).description("Seconds without a single streamed byte before the stall watchdog cuts the attempt and switches the subagent (0 disables)")),
	injectRouteContext: volatileField(z.boolean().default(true).description("Inject the actually-used provider/model into each subagent context")),
	reasoningEffort: volatileField(z.string().default("").description("Reasoning effort for the single-model form (model)")),
	// Who wins at birth when the dispatching caller already wrote provider/model
	// into agentOptions. The host now copies the parent conversation's route
	// into every spawn it makes (observed 2026-11-09: `magpie-responses` +
	// `codex/gpt-6.1-sol` copied from the main session), so "someone named a
	// model" no longer implies "the user picked it". "pool" (default) honours
	// a birth pick ONLY when it names a route on the page's own whitelist
	// (`hostWhitelistModels`); an off-list pick — the copied parent route —
	// is replaced by pool routing. "explicit" keeps the old contract and
	// lets any caller pick through.
	// A manual switch from the Web UI (`/select`) is unrelated: it lands after
	// birth and always beats the pool.
	birthRoutePolicy: volatileField(z.union([z.const("pool"), z.const("explicit")]).default("pool").description("Birth route policy: pool = role pool wins over a caller-written model; explicit = caller-written model wins")),
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
	// ── the coordinator's own two lists ──────────────────────────────────────
	// A second, STRICTLY isolated pair of lists for the subagents one particular
	// plugin dispatches (by default the orchestrator's workers). Each side is an
	// ordered list: the first usable model serves, the next one takes over only
	// after a failure and a cooldown, and the first one is retried once its
	// cooldown expires. Routes named here are removed from the GENERAL lists, so
	// an ordinary subagent can never borrow one of them.
	coordinatorEnabled: volatileField(z.boolean().default(true).description("Route the coordinator plugin's subagents through the two lists below")),
	coordinatorPresetPrefix: volatileField(z.string().default("dsh-orchestrator-worker").description("Birth preset prefix identifying the coordinator's subagents")),
	coordinatorUiModels: volatileField(z.array(POOL_ENTRY).default([]).description("UI drawing list (visual work), first = default")),
	coordinatorResearchModels: volatileField(z.array(POOL_ENTRY).default([]).description("Read-only research list (look up, read, analyse), first = default")),
	coordinatorDeliveryModels: volatileField(z.array(POOL_ENTRY).default([]).description("Delivery list (build, upload, verify, move — no design decision), first = default; empty = follow the backend list")),
	coordinatorBackendModels: volatileField(z.array(POOL_ENTRY).default([]).description("Backend list (non-visual work), first = default")),
	coordinatorCooldownPreset: volatileField(z.union([z.const("light"), z.const("medium"), z.const("heavy"), z.const("custom")]).default("medium").description("Failure cooldown preset: light 1/3/5, medium 1/5/15, heavy 2/10/30 minutes")),
	coordinatorCooldownSteps: volatileField(z.array(z.number()).default([]).description("Custom cooldown steps in minutes (used when the preset is custom)")),
	coordinatorCooldownCap: volatileField(z.number().default(0).description("Custom cooldown ceiling in minutes (0 = last step)")),
	coordinatorNoFallback: volatileField(z.boolean().default(false).description("Never fall through to the next model on a failure")),
	forkWindowSlicing: volatileField(z.boolean().default(true).description("Enable Fork active window slicing (for BTW and subagent_fork)")),
	forkWindowTurns: volatileField(z.number().default(3).description("Number of recent turns to retain for fork")),
	showChatModelNotice: volatileField(z.boolean().default(false).description("Show model change notice in chat view")),
	showHeaderCritters: volatileField(z.boolean().default(true).description("Show the header critters animation while subagents run"))
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

/**
 * The codes that must NOT switch candidates.
 *
 * Everything else switches, including the generic `INVALID_REQUEST` a gateway
 * returns for a request it simply will not take: a live run proved that a 400
 * carrying no explanation stops a coordinator child dead, while the very same
 * payload runs fine on another model. The user's rule is "a subagent that
 * errors moves to the next model", so the gate is a blacklist instead of the
 * allowlist this used to be.
 *
 * The blast radius stays bounded: `installFailover` allows at most
 * `entries.length - 1` switches per run, each on a candidate this run has not
 * used, so a genuinely malformed request pays one round trip per candidate and
 * then surfaces its real error. Every failure also records a cooldown, so the
 * dead route is skipped by the NEXT delegation.
 */
const FAILOVER_NEVER_CODES = ["ABORTED", "CANCELED", "CANCELLED", "USER_ABORT", "USER_CANCEL", "INTERRUPTED"];

/** The connection/auth codes, kept for the logs' wording and the docs. */
const FAILOVER_ELIGIBLE_CODES = [...FAILOVER_TRIGGER_CODES, ...AUTH_FAILURE_CODES];

/**
 * True when a failure should move the child to another candidate.
 *
 * Cancellation is the only hard stop: the run is being torn down, so there is
 * nobody left to serve and a switch would resurrect work the user cancelled.
 */
export function shouldFailover(failure) {
	if (failure === void 0 || failure === null) return false;
	if (typeof failure.code === "string" && FAILOVER_NEVER_CODES.includes(failure.code)) return false;
	return true;
}

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
	// Reserved routes belong to the coordinator's children only.
	const reserved = new Set(coordinatorAllRoutes(section).map(routeKey));

	// Multi-model list wins; pick per strategy.
	const entries = Array.isArray(section.models)
		? section.models.filter((entry) => {
			const route = resolveEntry(section, entry);
			return route !== void 0 && !reserved.has(routeKey(route)) && !birthRouteIsDead(state, route);
		})
		: [];
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
		if (reserved.has(routeKey(result))) return void 0;
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
	// A route the coordinator's lists reserved never lands on an ordinary child,
	// even when someone also put it in a role pool.
	const reserved = new Set(coordinatorAllRoutes(section).map(routeKey));
	const keep = (route) => route !== void 0 && !reserved.has(routeKey(route));
	const field = ROLE_POOL_FIELDS[role];
	const declared = field === void 0 ? void 0 : section[field];
	if (Array.isArray(declared)) {
		const entries = declared.map((entry) => resolveEntry(section, entry)).filter(keep);
		if (entries.length > 0) return entries;
	}
	// Legacy single-value fallback (also covers a pool whose rows are all blank).
	const single = resolveRoleRoute(section, role);
	return single === void 0 || !keep(single) ? [] : [single];
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
	// A lane the gateway no longer serves is not a lane: drop it here so the
	// pool's rotation, spillover and cooldown all see the same list.
	entries = filterLiveRoutes(state, entries);
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
 * undefined: agent-teams members, and — under the `explicit` birth policy —
 * requests that already name a model. Under the default `pool` policy a birth
 * pick is honoured ONLY when it names a route on the page's whitelist; an
 * off-list pick (the copied parent route) is replaced by pool routing (see
 * `birthRoutePolicy` and `isApprovedBirthRoute`).
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
	const section = state.getSection?.();
	// Token/depth controls alone are not an explicit model selection.
	const explicit = request.agentOptions;
	if (explicit?.model || explicit?.provider) {
		if ((section?.birthRoutePolicy ?? "pool") === "explicit") return { request };
		// The host copies the parent conversation's route into spawn options,
		// so a birth pick is usually the parent's own habit, not a user choice.
		// A pick that IS on the page's whitelist is still honoured — the page
		// owner configured exactly those routes for this kind of work. An
		// off-list pick (the copied parent route) falls through to pool
		// routing; the spread `{ ...explicit, ...route }` below preserves any
		// non-model agentOptions. "explicit" keeps the old let-it-through
		// contract for every pick.
		if (isApprovedBirthRoute(section, explicit)) return { request };
	}

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

/**
 * True when a birth pick names a route this page actually configured
 * (`hostWhitelistModels`). The provider must match OR the model must match the
 * whitelist entry exactly — gateway aliases rename providers between the page
 * and the dispatch path (`magpie` vs `magpie-responses`), but model names are
 * unique per page. A bare short name (`dnq` for `group/dnq`) also matches.
 *
 * `routes` overrides the list being approved against: a coordinator child is
 * judged against ITS group, not the general list (see `pickPageRoute`).
 */
function isApprovedBirthRoute(section, pick, routes) {
	const provider = typeof pick?.provider === "string" ? pick.provider.trim() : "";
	const model = typeof pick?.model === "string" ? pick.model.trim() : "";
	if (provider === "" && model === "") return false;
	for (const route of Array.isArray(routes) ? routes : hostWhitelistModels(section)) {
		if (model !== "" && route.model === model) return true;
		if (provider !== "" && model !== "" && route.provider === provider && route.model === model) return true;
		if (model.includes("/") === false && model !== "" && route.model.endsWith(`/${model}`)) return true;
	}
	return false;
}

/**
 * Substitute a route this page DID approve for a pick it never approved.
 *
 * WHY THIS EXISTS: every gate this plugin owns (`/batch`, birth routing) reads
 * the page whitelist, but a model pick can also arrive from the host's own model
 * seat or from a client that POSTs `/select` directly, and both bypassed it — a
 * child really did run `codex/gpt-6.1-sol`, then `gm4/gemini-4-carbon`, on a page
 * whose whitelist named neither. Refusing would stall the child; honouring it is
 * the bug. So the plugin SWITCHES: the child keeps working, on a model the user
 * did approve.
 *
 * Preferred target, in order: the SAME provider (a swap inside one gateway keeps
 * its credentials, protocol and usually its strengths), then the first route the
 * page configures. Returns null when the pick is already approved — nothing to
 * do — and when the page configures no whitelist at all, because there is no
 * approved route to switch to.
 *
 * @param {object|undefined} section - the live settings section.
 * @param {{provider?: string, model?: string}} pick - the route that was asked for.
 * @param {{routes?: Array<{provider: string, model: string}>}} [options] - the page's own list.
 * @returns {{provider: string, model: string}|null} the route to use instead.
 */
export function pickWhitelistRoute(section, pick, options) {
	const askedProvider = typeof pick?.provider === "string" ? pick.provider.trim() : "";
	const askedModel = typeof pick?.model === "string" ? pick.model.trim() : "";
	if (askedProvider === "" && askedModel === "") return null;
	const routes = Array.isArray(options?.routes) ? options.routes : hostWhitelistModels(section);
	if (isApprovedBirthRoute(section, { provider: askedProvider, model: askedModel }, routes)) return null;
	if (routes.length === 0) return null;
	const normalized = askedProvider.toLowerCase();
	if (normalized !== "") {
		for (const route of routes) {
			if (route.provider.toLowerCase() === normalized) return { provider: route.provider, model: route.model };
		}
	}
	return { provider: routes[0].provider, model: routes[0].model };
}

/**
 * The routes a CHILD's own page approves: the coordinator group it was born on
 * when it has one, the general list otherwise.
 *
 * THE BUG THIS FIXES (live, session-7a929cab): the model menu on a coordinator
 * child already showed only its group, but `/select` judged the pick against the
 * GENERAL list — which by design excludes every coordinator route. So picking a
 * group model looked "unapproved" and the child was pushed onto the general
 * list's first route (flash-eco), and picking anything else did the same. One
 * child, two answers. Everything that judges a pick now reads this.
 *
 * @param {object} state - plugin state (needs `getSection` and the group ledger).
 * @param {string} childId - the child whose page is being judged.
 * @returns {{group: string|undefined, routes: Array<{provider: string, model: string}>}}
 */
export function childPageRoutes(state, childId) {
	const section = state?.getSection?.();
	const record = coordinatorRecordOf(state, childId);
	if (record !== void 0) {
		const group = coordinatorGroupRoutes(section, record.group);
		if (group.length > 0) {
			return { group: record.group, routes: group.map((route) => ({ provider: route.provider, model: route.model })) };
		}
	}
	return { group: void 0, routes: hostWhitelistModels(section) };
}

/** Substitution for one child, judged against ITS page (never the general list). */
export function pickPageRoute(state, childId, pick) {
	return pickWhitelistRoute(state?.getSection?.(), pick, { routes: childPageRoutes(state, childId).routes });
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
	// An explicit pick from the Web UI used to veto the automatic switch
	// outright, so a pick that could not run stopped the child dead. The
	// promised behaviour is now "revert, do not stop": the override is dropped
	// on the first failure and the child continues on its page's own list (see
	// `manual` below, and the caller's clearChildRoute). What that lock was
	// defending — silently replacing a model the user just named, then blaming
	// the new candidate for the old one's failure — stays defended: the cooldown
	// is recorded against the route that actually failed, never the fallback.
	const manual = agent !== void 0 && hasChildRouteOverride(state, agent.id);
	// A coordinator child fails over INSIDE its own list and nowhere else: the
	// two lists exist precisely so visual work never lands on a backend model.
	if (agent !== void 0) {
		const coordGroup = coordinatorGroupOfAgent(state, agent);
		if (coordGroup !== void 0) {
			if (section.coordinatorNoFallback === true) return void 0;
			const coordEntries = filterLiveRoutes(state, coordinatorGroupRoutes(section, coordGroup));
			if (coordEntries.length < 2) return void 0;
			return { entries: coordEntries, strategy: "round-robin", coordinatorGroup: coordGroup, manual };
		}
	}
	// A subagent that was placed on a ROLE pool must fail over INSIDE that pool:
	// its lanes are the alternatives the user actually chose for this kind of
	// work. Falling back to the base pool here would silently drag a general-
	// purpose task onto an unrelated model that the role was configured to avoid.
	const role = agent === void 0 ? void 0 : state.roleOfChild.get(agent.id);
	const rolePool = section.roleMode === true && role !== void 0 ? resolveRolePool(section, role) : [];
	const entries = filterLiveRoutes(state, rolePool.length >= 2
		? rolePool
		: (Array.isArray(section.models)
			? section.models.map((entry) => resolveEntry(section, entry)).filter((entry) => entry !== void 0)
			: []));
	// A pool of <2 models has nothing to switch to; keep the parent route.
	if (entries.length < 2) return void 0;
	return { entries, strategy: section.strategy === "random" ? "random" : "round-robin", manual };
}

/**
 * True when the user (or a tool) wrote an explicit route for this child.
 *
 * Either id spelling counts — the host and the endpoints do not agree on
 * whether a child id carries its `session-` prefix.
 */
function hasChildRouteOverride(state, childId) {
	return childRouteOverrideFor(state, childId) !== void 0;
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
export function hostWhitelistModels(section, options) {
	if (!section) return [];
	// STRICT ISOLATION: a route the coordinator's own lists reserve is NOT part
	// of the general answer, so an ordinary child can never be routed onto it and
	// the native gate never approves it for one. `includeCoordinator` is what the
	// host gate itself needs (it is a single global list); everything that decides
	// for a plain child uses the default.
	const includeCoordinator = options?.includeCoordinator === true;
	const reserved = includeCoordinator ? null : new Set(coordinatorAllRoutes(section).map(routeKey));
	const out = [];
	const seen = new Set();
	const add = (entry) => {
		if (!entry || typeof entry.provider !== "string" || typeof entry.model !== "string") return;
		const provider = entry.provider.trim();
		const model = entry.model.trim();
		if (provider === "" || model === "") return;
		if (reserved !== null && reserved.has(`${provider}/${model}`)) return;
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
	if (includeCoordinator) {
		for (const route of coordinatorAllRoutes(section)) add(route);
	}
	return out;
}

/**
 * The routes the HOST's own model gate must approve: the general whitelist plus
 * every route the coordinator's lists reserve for its own children.
 *
 * The host keeps a single global list, so a per-group gate has to live in this
 * plugin; the host is only told the union, and every decision here still judges
 * a child against the list its own group owns.
 */
export function hostGateModels(section) {
	return hostWhitelistModels(section, { includeCoordinator: true });
}

/**
 * Every distinct route this page configures, WITH the sources and the efforts
 * the page pinned on it.
 *
 * `hostWhitelistModels` answers the native gate's question ("which routes may a
 * child name at all") and deliberately drops the effort. The batch switcher
 * asks a different question — "which models and thinking levels may I offer in
 * this card, and where did each come from" — so the rows keep both. Same dedupe
 * key, same page order, so the two views can never disagree about which routes
 * exist.
 *
 * @param {object|undefined} section - the live settings section.
 * @returns {Array<{provider: string, model: string, sources: string[], configuredEfforts: string[]}>}
 */
export function hostModelPool(section, options) {
	if (!section) return [];
	const out = [];
	const index = new Map();
	const add = (entry, source) => {
		if (!entry || typeof entry.provider !== "string" || typeof entry.model !== "string") return;
		const provider = entry.provider.trim();
		const model = entry.model.trim();
		if (provider === "" || model === "") return;
		const key = `${provider}\u0000${model}`;
		let row = index.get(key);
		if (row === void 0) {
			row = { provider, model, sources: [], configuredEfforts: [] };
			index.set(key, row);
			out.push(row);
		}
		if (!row.sources.includes(source)) row.sources.push(source);
		if (typeof entry.reasoningEffort === "string" && entry.reasoningEffort !== "" && !row.configuredEfforts.includes(entry.reasoningEffort)) {
			row.configuredEfforts.push(entry.reasoningEffort);
		}
	};
	if (Array.isArray(section.models)) {
		for (const entry of section.models) add(resolveEntry(section, entry), "base");
	}
	if (typeof section.provider === "string" && typeof section.model === "string") {
		add({
			provider: section.provider,
			model: section.model,
			...(typeof section.reasoningEffort === "string" ? { reasoningEffort: section.reasoningEffort } : {})
		}, "single");
	}
	for (const role of ["explore", "plan", "patch"]) {
		for (const entry of resolveRolePool(section, role)) add(entry, `role:${role}`);
	}
	add(teamBirthModel({ getSection: () => section }), "team");
	if (options?.includeCoordinator === true) {
		for (const group of COORD_GROUPS) {
			for (const route of coordinatorGroupRoutes(section, group)) add(route, `coordinator:${group}`);
		}
	}
	return out;
}

/** How long a provider's model catalog answer is reused. */const MODEL_CAPS_TTL_MS = 60 * 1000;

/** The `agents` service, or undefined when this host does not expose one. */
function agentsService(ctx) {
	try {
		return typeof ctx?.get === "function" ? ctx.get("agents", false) : void 0;
	} catch (_error) {
		return void 0;
	}
}

/** The `subagents` service, or undefined when this host does not expose one. */
function subagentsService(ctx) {
	try {
		return typeof ctx?.get === "function" ? ctx.get("subagents", false) : void 0;
	} catch (_error) {
		return void 0;
	}
}

/**
 * The host's CURRENT child-list API, exposed through the same `{ listChildren }`
 * shim the caller already loops over.
 *
 * The host renamed this service method: `listChildren(parentId)` became
 * `listDescendants(rootSessionId)`, which walks EVERY reachable parent catalog
 * in pre-order and tags each row with `parentId` and `depth`. This plugin wants
 * the DIRECT children of one conversation, so the recursive answer is filtered
 * on `parentId` — the rows still come from the host's own catalog, never from a
 * guess, and a child of some other conversation can never leak in.
 *
 * @param {object|undefined} service - the `subagents` service.
 * @returns {{listChildren: function(string): Promise<Array<object>>}|null}
 */
function subagentDescendantsReader(service) {
	if (service === void 0 || service === null || typeof service.listDescendants !== "function") return null;
	return {
		async listChildren(parentSessionId) {
			const listed = await service.listDescendants(parentSessionId);
			const wanted = new Set(childIdForms(parentSessionId));
			const out = [];
			for (const entry of Array.isArray(listed) ? listed : []) {
				// Non-child rows (`kind: "diagnostic"`) describe a branch the host
				// could not read (corrupt / unsupported / unavailable). They are not
				// members of the conversation, so they must never become rows here.
				if (typeof entry?.kind === "string" && entry.kind !== "child") continue;
				const owner = typeof entry?.parentId === "string" ? entry.parentId.trim() : "";
				if (owner === "") continue;
				if (!childIdForms(owner).some((form) => wanted.has(form))) continue;
				out.push(entry);
			}
			return out;
		}
	};
}

/**
 * Read the parent's own child catalog WITHOUT any service method at all.
 *
 * Newer hosts deleted `listChildren` / `list` / `drainChildren` from the
 * subagent service (their upgrade guide says so verbatim) and kept the
 * capability behind a projection:
 *
 *   query.observeSession(parentId) -> session.projections.values.subagentCatalog
 *
 * That projection is the very source `listDescendants` folds, and the header
 * critters here already read it, so this leg needs no import of the host's own
 * module (which a plugin must not depend on at runtime). It is the last resort:
 * a host that serves the catalog to nobody still answers "cannot verify" rather
 * than a guessed list.
 *
 * @param {object} ctx - plugin context.
 * @returns {{listChildren: function(string): Promise<Array<object>>}|null}
 */
function subagentCatalogReader(ctx) {
	let query;
	try {
		query = typeof ctx?.get === "function" ? ctx.get("sessionQuery", false) : void 0;
	} catch (_error) {
		query = void 0;
	}
	if (query === void 0 || query === null || typeof query.observeSession !== "function") {
		// Older hosts never expose sessionQuery; the service legs cover them.
		return null;
	}
	return {
		async listChildren(parentSessionId) {
			const observation = await query.observeSession(parentSessionId);
			try {
				const entries = observation?.projections?.values?.subagentCatalog;
				if (entries === void 0) {
					throw new Error("the subagentCatalog projection is not registered on this host");
				}
				return entries;
			} finally {
				// observeSession hands back a disposable observation; releasing it
				// here keeps a batch probe from pinning a session observation.
				try { observation?.dispose?.(); } catch (_error) { /* best effort */ }
				try { observation?.[Symbol.dispose]?.(); } catch (_error) { /* best effort */ }
			}
		}
	};
}

/** The `llm` service, or undefined when this host does not expose one. */
function llmService(ctx) {
	try {
		return typeof ctx?.get === "function" ? ctx.get("llm", false) : void 0;
	} catch (_error) {
		return void 0;
	}
}

/**
 * Which efforts each configured model really accepts, straight from the host.
 *
 * The plugin may NOT invent effort levels: a provider whose thinking level must
 * agree with the effort rejects an unknown value, and a card that silently
 * offered `high` for a model with no reasoning would be lying. `llm`'s
 * `listModels(provider)` is the authority, so it is asked once per provider and
 * cached for a minute. A provider that throws is remembered as unknown — the
 * page's own configured efforts still count as legal (they came from the user).
 *
 * @param {object} ctx - the plugin context.
 * @param {object} state - the plugin state (cache lives on `state.modelCaps`).
 * @returns {Promise<Map<string, {ok: boolean, models: Map<string, {name: string, efforts: Array<{id: string, label: string}>}>, message?: string}>>}
 */
/**
 * The reasoning strengths a provider reports for ONE model.
 *
 * WHY `resolveModelInfo` AND NOT `listModels`: the model list carries
 * `{ provider, id, name, description }` only. Reading `reasoning.efforts` off a
 * `listModels` row therefore found nothing for every provider, so every model
 * looked like it had no strengths — including models that do. The strengths
 * live on the per-model info:
 * `{ reasoning: { efforts: [{ id, name, description }] } }`.
 *
 * `capabilityKnown` stays false when the lookup is unavailable or throws, so the
 * caller can treat this page's own pinned strengths as UNVERIFIED instead of
 * claiming the provider offers them.
 *
 * @param {object|undefined} llm - the host `llm` service.
 * @param {string} provider - provider id.
 * @param {string} model - model id.
 * @returns {Promise<{capabilityKnown: boolean, efforts: Array<{id: string, label: string, description?: string}>}>}
 */
async function resolveModelEfforts(llm, provider, model) {
	const missing = { capabilityKnown: false, efforts: [] };
	if (llm === void 0 || llm === null || typeof llm.resolveModelInfo !== "function") return missing;
	let info;
	try {
		info = await llm.resolveModelInfo(provider, model);
	} catch (_error) {
		return missing;
	}
	const raw = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : [];
	const efforts = [];
	for (const effort of raw) {
		const id = typeof effort?.id === "string" ? effort.id : "";
		if (id === "") continue;
		// `name` is the display name; `label` is the older spelling some hosts use.
		const label = typeof effort?.name === "string" && effort.name !== ""
			? effort.name
			: (typeof effort?.label === "string" && effort.label !== "" ? effort.label : id);
		const description = typeof effort?.description === "string" ? effort.description : "";
		efforts.push(description === "" ? { id, label } : { id, label, description });
	}
	return { capabilityKnown: true, efforts };
}

async function modelCapabilities(ctx, state) {
	const now = Date.now();
	const cached = state.modelCaps;
	if (cached !== void 0 && cached !== null && now - cached.at < MODEL_CAPS_TTL_MS) return cached.map;
	const map = new Map();
	const llm = llmService(ctx);
	const wanted = new Map();
	for (const row of hostModelPool(state.getSection?.())) {
		if (!wanted.has(row.provider)) wanted.set(row.provider, new Set());
		wanted.get(row.provider).add(row.model);
	}
	if (llm !== void 0 && llm !== null) {
		for (const [provider, models] of wanted) {
			try {
				// `listModels` is asked ONLY for display names: it is the one call that
				// enumerates a provider, and its rows carry no strengths.
				const named = new Map();
				if (typeof llm.listModels === "function") {
					const listed = await llm.listModels(provider);
					for (const info of Array.isArray(listed) ? listed : []) {
						const id = typeof info?.id === "string" ? info.id : "";
						if (id === "") continue;
						named.set(id, typeof info?.name === "string" && info.name !== "" ? info.name : id);
					}
				}
				const entries = new Map();
				for (const modelId of models) {
					const resolved = await resolveModelEfforts(llm, provider, modelId);
					entries.set(modelId, {
						name: named.get(modelId) ?? modelId,
						capabilityKnown: resolved.capabilityKnown,
						efforts: resolved.efforts
					});
				}
				map.set(provider, { ok: true, models: entries });
			} catch (error) {
				map.set(provider, { ok: false, models: new Map(), message: String(error?.message ?? error) });
			}
		}
	}
	state.modelCaps = { at: now, map };
	return map;
}

/**
 * The card's model list: page routes + display names + selectable efforts.
 *
 * @param {object|undefined} section - the live settings section.
 * @param {Map<string, object>|undefined} caps - `modelCapabilities` result.
 * @returns {Array<object>} one row per deduplicated provider/model.
 */
export function batchModelCatalog(section, caps, options) {
	const includeCoordinator = options?.includeCoordinator === true;
	return hostModelPool(section, { includeCoordinator }).map((row) => {
		const providerCaps = caps?.get?.(row.provider);
		const info = providerCaps !== void 0 && providerCaps !== null && providerCaps.ok === true
			? providerCaps.models.get(row.model)
			: void 0;
		const capabilityKnown = info !== void 0 && info.capabilityKnown === true;
		const efforts = [];
		const seen = new Set();
		const push = (entry) => {
			if (typeof entry?.id !== "string" || entry.id === "" || seen.has(entry.id)) return;
			seen.add(entry.id);
			efforts.push(entry);
		};
		if (capabilityKnown) {
			// The provider answered, so it is authoritative: a strength this page pins
			// but the provider does not list is NOT offered here (the backend refuses
			// it too, so offering it would only produce a per-row failure).
			for (const effort of info.efforts) {
				push(row.configuredEfforts.includes(effort.id)
					? { ...effort, source: "catalog", configured: true }
					: { ...effort, source: "catalog" });
			}
		} else {
			// Capability unknown: the page's own pins are the only strengths that can
			// be named, and they stay labelled `config` so nothing claims support.
			for (const id of row.configuredEfforts) push({ id, label: id, source: "config" });
		}
		return {
			provider: row.provider,
			model: row.model,
			displayName: info?.name ?? row.model,
			sources: row.sources,
			configuredEfforts: row.configuredEfforts,
			capabilityKnown,
			efforts
		};
	});
}

/**
 * The children the HOST says belong to this parent conversation — nothing else.
 *
 * Attribution used to be inferred (activity ledger, session headers, an on-disk
 * scan). All three are weaker than the authority the host already keeps: the
 * subagent service's own per-parent catalog — `listChildren(parentId)` on older
 * hosts, `listDescendants(rootId)` on newer ones, and the `subagentCatalog`
 * projection underneath both — so an id it returns is the parent's child BY
 * CONSTRUCTION, survives a reload, and does not leak children of other
 * conversations. This therefore NEVER falls back to a broader set: when no leg
 * can answer, the answer is "cannot verify", not "here is everyone".
 *
 * @param {object} ctx - the plugin context.
 * @param {object} state - the plugin state.
 * @param {string} parentSessionId - the conversation whose children are wanted.
 * @returns {Promise<{ok: true, value: Array<object>}|{ok: false, error: {code: string, message: string}}>}
 */
/** Statuses that mean the resident child is on its way out, so it must not be written. */
const ENDING_STATUSES = new Set(["closing", "closed", "disposed", "ended", "stopping"]);

export async function strictChildrenOf(ctx, state, parentSessionId) {
	const parent = typeof parentSessionId === "string" ? parentSessionId.trim() : "";
	if (parent === "") return { ok: false, error: { code: "bad-request", message: "parentSessionId is required" } };
	const service = subagentsService(ctx);
	const candidates = Array.from(new Set(childIdForms(parent)));
	// THE HOST MOVED THIS API TWICE.
	//
	//   old service method : subagents.listChildren(parentId)
	//   current            : subagents.listDescendants(rootId)   (recursive, row.parentId tells the owner)
	//   projection only    : sessionQuery.observeSession(parentId).projections.values.subagentCatalog
	//
	// The first removed shape made the batch card hide itself, because it could
	// not verify a single child — the "batch button disappeared" report. All
	// three are tried, in that order, so one build runs on every host and a host
	// that still exposes the original method keeps its exact old behaviour. NONE
	// of them is a broader set: every leg is the host's own per-parent catalog.
	let listed;
	let lastError = null;
	const readers = [];
	if (service !== void 0 && service !== null && typeof service.listChildren === "function") readers.push(service);
	const descendants = subagentDescendantsReader(service);
	if (descendants !== null) readers.push(descendants);
	const hostApi = subagentCatalogReader(ctx);
	if (hostApi !== null) readers.push(hostApi);
	if (readers.length === 0) {
		return { ok: false, error: { code: "catalog-unavailable", message: "this host exposes no way to list a conversation's subagents" } };
	}
	for (const reader of readers) {
		for (const candidate of candidates) {
			try {
				listed = await reader.listChildren(candidate);
				lastError = null;
				break;
			} catch (error) {
				lastError = error;
			}
		}
		if (lastError === null) break;
	}
	if (lastError !== null) {
		return { ok: false, error: { code: "catalog-unavailable", message: String(lastError?.message ?? lastError) } };
	}
	const section = state.getSection?.();
	const rules = section !== void 0 && section !== null && Array.isArray(section.exemptRules) ? section.exemptRules : [];
	const agents = agentsService(ctx);
	const rows = [];
	for (const entry of Array.isArray(listed) ? listed : []) {
		const childId = typeof entry?.id === "string" ? entry.id.trim() : "";
		if (childId === "") continue;
		const label = typeof entry?.label === "string" ? entry.label : "";
		const mode = typeof entry?.mode === "string" && entry.mode !== "" ? entry.mode : "unknown";
		const agent = liveSubagent(agents, childId);
		// IDLE IS NOT ENDED.
		//
		// A resident child between turns reports `inactive` from the host's own
		// listing code (`status === "running" ? "running" : "inactive"`), and it is
		// still a perfectly legal target — refusing it would make this card useless
		// for exactly the case it exists for. What must be refused is a child that
		// is no longer RESIDENT (disposed, exited, never registered) or one that is
		// explicitly closing.
		const status = agent !== void 0 && typeof agent?.status === "string" ? agent.status : "";
		const ending = ENDING_STATUSES.has(status);
		// A live agent answers with its own durable label; a child that is no longer
		// resident can only be judged by the catalog's label, which is the same
		// string the exemption rules match on at birth.
		const exempt = agent !== void 0
			? isExemptAgent(state, agent)
			: (label !== "" && rules.some((rule) => ruleMatches(rule, { label })));
		let reason;
		if (mode !== "continuable") {
			reason = mode === "external" ? "external" : mode === "one-shot" ? "ended" : "unknown-mode";
		} else if (ending) {
			reason = "ending";
		} else if (exempt) {
			reason = "exempt";
		} else if (agent === void 0) {
			// The catalog remembers the child but the registry no longer has it, so
			// "may this child still be re-routed" can no longer be confirmed.
			reason = "unverified";
		} else {
			reason = "ok";
		}
		const route = describeChildRoute(state, childId, agent);
		rows.push({
			childId,
			label,
			mode,
			live: agent !== void 0,
			activity: agent === void 0 ? "gone" : (status !== "" ? status : "resident"),
			selectable: reason === "ok",
			reason,
			revision: routeRevisionOf(state, childId),
			provider: route.provider,
			model: route.model,
			reasoningEffort: route.reasoningEffort,
			actual: route.actual,
			override: route.override,
			pending: route.pending,
			pendingRoute: route.pendingRoute
		});
	}
	return { ok: true, value: rows };
}

/**
 * Re-verify one child against the parent's catalog before writing anything.
 *
 * The batch card holds a list fetched seconds ago; by the time the user presses
 * Apply, a child may have ended. Ownership, continuability and exemption are all
 * re-derived here from the host's catalog — the request's childId alone is a
 * claim, never a permission.
 *
 * @returns {Promise<{ok: true, value: object}|{ok: false, error: {code: string, message: string}}>}
 */
export async function resolveOwnedChild(ctx, state, parentSessionId, childId) {
	const wanted = typeof childId === "string" ? childId.trim() : "";
	if (wanted === "") return { ok: false, error: { code: "bad-request", message: "childId is required" } };
	const listed = await strictChildrenOf(ctx, state, parentSessionId);
	if (listed.ok !== true) return listed;
	const forms = new Set(childIdForms(wanted));
	const row = listed.value.find((entry) => childIdForms(entry.childId).some((form) => forms.has(form)));
	if (row === void 0) return { ok: false, error: { code: "not-owned", message: "that child does not belong to this conversation" } };
	if (row.selectable !== true) {
		const message = row.reason === "ended"
			? "that child has ended"
			: row.reason === "exempt"
				? "that child is exempt from model overrides"
				: row.reason === "external"
					? "that child is owned by another host"
					: row.reason === "unverified"
						? "that child is no longer resident, so its route cannot be confirmed"
						: row.reason === "ending"
							? "that child is closing"
							: "that child's mode cannot be re-routed";
		return { ok: false, error: { code: row.reason, message } };
	}
	return { ok: true, value: row };
}

/** Collapse the two host id spellings into one canonical revision key. */
function canonicalChildKey(childId) {
	return typeof childId === "string" && childId.startsWith("session-") ? childId.slice(8) : String(childId ?? "");
}

/**
 * The per-target route revision: 0 means "never written", and every explicit
 * write or clear bumps it by one. Paired with the instance 'routeEpoch', a
 * client can tell a stale response from a fresh one even across a reload (a
 * new process starts every revision back at 0, so the epoch disambiguates).
 */
export function routeRevisionOf(state, childId) {
	return state.routeRevisions?.get(canonicalChildKey(childId)) ?? 0;
}

function bumpRouteRevision(state, childId) {
	if (state.routeRevisions === void 0) state.routeRevisions = new Map();
	const key = canonicalChildKey(childId);
	const next = (state.routeRevisions.get(key) ?? 0) + 1;
	state.routeRevisions.set(key, next);
	return next;
}

/**
 * Push a route change to every open SSE listener. Best-effort by design:
 * no listeners (or a not-yet-installed broadcaster) is a no-op, and one
 * failed connection is dropped by its own write guard without disturbing
 * the others.
 */
function broadcastRouteChange(state, childId, revision, reason) {
	const broadcast = state?.routeEventBroadcast;
	if (typeof broadcast !== "function") return;
	try {
		broadcast({ type: "route", childId: canonicalChildKey(childId), epoch: state.routeEpoch, revision, reason });
	} catch (_) { /* a dead stream cleans itself up in its write guard */ }
}

/**
 * Announce that a child's EFFECTIVE route moved (an override or a failover
 * switch applying on a request). Deduped per child by the seed signature:
 * both handlers run on every request, and only a genuine switch is news
 * worth waking a picker for.
 */
function broadcastAppliedRoute(state, agent, switched, reason) {
	if (!isChildAgent(agent) || typeof agent?.id !== "string" || !switched) return;
	const signature = [switched.provider ?? "", switched.model ?? "", switched.reasoningEffort ?? ""].join("|");
	if (state.routeAppliedSignatures === void 0) state.routeAppliedSignatures = new Map();
	const key = canonicalChildKey(agent.id);
	if (state.routeAppliedSignatures.get(key) === signature) return;
	state.routeAppliedSignatures.set(key, signature);
	broadcastRouteChange(state, agent.id, routeRevisionOf(state, agent.id), reason);
}

/**
 * Tell every open page that a subagent was moved off a failing route.
 *
 * The pill in the session header is the only place this is visible while the
 * child keeps running: the failure itself never reaches the transcript (the
 * child is retried, not stopped), so without this frame the switch would be
 * silent. Best-effort, like the route frames.
 */
function broadcastFailoverNotice(state, notice) {
	const broadcast = state?.routeEventBroadcast;
	if (typeof broadcast !== "function" || notice === void 0 || notice === null) return;
	const route = (value) => (value !== void 0 && value !== null && typeof value.provider === "string" && typeof value.model === "string"
		? { provider: value.provider, model: value.model, reasoningEffort: typeof value.reasoningEffort === "string" ? value.reasoningEffort : "" }
		: null);
	try {
		broadcast({
			type: "failover",
			childId: canonicalChildKey(notice.childId),
			parentSessionId: typeof notice.parentSessionId === "string" ? notice.parentSessionId : "",
			from: route(notice.from),
			to: route(notice.to),
			reason: typeof notice.reason === "string" ? notice.reason : "failover",
			manual: notice.manual === true,
			error: typeof notice.error === "string" ? notice.error.slice(0, 200) : "",
			at: Date.now()
		});
	} catch (_) { /* a dead stream cleans itself up in its write guard */ }
}

/**
 * Best-effort parent session id of a live child.
 *
 * The host does not promise a parent field on the agent object, so this tries
 * the shapes it has been seen to carry and returns "" when none is there. The
 * UI uses it only to keep another conversation's notice out of this page; an
 * empty answer means "unknown", and the notice is shown.
 */
function failoverParentSessionId(agent) {
	const header = agent?.session?.header ?? {};
	const candidates = [header.parentSessionId, header.parentId, agent?.parentId];
	for (const value of candidates) {
		if (typeof value === "string" && value !== "") return value;
	}
	return "";
}

/** The override written for one child (either id spelling), or undefined. */
function childRouteOverrideFor(state, childId) {
	if (typeof childId !== "string" || state.childRoutes === void 0) return void 0;
	return state.childRoutes.get(childId)
		?? (childId.startsWith("session-") ? state.childRoutes.get(childId.slice(8)) : state.childRoutes.get("session-" + childId));
}

/** Write one override under every id spelling the host may key it by. */
function setChildRoute(state, childId, route) {
	const revision = bumpRouteRevision(state, childId);
	for (const form of childIdForms(childId)) state.childRoutes.set(form, route);
	broadcastRouteChange(state, childId, revision, "override-set");
}

/** Drop every id spelling of one override. */
function clearChildRoute(state, childId) {
	const revision = bumpRouteRevision(state, childId);
	for (const form of childIdForms(childId)) state.childRoutes.delete(form);
	broadcastRouteChange(state, childId, revision, "override-cleared");
}

/**
 * Apply a route to a LIVE child through the host's front door: `agent.model.select()`.
 *
 * WHY THIS EXISTS: the host (since its 2026-11-04 build) freezes the selection
 * before step preparation and THROWS when an `agent/request` waterfall proposes
 * a different provider/model/effort ("use agent.model.select() before step
 * preparation"). Request-time rewrites are therefore illegal; the only live
 * mutation surface left is `model.select`, which takes effect from the NEXT
 * step/turn (the loop retains the captured selection across retries).
 *
 * Never throws: the caller reports `{applied, reason, message}` honestly and the
 * stored override stays in place either way (it keeps describing the intent for
 * the pickers, and for children that are not live yet it is the pending route).
 *
 * @param {object|undefined} agent - a live agent from `agentsService`, or undefined.
 * @param {{provider: string, model: string, reasoningEffort?: string}} route - the target route.
 * @returns {Promise<{applied: boolean, reason?: string, message?: string}>}
 */
async function applyLiveRouteSelect(ctx, state, agent, route) {
	if (agent === void 0 || agent === null) return { applied: false, reason: "not-live" };
	// THE EXIT GATE: every live switch in this plugin comes through here, so a
	// retired model can never be handed to the host from any caller — present or
	// future — without being replaced first.
	const gated = liveRouteGate(ctx, state, agent, route);
	if (gated === void 0) return { applied: false, reason: "no-route" };
	route = gated;
	const model = agent.model;
	if (model === void 0 || model === null || typeof model.select !== "function") {
		return { applied: false, reason: "no-model-select" };
	}
	const selection = {
		provider: route.provider,
		model: route.model,
		...(route.reasoningEffort === void 0 ? {} : { reasoningEffort: route.reasoningEffort })
	};
	try {
		// `model.select` is synchronous on the host's own call sites but the
		// ACP path awaits nothing either — accept both shapes without assuming.
		const outcome = model.select(selection);
		if (outcome !== void 0 && outcome !== null && typeof outcome.then === "function") await outcome;
		return { applied: true };
	} catch (error) {
		return { applied: false, reason: "select-failed", message: String(error?.message ?? error) };
	}
}

/**
 * The route a child is on or will move to, ignoring nothing.
 *
 * Used by `keepModel` so that "change only the thinking level" cannot silently
 * swap the model: the model comes from whatever the child is actually bound to.
 *
 * @param {object} row - a `strictChildrenOf` row.
 * @returns {{provider: string, model: string, reasoningEffort: string}}
 */
export function effectiveRouteOf(row) {
	const override = row?.override;
	const actualProvider = typeof row?.provider === "string" ? row.provider : "";
	const actualModel = typeof row?.model === "string" ? row.model : "";
	if (override === null || override === void 0) {
		return {
			provider: actualProvider,
			model: actualModel,
			reasoningEffort: typeof row?.reasoningEffort === "string" ? row.reasoningEffort : ""
		};
	}
	return {
		provider: typeof override.provider === "string" && override.provider !== "" ? override.provider : actualProvider,
		model: typeof override.model === "string" && override.model !== "" ? override.model : actualModel,
		reasoningEffort: typeof override.reasoningEffort === "string" ? override.reasoningEffort : ""
	};
}

/**
 * Validate and apply one batch selection, returning the item result row.
 *
 * Order matters: ownership first (a forged id must never reach the pool check,
 * which would report "model not allowed" and teach the caller nothing), then the
 * model, then the effort. Only the model list this page configures may be
 * written. Never throws: one bad selection must not abort its siblings.
 *
 * @returns {Promise<object>} `{childId, ok, ...}`.
 */
export async function applyBatchSelection(ctx, state, parentSessionId, selection, caps) {
	const childId = typeof selection?.childId === "string" ? selection.childId.trim() : "";
	const fail = (code, message) => ({ childId, ok: false, error: { code, message } });
	const owned = await resolveOwnedChild(ctx, state, parentSessionId, childId);
	if (owned.ok !== true) return { childId, ok: false, error: owned.error };
	const row = owned.value;
	const pool = hostModelPool(state.getSection?.());
	const allowed = new Map(pool.map((entry) => [`${entry.provider}\u0000${entry.model}`, entry]));
	const keepModel = selection?.keepModel === true;
	const keepEffort = selection?.keepEffort === true;
	if (keepModel && keepEffort) return fail("bad-request", "keepModel and keepEffort cannot both be asked of one write");
	let provider = "";
	let model = "";
	if (keepModel) {
		const base = effectiveRouteOf(row);
		provider = base.provider;
		model = base.model;
		if (provider === "" || model === "") return fail("model-unknown", "that child has no known model to keep");
		if (!allowed.has(`${provider}\u0000${model}`)) return fail("model-not-allowed", "that child's current model is not in this page's list");
	} else {
		provider = typeof selection?.provider === "string" ? selection.provider.trim() : "";
		model = typeof selection?.model === "string" ? selection.model.trim() : "";
		if (provider === "" || model === "") return fail("bad-request", "provider and model are required (or keepModel: true)");
		if (!allowed.has(`${provider}\u0000${model}`)) return fail("model-not-allowed", `${provider}/${model} is not configured on this page`);
	}
	const rawEffort = selection?.reasoningEffort;
	if (rawEffort !== void 0 && rawEffort !== null && typeof rawEffort !== "string") {
		return fail("bad-request", "reasoningEffort must be a string or null");
	}
	// THREE DISTINCT ASKS, not one flag:
	//   keepEffort  → carry whatever strength this child already has on its override;
	//   "" / null   → the model's default, which DROPS any inherited effort in the
	//                 request waterfall instead of quietly keeping the old one;
	//   "<id>"      → that exact strength.
	let effort = "";
	if (keepEffort) {
		const before = row.override;
		effort = before !== null && before !== void 0 && typeof before.reasoningEffort === "string" ? before.reasoningEffort : "";
	} else {
		effort = typeof rawEffort === "string" ? rawEffort.trim() : "";
	}
	if (effort !== "") {
		const poolRow = allowed.get(`${provider}\u0000${model}`);
		const configured = Array.isArray(poolRow?.configuredEfforts) && poolRow.configuredEfforts.includes(effort);
		const providerCaps = caps?.get?.(provider);
		const known = providerCaps !== void 0 && providerCaps !== null && providerCaps.ok === true
			? providerCaps.models.get(model)
			: void 0;
		const capabilityKnown = known !== void 0 && known.capabilityKnown === true;
		if (capabilityKnown) {
			// The provider is authoritative: a strength left over in this page's own
			// configuration does NOT make it supported, so it is refused here rather
			// than written and silently ignored by the provider.
			if (!known.efforts.some((entry) => entry.id === effort)) {
				return fail("effort-unknown", `reasoning effort "${effort}" is not offered by ${provider}/${model}`);
			}
		} else if (!configured) {
			// Capability unknown: a pin in this page is the only evidence there is, and
			// an unverified strength must never be invented for a model.
			return fail("effort-unverified", `reasoning effort "${effort}" cannot be verified for ${provider}/${model}`);
		}
	}
	const liveAgent = liveSubagent(agentsService(ctx), childId);
	// ONE DECISION, ONE STORE. The whitelist already said "this child may name
	// it"; the exit gate says "its provider still serves it". What survives both
	// is what gets stored and applied, so the picker and the child can never
	// disagree about the route that is really running.
	const requested = { provider, model, ...(effort === "" ? {} : { reasoningEffort: effort }) };
	const gatedPick = liveRouteGate(ctx, state, liveAgent, requested) ?? requested;
	setChildRoute(state, childId, gatedPick);
	const frontDoor = await applyLiveRouteSelect(ctx, state, liveAgent, gatedPick);
	const described = describeChildRoute(state, childId, liveAgent);
	return {
		childId,
		ok: true,
		revision: routeRevisionOf(state, childId),
		route: { provider, model, ...(effort === "" ? {} : { reasoningEffort: effort }) },
		provider: described.provider,
		model: described.model,
		reasoningEffort: described.reasoningEffort,
		actual: described.actual,
		override: described.override,
		pendingRoute: described.pendingRoute,
		pending: described.pending,
		applied: frontDoor.applied,
		...(frontDoor.applied === true ? {} : {
			appliedReason: frontDoor.reason,
			...(frontDoor.message === void 0 ? {} : { appliedError: frontDoor.message })
		})
	};
}


/**
 * One controller behind BOTH the HTTP endpoints and the model-callable tools.
 *
 * The tools must not re-enter this plugin over its own localhost HTTP: that
 * would make tool behavior depend on the web server being mounted, and it
 * would duplicate every validation rule. Everything that decides whether a
 * write is legal lives here, once.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} state - the plugin state.
 */
export function createRouteController(ctx, state) {
	return {
		/** Instance epoch: changes on every (re)mount; pairs with per-target revisions. */
		epoch: () => (typeof state.routeEpoch === "string" && state.routeEpoch !== "" ? state.routeEpoch : "e0"),
		revisionOf: (childId) => routeRevisionOf(state, childId),
		/** The strict catalog rows for one parent conversation. */
		children: (parentSessionId) => strictChildrenOf(ctx, state, parentSessionId),
		/** The configured model pool with provider-verified efforts. */
		async catalog() {
			const caps = await modelCapabilities(ctx, state);
			return batchModelCatalog(state.getSection?.(), caps);
		},
		/** Re-verify ownership and write one selection. Never throws. */
		async select(parentSessionId, selection) {
			const caps = await modelCapabilities(ctx, state);
			return applyBatchSelection(ctx, state, parentSessionId, selection, caps);
		},
		/** Re-verify ownership and drop one override. Never throws. */
		async clear(parentSessionId, childId) {
			const owned = await resolveOwnedChild(ctx, state, parentSessionId, childId);
			if (owned.ok !== true) return { childId, ok: false, error: owned.error };
			clearChildRoute(state, childId);
			const described = describeChildRoute(state, childId, liveSubagent(agentsService(ctx), childId));
			return {
				childId,
				ok: true,
				revision: routeRevisionOf(state, childId),
				route: null,
				provider: described.provider,
				model: described.model,
				reasoningEffort: described.reasoningEffort,
				actual: described.actual,
				override: described.override,
				pendingRoute: described.pendingRoute,
				pending: described.pending
			};
		},
		/** What one child is on right now (actual/override/pending). */
		snapshot: (childId) => describeChildRoute(state, childId, liveSubagent(agentsService(ctx), childId))
	};
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
	const section = state?.getSection?.();
	// The host's own gate must never offer a route the gateway retired: what it
	// offers is what a child may name, so filtering here closes the last way a
	// dead model could reach a request that the plugin did not select itself.
	const desired = filterLiveRoutes(state, hostGateModels(section));
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
		// rc.3 spells the preset as a FLAT spec field (`spec.agentPreset`); older
		// hosts put it on the request. Read both: a spawn that names its preset on
		// the spec would otherwise look like an ordinary child.
		preset: request?.agentPreset ?? spec?.agentPreset,
		cwd: request?.cwd ?? spec?.cwd
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

// ── the coordinator's two lists ─────────────────────────────────────────────
//
// WHY A SECOND PAIR OF LISTS: one plugin (by default dsh-orchestrator) dispatches
// every unit of work as a child session whose title says what KIND of work it
// is. Visual work (SVG, SVG animation, UI/UX edits, generated visual code) and
// non-visual work want different models, and mixing them into the general pools
// would let an ordinary subagent borrow a model the user reserved for that one
// plugin. So the two lists here are STRICTLY isolated:
//
//   * a route named here is removed from every general list and from the native
//     whitelist a plain child is judged against;
//   * a child born by that plugin (its preset) runs on the list its title names,
//     first entry first;
//   * a failure cools the route down for a growing wait, then the next entry
//     serves, and once the wait expires the FIRST entry is tried again.
const COORD_UI_TAG = /【\s*(?:UI|UI\s*绘制|ui\s*绘制|界面|前端|视觉)\s*】|\[\s*(?:ui|frontend|visual)\s*\]/;
const COORD_BACKEND_TAG = /【\s*(?:后端|服务端|接口|后端处理)\s*】|\[\s*(?:backend|be|server|api)\s*\]/i;
const COORD_RESEARCH_TAG = /【\s*(?:查阅|审计|排查|调研|分析|研究|盘点|只读)\s*】|\[\s*(?:research|readonly|read-only|analysis|audit|investigate)\s*\]/i;
const COORD_DELIVERY_TAG = /【\s*(?:交付|执行|打包|发布|上线|运维|跑腿)\s*】|\[\s*(?:delivery|ops|ship|release|build|deploy)\s*\]/i;

/**
 * Read-only ACTS. A title that starts at one of these — and names no write act
 * — is research work no matter what it looks at: an audit OF the backend is
 * still an audit. Live evidence that this was missing: 「审计后端漏洞用户系统
 * 与服务器安全」 scored backend on 服务/后端 and ran on the codex backend route,
 * while 「盘点表盘内容供给与合规缺口」 only reached research by accident (the
 * boilerplate 「【任务引用】」 in the prompt contains 「引用」).
 */
const COORD_READONLY_ACT = /(?:审计|审查|审阅|稽核|盘点|清点|体检|复查|复核|核对|对账|比对|对比|梳理|排查|盘查|查证|核实|追溯|溯源|摸底|探查|调研|查阅|评估|分析|研究|摸清|检查|巡检|取证|只读|读一遍|读一下|看一遍|看一下|\b(?:audit|review|inspect|survey|inventory|read-?only|analyse|analyze|assess|evaluate|investigate|examine)\b)/i;

/** Write acts. Their presence cancels the read-only rule (audit AND fix = backend). */
const COORD_WRITE_ACT = /(?:修复|修一下|修改|改一下|改动|整改|实现|新增|添加|加上|补齐|补上|重构|重写|接上|接入|部署|发布|上传|打包|替换|换成|迁移|升级|优化|删除|清理|联调|上线|回滚|生成|\b(?:build|fix|implement|add|deploy|refactor|migrate|upgrade|replace|remove|optimi[sz]e|generate)\b)/i;

/** Words that point at VISUAL work. Chinese and English, both lowercased. */
const COORD_UI_WORDS = [
	"svg", "图标", "icon", "动画", "animation", "动效", "配色", "调色", "主题色", "深浅色", "暗色", "亮色",
	"排版", "字体", "字号", "行高", "布局", "栅格", "间距", "圆角", "阴影", "渐变", "样式", "样式表", "css",
	"组件", "界面", "页面", "视觉", "视觉稿", "原型", "截图", "线框", "交互", "响应式", "自适应", "窄屏", "宽屏",
	"无障碍", "可访问性", "ui", "ux", "mockup", "设计稿", "画布", "canvas", "图表", "折线图", "柱状图", "饼图"
];

/**
 * Words that point at DELIVERY work: build it, ship it, install it, verify it,
 * move it. These are the acts that need no design decision — the target is
 * already decided and the receipt is what proves the work. They used to sit in
 * the backend list, so every packaging job was priced like a code change.
 */
const COORD_DELIVERY_WORDS = [
	"打包", "构建", "出包", "签名", "上传", "发布", "发版", "上线", "部署", "回滚", "安装",
	"跑一遍", "跑一下", "重跑", "重试", "回归测试", "冒烟", "验收", "核对", "校验", "比对哈希",
	"导出", "导入", "归档", "搬运", "拷贝", "复制", "重命名", "批量", "清理", "环境准备",
	"装依赖", "清缓存", "看端口", "版本号", "下载链接", "回执", "哈希", "校验和", "截图取证",
	"录屏", "压缩", "解压", "发布物", "产物", "安装包", "真机安装", "模拟器",
	"build", "package", "upload", "deploy", "release", "publish", "ship", "install",
	"rollback", "archive", "export", "import", "batch", "rename", "checksum", "artifact"
];

/**
 * The read-only acts that PAIR with a delivery verb: they are how a delivery job
 * proves itself (核对/比对/校验/验收/取证). An audit act (审计/盘点/调研) keeps the
 * research lane even when the thing being audited is a release process.
 */
const COORD_RECEIPT_CHECK = /(?:核对|比对|校验|验收|复核|复查|对账|取证)/;

/** Verbs and nouns that mean "produce it / ship it / prove it". */
const COORD_DELIVERY_ACT = /(?:打包|构建|出包|签名|上传|发布|发版|上线|部署|回滚|安装|删除|传上去|传上去|跑一遍|跑一下|重跑|回归测试|冒烟|验收|导出|导入|归档|搬运|拷贝|复制|重命名|批量|清理|截图取证|录屏|压缩|解压|下载链接|回执|哈希|校验和|安装包|\b(?:build|package|upload|deploy|release|publish|install|rollback|archive|export|import|batch|rename|checksum)\b)/i;

/** Acts that require a decision — they outrank every delivery verb. */
const COORD_DESIGN_ACT = /(?:修复|修好|改掉|改造|实现|新增|开发|重构|优化|设计|接入|替换|迁移|解决|补齐|加上|去掉|调整|改成|换成|重写|合并|拆分)/;

/**
 * Diagnosing a DELIVERY failure (「构建失败的排查」「上传卡住的原因」) needs judgment:
 * it is not "run the steps again", so it goes to backend. Diagnosis on its own
 * (「排查线上报错原因」) keeps the research lane it always had.
 */
const COORD_DIAGNOSE = /(?:排查|定位|复现|原因|为什么|调试)/;

/** Words that point at NON-visual work. */
const COORD_BACKEND_WORDS = [
	"接口", "api", "端点", "数据库", "sql", "表结构", "索引", "迁移", "migration", "构建", "build", "ci",
	"部署", "deploy", "服务", "服务端", "脚本", "性能", "内存", "日志", "测试", "单测", "回归", "重构",
	"状态机", "缓存", "队列", "并发", "锁", "序列化", "解析", "算法", "依赖", "打包", "编译", "崩溃",
	"报错", "异常", "超时", "重试", "配置", "环境变量", "后端", "命令行", "终端", "进程"
];

/** Words that point at READ-ONLY research: look it up, read it, explain it. */
const COORD_RESEARCH_WORDS = [
	"查阅", "调研", "分析", "研究", "评估", "对比", "比较", "结论", "证据", "依据", "出处", "引用",
	"审计", "只读", "盘点", "清点", "体检", "审查", "审阅", "稽核", "合规", "缺口", "现状", "家底",
	"盘查", "查证", "核实", "追溯", "溯源", "摸底", "探查", "巡检", "调研报告",
	"竞争力", "完成度", "覆盖率", "风险点", "薄弱", "梳理", "排查", "定位", "复现", "是什么",
	"读一遍", "读一下", "看看", "看一下", "找资料", "资料", "文档", "源码", "代码阅读",
	"为什么", "原理", "机制", "方案对比", "可行性", "风险",
	"research", "analyse", "analyze", "compare", "review", "investigate", "explain", "audit",
	"readonly", "read-only", "survey", "inventory", "inspect", "assessment"
];

const COORD_COOLDOWN_PRESETS = {
	light: { steps: [1, 3, 5], cap: 10 },
	medium: { steps: [1, 5, 15], cap: 30 },
	heavy: { steps: [2, 10, 30], cap: 60 }
};

const COORD_GROUP_LABEL = { ui: "UI 绘制", research: "审计查阅", delivery: "交付执行", backend: "后端处理" };
const COORD_GROUP_FIELD = {
	ui: "coordinatorUiModels",
	research: "coordinatorResearchModels",
	delivery: "coordinatorDeliveryModels",
	backend: "coordinatorBackendModels"
};
/** The four lists, in the order the card shows them. */
export const COORD_GROUPS = ["ui", "research", "delivery", "backend"];

/** The four lists, resolved from the live settings section (page order kept). */
export function coordinatorGroupRoutes(section, group) {
	if (!section) return [];
	const field = COORD_GROUP_FIELD[group] ?? "";
	if (field === "") return [];
	const declared = Array.isArray(section[field]) ? section[field] : [];
	// AN UNCONFIGURED DELIVERY LIST IS NOT A HOLE. Work classified as delivery
	// would otherwise fall back to the parent's route — the expensive model the
	// split exists to spare. Until the user fills it, delivery runs on the
	// backend list, which is what those jobs ran on before the split existed.
	if (group === "delivery" && declared.length === 0) return coordinatorGroupRoutes(section, "backend");
	const out = [];
	const seen = new Set();
	for (const entry of declared) {
		const route = resolveEntry(section, entry);
		if (route === void 0) continue;
		const key = routeKey(route);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(route);
	}
	return out;
}

/**
 * The general pool AS THE PAGE DECLARES IT, before the coordinator lists take
 * their share. Used only to explain a short picker: "3 configured, 2 reserved".
 *
 * @param {object} section - the resolved settings section.
 * @returns {Array<{provider: string, model: string}>} declared general routes.
 */
function declaredGeneralRoutes(section) {
	if (!section) return [];
	const out = [];
	const seen = new Set();
	const add = (route) => {
		if (route === void 0 || route === null) return;
		const key = routeKey(route);
		if (seen.has(key)) return;
		seen.add(key);
		out.push(route);
	};
	if (Array.isArray(section.models)) {
		for (const entry of section.models) add(resolveEntry(section, entry));
	}
	if (typeof section.model === "string" && section.model !== "" && typeof section.provider === "string" && section.provider !== "") {
		add({ provider: section.provider, model: section.model });
	}
	return out;
}

/** Every route either coordinator list names — the set ordinary children may not use. */
export function coordinatorAllRoutes(section) {
	const out = [];
	const seen = new Set();
	for (const group of COORD_GROUPS) {
		for (const route of coordinatorGroupRoutes(section, group)) {
			const key = routeKey(route);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(route);
		}
	}
	return out;
}

/** True when this route is reserved for the coordinator's subagents. */
export function isCoordinatorRoute(section, route) {
	if (!route || typeof route.provider !== "string" || typeof route.model !== "string") return false;
	const key = routeKey(route);
	return coordinatorAllRoutes(section).some((entry) => routeKey(entry) === key);
}

/** True when the two lists are switched on and at least one of them has a route. */
function coordinatorEnabled(section) {
	if (!section || section.coordinatorEnabled === false) return false;
	return coordinatorAllRoutes(section).length > 0;
}

function tagGroupOf(text) {
	if (typeof text !== "string" || text === "") return void 0;
	if (COORD_UI_TAG.test(text)) return "ui";
	if (COORD_RESEARCH_TAG.test(text)) return "research";
	if (COORD_DELIVERY_TAG.test(text)) return "delivery";
	if (COORD_BACKEND_TAG.test(text)) return "backend";
	return void 0;
}

// ── the coordinator's own decision ───────────────────────────────────────────
//
// The lists belong to the user, but WHICH list a unit of work needs is a
// judgement about intent, and the coordinator is the only party that knows it.
// The rules below (tags, read-only acts, keyword scores) are a GUESS; this is
// the coordinator SAYING it, and a statement outranks every guess. It can be
// written anywhere in the title or the task description:
//
//   组：审计查阅        【组：后端】        group: research
//   交给审计组          用后端组的模型
//
// Naming the group in the settings page is what the convention text now asks
// for, so the coordinator decides and the plugin stays out of the way.
const COORD_GROUP_ALIAS = {
	ui: ["ui", "ui绘制", "界面", "视觉", "绘制", "设计", "外观", "前端外观", "样式", "visual", "frontend", "design"],
	research: ["审计查阅", "审计", "查阅", "排查", "调研", "研究", "只读", "分析", "查证", "核实", "检查", "research", "audit", "readonly", "read-only"],
	delivery: ["交付执行", "交付", "执行", "打包", "发布", "上线", "运维", "跑腿", "发布运维", "delivery", "ops", "ship", "runner", "exec"],
	backend: ["后端处理", "后端", "服务端", "接口", "工程", "代码", "实现", "开发", "backend", "server", "api", "code", "impl"]
};

const COORD_DIRECTIVE = /(?:【|\[)?\s*(?:组|分组|名单|group)\s*[:：]\s*([^\s】\]()（）,，。;；]{1,12})/i;
const COORD_DIRECTIVE_VERB = /(?:交给|派给|分给|交给|用|走|归|放到|挂到)\s*([^\s，,。；;]{1,10}?)\s*组/;

/** The group name a coordinator wrote, matched loosely against the aliases. */
function aliasGroupOf(word) {
	const text = typeof word === "string" ? word.trim().toLowerCase().replace(/\s+/g, "") : "";
	if (text === "") return void 0;
	for (const group of COORD_GROUPS) {
		const aliases = COORD_GROUP_ALIAS[group];
		if (aliases.some((alias) => alias.replace(/\s+/g, "") === text)) return group;
	}
	for (const group of COORD_GROUPS) {
		const aliases = COORD_GROUP_ALIAS[group];
		if (aliases.some((alias) => text.includes(alias.replace(/\s+/g, "")) || alias.replace(/\s+/g, "").includes(text))) return group;
	}
	return void 0;
}

/** The group the coordinator explicitly named in `text`, if any. */
function directiveGroupOf(text) {
	if (typeof text !== "string" || text === "") return void 0;
	const named = text.match(COORD_DIRECTIVE);
	if (named !== null) {
		const group = aliasGroupOf(named[1]);
		if (group !== void 0) return { group, word: named[1] };
	}
	const phrased = text.match(COORD_DIRECTIVE_VERB);
	if (phrased !== null) {
		const group = aliasGroupOf(phrased[1]);
		if (group !== void 0) return { group, word: phrased[1] };
	}
	return void 0;
}

function countWords(text, words) {
	const lower = text.toLowerCase();
	let hits = 0;
	const found = [];
	for (const word of words) {
		if (lower.includes(word)) {
			hits += 1;
			if (found.length < 3) found.push(word);
		}
	}
	return { hits, found };
}

const COORD_TAG_NAME = { ui: "UI", research: "审计查阅", delivery: "交付", backend: "后端" };

/**
 * Which of the coordinator's four lists a task belongs to.
 *
 * THE COORDINATOR DECIDES FIRST. It is the only party that knows what a unit of
 * work is FOR, so it can name the group outright — 「组：审计查阅」 in the title or
 * in the task description, 【组：后端】, `group: research`, 「交给审计组」 — and that
 * outranks everything below. The rules exist for the case where it says nothing.
 *
 * When it says nothing, in this order:
 *   0. a 【UI】/【查阅】/【后端】 tag in the title (or description);
 *   1. a READ-ONLY ACT in the title with no write act — 审计/盘点/调研/梳理… —
 *      is research, whatever it looks at (an audit OF the backend is an audit);
 *      both kinds of act in one title (审计并修复) is a change: backend;
 *   2. otherwise the TITLE's words decide on their own, and only a title with
 *      no clear answer consults the body — with the dispatcher's boilerplate
 *      (【任务引用】 tk-… chunks) stripped first, so a task is judged on what it
 *      is and not on the wrapper it arrived in;
 *   3. a tie or no evidence at all falls back to BACKEND — a backend task on a
 *      visual or read-only model costs more than the reverse.
 *
 * @returns {{group: "ui"|"research"|"delivery"|"backend", reason: "directive"|"tag"|"readonly"|"mixed"|"keyword"|"default", evidence: string}}
 */
export function classifyCoordinatorTask(label, prompt) {
	const title = typeof label === "string" ? label : "";
	const body = stripCoordinatorBoilerplate(typeof prompt === "string" ? prompt : extractPromptText(prompt));
	// 1. The coordinator NAMED the group. That is a decision, not a signal.
	const said = directiveGroupOf(title);
	if (said !== void 0) {
		return { group: said.group, reason: "directive", evidence: `标题写明「组：${said.word}」` };
	}
	const saidInBody = directiveGroupOf(body);
	if (saidInBody !== void 0) {
		return { group: saidInBody.group, reason: "directive", evidence: `说明里写明「组：${saidInBody.word}」` };
	}
	const tagged = tagGroupOf(title) ?? tagGroupOf(body);
	if (tagged !== void 0) {
		const where = tagGroupOf(title) !== void 0 ? "标题" : "描述";
		return { group: tagged, reason: "tag", evidence: `${where}命中【${COORD_TAG_NAME[tagged]}】` };
	}
	const readOnly = title.match(COORD_READONLY_ACT);
	if (readOnly !== null) {
		// 核对/比对 next to a delivery verb or noun (链接、哈希、安装包、回执) is a
		// receipt check — a delivery job — not an audit. Pure reading keeps the
		// research lane.
		if (!COORD_DESIGN_ACT.test(title) && COORD_RECEIPT_CHECK.test(readOnly[0]) && COORD_DELIVERY_ACT.test(title)) {
			return { group: "delivery", reason: "readonly", evidence: `标题是交付动作（读只是手段）：${readOnly[0]}` };
		}
		if (!COORD_DESIGN_ACT.test(title) && COORD_DELIVERY_ACT.test(title) && COORD_DIAGNOSE.test(title)) {
			return { group: "backend", reason: "mixed", evidence: `交付失败要判断原因：${title.match(COORD_DIAGNOSE)[0]}` };
		}
		if (!COORD_DESIGN_ACT.test(title)) {
			return { group: "research", reason: "readonly", evidence: `标题是只读动作：${readOnly[0]}` };
		}
		// 审计并修复 / 分析后改掉：both directions are named in one title, so it is
		// a change that happens to start with reading. Backend is the safe side.
		return { group: "backend", reason: "mixed", evidence: `标题既读又改：${readOnly[0]}` };
	}
	// DELIVERY BEFORE DESIGN: an act that produces or ships something, with no
	// decision act beside it, is delivery. 「改完再传」 (both acts in one title) is
	// a change and stays backend — splitting one chain across two lists costs
	// more than it saves.
	if (COORD_DELIVERY_ACT.test(title) && !COORD_DESIGN_ACT.test(title)) {
		return { group: "delivery", reason: "keyword", evidence: `标题是交付动作：${title.match(COORD_DELIVERY_ACT)[0]}` };
	}
	if (COORD_DELIVERY_ACT.test(title) && COORD_DESIGN_ACT.test(title)) {
		return { group: "backend", reason: "mixed", evidence: `标题既要改又要交付：${title.match(COORD_DESIGN_ACT)[0]}` };
	}
	if (COORD_DELIVERY_ACT.test(title) && COORD_DIAGNOSE.test(title)) {
		return { group: "backend", reason: "mixed", evidence: `交付失败要判断原因：${title.match(COORD_DIAGNOSE)[0]}` };
	}
	// THE TITLE DECIDES WHEN IT CAN. The dispatcher's body is instructions, not a
	// job description: a title saying 「修复登录超时」 must not lose to a body that
	// happens to list 「文档、源码、分析、梳理…」 as reading material.
	const titleScores = {
		ui: countWords(title, COORD_UI_WORDS),
		research: countWords(title, COORD_RESEARCH_WORDS),
		delivery: countWords(title, COORD_DELIVERY_WORDS),
		backend: countWords(title, COORD_BACKEND_WORDS)
	};
	const decide = (scores) => {
		const best = COORD_GROUPS.reduce((winner, group) => (scores[group].hits > scores[winner].hits ? group : winner), "ui");
		const hits = scores[best].hits;
		const tied = COORD_GROUPS.some((group) => group !== best && scores[group].hits === hits);
		return { best, hits, tied };
	};
	const byTitle = decide(titleScores);
	if (byTitle.hits > 0 && !byTitle.tied) {
		const wordKind = { ui: "视觉词", research: "查阅词", delivery: "交付词", backend: "后端词" }[byTitle.best];
		return { group: byTitle.best, reason: "keyword", evidence: `命中${wordKind}：${titleScores[byTitle.best].found.join("、")}` };
	}
	const scores = {
		ui: weighTitleAndBody(title, body, COORD_UI_WORDS),
		research: weighTitleAndBody(title, body, COORD_RESEARCH_WORDS),
		delivery: weighTitleAndBody(title, body, COORD_DELIVERY_WORDS),
		backend: weighTitleAndBody(title, body, COORD_BACKEND_WORDS)
	};
	const combined = decide(scores);
	if (combined.hits === 0) {
		return { group: "backend", reason: "default", evidence: "没有标签也没有线索，按后端处理" };
	}
	if (combined.tied) {
		return { group: "backend", reason: "keyword", evidence: "几个方向打平，按后端处理" };
	}
	const wordKind = { ui: "视觉词", research: "查阅词", delivery: "交付词", backend: "后端词" }[combined.best];
	return { group: combined.best, reason: "keyword", evidence: `命中${wordKind}：${scores[combined.best].found.join("、")}` };
}

/**
 * Remove the dispatcher's wrapper before scoring.
 *
 * WHY: every coordinator child is born with 「【任务引用】tk-xxxx 【任务详情】先调
 * task_detail…」 in front of its real instruction, and that wrapper is not
 * neutral — 「任务引用」 alone carried 「引用」, a research word, so a backend
 * audit was routed onto the research list by the wrapper rather than by the job.
 */
export function stripCoordinatorBoilerplate(text) {
	if (typeof text !== "string" || text === "") return "";
	return text
		.replace(/【\s*任务引用\s*】[^\n]*/g, " ")
		.replace(/【\s*任务详情\s*】/g, " ")
		.replace(/\b(?:task_id|task_detail|task_status|tk-[a-z0-9]+)\b/gi, " ")
		.replace(/任务引用|任务详情/g, " ");
}

/**
 * Score one group's words, counting a hit in the TITLE twice.
 *
 * The title is what the user and the coordinator agreed the job is; the body is
 * mostly instructions and boilerplate, so a body word must not outvote it.
 */
function weighTitleAndBody(title, body, words) {
	const inTitle = countWords(title, words);
	const inBody = countWords(body, words);
	const found = inTitle.found.slice();
	for (const word of inBody.found) {
		if (found.length >= 3) break;
		if (found.indexOf(word) < 0) found.push(word);
	}
	return { hits: inTitle.hits * 2 + inBody.hits, found };
}

/** The fresh child id/group ledger entry; also used to spot nested delegations. */
function coordinatorRecord(state, childId, group, reason, evidence) {
	if (typeof childId !== "string" || childId === "") return;
	const map = state.coordGroupOfChild instanceof Map ? state.coordGroupOfChild : (state.coordGroupOfChild = new Map());
	for (const form of childIdForms(childId)) map.set(form, { group, reason, evidence, at: Date.now() });
	scheduleCoordinatorLedgerSave(state);
}

// ── the group ledger SURVIVES A RELOAD ───────────────────────────────────────
//
// WHAT WENT WRONG (live, session-7a929cab at 02:54): the ledger is the only
// thing that says "this child belongs to the backend list". It lived in memory,
// so every plugin reload emptied it — and a running coordinator child was then
// judged as an ordinary child by `enforceWhitelistOnSeed`, which reads the
// GENERAL whitelist. Its backend route (codex/gpt-6.2-sol) was "not on the
// general list", so the plugin switched it mid-run onto the general list's
// first route (flash-eco): the exact bug 5.6.0 fixed, resurrected by a reload.
//
// The decisions are small and cheap, so they are written to a JSON file under
// the DSH state directory and read back at boot. TTL keeps the file from
// growing forever; a child that is gone simply never matches again.
const COORD_LEDGER_TTL_MS = 24 * 60 * 60 * 1000;

/** Where the ledger lives; the test suite overrides the directory. */
export function coordinatorLedgerPath() {
	const explicit = typeof process.env.DSH_SUBAGENT_ROLE_ROUTER_STATE === "string" ? process.env.DSH_SUBAGENT_ROLE_ROUTER_STATE.trim() : "";
	if (explicit !== "") return join(explicit, "coordinator-groups.json");
	// NEVER touch the user's real state directory from the test runner: the
	// harnesses call `apply()`, and a fake child ("child-1") would be written into
	// the live ledger and then be judged as a coordinator child by every later
	// run — which is exactly how the failover tests started failing.
	if (typeof process.env.NODE_TEST_CONTEXT === "string" && process.env.NODE_TEST_CONTEXT !== "") return "";
	return join(process.env.USERPROFILE || process.env.HOME || "", ".dsh", "state", "subagent-role-router", "coordinator-groups.json");
}

/**
 * Read the persisted decisions into `state.coordGroupOfChild`.
 *
 * @param {object} state - plugin state.
 * @param {number} [now] - clock, for tests.
 * @returns {number} how many children were restored.
 */
export function loadCoordinatorLedger(state, now = Date.now()) {
	if (state === void 0 || state === null) return 0;
	const path = coordinatorLedgerPath();
	if (path === "") return 0;
	let rows;
	try {
		rows = JSON.parse(fs.readFileSync(path, "utf8"));
	} catch (_error) {
		return 0;
	}
	if (!Array.isArray(rows)) return 0;
	const map = state.coordGroupOfChild instanceof Map ? state.coordGroupOfChild : (state.coordGroupOfChild = new Map());
	let restored = 0;
	for (const row of rows) {
		if (row === null || typeof row !== "object") continue;
		if (typeof row.childId !== "string" || row.childId === "") continue;
		if (typeof row.group !== "string" || COORD_GROUP_FIELD[row.group] === void 0) continue;
		if (typeof row.at === "number" && now - row.at > COORD_LEDGER_TTL_MS) continue;
		for (const form of childIdForms(row.childId)) {
			map.set(form, { group: row.group, reason: row.reason ?? "restored", evidence: row.evidence ?? "上次运行留下的记录", at: row.at ?? now });
		}
		restored += 1;
	}
	return restored;
}

/** Write the ledger atomically (tmp + rename), tolerating every failure. */
export function writeCoordinatorLedger(state, now = Date.now()) {
	const path = coordinatorLedgerPath();
	if (path === "") return 0;
	const map = state?.coordGroupOfChild;
	if (!(map instanceof Map)) return 0;
	const rows = [];
	const seen = new Set();
	for (const [id, record] of map) {
		if (record === null || typeof record !== "object") continue;
		if (typeof record.group !== "string" || COORD_GROUP_FIELD[record.group] === void 0) continue;
		const base = id.startsWith("session-") ? id.slice(8) : id;
		if (seen.has(base)) continue;
		const at = typeof record.at === "number" ? record.at : now;
		if (now - at > COORD_LEDGER_TTL_MS) continue;
		seen.add(base);
		rows.push({ childId: base, group: record.group, reason: record.reason ?? "", evidence: record.evidence ?? "", at });
	}
	try {
		fs.mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(rows));
		fs.renameSync(tmp, path);
	} catch (_error) {
		return 0;
	}
	return rows.length;
}

/** Debounced save: one write per burst of dispatches, never on the spawn path. */
function scheduleCoordinatorLedgerSave(state) {
	if (state === void 0 || state === null) return;
	if (state.coordLedgerTimer !== void 0) return;
	state.coordLedgerTimer = setTimeout(() => {
		state.coordLedgerTimer = void 0;
		writeCoordinatorLedger(state);
	}, 400);
	state.coordLedgerTimer?.unref?.();
}

function coordinatorRecordOf(state, childId) {
	if (!(state.coordGroupOfChild instanceof Map) || typeof childId !== "string" || childId === "") return void 0;
	for (const form of childIdForms(childId)) {
		const hit = state.coordGroupOfChild.get(form);
		if (hit !== void 0) return hit;
	}
	return void 0;
}

/**
 * Forget one child's group (manual re-assignment to "no list").
 *
 * WHY IT EXISTS: a child born while the plugin was down has no record at all,
 * and a child that was mis-routed needs a way back. The ledger can be edited for
 * one child over the same loopback endpoint the picker uses (see `POST /group`),
 * and the change is persisted like a birth decision.
 */
export function clearCoordinatorGroup(state, childId) {
	if (!(state?.coordGroupOfChild instanceof Map) || typeof childId !== "string" || childId === "") return false;
	let removed = false;
	for (const form of childIdForms(childId)) {
		if (state.coordGroupOfChild.delete(form)) removed = true;
	}
	if (removed) scheduleCoordinatorLedgerSave(state);
	return removed;
}

/** Remember which list a freshly dispatched child belongs to (receipt or promise). */
function bindCoordinatorGroup(state, dispatched, coord) {
	const record = (childId) => coordinatorRecord(state, childId, coord.group, coord.reason, coord.evidence);
	if (dispatched !== null && dispatched !== void 0 && typeof dispatched.then === "function") {
		Promise.resolve(dispatched).then(
			(receipt) => {
				if (typeof receipt?.childId === "string") record(receipt.childId);
			},
			() => {}
		);
		return;
	}
	if (typeof dispatched?.childId === "string") record(dispatched.childId);
}

/** The coordinator's group for a spawn, or undefined when this is not its child. */
export function coordinatorGroupForBirth(state, spec, request) {
	const section = state.getSection?.();
	if (!coordinatorEnabled(section)) return void 0;
	const prefix = typeof section.coordinatorPresetPrefix === "string" && section.coordinatorPresetPrefix !== ""
		? section.coordinatorPresetPrefix
		: "dsh-orchestrator-worker";
	const preset = typeof request?.agentPreset === "string"
		? request.agentPreset
		: (typeof spec?.agentPreset === "string" ? spec.agentPreset : "");
	const parentId = request?.parent?.id ?? request?.parent?.session?.id;
	const inherited = coordinatorRecordOf(state, parentId);
	if (!preset.startsWith(prefix) && inherited === void 0) return void 0;
	const classified = classifyCoordinatorTask(spec?.label ?? request?.label, request?.prompt);
	if (inherited !== void 0 && classified.reason !== "tag") {
		// A nested delegation (the plugin says its children do not delegate, but if
		// one does) stays in the list its parent was put on.
		return { group: inherited.group, reason: inherited.reason, evidence: inherited.evidence };
	}
	return classified;
}

/** The group a RUNNING child was put on, from the ledger only (never a guess). */
export function coordinatorGroupOfAgent(state, agent) {
	return coordinatorRecordOf(state, agent?.id)?.group;
}

function coordinatorPlan(section) {
	const preset = section?.coordinatorCooldownPreset;
	if (preset === "custom") {
		const steps = (Array.isArray(section?.coordinatorCooldownSteps) ? section.coordinatorCooldownSteps : [])
			.map((value) => Number(value))
			.filter((value) => Number.isFinite(value) && value > 0);
		if (steps.length > 0) {
			const cap = Number(section?.coordinatorCooldownCap);
			return { steps, cap: Number.isFinite(cap) && cap > 0 ? cap : Math.max(...steps) };
		}
	}
	return COORD_COOLDOWN_PRESETS[preset] ?? COORD_COOLDOWN_PRESETS.medium;
}

/** How long a failed coordinator route sits out, in minutes, for the Nth strike. */
export function coordinatorWaitMinutes(section, strikes, rateLimited = false) {
	const plan = coordinatorPlan(section);
	const index = Math.min(Math.max(0, strikes - 1) + (rateLimited ? 1 : 0), plan.steps.length - 1);
	return Math.min(plan.steps[index], plan.cap);
}

function coordinatorCooldownMap(state) {
	return state.coordCooldown instanceof Map ? state.coordCooldown : (state.coordCooldown = new Map());
}

function coordinatorCooldownKey(group, route) {
	return `${group}\u0000${routeKey(route)}`;
}

/** Remaining wait for one route, in ms (0 = ready). An expired wait clears the strikes. */
function coordinatorCoolingFor(state, group, route) {
	const key = coordinatorCooldownKey(group, route);
	const entry = coordinatorCooldownMap(state).get(key);
	if (entry === void 0) return 0;
	const remaining = Math.max(0, entry.until - Date.now());
	if (remaining === 0) {
		// The wait is over: the route returns to the front of the order with a
		// clean record, which is the "rest, then try the first one again" rule.
		coordinatorCooldownMap(state).delete(key);
		return 0;
	}
	return remaining;
}

/** Record one failure and return the wait that was applied. */
export function noteCoordinatorFailure(state, group, route, failure) {
	if (!route || typeof route.provider !== "string" || typeof route.model !== "string") return 0;
	const section = state.getSection?.();
	const rateLimited = failure?.code === "RATE_LIMIT";
	const key = coordinatorCooldownKey(group, route);
	const map = coordinatorCooldownMap(state);
	const prior = map.get(key);
	const strikes = (prior?.strikes ?? 0) + 1;
	const minutes = coordinatorWaitMinutes(section, strikes, rateLimited);
	const until = Date.now() + minutes * 60 * 1000;
	map.set(key, { until, strikes, at: Date.now(), minutes });
	return minutes;
}

/** A success clears the strikes, so the next failure starts the gradient over. */
export function noteCoordinatorSuccess(state, group, route) {
	if (!route) return;
	coordinatorCooldownMap(state).delete(coordinatorCooldownKey(group, route));
}

/**
 * The route this group should use right now: the FIRST entry that is not
 * cooling; when every entry is cooling, the one whose wait ends soonest (a
 * degraded route beats no route), and the first entry when nothing is cooling.
 */
export function pickCoordinatorRoute(state, group, excludeKeys = new Set()) {
	const section = state.getSection?.();
	const routes = coordinatorGroupRoutes(section, group).filter((route) => !excludeKeys.has(routeKey(route)));
	if (routes.length === 0) return void 0;
	for (const route of routes) {
		if (coordinatorCoolingFor(state, group, route) === 0) return route;
	}
	let best = routes[0];
	let bestWait = coordinatorCoolingFor(state, group, best);
	for (const route of routes.slice(1)) {
		const wait = coordinatorCoolingFor(state, group, route);
		if (wait < bestWait) {
			best = route;
			bestWait = wait;
		}
	}
	return best;
}

/** One diagnostic row per route of one group, in page order. */
export function coordinatorGroupStatus(state, group) {
	const section = state.getSection?.();
	return coordinatorGroupRoutes(section, group).map((route, index) => {
		const remaining = coordinatorCoolingFor(state, group, route);
		return {
			index,
			provider: route.provider,
			model: route.model,
			reasoningEffort: route.reasoningEffort ?? "",
			cooling: remaining > 0,
			remainingMs: remaining,
			defaulted: index === 0
		};
	});
}

function isTeamAgent(agent) {	const session = agent?.session;
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
 * The list's head for a child whose MANUAL pick just failed.
 *
 * "Revert" here means the page's own order decides again, so the first entry
 * that is not cooling is the answer. The entry that just failed is skipped even
 * when its cooldown is disabled or already expired — retrying the dead route in
 * the same step would only reproduce the failure. Falls back to the first
 * non-failed entry, then to entry 0: a degraded route still beats no route.
 *
 * @param {object} state - plugin state (cooldowns, settings).
 * @param {{entries: Array<object>, coordinatorGroup?: string}} view - from failoverView.
 * @param {{provider?: string, model?: string}} failedRoute - the route that failed.
 * @returns {number} index into `view.entries`.
 */
function firstUsableAfterFailure(state, view, failedRoute, alsoAvoid) {
	const entries = view.entries;
	const avoid = new Set([routeKey({
		provider: typeof failedRoute?.provider === "string" ? failedRoute.provider : "",
		model: typeof failedRoute?.model === "string" ? failedRoute.model : ""
	})]);
	// The withdrawn manual pick is avoided explicitly: the served-route record
	// can lag one step behind a pick applied through the front door, and landing
	// straight back on the dead pick would waste the whole switch.
	if (alsoAvoid !== void 0 && alsoAvoid !== null) avoid.add(routeKey(alsoAvoid));
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (avoid.has(routeKey(entry))) continue;
		const cooling = view.coordinatorGroup !== void 0
			? coordinatorCoolingFor(state, view.coordinatorGroup, entry)
			: (state.cooldowns?.get(routeKey(entry)) ?? 0) - Date.now();
		if (cooling <= 0) return index;
	}
	for (let index = 0; index < entries.length; index += 1) {
		if (!avoid.has(routeKey(entries[index]))) return index;
	}
	return 0;
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
		// Everything except a cancelled run switches: see FAILOVER_NEVER_CODES.
		// A generic "the gateway would not take this request" is exactly what
		// used to stop a coordinator child dead, and the next model often serves
		// the very same payload.
		if (!shouldFailover(failure)) return next();
		// An exempt plugin child must not even COOL its route down: its failure
		// says nothing about the model's health for everyone else, and a cooldown
		// recorded here would silently skew the next ordinary delegation.
		if (isExemptAgent(state, agent)) return next();
		// Cool the failing route down BEFORE deciding whether anything can be
		// switched to: a role pool with a single lane cannot fail over at all,
		// yet its model still deserves to be skipped by the NEXT delegation
		// instead of being handed the next task while it is still rate-limited.
		// A coordinator child cools its OWN list with the graded wait (1/5/15
		// minutes by default); its failures say nothing about the general pools.
		const coordGroup = coordinatorGroupOfAgent(state, agent);
		if (coordGroup !== void 0) {
			const current = agent?.session?.requestContext?.() ?? {};
			const failedRoute = { provider: typeof current.provider === "string" ? current.provider : "", model: typeof current.model === "string" ? current.model : "" };
			if (failedRoute.provider !== "" && failedRoute.model !== "") {
				noteCoordinatorFailure(state, coordGroup, failedRoute, failure);
			}
		} else {
			noteCooldown(ctx, state, agent, failure);
		}
		const view = failoverView(state, agent);
		if (view === void 0) return next();
		const current = pending.get(agent.id);
		// The primary already failed (that triggered the first switch), so the
		// remaining candidates are the other pool entries: at most
		// `entries.length - 1` switches, then let the real error surface.
		if (current !== void 0 && current.count >= view.entries.length - 1) return next(); // pool exhausted
		// The user's own pick failed. Drop the override so this child follows the
		// page's ordered list again — a dead pick must not be restored on every
		// later turn — and go to that list's first usable entry ("revert, not
		// stop"). The switch target is therefore the list's head rather than
		// "whatever comes after the dead pick".
		const failedRoute = agent?.session?.requestContext?.() ?? {};
		const withdrawn = view.manual === true ? childRouteOverrideFor(state, agent.id) : void 0;
		if (view.manual === true) {
			clearChildRoute(state, agent.id);
			ctx.logger.warn(
				`[dsh-subagent-role-router] the manually selected route for subagent %s failed (%s); falling back to this page's list`,
				agent.id,
				failure.code
			);
		}
		const index = view.manual === true
			? firstUsableAfterFailure(state, view, failedRoute, withdrawn)
			: nextFailoverIndex(view, agent, current);
		// Remember every pool entry this run has already been switched to, so a
		// candidate that fails again is not selected a second time.
		const tried = new Set(current?.tried ?? []);
		tried.add(index);
		pending.set(agent.id, {
			index,
			tried,
			count: (current?.count ?? 0) + 1
		});
		// The child keeps running on the new route; the switch itself never
		// reaches its transcript, so this frame is the only way the user learns
		// about it while it happens. Best-effort by design.
		broadcastFailoverNotice(state, {
			childId: agent.id,
			parentSessionId: failoverParentSessionId(agent),
			from: failedRoute,
			to: view.entries[index],
			reason: view.manual === true ? "manual-fallback" : "error-switch",
			manual: view.manual === true,
			error: typeof failure.message === "string" && failure.message !== ""
				? `${failure.code ?? "error"}: ${failure.message}`
				: String(failure.code ?? "error")
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
		// THE FRONT DOOR: select the target on the agent itself the moment the
		// failure is seen. The host's loop retains the step's captured selection
		// across retries, so the current step (and its retries) still run the
		// failing route; the selection lands from the child's NEXT step/turn on.
		// Request-time seed rewrites are no longer legal (the host throws), so
		// this is the only live mutation surface left. Fire-and-forget on
		// purpose: this hook returns synchronously, and the selection only
		// affects the NEXT step, so awaiting it would change nothing for the
		// in-flight retry. Never rejects (the helper catches internally).
		void applyLiveRouteSelect(ctx, state, agent, view.entries[index]).then((frontDoor) => {
			if (frontDoor.applied !== true) {
				ctx.logger.warn(
					`[dsh-subagent-role-router] failover target %s/%s could not be selected on subagent %s yet (%s) — it will be re-selected at the next request`,
					view.entries[index].provider,
					view.entries[index].model,
					agent.id,
					frontDoor.reason
				);
			}
		});
		return { kind: "retry" };
	});

	// On the rebuilt request for that subagent: confirm the failover target and
	// announce it, but NEVER rewrite the seed — the host (2026-11-04 build)
	// freezes the selection before step preparation and throws on any
	// request-time proposal that differs from it. The switch itself is applied
	// through the front door (`agent.model.select`) in the error handler the
	// moment the failure is seen; it lands from the child's NEXT step/turn on,
	// because the loop retains the captured selection across retries.
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
		const landed = seed.provider === target.provider && seed.model === target.model;
		if (!landed) {
			// Belt and suspenders: the error handler already selected this
			// target; re-selecting is idempotent and covers the case where the
			// agent object was not yet live at error time.
			const outcome = await applyLiveRouteSelect(ctx, state, agent, target);
			if (outcome.applied !== true) {
				ctx.logger?.warn?.(
					`[dsh-subagent-role-router] subagent %s failover target %s/%s not selected: %s`,
					agent.id,
					target.provider,
					target.model,
					outcome.reason
				);
			}
		}
		// The failover switched the child's actual route. When an explicit
		// override is also written, the override handler (which runs after this
		// one and wins) announces the FINAL route — announcing both would flap
		// the signature map on every request.
		if (childRouteOverrideFor(state, agent.id) === void 0) {
			broadcastAppliedRoute(state, agent, target, "failover-switch");
		}
		return seed;
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
/**
 * Stall watchdog: a route that never answers is not an error.
 *
 * Live case (session-7a929cab): a coordinator child sat on "thinking 2m52s"
 * with no output at all. Nothing failed, so failover had nothing to react to
 * and the user had to notice and switch by hand.
 *
 * The host publishes `agent/assistant-stream` frames (start / chunk / end), so
 * "no output" is measurable: the timer starts when the attempt starts and is
 * cancelled by the FIRST chunk. When it fires the plugin:
 *
 *   1. cools the stalled route (so the next delegation skips it),
 *   2. withdraws a manual pick and selects the page's next usable candidate
 *      through the host's front door,
 *   3. cuts the hanging attempt (`agent.cancel` with a hook cause, inbox kept),
 *   4. re-delivers one clearly-labelled continuation message so the child goes
 *      on from where it stopped instead of ending its turn,
 *   5. announces the switch on the same SSE stream the header pill listens to.
 *
 * Two stalls on the same child in a row means switching is not helping: the
 * watchdog then stands down and lets the real error surface.
 *
 * @param {object} ctx - plugin context.
 * @param {object} state - plugin state.
 */
function installStallWatchdog(ctx, state) {
	const timers = new Map();
	const strikes = new Map();
	const MAX_STRIKES = 2;

	const clear = (agentId) => {
		const entry = timers.get(agentId);
		if (entry === void 0) return;
		timers.delete(agentId);
		try { if (typeof clearTimeout === "function") clearTimeout(entry); } catch (_) { /* nothing to clear */ }
	};

	const secondsOf = () => {
		const section = state.getSection?.();
		if (section === void 0 || section === null) return 0;
		if (section.stallWatchdogEnabled === false) return 0;
		const raw = Number(section.stallWatchdogSeconds ?? 180);
		if (!Number.isFinite(raw) || raw <= 0) return 0;
		return Math.min(raw, 3600);
	};

	function onStall(agent, seconds) {
		clear(agent.id);
		const attempts = (strikes.get(agent.id) ?? 0) + 1;
		strikes.set(agent.id, attempts);
		if (attempts > MAX_STRIKES) {
			ctx.logger.warn(
				`[dsh-subagent-role-router] subagent %s stalled %d times in a row; the watchdog is standing down and letting the error surface`,
				agent.id,
				attempts
			);
			return;
		}
		const view = failoverView(state, agent);
		if (view === void 0) return;
		const served = agent.session?.requestContext?.() ?? {};
		const failed = {
			provider: typeof served.provider === "string" ? served.provider : "",
			model: typeof served.model === "string" ? served.model : ""
		};
		const coordGroup = coordinatorGroupOfAgent(state, agent);
		if (coordGroup !== void 0) noteCoordinatorFailure(state, coordGroup, failed, { code: "TIMEOUT" });
		else noteCooldown(ctx, state, agent, { code: "TIMEOUT" });
		const withdrawn = view.manual === true ? childRouteOverrideFor(state, agent.id) : void 0;
		if (view.manual === true) clearChildRoute(state, agent.id);
		const index = firstUsableAfterFailure(state, view, failed, withdrawn);
		const target = view.entries[index];
		if (target === void 0) return;
		ctx.logger.warn(
			`[dsh-subagent-role-router] subagent %s produced no output for %ds on %s/%s; cutting the attempt and switching to %s/%s`,
			agent.id,
			seconds,
			failed.provider || "(unknown)",
			failed.model || "(unknown)",
			target.provider,
			target.model
		);
		broadcastFailoverNotice(state, {
			childId: agent.id,
			parentSessionId: failoverParentSessionId(agent),
			from: failed,
			to: target,
			reason: "stall-watchdog",
			manual: view.manual === true,
			error: `no output for ${seconds}s`
		});
		void applyLiveRouteSelect(ctx, state, agent, target).then((outcome) => {
			if (outcome.applied !== true) {
				ctx.logger.warn(
					`[dsh-subagent-role-router] stall switch target %s/%s not selected on %s: %s`,
					target.provider,
					target.model,
					agent.id,
					outcome.reason
				);
			}
		});
		// Cut the hanging attempt. The cause is a hook cause on purpose: it says
		// the plugin did this, not the user, and it keeps the inbox so nothing
		// queued is thrown away.
		try {
			agent.cancel({ kind: "hook", reason: "stall-watchdog" }, { keepInbox: true });
		} catch (error) {
			ctx.logger.warn(`[dsh-subagent-role-router] could not cancel the stalled attempt on %s: %s`, agent.id, error?.message ?? error);
		}
		// Without this the child would simply end its turn and wait: the work
		// must go on, on the new route, from the same point.
		try {
			agent.followup(createUserMessage({
				content: [{
					type: "text",
					text: `[dsh-subagent-role-router] 上一步在 ${failed.model || "上一个模型"} 上超过 ${Math.round(seconds / 60 * 10) / 10} 分钟没有任何输出，已被中断并切换到 ${target.model}。请从中断处继续完成同一个任务，不要重复已经完成的步骤，也不要重新规划。`
				}],
				source: { kind: ROUTE_CONTEXT_SOURCE, form: "stall-watchdog" }
			}));
		} catch (error) {
			ctx.logger.warn(`[dsh-subagent-role-router] could not resume subagent %s after the stall: %s`, agent.id, error?.message ?? error);
		}
	}

	const disposeStream = ctx.on("agent/assistant-stream", ({ agent, frame }) => {
		if (!isSubagentAgent(agent)) return;
		const seconds = secondsOf();
		if (seconds <= 0) return;
		const type = frame?.type;
		if (type === "start") {
			clear(agent.id);
			const timer = setTimeout(() => {
				timers.delete(agent.id);
				try { onStall(agent, seconds); } catch (error) {
					ctx.logger.warn(`[dsh-subagent-role-router] stall watchdog failed on %s: %s`, agent.id, error?.message ?? error);
				}
			}, seconds * 1000);
			timer?.unref?.();
			timers.set(agent.id, timer);
			return;
		}
		// ANY streamed byte means the route is alive: "no output" is over.
		if (type === "chunk") {
			clear(agent.id);
			strikes.delete(agent.id);
			return;
		}
		if (type === "end") {
			clear(agent.id);
			strikes.delete(agent.id);
		}
	});

	const disposeDisposed = ctx.on("agent/disposed", ({ agent }) => {
		clear(agent.id);
		strikes.delete(agent.id);
	});

	ctx.effect(() => () => {
		for (const timer of timers.values()) {
			try { if (typeof clearTimeout === "function") clearTimeout(timer); } catch (_) { /* already gone */ }
		}
		timers.clear();
		strikes.clear();
		disposeStream();
		disposeDisposed();
	}, "dsh-subagent-role-router: stall watchdog");
}

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
/**
 * Whether a request came from this machine.
 *
 * Exported for the tests: the activity route is read-only but it does expose
 * which children are running, so the guard has to be provable rather than
 * assumed — and a curl from this box can never exercise the refusal path.
 */
export function isLoopbackRequest(req) {
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
	// `{provider, model, contextWindow}` — no effort at all.
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
	const liveProvider = pick("provider");
	const liveModel = pick("model");
	const liveEffort = pick("reasoningEffort");
	// ACTUAL IS ACTUAL, AND NOTHING ELSE.
	//
	// This used to report `provider: liveProvider || override.provider` and
	// `reasoningEffort: liveEffort || override.reasoningEffort`, which turned a
	// pending override into a live route, dressed "default" up as an applied
	// strength, and invented a live pair for a child with no live request at all.
	// The three facts are separate now: `actual` (null when nothing is live),
	// `override` (what was asked for), `pendingRoute` (what the next request
	// will use) and `pending` (whether the two differ).
	const actual = liveProvider === "" && liveModel === ""
		? null
		: { provider: liveProvider, model: liveModel, reasoningEffort: liveEffort };
	const pending = override !== void 0 && (
		override.provider !== liveProvider
		|| override.model !== liveModel
		|| (override.reasoningEffort ?? "") !== liveEffort
	);
	const pendingRoute = override === void 0
		? null
		: {
			provider: override.provider,
			model: override.model,
			// No key at all when the override asks for the model default: an empty
			// string here would read as "default is in force", which is a different
			// claim from "the next request will clear the strength".
			...(typeof override.reasoningEffort === "string" && override.reasoningEffort !== ""
				? { reasoningEffort: override.reasoningEffort }
				: {})
		};
	return {
		childId,
		label: typeof agent?.session?.header?.label === "string" ? agent.session.header.label : "",
		// The pair the child is on RIGHT NOW; empty when no request is live.
		provider: liveProvider,
		model: liveModel,
		reasoningEffort: liveEffort,
		actual,
		override: override === void 0
			? null
			: {
				provider: override.provider,
				model: override.model,
				...(override.reasoningEffort === void 0 ? {} : { reasoningEffort: override.reasoningEffort })
			},
		pendingRoute,
		pending,
		revision: routeRevisionOf(state, childId)
	};
}

/**
 * Keep a child on this page's whitelist even when nothing asked the plugin.
 *
 * The gate on `/batch` and on birth routing only sees picks that come THROUGH
 * the plugin. A child spawned with no override inherits whatever the host's own
 * model seat hands it, and the access log showed exactly that hole: the seat was
 * changed twice and the child really ran `codex/gpt-6.1-sol` and then
 * `gm4/gemini-4-carbon`, neither of which this page ever listed. The fix is not
 * to refuse the step (the host has already frozen the selection, and refusing
 * would just stall the child) but to SWITCH it: store a whitelisted override and
 * apply it through the front door, which lands from the child's next step.
 *
 * Silent when the pick is already approved, when no whitelist is configured, and
 * for exempt plugin children (their plugin pinned their model; the exemption
 * list is a promise that this page stays out of their way).
 */
async function enforceWhitelistOnSeed(ctx, state, agent, seed, id) {
	if (seed === void 0 || seed === null) return;
	const provider = typeof seed.provider === "string" ? seed.provider : "";
	const model = typeof seed.model === "string" ? seed.model : "";
	if (provider === "" || model === "") return;
	const section = state.getSection?.();
	const target = pickWhitelistRoute(section, { provider, model });
	if (target === null) return;
	if (isExemptAgent(state, agent)) return;
	setChildRoute(state, id, target);
	// One line per (child, asked route): a child that keeps being handed the same
	// unlisted route must not turn the log into a wall of identical entries.
	const seen = state.whitelistSubstitutions instanceof Set
		? state.whitelistSubstitutions
		: (state.whitelistSubstitutions = new Set());
	const key = `${id}\u0000${provider}\u0000${model}\u0000${target.provider}\u0000${target.model}`;
	const first = !seen.has(key);
	if (first) {
		seen.add(key);
		trace(`SUBSTITUTE_WHITELIST_REQUEST ${id} ${provider}/${model} -> ${target.provider}/${target.model}`);
	}
	const outcome = await applyLiveRouteSelect(ctx, state, agent, target);
	if (first) {
		ctx.logger?.info?.(
			`[dsh-subagent-role-router] subagent ${id} asked for ${provider}/${model}, not on this page's whitelist -> switched to ${target.provider}/${target.model} (applied=${outcome.applied === true ? "yes" : `no (${outcome.reason})`})`
		);
	}
}

/**
 * Keep a coordinator child on its OWN list, and off everyone else's.
 *
 * Called on every request of such a child. The seed is never rewritten (the
 * host freezes the selection before step preparation and throws on a differing
 * proposal), so an off-list route is swapped through the front door and takes
 * effect from the next step. A route that IS on the list is left alone — a
 * fallback the failover already chose must not be bounced back to entry one.
 */
async function ensureCoordinatorRoute(ctx, state, agent, group, seed, id) {
	const section = state.getSection?.();
	const routes = coordinatorGroupRoutes(section, group);
	if (routes.length === 0) return;
	const provider = typeof seed?.provider === "string" ? seed.provider : "";
	const model = typeof seed?.model === "string" ? seed.model : "";
	if (provider !== "" && model !== "" && routes.some((route) => route.provider === provider && route.model === model)) {
		// A healthy step on an allowed route clears the strike count for it.
		noteCoordinatorSuccess(state, group, { provider, model });
		return;
	}
	const target = pickBirthableRoute(ctx, state, routes, {
		cooling: (candidate) => coordinatorCoolingFor(state, group, candidate)
	});
	if (target === void 0) return;
	const seen = state.coordSubstitutions instanceof Set
		? state.coordSubstitutions
		: (state.coordSubstitutions = new Set());
	const key = `${id}\u0000${provider}\u0000${model}\u0000${target.provider}\u0000${target.model}`;
	const first = !seen.has(key);
	if (first) {
		seen.add(key);
		trace(`SUBSTITUTE_COORDINATOR ${id} ${provider || "?"}/${model || "?"} -> ${target.provider}/${target.model}`);
	}
	const outcome = await applyLiveRouteSelect(ctx, state, agent, target);
	if (first) {
		ctx.logger?.info?.(
			`[dsh-subagent-role-router] coordinator child ${id} ran ${provider || "?"}/${model || "?"}, not on its ${COORD_GROUP_LABEL[group] ?? group} list -> switched to ${target.provider}/${target.model} (applied=${outcome.applied === true ? "yes" : `no (${outcome.reason})`})`
		);
	}
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
		if (override === void 0) {
			// A coordinator child is judged against ITS list, not the general one.
			// A route outside that list (the host's model seat, an inherited route,
			// anything a caller slipped in) is swapped back to the list's first
			// usable entry — the seed itself is frozen by the host, so this lands
			// from the child's next step.
			const coordGroup = coordinatorGroupOfAgent(state, agent);
			if (coordGroup !== void 0) {
				await ensureCoordinatorRoute(ctx, state, agent, coordGroup, seed, id);
				return seed;
			}
			await enforceWhitelistOnSeed(ctx, state, agent, seed, id);
			return seed;
		}
		if (seed === void 0 || seed === null) return seed;
		// THE OVERRIDE MAY NAME A RETIRED MODEL. Nothing stops a pick made before
		// the gateway dropped that model (or a `/group` default taken from a list
		// whose head is stale), and handing it to the host fails the step before
		// any request: "provider has no configured model". Replace it with the
		// first route this child may actually use, and persist the replacement so
		// the picker shows what is really running.
		let effective = override;
		if (birthRouteIsDead(state, override)) {
			const page = childPageRoutes(state, id);
			const replacement = filterLiveRoutes(state, page.routes)[0];
			if (replacement !== void 0) {
				ctx.logger?.warn?.(
					`[dsh-subagent-role-router] subagent %s was pinned to %s/%s, which its provider no longer serves; using %s/%s instead`,
					id,
					override.provider,
					override.model,
					replacement.provider,
					replacement.model
				);
				setChildRoute(state, id, replacement);
				effective = replacement;
			}
		}
		// THE HOST'S NEW CONTRACT (2026-11-04 build): the loop freezes the
		// selection BEFORE step preparation and throws on any request-time
		// proposal that differs from it — the very throw the model picker used
		// to surface ("agent/request proposed … after step preparation fixed …").
		// So this listener NEVER rewrites the seed. The override is applied
		// through the front door (`agent.model.select`) — from the WRITE path
		// the moment the pick happens, and here as a late apply for children
		// whose override was written while they were idle or not yet spawned.
		// The late apply lands from the child's NEXT step onward: the current
		// step keeps its fixed selection, which is the best the host allows.
		const matches = seed.provider === effective.provider
			&& seed.model === effective.model
			&& (effective.reasoningEffort === void 0 || effective.reasoningEffort === seed.reasoningEffort);
		if (matches) {
			// The override has landed on a real dispatch — announce it so
			// pickers in other windows (which the store cannot reach) converge.
			broadcastAppliedRoute(state, agent, effective, "override-applied");
			return seed;
		}
		const outcome = await applyLiveRouteSelect(ctx, state, agent, effective);
		if (outcome.applied !== true) {
			ctx.logger?.warn?.(
				`[dsh-subagent-role-router] subagent %s override ${effective.provider}/${effective.model} not applied yet: %s`,
				id,
				outcome.reason
			);
		}
		// Always hand the ORIGINAL seed back: mutating it is what throws.
		return seed;
	});

	const disposeDisposed = ctx.on("agent/disposed", ({ agent }) => {
		// clearChildRoute (not raw deletes) so the revision advances: a client
		// that cached "override present" must be able to see the disappearance.
		if (typeof agent?.id === "string") clearChildRoute(state, agent.id);
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
 *   GET  route?childId=…            → { childId, provider, model, override, pending }
 *   POST select {childId, provider, model, reasoningEffort?}
 *   POST clear  {childId}
 *   GET  batch?parentSessionId=…    → { parentSessionId, children, models }
 *   POST batch/select {parentSessionId, selections[]}
 *   POST batch/clear  {parentSessionId, childIds[]}
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
		// The broadcast seam: every write path calls state.routeEventBroadcast
		// (best-effort), which fans the frame out to the open SSE responses.
		// A failing connection is dropped here; its own close handler cleans
		// up the rest.
		state.routeEventBroadcast = (event) => {
			const clients = state.routeEventClients;
			if (!clients || clients.size === 0) return;
			const frame = `data: ${JSON.stringify(event)}\n\n`;
			for (const client of clients) {
				try { client.res.write(frame); } catch (_) { clients.delete(client); }
			}
		};
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
				trace(`STOP ${stopId} parent=${parent || "(none)"} ok=${result.ok} ${JSON.stringify(result.attempts)}`);
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
				const routeRecord = coordinatorRecordOf(state, childId);
				const coordinator = routeRecord === void 0 ? void 0 : {
					group: routeRecord.group,
					label: COORD_GROUP_LABEL[routeRecord.group] ?? routeRecord.group,
					reason: routeRecord.reason,
					evidence: routeRecord.evidence
				};
				writeJson(res, 200, { ok: true, build: ROUTER_BUILD, epoch: state.routeEpoch, value: describeChildRoute(state, childId, agent), coordinator });
				return;
			}
			// ── live route announcements (Server-Sent Events) ─────────────────
			//
			// Writes and applied switches push a small JSON frame to every
			// connected page, so pickers in OTHER windows (which the host
			// session store never reaches) verify without polling. The frame
			// is a hint only: the client always answers with GET /route.
			if (req.method === "GET" && pathname === `${OVERRIDE_PATH}/events`) {
				if (state.httpCounters) state.httpCounters.events += 1;
				res.writeHead(200, {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-cache, no-transform",
					connection: "keep-alive"
				});
				const client = { res };
				(state.routeEventClients ?? (state.routeEventClients = new Set())).add(client);
				res.write("retry: 5000\n\n");
				res.write(`data: ${JSON.stringify({ type: "hello", epoch: state.routeEpoch, build: ROUTER_BUILD })}\n\n`);
				const heartbeat = setInterval(() => {
					try { res.write(": ping\n\n"); } catch (_) { /* the close handler cleans up */ }
				}, 25000);
				// Node only: a leaked heartbeat must never keep a process alive
				// on its own. Browsers return a number here; the optional call
				// is a no-op for them.
				heartbeat?.unref?.();
				req.on("close", () => {
					clearInterval(heartbeat);
					state.routeEventClients?.delete(client);
				});
				return;
			}
			// ── who is running right now ──────────────────────────────────────
			// Read-only view of the activity ledger for the header critters. The
			// loopback guard above already refused every non-local caller.
			if (req.method === "GET" && pathname === `${OVERRIDE_PATH}/activity`) {
				const parentSessionId = String(url.searchParams.get("parentSessionId") ?? "").trim();
				if (state.httpCounters) state.httpCounters.activity += 1;
				const rows = listActiveChildren(state, parentSessionId === "" ? void 0 : parentSessionId);
				// The ledger records the model a child was BORN on; after a switch
				// (this panel's picker, the host's own seat, a failover) that row went
				// stale while the picker showed the new model — one child, two answers.
				// Prefer the live request header whenever there is one.
				const active = pruneStaleActivity(state, rows).map((row) => {
					const agent = resolve(row.childId);
					if (agent === void 0) return row;
					const described = describeChildRoute(state, row.childId, agent);
					if (described.actual === null) return row;
					return { ...row, provider: described.actual.provider, model: described.actual.model };
				});
				writeJson(res, 200, {
					ok: true,
					build: ROUTER_BUILD,
					value: {
						count: active.length,
						active: active.map((row) => ({
							childId: row.childId,
							label: row.label,
							role: row.role,
							provider: row.provider,
							model: row.model,
							startedAt: row.startedAt,
							ageMs: row.ageMs,
							parentSessionId: row.parentSessionId ?? null
						}))
					}
				});
				return;
			}
			if (req.method === "POST" && pathname === OVERRIDE_PATH + "/debug") {

    const raw = await readJsonBody(req);
    try {
      // Rate limit: one line per tag per 30s. Diagnostic polls used to write
      // every few seconds and the file grew past 7MB; repeating diagnostics
      // add nothing once the first line of a kind is on disk.
      const tag = typeof raw === "object" && raw !== null && typeof raw.tag === "string" ? raw.tag : String(raw?.tag ?? "");
      const nowMs = Date.now();
      if (typeof state.debugLogAt !== "object" || state.debugLogAt === null) state.debugLogAt = {};
      const lastAt = state.debugLogAt[tag] ?? 0;
      if (nowMs - lastAt >= 30000) {
        state.debugLogAt[tag] = nowMs;
        const home = process.env.USERPROFILE || process.env.HOME || "";
        const logPath = join(home, ".dsh", "live-route-debug.log");
        const line = "[" + new Date().toISOString() + "] " + (typeof raw === "string" ? raw : JSON.stringify(raw)) + String.fromCharCode(10);
        fs.appendFileSync(logPath, line);
      }
    } catch (_eLog) {}
    writeJson(res, 200, { ok: true });
    return;
  }
			if (req.method === "GET" && pathname === `${OVERRIDE_PATH}/exempt-candidates`) {
				writeJson(res, 200, { ok: true, build: ROUTER_BUILD, value: { candidates: birthSeenSuggestions() } });
				return;
			}
			// Diagnostic: what the native gate holds versus what this page asks
			// for, plus the reason a sync was skipped or rejected.
			if (req.method === "GET" && pathname === `${OVERRIDE_PATH}/whitelist`) {
				const section = state.getSection?.();
				// A coordinator child's page asks with its own id: its menu must
				// offer ITS list, while an ordinary page keeps the general one.
				const askedChild = String(url.searchParams.get("childId") ?? "").trim();
				const record = askedChild === "" ? void 0 : coordinatorRecordOf(state, askedChild);
				// ONE SOURCE OF TRUTH: the same helper `/select` judges a pick with.
				const desired = askedChild === ""
					? hostWhitelistModels(section)
					: childPageRoutes(state, askedChild).routes;
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
				// HOW MUCH DID THE COORDINATOR LISTS TAKE FROM THIS PAGE'S GENERAL LIST?
		// An ordinary page that shows one model looks broken until it can say
		// "the other two are reserved". Count ONLY routes the general list itself
		// declares: a coordinator-only route was never an option here, and
		// counting it would overstate the loss.
		const reservedKeys = new Set(coordinatorAllRoutes(section).map(routeKey));
		const reservedCount = declaredGeneralRoutes(section)
			.filter((route) => reservedKeys.has(routeKey(route))).length;
		const coordinator = record === void 0 ? void 0 : {
					group: record.group,
					label: COORD_GROUP_LABEL[record.group] ?? record.group,
					reason: record.reason,
					evidence: record.evidence,
					routes: coordinatorGroupStatus(state, record.group)
				};
				writeJson(res, 200, { ok: true, build: ROUTER_BUILD, value: { desired, reserved: reservedCount, coordinator, current, outcome, last: state.lastWhitelistSync ?? null, routes: state.routeSeen ?? [], tools: Array.isArray(state.routerToolsRegistered) ? state.routerToolsRegistered : [], toolsInstalled: state.routerToolsInstalled === true, toolsBuilt: state.routerToolsBuilt === true, toolsError: state.routerToolsError ?? null, epoch: state.routeEpoch, counters: state.httpCounters ?? null } });
				return;
			}
			// ── the coordinator's two lists: what they hold and how they are doing ──
			// ── catalog probe ─────────────────────────────────────────────────
			//
			// Answers ONE question for one configured route: does the provider
			// still serve this model? `unknown` means the plugin could not verify
			// (provider absent from the catalog) and the route is therefore left
			// alone — the distinction that keeps a catalog outage from looking
			// like a dead config.
			if (req.method === "GET" && pathname === `${OVERRIDE_PATH}/catalog`) {
				if (String(url.searchParams.get("refresh") ?? "") === "1") {
					await refreshBirthCatalogSoon(ctx, state);
				}
				const raw = String(url.searchParams.get("route") ?? "").trim();
				const slash = raw.indexOf("/");
				const provider = slash > 0 ? raw.slice(0, slash) : "";
				const model = slash > 0 ? raw.slice(slash + 1) : "";
				const map = state.birthCatalog?.map;
				let served;
				if (map === void 0 || map === null || provider === "" || model === "") served = "unknown";
				else if (!map.has(provider)) served = "unknown";
				else served = map.get(provider).has(model);
				writeJson(res, 200, {
					ok: true,
					build: ROUTER_BUILD,
					value: {
						route: raw === "" ? null : { provider, model, served },
						catalog: state.birthCatalog === void 0 || state.birthCatalog === null
							? null
							: { at: new Date(state.birthCatalog.at).toISOString(), providers: [...state.birthCatalog.map.keys()] }
					}
				});
				return;
			}
			// ── the coordinator's three lists, with the dead rows called out ──
			if (req.method === "GET" && pathname === `${OVERRIDE_PATH}/coordinator`) {
				const section = state.getSection?.();
				const enabled = coordinatorEnabled(section);
				const plan = coordinatorPlan(section);
				// `?refresh=1` re-reads the gateway catalog before answering, so a
				// human can tell "the list has a dead row" from "the plugin could
				// not verify anything".
				if (String(url.searchParams.get("refresh") ?? "") === "1") {
					await refreshBirthCatalogSoon(ctx, state);
				}
				const dead = [];
				for (const group of COORD_GROUPS) {
					for (const route of coordinatorGroupRoutes(section, group)) {
						if (birthRouteIsDead(state, route)) dead.push({ group, provider: route.provider, model: route.model });
					}
				}
				for (const route of hostModelPool(section)) {
					if (birthRouteIsDead(state, route)) dead.push({ group: "general", provider: route.provider, model: route.model });
				}

				writeJson(res, 200, {
					ok: true,
					build: ROUTER_BUILD,
					value: {
						enabled,
						presetPrefix: section?.coordinatorPresetPrefix ?? "dsh-orchestrator-worker",
						groups: {
							ui: { label: COORD_GROUP_LABEL.ui, routes: coordinatorGroupStatus(state, "ui") },
							research: { label: COORD_GROUP_LABEL.research, routes: coordinatorGroupStatus(state, "research") },
							delivery: { label: COORD_GROUP_LABEL.delivery, routes: coordinatorGroupStatus(state, "delivery") },
							backend: { label: COORD_GROUP_LABEL.backend, routes: coordinatorGroupStatus(state, "backend") }
						},
						cooldown: {
							preset: section?.coordinatorCooldownPreset ?? "medium",
							steps: plan.steps,
							cap: plan.cap
						},
						noFallback: section?.coordinatorNoFallback === true,
						// Rows the gateway provably no longer serves (they are skipped
						// everywhere), plus how fresh that verdict is.
						dead,
						catalog: state.birthCatalog === void 0 || state.birthCatalog === null
							? null
							: {
								at: new Date(state.birthCatalog.at).toISOString(),
								providers: [...state.birthCatalog.map.keys()]
							},
						// What the general lists keep after the reservation, and what the
						// native gate was told (a union — the split lives in this plugin).
						general: hostWhitelistModels(section),
						gate: hostGateModels(section),
						warning: hostWhitelistModels(section).length === 0 && enabled
							? "两条专属名单已经占满了通用名单：普通子代理不会再被分配模型，会继承父会话。"
							: null
					}
				});
				return;
			}
			// ── the batch card's data: who belongs to this conversation, on what ──
			//
			// Read-only, and scoped to ONE parent: the host's own catalog answers both
			// halves (membership and mode), and this page's settings answer the model
			// list. A conversation with no children is a valid empty answer, not an
			// error; an unavailable catalog is an explicit refusal, never a guess.
			if (req.method === "GET" && pathname === `${OVERRIDE_PATH}/batch`) {
				const parentSessionId = String(url.searchParams.get("parentSessionId") ?? "").trim();
				if (state.httpCounters) state.httpCounters.batch += 1;
				if (parentSessionId === "") {
					writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "parentSessionId query parameter required" } });
					return;
				}
				const listed = await strictChildrenOf(ctx, state, parentSessionId);
				if (listed.ok !== true) {
					writeJson(res, 200, { ok: false, build: ROUTER_BUILD, error: listed.error });
					return;
				}
				const caps = await modelCapabilities(ctx, state);
				// A page whose children came from the coordinator plugin offers BOTH
				// lists' routes: each child is still held to its own list at request
				// time, so the union here only widens what the card may offer.
				const coordinatorOnPage = listed.value.some((row) => coordinatorRecordOf(state, row.childId) !== void 0);
				writeJson(res, 200, {
					ok: true,
					build: ROUTER_BUILD,
					value: {
						parentSessionId,
						children: listed.value,
						models: batchModelCatalog(state.getSection?.(), caps, { includeCoordinator: coordinatorOnPage }),
						epoch: state.routeEpoch
					}
				});
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
			// ── batch apply / clear ───────────────────────────────────────────────
			//
			// Partial success is the normal case (one child ended between the fetch and
			// the click), so every item is judged on its own and the HTTP status stays
			// 200: the per-item `ok` is the answer, and one refusal must not hide the
			// siblings that did apply.
			if (pathname === `${OVERRIDE_PATH}/batch/select` || pathname === `${OVERRIDE_PATH}/batch/clear`) {
				const batchParent = typeof body.parentSessionId === "string" ? body.parentSessionId.trim() : "";
				if (batchParent === "") {
					writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "parentSessionId is required" } });
					return;
				}
				const listed = await strictChildrenOf(ctx, state, batchParent);
				if (listed.ok !== true) {
					writeJson(res, 200, { ok: false, build: ROUTER_BUILD, error: listed.error });
					return;
				}
				const results = [];
				if (pathname === `${OVERRIDE_PATH}/batch/select`) {
					if (state.httpCounters) state.httpCounters.batchSelect += 1;
					const selections = Array.isArray(body.selections) ? body.selections : void 0;
					if (selections === void 0 || selections.length === 0) {
						writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "selections must be a non-empty array" } });
						return;
					}
					const caps = await modelCapabilities(ctx, state);
					for (const selection of selections) {
						results.push(await applyBatchSelection(ctx, state, batchParent, selection, caps));
					}
				} else {
					const childIds = Array.isArray(body.childIds) ? body.childIds : void 0;
					if (childIds === void 0 || childIds.length === 0) {
						writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "childIds must be a non-empty array" } });
						return;
					}
					for (const rawId of childIds) {
						const childId = typeof rawId === "string" ? rawId.trim() : "";
						const owned = await resolveOwnedChild(ctx, state, batchParent, childId);
						if (owned.ok !== true) {
							results.push({ childId, ok: false, error: owned.error });
							continue;
						}
						clearChildRoute(state, childId);
						const described = describeChildRoute(state, childId, liveSubagent(agentsService(ctx), childId));
						results.push({
							childId,
							ok: true,
							revision: routeRevisionOf(state, childId),
							provider: described.provider,
							model: described.model,
							reasoningEffort: described.reasoningEffort,
							override: described.override,
							pending: described.pending
						});
					}
				}
				const applied = results.filter((row) => row.ok === true).length;
				writeJson(res, 200, {
					ok: true,
					build: ROUTER_BUILD,
					value: {
						parentSessionId: batchParent,
						results,
						summary: { total: results.length, ok: applied, failed: results.length - applied }
					}
				});
				return;
			}
			const action = pathname === `${OVERRIDE_PATH}/clear`
				? "clear"
				: pathname === `${OVERRIDE_PATH}/select`
					? "select"
					: pathname === `${OVERRIDE_PATH}/group` ? "group" : void 0;
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
				clearChildRoute(state, childId);
				webCtx.logger?.info?.(`[dsh-subagent-role-router] cleared the route override for subagent ${childId}`);
				writeJson(res, 200, { ok: true, build: ROUTER_BUILD, epoch: state.routeEpoch, value: describeChildRoute(state, childId, agent) });
				return;
			}
			// Re-assign the LIST a child belongs to (or take it off every list).
			//
			// WHY: a child born while the plugin was down has no record, and an
			// existing child may need to be put back where it belongs. The new
			// decision is persisted exactly like a birth decision, and the group's
			// first usable route is applied straight away.
			if (action === "group") {
				const wanted = typeof body.group === "string" ? body.group.trim() : "";
				if (wanted === "") {
					clearCoordinatorGroup(state, childId);
					webCtx.logger?.info?.(`[dsh-subagent-role-router] subagent ${childId} is off every coordinator list`);
					writeJson(res, 200, { ok: true, build: ROUTER_BUILD, epoch: state.routeEpoch, group: null, applied: false, value: describeChildRoute(state, childId, agent) });
					return;
				}
				if (COORD_GROUP_FIELD[wanted] === void 0) {
					writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "group must be ui, research or backend" } });
					return;
				}
				coordinatorRecord(state, childId, wanted, "manual", "手动改判到这一组");
				// The list's head may name a model the gateway retired; picking it
				// here is exactly how a freshly re-grouped child died on its first
				// request. Same rule as birth: first candidate that still exists.
				const target = pickBirthableRoute(webCtx, state, coordinatorGroupRoutes(state.getSection?.(), wanted), {
					cooling: (candidate) => coordinatorCoolingFor(state, wanted, candidate)
				});
				let applied = false;
				if (target !== void 0) {
					setChildRoute(state, childId, {
						provider: target.provider,
						model: target.model,
						...(typeof target.reasoningEffort === "string" && target.reasoningEffort !== "" ? { reasoningEffort: target.reasoningEffort } : {})
					});
					if (isChildAgent(agent)) {
						const outcome = await applyLiveRouteSelect(webCtx, state, agent, target);
						applied = outcome?.applied === true;
					}
				}
				webCtx.logger?.info?.(`[dsh-subagent-role-router] subagent ${childId} was moved to the ${wanted} list (target=${target === void 0 ? "none" : `${target.provider}/${target.model}`}, applied=${applied ? "yes" : "no"})`);
				writeJson(res, 200, {
					ok: true,
					build: ROUTER_BUILD,
					epoch: state.routeEpoch,
					group: wanted,
					applied,
					...(target === void 0 ? {} : { target: { provider: target.provider, model: target.model } }),
					value: describeChildRoute(state, childId, agent)
				});
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
			// `/batch` refuses a route this page never configured, but this endpoint
			// used to store whatever arrived (the host's own model seat reaches the
			// child without passing here at all). So it does not refuse either: it
			// SWITCHES to a whitelisted route, and says so in the response.
			// JUDGED AGAINST THE CHILD'S OWN PAGE: a coordinator child switches
			// inside its group, never onto the general list (see `pickPageRoute`).
			const substitute = pickPageRoute(state, childId, route);
			const whitelisted = substitute === null
				? route
				: { provider: substitute.provider, model: substitute.model };
			// The whitelist answers "may this child name it"; the gate answers "does
			// its provider still serve it". BOTH must pass before anything is stored,
			// or the picker keeps showing a row that can only fail on the next step.
			const effective = liveRouteGate(webCtx, state, agent, whitelisted) ?? whitelisted;
			if (effective.provider !== whitelisted.provider || effective.model !== whitelisted.model) {
				webCtx.logger?.warn?.(
					`[dsh-subagent-role-router] subagent ${childId} asked for ${whitelisted.provider}/${whitelisted.model}, which its provider no longer serves -> switched to ${effective.provider}/${effective.model}`
				);
			}
			if (substitute !== null) {
				trace(`SUBSTITUTE_WHITELIST ${childId} asked ${provider}/${model} -> ${effective.provider}/${effective.model}`);
				webCtx.logger?.info?.(
					`[dsh-subagent-role-router] subagent ${childId} asked for ${provider}/${model}, not on this page's whitelist -> switched to ${effective.provider}/${effective.model}`
				);
			}
			setChildRoute(state, childId, effective);
			trace(`SET_OVERRIDE ${childId} -> ${effective.provider}/${effective.model} (effort: ${effective.reasoningEffort})`);
			// THE FRONT DOOR: apply the pick to the live child immediately
			// (see `applyLiveRouteSelect`). The stored override stays for the
			// pickers and for children that are not live yet.
			const frontDoor = await applyLiveRouteSelect(webCtx, state, isChildAgent(agent) ? agent : void 0, effective);
			webCtx.logger?.info?.(
				`[dsh-subagent-role-router] subagent ${childId} will use ${effective.provider}/${effective.model}${effective.reasoningEffort === void 0 ? "" : ` effort=${effective.reasoningEffort}`} (set from the Web UI; applied=${frontDoor.applied === true ? "yes" : `no (${frontDoor.reason})`})`
			);
			writeJson(res, 200, {
				ok: true,
				build: ROUTER_BUILD,
				epoch: state.routeEpoch,
				value: describeChildRoute(state, childId, agent),
				applied: frontDoor.applied,
				...(substitute === null ? {} : {
					substituted: {
						from: { provider, model },
						to: { provider: effective.provider, model: effective.model }
					}
				}),
				...(frontDoor.applied === true ? {} : {
					appliedReason: frontDoor.reason,
					...(frontDoor.message === void 0 ? {} : { appliedError: frontDoor.message })
				})
			});
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

/** How long an unfinished activity record keeps counting as "running". */
const ACTIVITY_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * The parent session id carried by a spawn request, whichever field the host
 * happens to use. `request.parent` is the parent AGENT INSTANCE (it is passed
 * to `buildWindowSlicedSeed` as such), so its id has to be read off the
 * instance rather than treated as a string.
 *
 * @param {object|undefined} request - the (already routed) spawn request.
 * @param {object|null|undefined} spec - the continuable spec, when there is one.
 * @returns {string|null} the parent session id, or null when the host gave none.
 */
function parentSessionIdOf(request, spec) {
	const candidates = [
		request?.parent?.id,
		request?.parent?.session?.id,
		request?.parent?.sessionId,
		request?.parentSessionId,
		spec?.parent?.id,
		spec?.parent?.session?.id,
		spec?.parentSessionId
	];
	for (const value of candidates) {
		if (typeof value === "string" && value !== "") return value;
	}
	return null;
}

/**
 * Build one ledger row. Provider/model come from the ROUTED request (the
 * wrapper rewrites `args` before dispatch), so the row shows what the child
 * will actually run on rather than what the pool happened to hold at birth.
 */
function activityEntry(request, spec, label, childId) {
	const options = request?.agentOptions ?? {};
	const role = detectRole(label || request?.label, request?.prompt);
	return {
		childId,
		parentSessionId: parentSessionIdOf(request, spec),
		label: typeof label === "string" && label !== "" ? label : null,
		role: typeof role === "string" && role !== "" ? role : null,
		provider: typeof options.provider === "string" ? options.provider : null,
		model: typeof options.model === "string" ? options.model : null,
		startedAt: Date.now()
	};
}

/**
 * Push one child's start/end to the SSE stream (`/subagent-role-router/events`).
 *
 * THE CRITTERS' PULSE: the host session store never lists ordinary (non-team)
 * subagents, and the activity ledger is only readable by polling. These frames
 * tell every open page "a child started / ended" so the header critters can
 * refetch the strict catalog instead of guessing. Best-effort by design: with
 * no SSE clients mounted this is a no-op, and a failed frame never disturbs
 * the dispatch it reports.
 */
function broadcastActivityFrame(state, action, entry) {
	if (state === void 0 || state === null || typeof state.routeEventBroadcast !== "function") return;
	if (entry === void 0 || entry === null) return;
	try {
		state.routeEventBroadcast({
			type: "activity",
			action,
			childId: typeof entry.childId === "string" ? entry.childId : "",
			parentSessionId: entry.parentSessionId ?? null,
			label: entry.label ?? null,
			role: entry.role ?? null,
			provider: entry.provider ?? null,
			model: entry.model ?? null,
			startedAt: typeof entry.startedAt === "number" ? entry.startedAt : null
		});
	} catch (_e) { /* a broken SSE client must never break a dispatch */ }
}

/** Remove one child from the ledger, in every id spelling the host may use. */
function settleActivity(state, childId) {
	if (typeof childId !== "string" || childId === "") return;
	// Read the entry before deleting so the "ended" frame can carry it; the
	// client only needs childId + parent, but the label/role make the refetch
	// cheap to render before its own batch call returns.
	const entry = state.activity.get(childId)
		?? (childId.startsWith("session-") ? state.activity.get(childId.slice(8)) : state.activity.get("session-" + childId));
	for (const form of childIdForms(childId)) state.activity.delete(form);
	if (entry !== void 0) broadcastActivityFrame(state, "ended", entry);
}

/**
 * Record a dispatch in the activity ledger and drop it when the child settles.
 *
 * Deliberately independent of `lease`: the lane is only reserved for pooled
 * delegations, while team members, exempt children and children that already
 * name a model never get one. Hanging the ledger off `lease.bind` would make
 * exactly those spawns invisible.
 *
 * `start` hands back a promise of the receipt and `startActivation` returns the
 * receipt synchronously; both shapes are handled without assuming either.
 */
const ACTIVITY_MAX_ROWS = 64;
function trackDispatch(state, request, spec, dispatched, label) {
	const remember = (receipt) => {
		const childId = receipt?.childId;
		if (typeof childId !== "string" || childId === "") return;
		// Hard cap: children whose result never settles would otherwise grow the
		// ledger without bound across a long session.
		while (state.activity.size >= ACTIVITY_MAX_ROWS) {
			const oldest = state.activity.keys().next().value;
			if (oldest === void 0) break;
			state.activity.delete(oldest);
		}
		state.activity.set(childId, activityEntry(request, spec, label, childId));
		broadcastActivityFrame(state, "started", state.activity.get(childId));
		const result = receipt?.result;
		if (result !== void 0 && result !== null && typeof result.then === "function") {
			Promise.resolve(result).then(
				() => settleActivity(state, childId),
				() => settleActivity(state, childId)
			);
		}
	};
	if (dispatched !== null && typeof dispatched === "object" && typeof dispatched.then === "function") {
		Promise.resolve(dispatched).then(remember, () => {});
		return;
	}
	remember(dispatched);
}

/**
 * The children this plugin still believes are running under one parent session.
 *
 * Exported for the tests, like `interruptChildNow`: the filtering and the TTL
 * are invisible in the UI and expensive to rediscover from a browser.
 *
 * Entries whose parent could not be determined are returned for EVERY query
 * rather than hidden: on a single-user desktop, a visible child is better than
 * a silently missing one, and the missing field is logged at spawn time.
 *
 * @param {object} state - plugin state (needs `activity`).
 * @param {string} [parentSessionId] - filter to one parent session.
 * @param {number} [now] - clock, for tests.
 * @returns {Array<object>} rows sorted by start time, each with `ageMs`/`stale`.
 */
/**
 * Drop rows the TTL already retired from the ledger, in every id spelling.
 *
 * Filtering alone was not enough: a ghost child kept riding along in every
 * poll until restart, and a long-lived parent could accumulate hundreds of
 * them — which is what made the header look like it had 189 running children.
 * Exported for the tests, like `listActiveChildren`.
 *
 * @param {object} state - plugin state (needs `activity`).
 * @param {Array<object>} rows - rows from `listActiveChildren`.
 * @returns {Array<object>} the rows that are still fresh.
 */
export function pruneStaleActivity(state, rows) {
	const fresh = [];
	for (const row of rows) {
		if (row.stale) {
			for (const form of childIdForms(row.childId)) state?.activity?.delete(form);
			continue;
		}
		fresh.push(row);
	}
	return fresh;
}

export function listActiveChildren(state, parentSessionId, now = Date.now()) {
	const wanted = typeof parentSessionId === "string" && parentSessionId !== "" ? new Set(childIdForms(parentSessionId)) : null;
	const rows = [];
	for (const entry of (state?.activity ?? new Map()).values()) {
		if (wanted !== null) {
			// Strict ownership: a row with no known parent must never leak into
			// every session's view — it would show strangers as critters. Such
			// rows stay visible only to the unfiltered listing.
			if (entry.parentSessionId === null) continue;
			const forms = childIdForms(entry.parentSessionId);
			if (!forms.some((form) => wanted.has(form))) continue;
		}
		const ageMs = Math.max(0, now - entry.startedAt);
		rows.push({ ...entry, ageMs, stale: ageMs > ACTIVITY_TTL_MS });
	}
	rows.sort((a, b) => a.startedAt - b.startedAt);
	return rows;
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

// ── birth-time route existence check ─────────────────────────────────────────
//
// Live failure (session-7a929cab, 2026-11-24): two coordinator children were
// created and died instantly with
//   pi-ai provider "magpie-responses" has no configured model "codex/gpt-6.2-sol"
// because the gateway had retired that model while the page still named it
// first. No request was ever made, so neither the failover hooks nor the stall
// watchdog could see anything: the child failed BEFORE its first step.
//
// The check therefore has to sit at birth — and it has to be SYNCHRONOUS,
// because the host's `startActivation` hands its receipt back synchronously and
// turning that into a promise would break every caller. So the catalog is kept
// warm in the background and read from the cache here. A cache that is missing
// or cold means "cannot verify": the configured row is used as before, because
// a catalog outage must never look like a dead config.

const BIRTH_CATALOG_TTL_MS = 5 * 60 * 1000;

/**
 * Read `llm.listModels(provider)` for every provider this page uses.
 *
 * @param {object} ctx - plugin context (`llm` service).
 * @param {object} state - plugin state (result cached on `state.birthCatalog`).
 * @returns {Promise<void>} resolves once the cache is refreshed.
 */
async function refreshBirthCatalogNow(ctx, state) {
	const map = new Map();
	const llm = llmService(ctx);
	if (llm !== void 0 && llm !== null && typeof llm.listModels === "function") {
		// Only the coordinator's lists are checked here: they are what the birth
		// path validates, and asking about every pool would double the catalog
		// traffic the batch card already makes for no additional guarantee.
		const providers = new Set();
		for (const group of COORD_GROUPS) {
			for (const route of coordinatorGroupRoutes(state.getSection?.(), group)) providers.add(route.provider);
		}
		if (providers.size === 0) return;
		for (const provider of providers) {
			if (typeof provider !== "string" || provider === "") continue;
			try {
				const listed = await llm.listModels(provider);
				const ids = new Set();
				for (const info of Array.isArray(listed) ? listed : []) {
					if (typeof info?.id === "string" && info.id !== "") ids.add(info.id);
				}
				// An unreadable or empty answer says nothing about the provider:
				// leave it out of the map so "cannot verify" stays distinct from
				// "the provider serves nothing".
				if (ids.size > 0) map.set(provider, ids);
			} catch (_error) { /* cannot verify this provider */ }
		}
	} else {
		return;
	}
	state.birthCatalog = { at: Date.now(), map };
}

/**
 * Refresh in the background unless a refresh is already running.
 *
 * @param {object} ctx - plugin context.
 * @param {object} state - plugin state.
 * @returns {Promise<void>|undefined} the in-flight refresh.
 */
function refreshBirthCatalogSoon(ctx, state) {
	if (state.birthCatalogInflight !== void 0 && state.birthCatalogInflight !== null) return state.birthCatalogInflight;
	const run = refreshBirthCatalogNow(ctx, state)
		.catch(() => { /* keep the previous cache */ })
		.finally(() => { state.birthCatalogInflight = void 0; });
	state.birthCatalogInflight = run;
	return run;
}

/**
 * True only when the cached catalog POSITIVELY lacks this model.
 *
 * @param {object} state - plugin state.
 * @param {{provider?: string, model?: string}} route - one candidate.
 * @returns {boolean} whether the route is provably dead.
 */
function birthRouteIsDead(state, route) {
	const map = state.birthCatalog?.map;
	if (map === void 0 || map === null) return false;
	if (typeof route?.provider !== "string" || typeof route?.model !== "string") return false;
	const ids = map.get(route.provider);
	if (ids === void 0) return false;
	return ids.has(route.model) === false;
}

/**
 * Drop every candidate the provider provably no longer serves.
 *
 * ONE PLACE FOR THE RULE. A row the gateway retired used to leak through every
 * path that did not ask: the failover target, the base pool, the role pool, the
 * "move this page to that list" default. Each leak produced the same live
 * failure ("provider has no configured model"), so every selection point now
 * runs its candidates through this.
 *
 * A route whose provider the catalog could not answer for is kept: "cannot
 * verify" must never look like "gone".
 *
 * @param {object} state - plugin state (birth catalog cache).
 * @param {Array<{provider: string, model: string}>} routes - candidates.
 * @returns {Array<object>} the candidates worth using.
 */
function filterLiveRoutes(state, routes) {
	const list = Array.isArray(routes) ? routes : [];
	if (list.length === 0) return list;
	const alive = list.filter((route) => route !== void 0 && route !== null && !birthRouteIsDead(state, route));
	// All dead is not better than unknown: hand the caller what the page says so
	// the real host error still names the row the user can fix.
	return alive.length > 0 ? alive : list;
}

/**
 * THE ONE GATE every route the plugin hands to the host passes through.
 *
 * Selection points keep multiplying — birth, pull-back, failover, a manual pick,
 * a list re-assignment, the batch card, the stall watchdog — and filtering each
 * one is exactly how the same retired-model failure kept coming back. So the
 * rule lives HERE, at the exit: a route whose provider provably no longer serves
 * it is replaced with the first usable route of the same page; anything that
 * cannot be verified is passed through untouched.
 *
 * @param {object} ctx - plugin context (warnings).
 * @param {object} state - plugin state (catalog cache).
 * @param {object|undefined} agent - the child the route is for.
 * @param {{provider: string, model: string}|undefined} route - the route about to be used.
 * @returns {{provider: string, model: string}|undefined} what the host may be given.
 */
function liveRouteGate(ctx, state, agent, route) {
	if (route === void 0 || route === null) return route;
	if (!birthRouteIsDead(state, route)) return route;
	const childId = typeof agent?.id === "string" ? agent.id : "";
	const candidates = childId === "" ? [] : childPageRoutes(state, childId).routes;
	const replacement = filterLiveRoutes(state, candidates).find((candidate) =>
		candidate.provider !== route.provider || candidate.model !== route.model);
	if (replacement === void 0) {
		ctx?.logger?.warn?.(
			`[dsh-subagent-role-router] %s/%s is gone from its provider and no live alternative is known; passing it through so the host can report it`,
			route.provider,
			route.model
		);
		return route;
	}
	ctx?.logger?.warn?.(
		`[dsh-subagent-role-router] %s/%s is gone from its provider; using %s/%s instead`,
		route.provider,
		route.model,
		replacement.provider,
		replacement.model
	);
	return replacement;
}

/**
 * The first candidate of `routes` that is not provably dead.
 * Cooling is honoured the same way `pickCoordinatorRoute` honours it, unless
 * `ignoreCooling` is set ("no fallback" on a group means "take its head", not
 * "take a dead head").
 *
 * @param {object} ctx - plugin context (warnings).
 * @param {object} state - plugin state.
 * @param {Array<object>} routes - candidates in page order.
 * @param {{cooling?: Function, ignoreCooling?: boolean}} [options] - cooling probe.
 * @returns {object|undefined} the route to use.
 */
function pickBirthableRoute(ctx, state, routes, options = {}) {
	const list = Array.isArray(routes) ? routes : [];
	if (list.length === 0) return void 0;
	const ignoreCooling = options.ignoreCooling === true;
	const cooling = !ignoreCooling && typeof options.cooling === "function" ? options.cooling : () => 0;
	let fallback;
	for (const route of list) {
		if (route === void 0 || route === null) continue;
		if (birthRouteIsDead(state, route)) {
			ctx.logger.warn(
				`[dsh-subagent-role-router] skipping the configured route %s/%s at birth: that provider does not serve this model any more`,
				route.provider,
				route.model
			);
			continue;
		}
		if (cooling(route) === 0) return route;
		if (fallback === void 0) fallback = route;
	}
	return fallback;
}

// ── subagent error journal ───────────────────────────────────────────────────
//
// The host persists only `message` + a coarse `code` when a subagent turn dies.
// A live failure (`ctx is not defined`, session-7a929cab 2026-11-24) carried no
// stack anywhere: not in the child session, not in the orchestrator's log, not
// in the parent transcript — so the thrower could not be found, and the fix was
// guesswork. `agent/error` hands the RAW error object to plugins, stack
// included; this journal is where that lands, bounded to a few hundred KB.

const ERROR_JOURNAL_LIMIT = 512 * 1024;

/** Where the journal lives (empty under the test runner, like the ledger). */
export function subagentErrorJournalPath() {
	const explicit = typeof process.env.DSH_SUBAGENT_ROLE_ROUTER_STATE === "string" ? process.env.DSH_SUBAGENT_ROLE_ROUTER_STATE.trim() : "";
	if (explicit !== "") return join(explicit, "subagent-errors.log");
	if (typeof process.env.NODE_TEST_CONTEXT === "string" && process.env.NODE_TEST_CONTEXT !== "") return "";
	return join(process.env.USERPROFILE || process.env.HOME || "", ".dsh", "state", "subagent-role-router", "subagent-errors.log");
}

/** Append one line, rotating once past the cap. Never throws. */
function appendErrorJournal(file, line) {
	if (file === "") return;
	try {
		fs.mkdirSync(dirname(file), { recursive: true });
		try {
			const size = fs.statSync(file).size;
			if (size > ERROR_JOURNAL_LIMIT) fs.renameSync(file, `${file}.1`);
		} catch (_error) { /* no previous file: nothing to rotate */ }
		fs.appendFileSync(file, line);
	} catch (_error) { /* a diagnostic must never break a session */ }
}

/**
 * Record every subagent turn/step error with its raw stack.
 *
 * @param {object} ctx - plugin context.
 * @param {object} state - plugin state (unused today; kept for symmetry).
 */
function installErrorJournal(ctx, state) {
	const dispose = ctx.on("agent/error", (payload) => {
		const { agent, turn, step, error } = payload ?? {};
		if (agent === void 0 || agent === null) return;
		// Main-agent errors are the host's own business; this journal is about
		// delegated children.
		if (agent?.session?.header?.origin !== "subagent") return;
		const message = typeof error?.message === "string" ? error.message : String(error);
		const stack = typeof error?.stack === "string" ? error.stack : "";
		appendErrorJournal(subagentErrorJournalPath(), `${JSON.stringify({
			at: new Date().toISOString(),
			agentId: typeof agent.id === "string" ? agent.id : "",
			label: agent?.session?.header?.label ?? "",
			preset: agent?.session?.header?.agentPreset ?? "",
			turn,
			step,
			message,
			stack
		})}\n`);
	});
	ctx.effect(() => () => { dispose(); }, "dsh-subagent-role-router: error journal");
}

function installSubagentWrapper(ctx, state) {
	const raw = ctx.subagents?.[Symbol.for("cordis.original")] ?? ctx.subagents;
	if (!raw || raw[WRAPPED]) return;
	const restorers = [];
	hookForkProvider(raw, state);
	const off = ctx.on("subagent/provider-added", (provider) => {
		if (provider?.name === "fork") hookForkProvider(raw, state);
	});
	// A receipt whose `result` never settles would leave a critter on screen
	// forever; disposal is the second, independent way out.
	const offDisposed = ctx.on("agent/disposed", ({ agent }) => {
		if (typeof agent?.id === "string") settleActivity(state, agent.id);
	});
	for (const key of ["start", "startContinuable", "startActivation"]) {
		const original = raw[key];
		if (typeof original !== "function") continue;
		const wrapped = function(...args) {
			// TWO SPEC SHAPES, ONE WRAPPER.
			//
			//   start(request)                 -> the request IS args[1]
			//   startActivation/spec           -> rc.3's activation spec is the
			//                                     SAME flat shape (SubagentActivationSpec
			//                                     extends SubagentStartRequest): label,
			//                                     parent, prompt, agentPreset and
			//                                     agentOptions are top-level fields and
			//                                     there is NO `spec.request`.
			//
			// Reading only `spec.request` made every flat spawn invisible here: the
			// plugin skipped birth routing, the coordinator's preset never matched,
			// and the child only got corrected later at request time (the kernel
			// seat swap). Older hosts keep the nested `{ request }` wrapper, so both
			// are understood and neither is broken.
			const rawSpec = key === "start" ? null : args[0];
			const nested = rawSpec !== null && rawSpec !== void 0 && typeof rawSpec === "object"
				&& rawSpec.request !== void 0 && rawSpec.request !== null && typeof rawSpec.request === "object"
				? rawSpec.request
				: null;
			const spec = rawSpec;
			const request = key === "start" ? args[1] : (nested ?? rawSpec);
			/** Write one rewritten request back in whichever shape came in. */
			const writeRequest = (next) => {
				if (key === "start") {
					args[1] = next;
					return;
				}
				if (nested !== null) args[0] = { ...rawSpec, request: next };
				else args[0] = { ...rawSpec, ...next };
			};
			const label = spec?.label || request?.label;
			// Keep the birth catalog warm without ever blocking the spawn: a cold
			// or missing cache means "cannot verify", and the spawn proceeds as
			// it always did.
			if (request && (state.birthCatalog === void 0 || state.birthCatalog === null
				|| Date.now() - (state.birthCatalog.at ?? 0) > BIRTH_CATALOG_TTL_MS)) {
				void refreshBirthCatalogSoon(ctx, state);
			}
			if (request) noteBirthSeen(spec, request);
			// Keep the native "a child may pick a model" gate in step with this
			// page before the child is built: the tool schema only carries
			// provider/model/reasoning_effort while that gate is enabled, and it
			// only accepts routes listed there.
			if (request) syncHostWhitelistSoon(ctx, state);
			const team = teamIdentity(label, request?.persona);
			// The coordinator's own children are decided FIRST and never reach the
			// exemption list, the role pools, or the general whitelist: their list
			// is the whole answer. The picked route overwrites whatever the host
			// copied in (usually the parent's own route), because an off-list birth
			// model is exactly what the two-list split exists to prevent.
			const coord = request ? coordinatorGroupForBirth(state, spec, request) : void 0;
			let lease;
			if (coord !== void 0) {
				const routes = coordinatorGroupRoutes(state.getSection?.(), coord.group);
				const route = coord.noFallback === true
					? pickBirthableRoute(ctx, state, routes, { ignoreCooling: true })
					: pickBirthableRoute(ctx, state, routes, {
						cooling: (candidate) => coordinatorCoolingFor(state, coord.group, candidate)
					});
				if (route !== void 0) {
					writeRequest({ ...request, agentOptions: { ...request.agentOptions, ...route } });
				}
			} else if (request && !team) {
				// Exempt plugin children: recognized by their BIRTH identity
				// (label / agentPreset / cwd, exact-prefix rules). No lanes, no
				// role pools, no default-model injection — the rule may pin a
				// birth model, and an explicit agentOptions on the spawn still
				// wins over the pin.
				const exempt = exemptRuleForBirth(state, spec, request);
				if (exempt !== void 0) {
					const pinned = exemptBirthModel(exempt);
					if (pinned && !request.agentOptions?.model && !request.agentOptions?.provider) {
						writeRequest({ ...request, agentOptions: { ...request.agentOptions, ...pinned } });
					}
				} else {
					const routed = routeDelegation(state, request, label);
					lease = routed.lease;
					writeRequest(routed.request);
				}
			} else if (request && team) {
				// Agent-teams spawn: no lanes, no failover — only the optional
				// birth model, mirroring how routeDelegation writes agentOptions
				// for plain subagents (an explicit agentOptions still wins).
				const birth = teamBirthModel(state);
				if (birth && !request.agentOptions?.model && !request.agentOptions?.provider) {
					writeRequest({ ...request, agentOptions: { ...request.agentOptions, ...birth } });
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
			// Recorded OUTSIDE the lease branch on purpose: `lease` only exists for
			// pooled delegations, so team members, exempt children and children that
			// already name a model would otherwise never reach the ledger.
			trackDispatch(
				state,
				key === "start" ? args[1] : (args[0]?.request ?? args[0]),
				key === "start" ? null : args[0],
				dispatched,
				label
			);
			if (coord !== void 0) bindCoordinatorGroup(state, dispatched, coord);
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
		offDisposed();
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
		/** childId → revision, bumped on every explicit route write/clear. */
		routeRevisions: new Map(),
		/** Instance epoch: a fresh process must not be confused with the old one. */
		routeEpoch: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		modelCaps: null,
		/** Warm provider→models cache used by the birth-time existence check. */
		birthCatalog: null,
		birthCatalogInflight: null,
		/**
		 * child session id → `{ childId, parentSessionId, label, role, provider,
		 * model, startedAt }` for the header critters. In memory only: it describes
		 * what is running right now, so a restart correctly forgets it.
		 */
		activity: new Map(),
		/**
		 * Diagnostic hit counters for the read endpoints. The header optimization's
		 * acceptance test is "zero periodic requests", and this is how that is
		 * proven without turning debug logging on: while a session sits idle these
		 * numbers must not move.
		 */
		httpCounters: { activity: 0, batch: 0, batchSelect: 0, events: 0 },
		// ── the coordinator's three lists (see coordinatorGroupRoutes) ────────
		// Which list each child born by that plugin was put on, why, and how long
		// each of its routes is sitting out after a failure. The decisions are
		// PERSISTED (see `loadCoordinatorLedger`): losing them on a reload made
		// running coordinator children fall back to the general list and get
		// switched mid-run. The cooldown stays in memory — it only lasts minutes.
		coordGroupOfChild: new Map(),
		coordCooldown: new Map(),
		coordSubstitutions: new Set(),
		/** Pending debounced ledger write; cleared by the timeout itself. */
		coordLedgerTimer: void 0,
		// Open SSE listeners for cross-window route announcements; filled by
		// installOverrideEndpoint, which also installs routeEventBroadcast.
		routeEventClients: new Set(),
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
				// The stall watchdog's two knobs live here for the same reason the
				// note above gives: a schema field missing from this mapping is
				// invisible to every consumer.
				stallWatchdogEnabled: unwrap(raw.stallWatchdogEnabled),
				stallWatchdogSeconds: unwrap(raw.stallWatchdogSeconds),
				injectRouteContext: unwrap(raw.injectRouteContext),
				// Read back too: the single-model form stores its effort here, so
				// dropping the key silently ignored the configured effort.
				reasoningEffort: unwrap(raw.reasoningEffort),
				birthRoutePolicy: unwrap(raw.birthRoutePolicy),
				roleMode: unwrap(raw.roleMode),
				// The coordinator's two lists. getSection() is an explicit field-by-
				// field view: a schema field NOT listed here is invisible to every
				// consumer, which is exactly how a feature can ship "working" and
				// still read as empty on a real profile.
				coordinatorEnabled: unwrap(raw.coordinatorEnabled),
				coordinatorPresetPrefix: unwrap(raw.coordinatorPresetPrefix),
				coordinatorUiModels: unwrap(raw.coordinatorUiModels),
				coordinatorResearchModels: unwrap(raw.coordinatorResearchModels),
				coordinatorDeliveryModels: unwrap(raw.coordinatorDeliveryModels),
				coordinatorBackendModels: unwrap(raw.coordinatorBackendModels),
				coordinatorCooldownPreset: unwrap(raw.coordinatorCooldownPreset),
				coordinatorCooldownSteps: unwrap(raw.coordinatorCooldownSteps),
				coordinatorCooldownCap: unwrap(raw.coordinatorCooldownCap),
				coordinatorNoFallback: unwrap(raw.coordinatorNoFallback),
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
				showChatModelNotice: unwrap(raw.showChatModelNotice),
				showHeaderCritters: unwrap(raw.showHeaderCritters)
			};
			// Drop any field that resolved to undefined so downstream defaults apply.
			for (const key of Object.keys(section)) {
				if (section[key] === void 0) delete section[key];
			}
			return section;
		}
	};

	// Restore the coordinator's group decisions BEFORE anything can judge a child
	// by a list: a reload must not turn a running coordinator child into an
	// "ordinary" one and switch it onto the general pool (see the ledger notes).
	loadCoordinatorLedger(state);

	// Installed BEFORE installFailover on purpose: cordis waterfalls run listeners
	// in registration order and unwind in reverse, so the first registered
	// listener has the last word. A route the user picked in the Web UI must beat
	// the automatic failover swap.
	installChildRouteOverride(ctx, state);

	// Subagent-only failover hooks the agent loop, not the subagents service,
	// so it is installed unconditionally: listeners no-op when the `failover`
	// section is absent/disabled or when the failing agent is the main loop.
	installFailover(ctx, state);

	// A route that never answers never errors either: only the stream frames
	// can tell "still thinking" from "hanging", and this watchman is what turns
	// a silent stall into a switch.
	installStallWatchdog(ctx, state);

	// A diagnostic must never change behaviour: this only records, it never
	// intervenes, and it exists because the host discards stack traces.
	installErrorJournal(ctx, state);

	// Warm the birth catalog so the FIRST spawn after a reload is already
	// checked; without it a restarted host spends one spawn trusting a config
	// that may name a retired model (the exact live failure this guards).
	void refreshBirthCatalogSoon(ctx, state);


	// Tell each subagent which route it is actually running on. Same gate as
	// failover (origin === "subagent"), so the main agent's context is untouched.
	installRouteContextInjector(ctx, state);

	// Repair a display name ("dnq") into the exact model id ("group/dnq") before
	// the host preflight asks the adapter for a model that does not exist.
	installDelegationArgumentRepair(ctx, state);

	// Serve the Web UI's model/effort picker for a running child.
	installOverrideEndpoint(ctx, state);

	// Model-callable tools over the same controller the HTTP endpoints use.
	installRouterTools(ctx, state);


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
		state.activity.clear();
	});
}
