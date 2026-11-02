/**
 * A local implementation of the host's tool-definition contract.
 *
 * Why this exists: `defineTool` lives in `@deepseek-ai/dsh-tools`, which a
 * third-party plugin cannot always resolve at runtime (the host resolves host
 * packages for plugins that declare them as peers; a plugin that only ships
 * `lib/` does not get that resolution for a *dynamic* import). A failed import
 * used to mean "no tools", silently. This module compiles the same authoring
 * spec into the same registry-ready shape the `tools` service validates, so the
 * tools keep working with no host package import at all.
 *
 * The accepted authoring subset is the host's: `type`, `oneOf`, `properties`,
 * `required` (nested only, must be `true`), `additionalProperties`, `items`,
 * `enum`, `const`, plus the `description`/`title` annotations. `type: "json"`
 * is the author-only "any JSON value" node and compiles to an annotation-only
 * schema, exactly like the host does.
 */

const ANNOTATIONS = ["description", "title"];
const VALUE_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function authorError(path, message) {
	throw new Error(`tool schema: ${path} ${message}`);
}

function copyAnnotations(source, target, path) {
	for (const key of ANNOTATIONS) {
		if (!Object.hasOwn(source, key)) continue;
		if (typeof source[key] !== "string") authorError(`${path}.${key}`, "must be a string");
		target[key] = source[key];
	}
}

/** Compile one author value schema into the host's raw JSON Schema subset. */
export function compileValueSchema(spec, path = "schema", allowRequired = false) {
	if (spec === null || typeof spec !== "object" || Array.isArray(spec)) authorError(path, "must be a value schema object");
	const allowed = new Set(["type", "oneOf", "properties", "items", "enum", "const", "additionalProperties", ...ANNOTATIONS]);
	if (allowRequired) allowed.add("required");
	for (const key of Object.keys(spec)) {
		if (!allowed.has(key)) authorError(`${path}.${key}`, "is not a supported author key");
	}
	// The author-only "any JSON value" node: annotations only, no constraints.
	if (spec.type === "json") {
		const node = {};
		copyAnnotations(spec, node, path);
		return node;
	}
	const node = {};
	copyAnnotations(spec, node, path);
	if (Object.hasOwn(spec, "oneOf")) {
		if (Object.hasOwn(spec, "type")) authorError(path, "cannot declare both type and oneOf");
		if (!Array.isArray(spec.oneOf) || spec.oneOf.length < 2) authorError(`${path}.oneOf`, "must list at least two value schemas");
		node.oneOf = spec.oneOf.map((branch, index) => compileValueSchema(branch, `${path}.oneOf[${index}]`, false));
		return node;
	}
	if (typeof spec.type !== "string" || !VALUE_TYPES.has(spec.type)) {
		authorError(`${path}.type`, `must be one of ${[...VALUE_TYPES].join("/")} (or "json")`);
	}
	node.type = spec.type;
	if (Object.hasOwn(spec, "enum")) {
		if (!Array.isArray(spec.enum) || spec.enum.length === 0) authorError(`${path}.enum`, "must be a non-empty array");
		node.enum = spec.enum;
	}
	if (Object.hasOwn(spec, "const")) node.const = spec.const;
	if (spec.type === "object") {
		const properties = {};
		const required = [];
		const source = Object.hasOwn(spec, "properties") ? spec.properties : {};
		if (source === null || typeof source !== "object" || Array.isArray(source)) authorError(`${path}.properties`, "must be an object of value schemas");
		for (const [key, child] of Object.entries(source)) {
			if (child !== null && typeof child === "object" && Object.hasOwn(child, "required")) {
				if (child.required !== true) authorError(`${path}.properties.${key}.required`, "must be true when present");
				required.push(key);
			}
			properties[key] = compileValueSchema(child, `${path}.properties.${key}`, true);
		}
		node.properties = properties;
		if (required.length > 0) node.required = required;
		if (Object.hasOwn(spec, "additionalProperties")) {
			if (typeof spec.additionalProperties !== "boolean") authorError(`${path}.additionalProperties`, "must be a boolean");
			node.additionalProperties = spec.additionalProperties;
		}
	}
	if (spec.type === "array" && Object.hasOwn(spec, "items")) {
		node.items = compileValueSchema(spec.items, `${path}.items`, false);
	}
	return node;
}

/** Compile the implicit parameter object (a map of property name → schema). */
export function compileParameterSchema(spec) {
	if (spec === null || typeof spec !== "object" || Array.isArray(spec)) authorError("parameters", "must be an object of value schemas");
	const properties = {};
	const required = [];
	for (const [key, child] of Object.entries(spec)) {
		if (child !== null && typeof child === "object" && Object.hasOwn(child, "required")) {
			if (child.required !== true) authorError(`parameters.${key}.required`, "must be true when present");
			required.push(key);
		}
		properties[key] = compileValueSchema(child, `parameters.${key}`, true);
	}
	const schema = { type: "object", properties };
	if (required.length > 0) schema.required = required;
	return schema;
}

/**
 * Build the registry-ready definition the host `tools` service accepts.
 *
 * Mirrors the host's `defineTool`: arguments are compiled to JSON Schema,
 * `execute` is wrapped so a non-object argument payload is refused before the
 * handler runs, and the renderer is passed through untouched.
 *
 * @param {object} options - authoring definition.
 * @returns {object} definition for `tools.register`.
 */
export function defineRouterTool(options) {
	if (typeof options?.name !== "string" || options.name === "") throw new Error("tool schema: name is required");
	if (typeof options.execute !== "function") throw new Error(`tool schema: ${options.name} needs execute`);
	const output = options.output;
	if (output === undefined || typeof output !== "object" || typeof output.render !== "function") {
		throw new TypeError(`tool "${options.name}" must declare output { schema, render }`);
	}
	const parameters = compileParameterSchema(options.parameters ?? {});
	const schema = compileValueSchema(output.schema, "output.schema", false);
	const userExecute = options.execute;
	return {
		name: options.name,
		description: options.description,
		parameters,
		output: { schema, render: output.render },
		...(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? { timeoutMs: options.timeoutMs } : {}),
		async execute(args, exec) {
			if (args === null || typeof args !== "object" || Array.isArray(args)) {
				throw new Error("invalid arguments: expected an object");
			}
			return userExecute(args, exec);
		}
	};
}
