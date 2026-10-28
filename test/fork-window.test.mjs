import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildWindowSlicedSeed, isSurfaceEligibleType } from "../lib/fork-window.js";

/**
 * Resolve a real `@deepseek-ai/dsh-session` module.
 *
 * The session package ships INSIDE `app.asar`, and plain Node cannot `require`
 * a path inside an asar archive — only Electron's patched loader can. Depending
 * on the install, it is therefore reachable from a few very different places:
 *
 *   1. a profile `node_modules` (when the host hoists packages there),
 *   2. a vendored closure extracted from the asar (`_vendor/...` in the
 *      workspace) — how this suite runs offline,
 *   3. the asar path itself, which works only under Electron.
 *
 * Every candidate is tried in order. If none loads, the caller SKIPS the file
 * instead of failing it: an environment that cannot supply the module says
 * nothing about the slicing logic, and a red suite for a missing optional
 * fixture trains people to ignore the suite.
 */
const require = createRequire(import.meta.url);
const SESSION_CANDIDATES = [
  // Explicit override for a checkout that vendors the closure elsewhere.
  process.env.DSH_SESSION_MODULE,
  // A normal install (profile node_modules, or the package installed as a dep).
  "@deepseek-ai/dsh-session",
  // Vendored closure extracted from app.asar — how this suite runs offline.
  // Built by `_diag/vendor-asar-closure.cjs` in the dev workspace, which walks
  // the asar import graph and hoists the whole closure into `node_modules/`.
  "C:/Users/A6430/Documents/deepseek-harness/default-workspace/_vendor/dsh-session-closure/node_modules/@deepseek-ai/dsh-session",
  "C:/Users/A6430/AppData/Local/Programs/DeepSeek Harness/resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-session",
  "C:/Users/A6430/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-session"
].filter((candidate) => typeof candidate === "string" && candidate.length > 0);

let Session = null;
for (const candidate of SESSION_CANDIDATES) {
  try {
    const loaded = require(candidate);
    if (typeof loaded?.Session?.create === "function") { Session = loaded.Session; break; }
  } catch { /* try the next candidate */ }
}

