import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Six critter characters share one canvas, one palette rule and one motion
// budget. What can be decided without a browser is pinned here: the species
// pick (seeded by childId, biased away from the ones on screen), the shape
// contract every character must satisfy, and the CSS that is actually built —
// including the promise that every animation it declares is also switched off
// under prefers-reduced-motion.
const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const KINDS = ["maker", "octo", "weld", "hamster", "owl", "courier"];

/** Load the client module; returns { client, css } with the injected stylesheet. */
function loadClient() {
  let capturedModule = null;
  let capturedCss = "";
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
      createElement: () => ({ dataset: {}, setAttribute() {}, textContent: "" }),
      head: {
        appendChild(el) {
          if (el && typeof el.textContent === "string") capturedCss += el.textContent;
        }
      }
    },
    console
  };
  vm.runInNewContext(clientSource, sandbox, { filename: "client.js" });
  if (!capturedModule || typeof capturedModule.factory !== "function") {
    throw new Error("client.js failed to register with __ModuleLoader__");
  }
  // Minimal React: record every element so rendered shapes can be asserted.
  const fakeReact = {
    createElement(type, props, ...children) {
      const flat = [];
      const push = (list) => {
        for (const item of list) {
          if (Array.isArray(item)) push(item);
          else if (item !== null && item !== undefined && item !== false) flat.push(item);
        }
      };
      push(children);
      return { type, props: props || {}, children: flat };
    },
    useState: (init) => [init, () => {}],
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
    useEffect: (fn) => {
      const cleanup = fn();
      return typeof cleanup === "function" ? cleanup : () => {};
    }
  };
  const fakeRequire = (id) => {
    if (id === "react") return fakeReact;
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return { Toast: function Toast() {} };
    return {};
  };
  return { client: capturedModule.factory(fakeRequire), css: capturedCss };
}

function rectsOf(element) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "rect") found.push(node.props);
    for (const child of node.children || []) walk(child);
  };
  walk(element);
  return found;
}

function classNamesOf(element) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.props.className === "string") {
      for (const cls of node.props.className.split(/\s+/)) if (cls) found.push(cls);
    }
    for (const child of node.children || []) walk(child);
  };
  walk(element);
  return found;
}

/** Every `animation:` shorthand the generated CSS declares, as class names. */
function animatedClasses(css) {
  const out = [];
  const re = /\.(dsm-critter-[a-z]+-[a-z0-9]+)\{animation:([^}]+)\}/g;
  let hit;
  while ((hit = re.exec(css)) !== null) {
    // The reduced-motion block also uses this shorthand; it switches motion off.
    if (hit[2].trim() === "none!important") continue;
    out.push({ cls: hit[1], value: hit[2] });
  }
  return out;
}

test("pickCritterKind is deterministic per childId and lands inside the six kinds", () => {
  const { client } = loadClient();
  for (const id of ["session-a", "session-b", "child-123", "abc"]) {
    const first = client.pickCritterKind(id, []);
    assert.ok(KINDS.includes(first), `${first} should be one of the six kinds`);
    assert.equal(client.pickCritterKind(id, []), first);
    assert.equal(client.pickCritterKind(id, ["octo", "weld"]), client.pickCritterKind(id, ["octo", "weld"]));
  }
});

test("pickCritterKind avoids taken kinds while free options remain", () => {
  const { client } = loadClient();
  const taken = ["octo", "weld", "hamster", "owl", "courier"];
  assert.equal(client.pickCritterKind("session-a", taken), "maker");
  assert.equal(client.pickCritterKind("session-b", taken), "maker");
  // Only "maker" is spoken for, so the pick must come from the other five.
  assert.ok(!["maker"].includes(client.pickCritterKind("anything", ["maker"])));
});

test("pickCritterKind falls back to the full pool when every kind is taken", () => {
  const { client } = loadClient();
  const picked = client.pickCritterKind("session-a", KINDS);
  assert.ok(KINDS.includes(picked));
  assert.equal(client.pickCritterKind("session-a", KINDS), picked);
});

