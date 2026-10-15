import { randomUUID } from "node:crypto";

/**
 * Surface-eligible event types defined by @deepseek-ai/dsh-session.
 * Surface events require surfaceOp ("append" or replace op).
 * Non-surface events must NOT carry surfaceOp or sourceEventSeqs.
 */
const SURFACE_EVENT_TYPES = new Set([
	"system/message",
	"developer/message",
	"user/message",
	"assistant/message",
	"tool/result"
]);

/**
 * Check if an event type is surface-eligible.
 * @param {string} type
 * @returns {boolean}
 */
export function isSurfaceEligibleType(type) {
	return SURFACE_EVENT_TYPES.has(type);
}

/**
 * Build a window-sliced seed containing only the most recent N completed turns.
 *
 * Invariants & Contract:
 * 1. Only completed turns (bounded by `turn/end`) are retained; in-flight turns
 *    are strictly excluded to prevent partial prompt/step leaking.
 * 2. If the total completed turns <= maxTurns, no slicing is needed: returns `null`
 *    so the caller safely uses the original un-sliced seed.
 * 3. Preserves all effective conversation content:
 *    - user messages with their original sources
 *    - assistant messages (including text and tool-call content blocks)
 *    - tool calls and tool results with their outputs and sources
 *    - prior compaction summary if one occurred before the window start
 * 4. Ensures DSH session protocol compliance:
 *    - contiguous `seq` starting from 0 (0, 1, 2, ...)
 *    - valid `surfaceOp` ("append" or safely remapped replace op)
 *    - non-surface events never carry `surfaceOp` or `sourceEventSeqs`
 * 5. Does NOT mutate `parent` or `parent.session`.
 * 6. Never claims fake ACP active context without a real ACP interface.
 * 7. When anything is uncertain or cannot be safely represented, returns `null`
 *    to preserve the original seed rather than silently producing an empty/broken context.
 *
 * @param {any} parent - The parent agent instance (may provide parent.session.snapshotEvents)
 * @param {number} [maxTurns=3] - Maximum number of completed turns to retain
 * @param {Array<any>} [completedSeed] - Optional pre-extracted completed event array
 * @returns {Array<any> | null} Sliced seed array, or null if no slicing is needed or possible
 */