if (Session === null) {
  test("fork-window slicing: SKIPPED, no loadable @deepseek-ai/dsh-session", (t) => {
    t.skip("dsh-session is inside app.asar and not resolvable from plain Node; vendor it or run under Electron");
  });
} else {

function createMultiTurnSession() {
	const s = Session.create("s-parent-test");

	// Turn 0
	s.append("turn/start", { turn: 0 });
	s.append("user/message", { id: "u0", role: "user", content: [{ type: "text", text: "turn 0 prompt" }], source: { kind: "user" } }, { surfaceOp: "append" });
	s.append("step/start", { turn: 0, step: 0 });
	s.append("assistant/message", {
		turn: 0, step: 0, stream: [],
		message: { id: "a0", role: "assistant", source: { kind: "model", provider: "p0", model: "m0" }, content: [{ type: "text", text: "turn 0 answer" }] }
	}, { surfaceOp: "append" });
	s.append("step/end", { turn: 0, step: 0 });
	s.append("turn/end", { turn: 0, reason: { kind: "completed" } });

	// Turn 1: with tool call and result
	s.append("turn/start", { turn: 1 });
	s.append("user/message", { id: "u1", role: "user", content: [{ type: "text", text: "turn 1 prompt" }], source: { kind: "user" } }, { surfaceOp: "append" });
	s.append("step/start", { turn: 1, step: 0 });
	s.append("assistant/message", {
		turn: 1, step: 0, stream: [],
		message: {
			id: "a1_0", role: "assistant", source: { kind: "model", provider: "p1", model: "m1" },
			content: [
				{ type: "text", text: "calling tool" },
				{ type: "tool-call", id: "call_1", name: "calculator", arguments: "{}" }
			]
		}
	}, { surfaceOp: "append" });
	s.append("tool/call", { callId: "call_1", name: "calculator", input: { a: 1 } });
	s.append("tool/result", {
		turn: 1, step: 0,
		message: {
			id: "t1", role: "tool", toolCallId: "call_1",
			source: { kind: "tool", callId: "call_1" },
			content: [{ type: "text", text: "calculation output: 42" }]
		}
	}, { surfaceOp: "append" });
	s.append("step/end", { turn: 1, step: 0 });
	s.append("step/start", { turn: 1, step: 1 });
	s.append("assistant/message", {
		turn: 1, step: 1, stream: [],
		message: { id: "a1_1", role: "assistant", source: { kind: "model", provider: "p1", model: "m1" }, content: [{ type: "text", text: "tool result processed" }] }
	}, { surfaceOp: "append" });
	s.append("step/end", { turn: 1, step: 1 });
	s.append("turn/end", { turn: 1, reason: { kind: "completed" } });

	// Turn 2
	s.append("turn/start", { turn: 2 });
	s.append("user/message", { id: "u2", role: "user", content: [{ type: "text", text: "turn 2 prompt" }], source: { kind: "user" } }, { surfaceOp: "append" });
	s.append("step/start", { turn: 2, step: 0 });
	s.append("assistant/message", {
		turn: 2, step: 0, stream: [],
		message: { id: "a2", role: "assistant", source: { kind: "model", provider: "p2", model: "m2" }, content: [{ type: "text", text: "turn 2 answer" }] }
	}, { surfaceOp: "append" });
	s.append("step/end", { turn: 2, step: 0 });
	s.append("turn/end", { turn: 2, reason: { kind: "completed" } });

	// Turn 3
	s.append("turn/start", { turn: 3 });
	s.append("user/message", { id: "u3", role: "user", content: [{ type: "text", text: "turn 3 prompt" }], source: { kind: "user" } }, { surfaceOp: "append" });
	s.append("step/start", { turn: 3, step: 0 });
	s.append("assistant/message", {
		turn: 3, step: 0, stream: [],
		message: { id: "a3", role: "assistant", source: { kind: "model", provider: "p3", model: "m3" }, content: [{ type: "text", text: "turn 3 answer" }] }
	}, { surfaceOp: "append" });
	s.append("step/end", { turn: 3, step: 0 });
	s.append("turn/end", { turn: 3, reason: { kind: "completed" } });

	// Turn 4: in-flight (uncompleted, NO turn/end)
	s.append("turn/start", { turn: 4 });
	s.append("user/message", { id: "u4_inflight", role: "user", content: [{ type: "text", text: "turn 4 in flight" }], source: { kind: "user" } }, { surfaceOp: "append" });
	s.append("step/start", { turn: 4, step: 0 });
	s.append("assistant/message", {
		turn: 4, step: 0, stream: [],
		message: { id: "a4_inflight", role: "assistant", source: { kind: "model", provider: "p4", model: "m4" }, content: [{ type: "text", text: "running fork" }] }
	}, { surfaceOp: "append" });

	return s;
}

test("buildWindowSlicedSeed retains last 2 completed turns with tool calls and outputs intact", () => {
	const parentSession = createMultiTurnSession();
	const initialParentEventCount = parentSession.snapshotEvents().length;

	const sliced = buildWindowSlicedSeed({ session: parentSession }, 2);
	assert.ok(Array.isArray(sliced), "sliced seed must be an array");

	// Invariant: parent session is not mutated
	assert.equal(parentSession.snapshotEvents().length, initialParentEventCount);

	// Invariant: continuous seq starting from 0
	for (let i = 0; i < sliced.length; i++) {
		assert.equal(sliced[i].seq, i, `seq at index ${i} must be contiguous starting from 0`);
	}

	// Invariant: surfaceOp validity
	for (const ev of sliced) {
		if (isSurfaceEligibleType(ev.type)) {
			assert.ok(ev.surfaceOp, `surface eligible event ${ev.type} must have surfaceOp`);
		} else {
			assert.equal(ev.surfaceOp, undefined, `non-surface event ${ev.type} must NOT have surfaceOp`);
			assert.equal(ev.sourceEventSeqs, undefined, `non-surface event ${ev.type} must NOT have sourceEventSeqs`);
		}
	}

	// Instantiate real Session with the sliced seed
	const child = Session.create("child-window-2", sliced, { version: 4, id: "child-window-2", createdAt: Date.now(), isSeeded: true }, sliced.length);
	const msgs = child.deriveMessages();

	// Turns 2 and 3 should be retained
	const msgIds = msgs.map((m) => m.id);
	assert.deepEqual(msgIds, ["u2", "a2", "u3", "a3"]);

	// No in-flight messages leaked
	assert.ok(!msgIds.includes("u4_inflight"));
	assert.ok(!msgIds.includes("a4_inflight"));

	// Message source preserved
	assert.equal(msgs[1].source.provider, "p2");
	assert.equal(msgs[3].source.provider, "p3");
});

test("buildWindowSlicedSeed retains last 3 completed turns including tool messages and tool calls", () => {
	const parentSession = createMultiTurnSession();

	const sliced = buildWindowSlicedSeed({ session: parentSession }, 3);
	assert.ok(Array.isArray(sliced));

	const child = Session.create("child-window-3", sliced, { version: 4, id: "child-window-3", createdAt: Date.now(), isSeeded: true }, sliced.length);
	const msgs = child.deriveMessages();

	const msgIds = msgs.map((m) => m.id);
	assert.deepEqual(msgIds, ["u1", "a1_0", "t1", "a1_1", "u2", "a2", "u3", "a3"]);

	// Tool output preserved
	const toolMsg = msgs.find((m) => m.id === "t1");
	assert.ok(toolMsg);
	assert.equal(toolMsg.role, "tool");
	assert.equal(toolMsg.toolCallId, "call_1");
	assert.equal(toolMsg.content[0].text, "calculation output: 42");
	assert.equal(toolMsg.source.kind, "tool");

	// Tool call inside assistant message preserved
	const assistantWithCall = msgs.find((m) => m.id === "a1_0");
	assert.ok(assistantWithCall.content.some((b) => b.type === "tool-call" && b.id === "call_1"));
});

test("buildWindowSlicedSeed returns null when completed turns <= maxTurns", () => {
	const parentSession = createMultiTurnSession();

	// Parent has 4 completed turns. maxTurns = 4 -> no slicing needed
	const res4 = buildWindowSlicedSeed({ session: parentSession }, 4);
	assert.equal(res4, null);

	// maxTurns = 10 -> no slicing needed
	const res10 = buildWindowSlicedSeed({ session: parentSession }, 10);
	assert.equal(res10, null);
});

test("buildWindowSlicedSeed preserves prior compaction summary when slicing across it", () => {
	const s = Session.create("s-compaction-test");
	// Turn 0
	s.append("turn/start", { turn: 0 });
	s.append("user/message", { id: "u0", role: "user", content: [{ type: "text", text: "turn 0" }], source: { kind: "user" } }, { surfaceOp: "append" });
	s.append("step/start", { turn: 0, step: 0 });
	s.append("assistant/message", { turn: 0, step: 0, stream: [], message: { id: "a0", role: "assistant", source: { kind: "model", provider: "p0", model: "m0" }, content: [{ type: "text", text: "reply 0" }] } }, { surfaceOp: "append" });
	s.append("step/end", { turn: 0, step: 0 });
	s.append("turn/end", { turn: 0, reason: { kind: "completed" } });

	// Turn 1 with compaction
	s.append("turn/start", { turn: 1 });
	s.append("compaction/summary", { compactionId: "c1", summary: "Prior work on feature Alpha" });
	s.append("step/start", { turn: 1, step: 0 });
	s.append("assistant/message", { turn: 1, step: 0, stream: [], message: { id: "a1", role: "assistant", source: { kind: "model", provider: "p1", model: "m1" }, content: [{ type: "text", text: "reply 1" }] } }, { surfaceOp: "append" });
	s.append("step/end", { turn: 1, step: 0 });
	s.append("turn/end", { turn: 1, reason: { kind: "completed" } });

	// Turn 2
	s.append("turn/start", { turn: 2 });
	s.append("user/message", { id: "u2", role: "user", content: [{ type: "text", text: "turn 2" }], source: { kind: "user" } }, { surfaceOp: "append" });
	s.append("step/start", { turn: 2, step: 0 });
	s.append("assistant/message", { turn: 2, step: 0, stream: [], message: { id: "a2", role: "assistant", source: { kind: "model", provider: "p2", model: "m2" }, content: [{ type: "text", text: "reply 2" }] } }, { surfaceOp: "append" });
	s.append("step/end", { turn: 2, step: 0 });
	s.append("turn/end", { turn: 2, reason: { kind: "completed" } });

	// Turn 3
	s.append("turn/start", { turn: 3 });
	s.append("user/message", { id: "u3", role: "user", content: [{ type: "text", text: "turn 3" }], source: { kind: "user" } }, { surfaceOp: "append" });
	s.append("step/start", { turn: 3, step: 0 });
	s.append("assistant/message", { turn: 3, step: 0, stream: [], message: { id: "a3", role: "assistant", source: { kind: "model", provider: "p3", model: "m3" }, content: [{ type: "text", text: "reply 3" }] } }, { surfaceOp: "append" });
	s.append("step/end", { turn: 3, step: 0 });
	s.append("turn/end", { turn: 3, reason: { kind: "completed" } });

	// Slice to last 2 turns (Turns 2 and 3), preserving compaction summary from Turn 1
	const sliced = buildWindowSlicedSeed({ session: s }, 2);
	assert.ok(sliced);

	const child = Session.create("child-compaction", sliced, { version: 4, id: "child-compaction", createdAt: Date.now(), isSeeded: true }, sliced.length);
	const msgs = child.deriveMessages();

	assert.equal(msgs.length, 5); // 1 summary message + 4 turn messages
	assert.ok(msgs[0].content[0].text.includes("Prior work on feature Alpha"));
	assert.equal(msgs[0].source.kind, "plugin:dsh-subagent-role-router");
});

test("buildWindowSlicedSeed accepts completedSeed directly", () => {
	const parentSession = createMultiTurnSession();
	const allEvents = parentSession.snapshotEvents();
	const completedOnly = allEvents.slice(0, allEvents.findLastIndex((e) => e.type === "turn/end") + 1);

	const sliced = buildWindowSlicedSeed(null, 2, completedOnly);
	assert.ok(Array.isArray(sliced));
	assert.equal(sliced[0].seq, 0);
});

test("buildWindowSlicedSeed returns null safely when no completed turns exist or input is invalid", () => {
	assert.equal(buildWindowSlicedSeed(null, 2, null), null);
	assert.equal(buildWindowSlicedSeed({}, 2), null);
	assert.equal(buildWindowSlicedSeed({ session: { snapshotEvents: () => [] } }, 2), null);
	assert.equal(buildWindowSlicedSeed(null, 2, [{ type: "user/message" }]), null); // no turn/end
});

test("summary content blocks are preserved without string coercion", () => {
	const content = [{ type: "text", text: "Native summary blocks" }];
	const events = [
		{type:"compaction/summary",seq:0,time:1,data:{summary:content}},
		{type:"turn/end",seq:1,time:1,data:{turn:0,reason:{kind:"completed"}}},
		{type:"user/message",seq:2,time:1,data:{id:"latest",role:"user",content:[{type:"text",text:"latest turn"}],source:{kind:"user"}},surfaceOp:"append"},
		{type:"turn/end",seq:3,time:1,data:{turn:1,reason:{kind:"completed"}}}
	];
	const sliced = buildWindowSlicedSeed(null, 1, events);
	assert.deepEqual(sliced[0].data.content, content);
	const child = Session.create("blocks-child", sliced, {version:4,id:"blocks-child",createdAt:1,isSeeded:true}, sliced.length);
	assert.equal(child.deriveMessages()[0].content[0].text, "Native summary blocks");
	assert.notEqual(sliced[0].data.content, content);
});

test("cross-window header, replacement and source references safely fall back", () => {
	const firstEnd = {type:"turn/end",seq:1,time:1,data:{turn:0,reason:{kind:"completed"}}};
	const finalEnd = {type:"turn/end",seq:3,time:1,data:{turn:1,reason:{kind:"completed"}}};
	for (const event of [
		{type:"developer/message",seq:2,data:{headerSeq:0},surfaceOp:"append"},
		{type:"user/message",seq:2,data:{},surfaceOp:{op:"replace",startSeq:0,endSeq:0},sourceEventSeqs:[0]},
		{type:"user/message",seq:2,data:{},surfaceOp:"append",sourceEventSeqs:[0]}
	]) {
		const events = [{type:"request/header",seq:0,time:1,data:{}},firstEnd,event,finalEnd];
		const before = JSON.stringify(events);
		assert.equal(buildWindowSlicedSeed(null,1,events),null);
		assert.equal(JSON.stringify(events),before);
	}
});}