import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// The subagent model menu used to render the WHOLE host catalog: other
// accounts, providers this page never allows, models no pool mentions. A click
// on such a row is either refused by the router or silently rerouted to a pool
// entry, which reads as "I picked GLM and got Gemini".
//
// The menu now renders the page whitelist joined onto the catalog. What is
// pinned here is the JOIN, not the markup:
//
//   1. Only whitelisted (provider, model) pairs survive, catalog order kept.
//   2. Catalog labels win when the catalog knows the route.
//   3. A whitelisted route the catalog cannot label is STILL offered (the
//      router, not the catalog, decides what a child may run).
//   4. The current route stays visible even when the page no longer allows it,
//      so the menu never looks like it lost the selection.
const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

function loadClient() {
  let capturedModule = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(module) {
          capturedModule = module;
        }
      }
    },
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, setAttribute() {} }),
      head: { appendChild() {} }
    },
    console
  };
  vm.runInNewContext(clientSource, sandbox, { filename: "client.js" });
  if (!capturedModule || typeof capturedModule.factory !== "function") {
    throw new Error("client.js failed to register with __ModuleLoader__");
  }
  const fakeRequire = (id) => {
    if (id === "react") {
      return {
        useState: (init) => [init, () => {}],
        useMemo: (fn) => fn(),
        useRef: (init) => ({ current: init }),
        useEffect: () => {},
        createElement: () => ({})
      };
    }
    if (id === "@deepseek-ai/dsh-client-ui-primitives") {
      return { Toast: function Toast() {} };
    }
    return {};
  };
  return capturedModule.factory(fakeRequire);
}

// Values built inside the vm carry that realm's prototypes, which
// `deepStrictEqual` rejects even when every field matches. Copying through JSON
// compares the DATA, which is what these helpers promise.
const plain = (value) => JSON.parse(JSON.stringify(value));

const client = loadClient();

const catalog = [
  { id: "deepseek", name: "DeepSeek", models: [{ id: "DeepSeek-V4-Pro", name: "DeepSeek V4 Pro" }, { id: "DeepSeek-V4-Flash", name: "DeepSeek V4 Flash" }] },
  { id: "magpie", name: "Magpie", models: [{ id: "group/dnq", name: "dnq · routing group" }, { id: "group/1017", name: "1017 · routing group" }] },
  { id: "magpie-anthropic", name: "DeepSeek Account", models: [{ id: "zcode/GLM-5.3-Flash", name: "GLM 5.3 Flash" }] }
];

test("normalizeWhitelistRoutes trims, dedupes case-insensitively and drops junk", () => {
  const routes = client.normalizeWhitelistRoutes([
    { provider: " magpie ", model: " group/dnq " },
    { provider: "MAGPIE", model: "GROUP/DNQ" },
    { provider: "magpie", model: "" },
    { provider: 7, model: "x" },
    null,
    { provider: "deepseek", model: "DeepSeek-V4-Pro" }
  ]);
  assert.deepEqual(plain(routes), [
    { provider: "magpie", model: "group/dnq" },
    { provider: "deepseek", model: "DeepSeek-V4-Pro" }
  ]);
});

test("catalogForWhitelist keeps only whitelisted rows, in catalog order", () => {
  const allowed = client.normalizeWhitelistRoutes([
    { provider: "magpie-anthropic", model: "zcode/GLM-5.3-Flash" },
    { provider: "magpie", model: "group/dnq" }
  ]);
  const menu = plain(client.catalogForWhitelist(catalog, allowed));
  assert.deepEqual(menu.map((g) => g.id), ["magpie", "magpie-anthropic"]);
  assert.deepEqual(menu[0].models.map((m) => m.id), ["group/dnq"]);
  // Catalog labels survive the join.
  assert.equal(menu[0].models[0].name, "dnq · routing group");
  assert.equal(menu[1].name, "DeepSeek Account");
});

test("a whitelisted route the catalog cannot label is still offered", () => {
  const allowed = client.normalizeWhitelistRoutes([
    { provider: "magpie", model: "group/brand-new" },
    { provider: "elsewhere", model: "some/model" }
  ]);
  const menu = plain(client.catalogForWhitelist(catalog, allowed));
  const magpie = menu.find((g) => g.id === "magpie");
  assert.deepEqual(magpie.models.map((m) => m.id), ["group/brand-new"]);
  const elsewhere = menu.find((g) => g.id === "elsewhere");
  assert.deepEqual(elsewhere.models.map((m) => m.id), ["some/model"]);
  // Nothing from the untouched groups leaks through.
  assert.equal(menu.some((g) => g.id === "deepseek"), false);
});

test("a pair the catalog claims twice appears once", () => {
  const duped = catalog.concat([{ id: "magpie", name: "Magpie", models: [{ id: "group/dnq", name: "dnq again" }] }]);
  const allowed = client.normalizeWhitelistRoutes([{ provider: "magpie", model: "group/dnq" }]);
  const menu = plain(client.catalogForWhitelist(duped, allowed));
  const ids = menu.flatMap((g) => g.models.map((m) => m.id));
  assert.deepEqual(ids, ["group/dnq"]);
});

test("ensureCatalogRoute keeps the running model visible when it is off-list", () => {
  const allowed = client.normalizeWhitelistRoutes([{ provider: "magpie", model: "group/dnq" }]);
  const narrowed = client.catalogForWhitelist(catalog, allowed);
  const withCurrent = plain(client.ensureCatalogRoute(narrowed, "deepseek", "DeepSeek-V4-Pro"));
  const deepseek = withCurrent.find((g) => g.id === "deepseek");
  assert.deepEqual(deepseek.models.map((m) => m.id), ["DeepSeek-V4-Pro"]);
  // Already present: the very same list comes back (no churn, no duplicate).
  const again = client.ensureCatalogRoute(narrowed, "magpie", "group/dnq");
  assert.equal(again, narrowed);
});
