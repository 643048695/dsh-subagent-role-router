/**
 * The boundary between this plugin and @nanmicoder/dsh-agent-teams.
 *
 * The member-route service itself lives in the teams plugin (stage 2 of the
 * execution plan). This adapter only probes for it and describes its contract;
 * it never edits .agent-teams state files and never impersonates a captain.
 *
 * Service contract (apiVersion 1):
 *   describe({ caller, memberNames? }) →
 *     { ok:true, members:[{ name, childId, writable, reason, mode, label,
 *                           actual, override, pendingRoute, pending, revision }] }
 *     | { ok:false, error:{ code, message } }
 *   setOverride({ caller, memberName, provider, model, reasoningEffort,
 *                 expectedRevision? }) →
 *     { ok, status, route, actual, pending, revision } | { ok:false, error }
 *   clearOverride({ caller, memberName, expectedRevision? }) → same shape
 *
 * `caller` is the calling Agent passed through untouched: the teams plugin
 * re-verifies captainship and membership itself, so this side never widens
 * authority, never edits team state directly, and never removes members.
 */

const MEMBER_ROUTE_SERVICE_KEYS = ["agentTeamsMemberRoutes", "memberRoutes"];
const REQUIRED_API_VERSION = 1;

export function createAgentTeamsAdapter(ctx) {
	const serviceOf = () => {
		for (const key of MEMBER_ROUTE_SERVICE_KEYS) {
			let service;
			try {
				service = typeof ctx?.get === "function" ? ctx.get(key, false) : void 0;
			} catch {
				service = void 0;
			}
			if (service !== void 0 && service !== null) return { key, service };
		}
		return void 0;
	};

	return {
		requiredApiVersion: REQUIRED_API_VERSION,
		/** Whether team-member routing is reachable right now, and why not. */
		capability() {
			const hit = serviceOf();
			if (hit === void 0) {
				return { available: false, reason: "agent-teams member route service is not installed" };
			}
			const apiVersion = typeof hit.service.apiVersion === "number" ? hit.service.apiVersion : 0;
			if (apiVersion < REQUIRED_API_VERSION) {
				return {
					available: false,
					reason: `agent-teams member route service apiVersion ${apiVersion} is older than the required ${REQUIRED_API_VERSION}`
				};
			}
			return { available: true, apiVersion, serviceKey: hit.key, service: hit.service };
		},
		/** The real calling agent, passed through untouched for the teams side to re-verify. */
		caller(exec) {
			return exec?.agent ?? void 0;
		}
	};
}
