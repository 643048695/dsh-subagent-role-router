/**
 * Bounded, generation-checked recovery for a subagent whose route failed.
 *
 * WHY THIS MODULE EXISTS: the host loop (DSH 0.2.2-rc.5, verified against the
 * installed `dsh-agent-loop/src/agent.ts`) captures ONE model selection when it
 * builds a step (`const selection = this.model.current()` in `preStep`) and
 * then reuses that same `decision.selection` for every attempt inside the step
 * (`prepareRequest(turn, step, decision.selection, signal)` in a `while (true)`).
 * `agent.model.select()` only appends a `model/selection` event — it cannot
 * change `decision.selection`, so answering `agent/request-error` with
 * `{ kind: "retry" }` is NOT a switch: the loop re-runs the SAME route.
 *
 * The only honest live switch is therefore:
 *
 *   1. `agent.model.select(target)` — synchronous, durable, used by the NEXT
 *      turn's `preStep`;
 *   2. `agent.cancel({ kind: "hook" }, { keepInbox: true })` — cuts the
 *      in-flight attempt (host: `this.phase.abort.abort(cause)`) while keeping
 *      queued work;
 *   3. `agent.followup(message)` — same synchronous window, AFTER the abort.
 *      Host `send()` reclassifies a waking message on an aborted phase to
 *      `next-turn` and latches `wakeRequested`, so `kick()`'s finally block
 *      starts a fresh turn without waiting on an error the user cancelled.
 *
 * There must be NO `await` between (2) and (3): the latch is set by the abort
 * classification inside `send()`, and the turn is already unwinding. This
 * module performs the three calls synchronously; callers do the planning and
 * pass only plain data in.
 *
 * RECOVERY IS AN EPISODE, NOT A COUNTER: the old code remembered "how many
 * switches happened on this agent id" forever, so a long-lived child that had
 * failed twice could never switch again even after twenty successful turns. An
 * episode here is bounded by the routes that ACTUALLY failed in it (`failed`),
 * and only a real, non-interrupted assistant message resets it. Request-time
 * events (`agent/request`) never reset it: preparing a request proves nothing
 * about the route, and clearing a strike on preparation is how a route that
 * fails every time kept looking healthy.
 *
 * GENERATIONS: disposal and a user/parent cancellation bump `generation` and
 * latch the episode dead. Every deferred recovery (the stall timer, the
 * prepare-failure microtask) captures its generation and re-checks it before
 * touching the agent, so a stop can never be resurrected by a late callback.
 *
 * @module dsh-subagent-role-router/recovery
 */

/** A route is addressable when both halves are non-empty strings. */
export function validRoute(route) {
	return route !== void 0 && route !== null
		&& typeof route.provider === "string" && route.provider !== ""
		&& typeof route.model === "string" && route.model !== "";
}

/** Stable identity of one route inside an episode, matching `index.js`'s `routeKey`. */
export function routeKeyOf(route) {
	if (!validRoute(route)) return "";
	// The plugin-wide cooldown table (written by `noteCooldown`) and the
	// coordinator table both key routes with `provider/model` (a slash), while
	// this module used to use a NUL separator. Two spellings meant a cooling
	// route was invisible to `coolingRemaining`, so the failover picker happily
	// re-chose a model it had just cooled. One spelling, the existing one.
	return `${route.provider}/${route.model}`;
}

/** Keep at most this many dead episodes as tombstones for late callbacks. */
const DISPOSED_KEEP = 64;

/** Defensive cap so a pathological list cannot grow one episode without bound. */
const MAX_FAILED_KEYS = 32;

/**
 * Lazily attach the ledger to the plugin state object.
 * @param {object} state - plugin state.
 * @returns {{episodes: Map<string, object>, disposedOrder: string[]}}
 */
export function recoveryLedger(state) {
	if (state.recovery === void 0 || state.recovery === null) {
		state.recovery = { episodes: new Map(), disposedOrder: [] };
	}
	if (!(state.recovery.episodes instanceof Map)) state.recovery.episodes = new Map();
	if (!Array.isArray(state.recovery.disposedOrder)) state.recovery.disposedOrder = [];
	return state.recovery;
}