test("six distinct childIds can occupy six stations without overlap", () => {
  const { client } = loadClient();
  const taken = [];
  const picks = ["s1", "s2", "s3", "s4", "s5", "s6"].map((id) => {
    const kind = client.pickCritterKind(id, taken);
    taken.push(kind);
    return kind;
  });
  assert.equal(new Set(picks).size, 6);
});

test("every character draws on the shared 32x24 canvas with only its own classes", () => {
  const { client } = loadClient();
  for (const kind of KINDS) {
    const svg = client.critterArt("in", kind);
    assert.equal(svg.type, "svg");
    assert.equal(svg.props.viewBox, "0 0 32 24");
    assert.equal(svg.props.width, 32);
    assert.equal(svg.props.height, 24);
    assert.equal(svg.props["aria-hidden"], "true");
    assert.ok(svg.props.className.includes("dsm-critters-art-" + kind), `${kind} keeps its own art class`);

    const rects = rectsOf(svg);
    assert.ok(rects.length >= 8, `${kind} should have enough parts, got ${rects.length}`);
    for (const rect of rects) {
      assert.ok(Number.isInteger(rect.x) && Number.isInteger(rect.y), `${kind} parts sit on whole pixels`);
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 32 && rect.y + rect.height <= 24,
        `${kind} part ${rect.className} escapes the canvas`);
    }
    // One character, one namespace: no borrowing another species' class.
    for (const cls of classNamesOf(svg)) {
      if (cls.startsWith("dsm-critters-art")) continue;
      assert.ok(cls.startsWith("dsm-critter-" + kind + "-"), `${kind} leaked ${cls}`);
    }
    assert.ok(classNamesOf(svg).includes("dsm-critter-" + kind + "-body"), `${kind} must paint a body part`);
    // The face is the family signature: ink eyes everywhere except the welder,
    // whose lit goggle lenses read as eyes.
    const face = classNamesOf(svg).filter((cls) => cls.endsWith("-eye") || cls.endsWith("-lens"));
    assert.ok(face.length > 0, `${kind} must have a face (eye or lens)`);
  }
});

test("the rig moves and the ground furniture stays bolted down", () => {
  const { client } = loadClient();
  for (const kind of KINDS) {
    const svg = client.critterArt("in", kind);
    const groups = svg.children.filter((child) => child && child.type === "g");
    const rig = groups.filter((g) => g.props.className === `dsm-critter-${kind}-rig`);
    const ground = groups.filter((g) => g.props.className === `dsm-critter-${kind}-ground`);
    assert.equal(rig.length, 1, `${kind} draws exactly one rig group`);
    assert.ok(ground.length <= 1, `${kind} draws at most one ground group`);
    assert.equal(groups.length, rig.length + ground.length, "no unnamed layer");
    assert.ok(rig[0].children.length > 0, `${kind} must paint inside its rig`);
    if (ground.length) {
      assert.equal(groups[0].props.className, `dsm-critter-${kind}-ground`, "ground paints behind the rig");
    }

    const spinning = groups.flatMap((g) =>
      g.children.filter((child) => child && child.type === "g" && String(child.props.className).includes("-spin"))
    );
    if (kind === "hamster") {
      assert.equal(spinning.length, 1, "the hamster spins its wheel");
      assert.ok(spinning[0].props.className.includes("dsm-critter-hamster-spin"));
      assert.ok(spinning[0].children.length >= 2, "the wheel needs spokes to spin");
      assert.ok(ground[0].children.includes(spinning[0]), "the spinning wheel belongs to the fixed ground");
    } else {
      assert.equal(spinning.length, 0, `${kind} must not rotate a group`);
    }
  }

  // A hopping character must not drag its desk into the air.
  const maker = client.critterArt("in", "maker");
  const makerGroups = maker.children.filter((c) => c && c.type === "g");
  const classesIn = (g) => g.children.map((c) => String(c.props.className));
  const makerRig = makerGroups.find((g) => g.props.className === "dsm-critter-maker-rig");
  const makerGround = makerGroups.find((g) => g.props.className === "dsm-critter-maker-ground");
  assert.ok(classesIn(makerGround).includes("dsm-critter-maker-board"), "the keyboard is furniture");
  assert.ok(!classesIn(makerRig).includes("dsm-critter-maker-board"), "the keyboard must not ride the rig");
  assert.ok(classesIn(makerRig).includes("dsm-critter-maker-arm"), "the arms ride the rig");
});