export function buildWindowSlicedSeed(parent, maxTurns = 3, completedSeed) {
	try {
		const turnsLimit = Number.isSafeInteger(maxTurns) && maxTurns >= 1 && maxTurns <= 20 ? maxTurns : 3;

		let events = completedSeed;
		if (!Array.isArray(events)) {
			if (typeof parent?.session?.snapshotEvents === "function") {
				events = parent.session.snapshotEvents();
			}
		}

		if (!Array.isArray(events) || events.length === 0) {
			return null;
		}

		// Strictly isolate completed turns: find the last turn/end in the event log
		const lastTurnEndIdx = events.findLastIndex((e) => e && e.type === "turn/end");
		if (lastTurnEndIdx === -1) {
			// No completed turns found
			return null;
		}

		// Discard any in-flight / uncompleted events after the last turn/end
		const completedEvents = events.slice(0, lastTurnEndIdx + 1);

		// Collect all completed turn end indices
		const turnEndIndices = [];
		for (let i = 0; i < completedEvents.length; i++) {
			if (completedEvents[i]?.type === "turn/end") {
				turnEndIndices.push(i);
			}
		}

		const totalCompletedTurns = turnEndIndices.length;
		if (totalCompletedTurns <= turnsLimit) {
			// No slicing needed; caller preserves full seed
			return null;
		}

		// Calculate window boundary: take the last `turnsLimit` turns
		const prevTurnEndIdx = turnEndIndices[totalCompletedTurns - turnsLimit - 1];
		const windowStartIdx = prevTurnEndIdx + 1;
		const windowEndIdx = lastTurnEndIdx;

		const rawWindow = completedEvents.slice(windowStartIdx, windowEndIdx + 1);
		if (rawWindow.length === 0) {
			return null;
		}

		// Check if there was an earlier compaction summary before windowStartIdx
		let priorSummary = null;
		for (let i = windowStartIdx - 1; i >= 0; i--) {
			const ev = completedEvents[i];
			if (ev?.type === "compaction/summary" && ev.data?.summary) {
				priorSummary = {
					summary: ev.data.summary,
					time: ev.time,
					compactionId: ev.data.compactionId
				};
				break;
			}
		}

		const resultSeed = [];
		let nextSeq = 0;

		// A summary may be a string or native content blocks; never stringify blocks.
		if (priorSummary) {
			const content = typeof priorSummary.summary === "string"
				? [{ type: "text", text: priorSummary.summary }]
				: priorSummary.summary;
			if (!Array.isArray(content) || content.length === 0) return null;
			resultSeed.push({
				type: "user/message",
				seq: nextSeq++,
				time: priorSummary.time ?? Date.now(),
				data: {
					id: `summary-compaction-${priorSummary.compactionId || randomUUID().slice(0, 8)}`,
					role: "user",
					content: JSON.parse(JSON.stringify(content)),
					source: { kind: "plugin:dsh-subagent-role-router", form: "prior-compaction-summary" }
				},
				surfaceOp: "append"
			});
		}

		// Map old sequences to new contiguous sequences
		const oldSeqToNewSeq = new Map();
		for (let i = 0; i < rawWindow.length; i++) {
			oldSeqToNewSeq.set(rawWindow[i].seq, nextSeq + i);
		}

		// Transform and validate events for the sliced seed
		for (const ev of rawWindow) {
			if (!ev || typeof ev.type !== "string") {
				return null;
			}

			const cloned = JSON.parse(JSON.stringify(ev));
			const curSeq = nextSeq++;
			cloned.seq = curSeq;

			if (isSurfaceEligibleType(cloned.type)) {
				// Surface-eligible events MUST have surfaceOp
				if (!cloned.surfaceOp) {
					cloned.surfaceOp = "append";
				} else if (typeof cloned.surfaceOp === "object" && cloned.surfaceOp.op === "replace") {
					const newStart = oldSeqToNewSeq.get(cloned.surfaceOp.startSeq);
					const newEnd = oldSeqToNewSeq.get(cloned.surfaceOp.endSeq);
					if (newStart === undefined || newEnd === undefined) {
						// Replacement points outside the retained window; cannot be safely represented
						return null;
					}
					cloned.surfaceOp.startSeq = newStart;
					cloned.surfaceOp.endSeq = newEnd;
				}

				// Remap sourceEventSeqs if present
				if (Array.isArray(cloned.sourceEventSeqs)) {
					const mappedSources = cloned.sourceEventSeqs
						.map((s) => oldSeqToNewSeq.get(s))
						.filter((s) => s !== undefined && s < curSeq);

					if (mappedSources.length !== cloned.sourceEventSeqs.length) {
						// Source event sequences in replacement cannot be fully resolved
						return null;
					}

					if (mappedSources.length > 0) {
						cloned.sourceEventSeqs = mappedSources;
					} else {
						delete cloned.sourceEventSeqs;
					}
				}

				// Check message source invariants
				if (cloned.type === "user/message") {
					if (!cloned.data?.source?.kind) {
						cloned.data = cloned.data || {};
						cloned.data.source = { kind: "user" };
					}
				} else if (cloned.type === "developer/message") {
					if (cloned.data?.headerSeq !== undefined) {
						const newHeaderSeq = oldSeqToNewSeq.get(cloned.data.headerSeq);
						if (newHeaderSeq !== undefined) {
							cloned.data.headerSeq = newHeaderSeq;
						} else {
							return null;
						}
					}
				}
			} else {
				// Non-surface events must NOT carry surfaceOp or sourceEventSeqs
				delete cloned.surfaceOp;
				delete cloned.sourceEventSeqs;
			}

			resultSeed.push(cloned);
		}

		return resultSeed;
	} catch (err) {
		console.warn("[dsh-subagent-role-router:fork-window] Slicing error, safely returning null:", err?.message || err);
		return null;
	}
}