/** One live-vs-dead episode for a child id, created on first use. */
export function episodeOf(state, agentId) {
	const ledger = recoveryLedger(state);
	const key = typeof agentId === "string" ? agentId : String(agentId ?? "");
	let episode = ledger.episodes.get(key);
	if (episode === void 0) {
		episode = {
			generation: 0,
			disposed: false,
			cancelled: false,
			failed: new Set(),
			switches: 0,
			lastFailureAt: 0,
			lastSuccessAt: 0
		};
		ledger.episodes.set(key, episode);
	}
	return episode;
}

/** The generation a deferred recovery must still match before it may act. */
export function generationOf(state, agentId) {
	return episodeOf(state, agentId).generation;
}

/**
 * Latch an episode dead for disposal. Keeps a bounded tombstone so a late
 * microtask/timer sees a mismatched generation instead of re-creating a live
 * episode and resurrecting a disposed child.
 */
export function markDisposed(state, agentId) {
	const episode = episodeOf(state, agentId);
	episode.generation += 1;
	episode.disposed = true;
	episode.failed.clear();
	episode.switches = 0;
	const ledger = recoveryLedger(state);
	const key = typeof agentId === "string" ? agentId : String(agentId ?? "");
	if (!ledger.disposedOrder.includes(key)) ledger.disposedOrder.push(key);
	while (ledger.disposedOrder.length > DISPOSED_KEEP) {
		const oldest = ledger.disposedOrder.shift();
		if (oldest !== void 0 && !ledger.episodes.get(oldest)?.cancelled) ledger.episodes.delete(oldest);
	}
}

/**
 * Latch an episode dead for a user/parent stop. A real success later clears the
 * latch (the same agent can legitimately be given new work).
 */
export function markCancelled(state, agentId) {
	const episode = episodeOf(state, agentId);
	episode.generation += 1;
	episode.cancelled = true;
}

/** Whether a captured generation may still act on this agent. */
export function canSwitch(state, agentId, generation) {
	const episode = episodeOf(state, agentId);
	return !episode.disposed && !episode.cancelled && episode.generation === generation;
}

/**
 * Record a real successful turn: only a committed, non-interrupted assistant
 * message reaches here. It clears the failed-route set and the switch budget,
 * so the NEXT failure opens a fresh episode.
 *
 * @param {object} state - plugin state.
 * @param {string} agentId - child id.
 * @param {{provider: string, model: string}|undefined} route - the route that answered.
 */
export function noteRealSuccess(state, agentId, route) {
	const episode = episodeOf(state, agentId);
	if (episode.disposed) return;
	episode.failed.clear();
	episode.switches = 0;
	episode.cancelled = false;
	episode.lastSuccessAt = Date.now();
	episode.lastSuccessRoute = validRoute(route) ? { provider: route.provider, model: route.model } : void 0;
}

/**
 * Remember one route that actually failed in this episode.
 * The generation check makes a late caller (from a superseded run) harmless.
 *
 * @returns {boolean} true when the failure belonged to the live generation.
 */
export function noteFailure(state, agentId, generation, route) {
	if (!canSwitch(state, agentId, generation)) return false;
	if (!validRoute(route)) return false;
	const episode = episodeOf(state, agentId);
	episode.failed.add(routeKeyOf(route));
	if (episode.failed.size > MAX_FAILED_KEYS) {
		// Keep the oldest keys: they are the routes most certainly dead in this
		// episode. Dropping one would re-try it, which is never the intent.
		const keys = [...episode.failed];
		episode.failed = new Set(keys.slice(0, MAX_FAILED_KEYS));
	}
	episode.lastFailureAt = Date.now();
	return true;
}

/** Count one applied switch. Bounded by the caller's candidate set. */
export function noteSwitch(state, agentId, generation) {
	if (!canSwitch(state, agentId, generation)) return false;
	const episode = episodeOf(state, agentId);
	episode.switches += 1;
	return true;
}

/**
 * Remaining cooldown for one route in the view that will serve it.
 *
 * A coordinator child's route cools inside its own group with the graded wait;
 * an ordinary child cools in the plugin-wide table. Cooling is a PREFERENCE for
 * in-run failover (a route that is merely resting may still beat stopping), so
 * selection prefers a ready route and only falls back to a cooling one when no
 * untried route is ready.
 *
 * @param {object} state - plugin state.
 * @param {{coordinatorGroup?: string}} view - failover view.
 * @param {{provider: string, model: string}} route - candidate route.
 * @param {(group: string, route: object) => number} coordinatorCooling - probe.
 * @returns {number} remaining milliseconds (<= 0 means ready).
 */
