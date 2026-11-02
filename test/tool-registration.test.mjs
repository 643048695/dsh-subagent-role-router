/**
 * The registration path: buildRouterTool (local schema compiler) must produce
 * definitions the host `tools` service accepts, installRouterTools must only
 * claim "installed" after the registry accepted both tools, and a refusing
 * registry must surface its error instead of a green flag.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { compileValueSchema, compileParameterSchema, defineRouterTool } from "../lib/tool-schema.js";
import { installRouterTools } from "../lib/router-tools.js";

test("the local compiler emits the host subset (required lifted to arrays, json as annotation-only)", () => {
	const schema = compileValueSchema({
		type: "object",
		properties: {
			name: { type: "string", required: true },
			effort: { type: "json", description: "any value or null" },
			items: { type: "array", items: { type: "object", properties: { id: { type: "string", required: true } } } }
		}
	});
	assert.equal(schema.type, "object");
	assert.deepEqual(schema.required, ["name"]);
	assert.deepEqual(schema.properties.effort, { description: "any value or null" });
	assert.deepEqual(schema.properties.items.items.required, ["id"]);
});

test("the compiler rejects author keys the host subset does not accept", () => {
	assert.throws(() => compileValueSchema({ type: "string", pattern: "^x" }), /pattern/);
	assert.throws(() => compileValueSchema({ type: "string", required: "yes" }), /required/);
	assert.throws(() => compileParameterSchema({ a: { type: "string", required: false } }), /required/);
	assert.throws(() => compileValueSchema({ type: "object", oneOf: [] }), /oneOf/);
});

test("defineRouterTool wraps execute with an object-args guard", async () => {
	const seen = [];
	const tool = defineRouterTool({
		name: "probe",
		description: "probe",
		parameters: {},
		output: { schema: { type: "object", properties: {} }, render: () => [{ type: "text", text: "ok" }] },
		execute: async (args) => { seen.push(args); return { ok: true }; }
	});
	assert.equal(typeof tool.output.render, "function");
	await tool.execute({ a: 1 }, {});
	await assert.rejects(tool.execute([1, 2], {}), /expected an object/);
	await assert.rejects(tool.execute(null, {}), /expected an object/);
	assert.equal(seen.length, 1);
});

test("installRouterTools claims installed only after the registry accepted both tools", async () => {
	const registered = [];
	const services = {
		subagents: { listChildren: async () => [] },
		agents: new Map(),
		llm: { listModels: async () => [], resolveModelInfo: async () => ({ reasoning: { efforts: [] } }) },
		tools: { register: (definition) => registered.push(definition.name) }
	};
	const ctx = { get: (name) => services[name], inject: (names, callback) => callback({ tools: services.tools }), logger: { warn: () => {} } };
	const state = { getSection: () => ({ models: [] }), childRoutes: new Map(), routeRevisions: new Map(), routeEpoch: "e", modelCaps: null };
	await installRouterTools(ctx, state);
	assert.deepEqual(registered.sort(), ["subagent_routes_inspect", "subagent_routes_update"]);
	assert.equal(state.routerToolsInstalled, true);
	assert.deepEqual(state.routerToolsRegistered, ["subagent_routes_inspect", "subagent_routes_update"]);
});

test("a registry that refuses the tools surfaces the error instead of a green flag", async () => {
	const services = {
		subagents: { listChildren: async () => [] },
		agents: new Map(),
		llm: { listModels: async () => [], resolveModelInfo: async () => ({ reasoning: { efforts: [] } }) },
		tools: { register: () => { throw new TypeError('tool "subagent_routes_inspect" must declare output { schema, render, presentationMeta? }'); } }
	};
	const warnings = [];
	const ctx = { get: (name) => services[name], inject: (names, callback) => callback({ tools: services.tools }), logger: { warn: (m) => warnings.push(m) } };
	const state = { getSection: () => ({ models: [] }), childRoutes: new Map(), routeRevisions: new Map(), routeEpoch: "e", modelCaps: null };
	await installRouterTools(ctx, state);
	assert.equal(state.routerToolsInstalled, false);
	assert.match(String(state.routerToolsError), /must declare output/);
	// Both definitions are refused, so both are reported — silence would hide a
	// registry mismatch behind an "installed" flag.
	assert.equal(warnings.length, 2);
});

test("a context without a tools service builds nothing and stays silent-but-false", async () => {
	const ctx = { get: () => undefined, inject: (names, callback) => undefined, logger: { warn: () => {} } };
	const state = { getSection: () => ({ models: [] }), childRoutes: new Map(), routeRevisions: new Map(), routeEpoch: "e", modelCaps: null };
	await installRouterTools(ctx, state);
	// Built (so a later mount can register) but never claimed as installed: the
	// inject callback simply never runs on a host without the registry.
	assert.equal(state.routerToolsBuilt, true);
	assert.notEqual(state.routerToolsInstalled, true);
});