test("unknown or missing kind falls back to the original maker", () => {
  const { client } = loadClient();
  for (const bogus of [undefined, null, "", "dragon"]) {
    const svg = client.critterArt("in", bogus);
    assert.ok(svg.props.className.includes("dsm-critters-art-maker"));
    assert.ok(classNamesOf(svg).includes("dsm-critter-maker-body"));
  }
});

test("leaving phase keeps the stretch hook and still paints the character", () => {
  const { client } = loadClient();
  const svg = client.critterArt("out", "octo");
  assert.ok(svg.props.className.includes("is-leaving"));
  assert.ok(classNamesOf(svg).includes("dsm-critter-octo-body"));
  assert.ok(!svg.props.className.includes("is-pop"));
});

test("the built CSS paints every character and moves only with steps()", () => {
  const { css } = loadClient();
  for (const kind of KINDS) {
    assert.ok(css.includes(".dsm-critter-" + kind + "-body{fill:#"), `${kind} body colour missing`);
    // Ink eyes for five, lit goggle lenses for the welder.
    assert.ok(
      css.includes(".dsm-critter-" + kind + "-eye{fill:#26211d}")
        || css.includes(".dsm-critter-" + kind + "-lens{fill:#ffe9a3}"),
      `${kind} face colour missing`
    );
  }
  const animated = animatedClasses(css);
  assert.ok(animated.length >= 20, `expected a full motion set, got ${animated.length}`);
  for (const { cls, value } of animated) {
    assert.ok(value.includes("steps("), `${cls} must animate in steps, not smoothly: ${value}`);
    assert.ok(!value.includes("cubic-bezier") && !value.includes("ease"), `${cls} must not ease: ${value}`);
  }
});

test("reduced-motion freezes every animation the CSS declares", () => {
  const { css } = loadClient();
  const marker = "@media (prefers-reduced-motion: reduce){";
  const at = css.indexOf(marker);
  assert.ok(at >= 0, "a reduced-motion block must exist");
  const block = css.slice(at);
  assert.ok(block.includes("animation:none!important"));
  for (const { cls } of animatedClasses(css)) {
    assert.ok(block.includes("." + cls), `${cls} animates but is not frozen under reduced motion`);
  }
});

// ── store-driven cost ───────────────────────────────────────────────────────
// The header no longer polls: rows are derived from the host session store
// and a single seed fetch adds route metadata. These pin the rules that keep
// that cheap: equal rows are reported as unchanged, and the derivation is a
// pure function of the snapshot.
test("an unchanged activity picture is reported as unchanged", () => {
  const { client } = loadClient();
  const row = { childId: "session-a", phase: "in", label: "worker", role: "explore", provider: "magpie", model: "group/dnq", startedAt: 1 };
  assert.equal(client.critterRowsEqual([row], [{ ...row }]), true, "a rebuilt but equal row must compare equal");
  assert.equal(client.critterRowsEqual([row], [{ ...row, model: "antigravity/gemini-3.8-flash" }]), false);
  assert.equal(client.critterRowsEqual([row], []), false);
  assert.equal(client.critterRowsEqual([row], [{ ...row, phase: "out" }]), false);
  const same = [row];
  assert.equal(client.critterRowsEqual(same, same), true);
});