export function coolingRemaining(state, view, route, coordinatorCooling) {
	if (view?.coordinatorGroup !== void 0 && typeof coordinatorCooling === "function") {
		// A probe may return a negative remaining time (expired); the helper's
		// contract is "0 = ready", never a negative number.
		return Math.max(0, Number(coordinatorCooling(view.coordinatorGroup, route)) || 0);
	}
	const until = state?.cooldowns?.get?.(routeKeyOf(route)) ?? 0;
	return Math.max(0, until - Date.now());
}

/**
 * Pick the next candidate index for one failed route.
 *
 * The candidate set is bounded by ACTUAL failures: a route in `triedKeys` is
 * never selected again in this episode, so a pool of N routes allows at most
 * N-1 switches and then the real error surfaces. Cooling routes are skipped
 * while any untried route is ready, and used only as a degraded last resort.
 * Round-robin order advances from the failed route (the "queue"), so a list's
 * order still decides; random ignores order.
 *
 * @param {object} options
 * @param {Array<object>} options.entries - candidate routes in page order.
 * @param {"round-robin"|"random"} options.strategy - view strategy.
 * @param {{provider: string, model: string}} options.failedRoute - route that failed.
 * @param {Set<string>} [options.triedKeys] - route keys already failed in this episode.
 * @param {Set<string>|Array<string>} [options.extraAvoidKeys] - withdrawn picks never to touch.
 * @param {(route: object) => number} [options.cooling] - remaining cooldown probe.
 * @param {boolean} [options.manual] - MANUAL fallback: the page head order, not "after this pick".
 * @returns {{index: number, route: object}|undefined}
 */
export function pickCandidate({ entries, strategy, failedRoute, triedKeys, extraAvoidKeys, cooling, manual }) {
	const list = Array.isArray(entries) ? entries : [];
	if (list.length === 0) return void 0;
	const tried = triedKeys instanceof Set ? triedKeys : new Set();
	const avoid = new Set();
	const failedKey = routeKeyOf(failedRoute);
	if (failedKey !== "") avoid.add(failedKey);
	if (extraAvoidKeys instanceof Set || Array.isArray(extraAvoidKeys)) {
		for (const key of extraAvoidKeys) if (typeof key === "string" && key !== "") avoid.add(key);
	}
	const isFree = (index) => {
		const route = list[index];
		if (!validRoute(route)) return false;
		const key = routeKeyOf(route);
		return key !== "" && !avoid.has(key) && !tried.has(key);
	};
	const isCooling = (index) => (typeof cooling === "function" ? cooling(list[index]) > 0 : false);
	// Candidate ORDER: a manual fallback reverts to the page head; automatic
	// round-robin advances from the route that failed (wrapping) so the list is
	// still a queue. Random has no order at all.
	let order;
	if (manual === true) {
		order = list.map((_, index) => index);
	} else if (strategy === "random") {
		order = list.map((_, index) => index);
	} else {
		const at = list.findIndex((entry) => routeKeyOf(entry) === failedKey);
		// A served route that is not in this pool (an inherited route, a pick
		// from another page) starts the queue at entry 0: `at === -1` means the
		// first wrapped index is 0. The old code started at 1 instead.
		order = [];
		for (let step = 1; step <= list.length; step += 1) order.push((at + step) % list.length);
	}
	const free = order.filter(isFree);
	if (free.length === 0) return void 0;
	const ready = free.filter((index) => !isCooling(index));
	let chosen;
	if (strategy === "random" && manual !== true) {
		const pool = ready.length > 0 ? ready : free;
		chosen = pool[Math.floor(Math.random() * pool.length)];
	} else {
		chosen = (ready.length > 0 ? ready : free)[0];
	}
	if (chosen === void 0) return void 0;
	return { index: chosen, route: list[chosen] };
}

/** The route a child is actually serving, from its own session evidence. */
export function servedRouteOf(agent) {
	const context = agent?.session?.requestContext?.();
	const header = agent?.session?.requestHeader?.()?.config;
	const provider = typeof context?.provider === "string" && context.provider !== ""
		? context.provider
		: (typeof header?.provider === "string" ? header.provider : "");
	const model = typeof context?.model === "string" && context.model !== ""
		? context.model
		: (typeof header?.model === "string" ? header.model : "");
	if (provider === "" || model === "") return void 0;
	const route = { provider, model };
	const effort = context?.reasoningEffort ?? header?.reasoningEffort;
	if (typeof effort === "string" && effort !== "") route.reasoningEffort = effort;
	return route;
}

/** The route that produced one committed assistant message (for success clearing). */
export function assistantRouteOf(event, session) {
	const source = event?.data?.message?.source;
	if (source !== null && typeof source === "object"
		&& typeof source.provider === "string" && source.provider !== ""
		&& typeof source.model === "string" && source.model !== "") {
		return { provider: source.provider, model: source.model };
	}
	const header = session?.requestHeader?.()?.config;
	if (header !== null && typeof header === "object"
		&& typeof header.provider === "string" && header.provider !== ""
		&& typeof header.model === "string" && header.model !== "") {
		return { provider: header.provider, model: header.model };
	}
	return void 0;
}

/**
 * The route the step's FROZEN selection names.
 *
 * A prepare-call failure happens before any request is committed, so
 * `requestContext()` still describes the PREVIOUS attempt. When a failover
 * already moved the child from A to B and B's configuration is what fails to
 * prepare, reading `requestContext()` would mark A again and choose B a second
 * time. `agent.model.current()` is the same fold `preStep` reads (`pending ??
 * lastUsed`), so it names B. Falls back to `requestContext()` for fixtures and
 * older agent shapes that do not expose `current()`.
 */
export function selectedRouteOf(agent) {
	const selection = agent?.model?.current?.();
	if (validRoute(selection)) {
		return {
			provider: selection.provider,
			model: selection.model,
			...(typeof selection.reasoningEffort === "string" && selection.reasoningEffort !== ""
				? { reasoningEffort: selection.reasoningEffort }
				: {})
		};
	}
	return servedRouteOf(agent);
}

/**
 * Wording for a route failure that happens BEFORE a request can be built.
 *
 * Prepare-call failures (`llm.prepareCall` throwing) never reach
 * `agent/request-error` — the host catches them in the turn and appends a
 * terminal `turn/end { kind: "error" }`. A raw `agent/error` is unsafe to act
 * on (it also fires for tool and session failures, and the phase may already be
 * unwinding), so the caller reacts only to this narrow, durable set.
 */
const PREPARE_CONFIG_PATTERN = /no\s+adapter\s+registered|provider\s+.*?no\s+configured\s+model|has\s+no\s+configured\s+model|no\s+configured\s+model\s+for|model\s*\[[^\]]*\]\s*(?:is\s+)?not\s+(?:allowed|available|permitted|supported|found)|no\s+such\s+model|unknown\s+model|knows\s+no\s+model|model\s+\S+\s+does\s+not\s+exist/i;

/** True only for a known LLM configuration failure (never a request/content bug). */
export function isPrepareConfigFailure(failure) {
	if (failure === void 0 || failure === null) return false;
	const code = typeof failure.code === "string" ? failure.code.toUpperCase() : "";
	if (code === "NO_ADAPTER" || code === "MISSING_CREDENTIAL" || code === "INVALID_CREDENTIAL") return true;
	if (typeof failure.message !== "string") return false;
	return PREPARE_CONFIG_PATTERN.test(failure.message);
}

/**
 * Apply one route to a live child through the host's ONLY legal live gate.
 *
 * `agent.model.select()` is synchronous (`AgentModel.select` appends
 * `model/selection`) but some call sites hand back a thenable; this helper is
 * deliberately synchronous and refuses a thenable result by reporting failure,
 * so no caller can accidentally await between select and the cut.
 *
 * @param {object} agent - live child.
 * @param {{provider: string, model: string}} route - intended route.
 * @param {(route: object) => object} [gate] - the plugin's route gate (dead-model exit check).
 * @returns {{ok: true, route: object}|{ok: false, reason: string, message?: string}}
 */
export function selectSynchronously(agent, route, gate) {
	if (!validRoute(route)) return { ok: false, reason: "no-route" };
	const gated = typeof gate === "function" ? gate(route) : route;
	if (!validRoute(gated)) return { ok: false, reason: "no-route" };
	const model = agent?.model;
	if (model === void 0 || model === null || typeof model.select !== "function") {
		return { ok: false, reason: "no-model-select" };
	}
	const selection = {
		provider: gated.provider,
		model: gated.model,
		...(typeof gated.reasoningEffort === "string" && gated.reasoningEffort !== ""
			? { reasoningEffort: gated.reasoningEffort }
			: {})
	};
	try {
		const outcome = model.select(selection);
		if (outcome !== void 0 && outcome !== null && typeof outcome.then === "function") {
			return { ok: false, reason: "async-select", message: "agent.model.select returned a promise; refusing an await gap" };
		}
		return { ok: true, route: gated };
	} catch (error) {
		return { ok: false, reason: "select-failed", message: String(error?.message ?? error) };
	}
}