test("critter rows derive from the host session store, not a poll", () => {
  const { client } = loadClient();
  const byId = {
    "root-1": { id: "root-1", origin: "root", running: true },
    "child-a": { id: "child-a", displayTitle: "worker", parentId: "session-me", origin: "subagent", running: true },
    "child-b": { id: "child-b", displayTitle: "done", parentId: "session-me", origin: "subagent", running: false },
    "child-c": { id: "child-c", displayTitle: "other", parentId: "session-other", origin: "subagent", running: true }
  };
  const seed = { "child-a": { provider: "magpie", model: "group/dnq", startedAt: 1000, role: "explore" } };
  const rows = Array.from(client.deriveCritterRows(byId, "session-me", seed));
  assert.deepEqual(rows.map((row) => row.childId), ["child-a"], "only running children of THIS parent show");
  assert.equal(rows[0].label, "worker", "store displayTitle wins over the seed");
  assert.equal(rows[0].provider, "magpie");
  assert.equal(rows[0].model, "group/dnq");
  assert.equal(rows[0].startedAt, 1000);
  assert.equal(rows[0].phase, "in");
  assert.deepEqual(Array.from(client.deriveCritterRows(byId, "session-other", null)).map((row) => row.childId), ["child-c"]);
  const unseeded = Array.from(client.deriveCritterRows(byId, "session-other", null));
  assert.equal(unseeded[0].provider, "", "no seed means blank route fields, not invented ones");
  assert.equal(unseeded[0].startedAt, 0);
  assert.equal(client.deriveCritterRows(byId, "", seed).length, 0);
  assert.equal(client.deriveCritterRows(null, "session-me", seed).length, 0);
});

test("the batch presence signature moves when the selectable set moves", () => {
  const { client } = loadClient();
  const catalog = [
    { id: "session-a", mode: "continuable" },
    { id: "session-b", mode: "one-shot" },
    { id: "session-x", mode: "external" }
  ];
  const snap = (running) => ({
    byId: {
      "session-a": { id: "session-a", running },
      "session-b": { id: "session-b", running: false }
    },
    projectionsBySession: { "session-me": { values: { subagentCatalog: catalog } } }
  });
  const first = client.batchCatalogSignature(snap(true), "session-me");
  assert.ok(first.includes("session-a|continuable|running"), first);
  assert.ok(first.includes("session-b|one-shot|settled"), first);
  assert.ok(!first.includes("session-x"), "external children are never selectable, never in the signature");
  assert.equal(client.batchCatalogSignature(snap(true), "session-me"), first, "same snapshot, same signature");
  assert.notEqual(client.batchCatalogSignature(snap(false), "session-me"), first, "a running flip moves the signature");
  assert.equal(client.batchCatalogSignature({ byId: {} }, "session-me"), "empty");
  assert.equal(client.batchCatalogSignature(null, "session-me"), null, "no store means no signature, not a guess");
});

test("an identical route poll produces the same signature", () => {
  const { client } = loadClient();
  const value = { provider: "magpie", model: "group/dnq", reasoningEffort: "high", override: null, revision: 3, pending: false };
  const first = client.routePollSignature(value, true, { ok: true, value });
  const again = client.routePollSignature({ ...value }, true, { ok: true, value: { ...value } });
  assert.equal(first, again);
  assert.notEqual(first, client.routePollSignature({ ...value, revision: 4 }, true, { ok: true }));
  assert.notEqual(first, client.routePollSignature({ ...value, override: { provider: "a", model: "b" } }, true, { ok: true }));
  assert.equal(client.routePollSignature(null, false, { ok: false, error: { code: "not-live" } }), "!not-live");
});

// ── panel rows ──────────────────────────────────────────────────────────────
// The hover panel used to print the raw host label, which ellipsized into
// fragments. Rows now print a preset phrase picked by childId; the real label
// survives only as a tooltip, so the pick must be stable and stay in the list.
test("panel rows pick one preset phrase per child, stably", () => {
  const { client } = loadClient();
  const phrases = client.critterPhrases;
  assert.ok(phrases.length >= 8, `expected a real preset list, got ${phrases.length}`);
  assert.equal(new Set(phrases).size, phrases.length, "preset phrases must not repeat");

  const row = { childId: "session-abc", label: "[agent:delegated review] Bounded…", role: "review" };
  const pick = client.critterPhrase(row);
  assert.ok(phrases.includes(pick), `unexpected phrase ${pick}`);
  assert.ok(pick.length <= 6, `a row label has to stay short: ${pick}`);

  // Same child, same phrase — every render, and after a rebuild of the row.
  assert.equal(client.critterPhrase({ ...row }), pick);
  assert.equal(client.critterPhrase({ childId: "session-abc" }), pick, "the label must not leak into the phrase pick");

  // Different children spread over the list instead of all landing on one.
  const seen = new Set();
  for (let i = 0; i < 60; i += 1) seen.add(client.critterPhrase({ childId: "session-" + i }));
  assert.ok(seen.size > 3, `60 children only produced ${seen.size} phrases`);
  assert.equal(client.critterPhrase({}), client.critterPhrase({}), "a row without an id still gets a stable phrase");
});