/**
 * THE switch: select, cut the in-flight attempt, then resume it — synchronously.
 *
 * Every function is preflighted BEFORE any mutation, so a child missing one
 * half is left untouched and the caller can surface the real error. `cancel`
 * keeps the inbox (a queued user message must never be thrown away); `followup`
 * is called with no `await` in between, which is what makes the host latch the
 * wake on the aborted phase.
 *
 * @returns {{ok: true, route: object}|{ok: false, reason: string, message?: string}}
 */
export function switchNow(agent, { target, continuation, gate, guard, reason = "failover" }) {
	if (agent === void 0 || agent === null) return { ok: false, reason: "not-live" };
	if (typeof agent.model?.select !== "function") return { ok: false, reason: "no-model-select" };
	if (typeof agent.cancel !== "function") return { ok: false, reason: "no-cancel" };
	if (typeof agent.followup !== "function") return { ok: false, reason: "no-followup" };
	if (continuation === void 0 || continuation === null) return { ok: false, reason: "no-continuation" };
	const selected = selectSynchronously(agent, target, gate);
	if (!selected.ok) return selected;
	// A synchronous re-check after the selection append: `model.select` mutates
	// the session log, and a session observer may have cancelled or disposed the
	// child in that same window. Catching it here means we never cut-and-resume
	// a child the user just stopped.
	if (typeof guard === "function" && guard() !== true) {
		return { ok: false, reason: "stale-generation", selected: true };
	}
	try {
		agent.cancel({ kind: "hook", reason }, { keepInbox: true });
	} catch (error) {
		return { ok: false, reason: "cancel-failed", message: String(error?.message ?? error) };
	}
	// NO await, no yielding, no Promise.resolve between these two calls.
	try {
		agent.followup(continuation);
	} catch (error) {
		return { ok: false, reason: "followup-failed", message: String(error?.message ?? error) };
	}
	return { ok: true, route: selected.route };
}

/**
 * Resume one terminal (already idle) attempt on a new route without cutting.
 *
 * Used by the prepare-failure path: the turn already ended with `error`, so
 * there is no in-flight stream to abort; a followup on an idle agent starts the
 * next turn. Requires a genuinely idle child (`agent.status === "idle"`), so a
 * callback can never inject into (or cancel) unrelated live work.
 */
export function resumeNow(agent, { target, continuation, gate, guard }) {
	if (agent === void 0 || agent === null) return { ok: false, reason: "not-live" };
	if (typeof agent.status === "string" && agent.status !== "idle") {
		return { ok: false, reason: "not-idle" };
	}
	if (typeof agent.model?.select !== "function") return { ok: false, reason: "no-model-select" };
	if (typeof agent.followup !== "function") return { ok: false, reason: "no-followup" };
	const selected = selectSynchronously(agent, target, gate);
	if (!selected.ok) return selected;
	if (typeof guard === "function" && guard() !== true) {
		return { ok: false, reason: "stale-generation", selected: true };
	}
	try {
		agent.followup(continuation);
	} catch (error) {
		return { ok: false, reason: "followup-failed", message: String(error?.message ?? error) };
	}
	return { ok: true, route: selected.route };
}

/** Human/model-readable continuation text; only built for a switch that happened. */
export function continuationText({ from, to, manual, error, reason }) {
	const fromLabel = `${from?.provider ?? "?"}/${from?.model ?? "?"}`;
	const toLabel = `${to?.provider ?? "?"}/${to?.model ?? "?"}`;
	const cause = typeof error === "string" && error !== "" ? error : (reason === "stall-watchdog" ? "长时间没有输出" : "请求失败");
	const manualPart = manual === true
		? `你在界面上为这个子会话选择的 ${fromLabel} 已撤回，` 
		: "";
	return `[dsh-subagent-role-router] ${manualPart}上一步在 ${fromLabel} 上失败（${cause}）。本会话已自动切换到 ${toLabel}，请从中断处继续完成同一个任务：不要重复已经完成的步骤，也不要重新制定计划。切换只改变执行模型，不改变任务、权限和已有结论。`;
}