test("the panel is height-capped and scrolls instead of running off screen", () => {
  const { css } = loadClient();
  const rule = css.match(/\.dsm-critters-panel\{[^}]*\}/);
  assert.ok(rule, "the panel rule must exist");
  assert.ok(/max-height:min\(60vh,\s*420px\)/.test(rule[0]), rule[0]);
  assert.ok(rule[0].includes("position:fixed"), "the panel must escape the actions row's overflow clip, not sit inside it");
  assert.ok(rule[0].includes("overflow-y:auto"), "a capped panel must scroll");
  assert.ok(rule[0].includes("overscroll-behavior:contain"), "scrolling the panel must not scroll the page behind it");
  assert.ok(rule[0].includes("width:max-content"), "the panel must size to its rows, not to a fixed 320px");
  assert.ok(rule[0].includes("max-width:min(320px,86vw)"), "sizing to content still needs a ceiling");
  const row = css.match(/\.dsm-critters-row\{[^}]*\}/);
  assert.ok(row && row[0].includes("cursor:pointer"), "a row is a launcher: it must look clickable");
});

// ── what a row reports ──────────────────────────────────────────────────────
// Rows used to end at a phrase; the useful facts are the numbers. Both are
// already projected onto the child row by the host, so a row must read them
// from there — and must stay silent when they are absent rather than print 0.
test("a row reads elapsed work time and tokens from the host projection", () => {
  const { client } = loadClient();
  const byId = {
    "child-a": {
      id: "child-a",
      running: true,
      parentId: "session-me",
      displayTitle: "worker",
      projectionValues: {
        tokenUsage: { uncachedInputTokens: 8000, outputTokens: 1200, cacheReadTokens: 40000, cacheWriteTokens: 0 },
        subagentTiming: { active: { since: 1000, through: 0 }, settledMs: 5000 }
      }
    },
    "child-b": { id: "child-b", running: true, parentId: "session-me", displayTitle: "bare" }
  };
  const rows = Array.from(client.deriveCritterRows(byId, "session-me", null));
  const a = rows.find((row) => row.childId === "child-a");
  assert.equal(a.startedAt, 1000, "the projection's start wins over the seed");
  assert.equal(a.settledMs, 5000);
  assert.equal(a.tokens, 49200, "all four usage buckets count");
  const b = rows.find((row) => row.childId === "child-b");
  assert.equal(b.startedAt, 0);
  assert.equal(b.settledMs, 0);
  assert.equal(b.tokens, null, "no projection means no invented token count");
  // A token change is a visible change: the rows must not compare equal.
  assert.equal(client.critterRowsEqual([a], [{ ...a, tokens: 1 }]), false);
  assert.equal(client.critterRowsEqual([a], [{ ...a, settledMs: 1 }]), false);
  assert.equal(client.critterRowsEqual([a], [{ ...a }]), true);
});

test("durations and token counts read the way a person says them", () => {
  const { client } = loadClient();
  assert.equal(client.formatCritterDuration(0), "0秒");
  assert.equal(client.formatCritterDuration(42000), "42秒");
  assert.equal(client.formatCritterDuration(187000), "3分07秒");
  assert.equal(client.formatCritterDuration(3900000), "1小时05分");
  assert.equal(client.formatCritterTokens(0), "0");
  assert.equal(client.formatCritterTokens(942), "942");
  assert.equal(client.formatCritterTokens(12345), "1.2万");
  assert.equal(client.formatCritterTokens(20000), "2万");
  assert.equal(client.formatCritterTokens(340000000), "3.4亿");
  assert.equal(client.critterTokenTotal({ uncachedInputTokens: 10, outputTokens: 5 }), 15);
  assert.equal(client.critterTokenTotal({}), null, "an empty usage object is not a zero");
  assert.equal(client.critterTokenTotal(undefined), null);
});
