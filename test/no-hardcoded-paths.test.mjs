// Publishing gate: no source file may carry one machine's absolute paths.
//
// 4.2.0 fixed the runtime leak (a typed-in user-profile log path),
// but the test fixtures still carried the author's checkout and install
// directories. A published repository hands those to everyone: they name the
// local user account, and on any other machine they point at nothing. This suite
// keeps the gate closed, so the next copy-paste from a debugging session fails
// here instead of shipping.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCANNED_DIRS = ["lib", "test", "tools"];
const SCANNED_ROOT_FILES = ["package.json", "cordis.patch.yml"];
const EXTENSIONS = [".js", ".mjs", ".cjs", ".json", ".yml", ".yaml"];

/** Patterns that only ever match one developer's machine. */
const FORBIDDEN = [
  { name: "Windows user profile", re: /[A-Za-z]:[\/]+Users[\/]+[^\/\s"']+/ },
  { name: "macOS user home", re: /\/Users\/[A-Za-z0-9._-]+/ },
  { name: "Linux user home", re: /\/home\/[A-Za-z0-9._-]+/ },
  { name: "DSH Desktop install dir", re: /AppData[\/]+Local[\/]+Programs/i },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

const files = [
  ...SCANNED_DIRS.flatMap((dir) => walk(join(ROOT, dir))),
  ...SCANNED_ROOT_FILES.map((name) => join(ROOT, name)).filter((p) => {
    try { return statSync(p).isFile(); } catch { return false; }
  }),
];

test("the scan is not vacuous", () => {
  // A guard that silently scans nothing passes forever.
  assert.ok(files.length >= 8, `expected to scan the sources, saw ${files.length} files`);
  assert.ok(files.some((f) => f.endsWith(join("lib", "index.js"))));
  assert.ok(files.some((f) => f.endsWith("no-hardcoded-paths.test.mjs")));
});

test("no source file hardcodes a local absolute path", () => {
  const findings = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const { name, re } of FORBIDDEN) {
        if (re.test(line)) {
          findings.push(`${relative(ROOT, file)}:${index + 1} [${name}] ${line.trim().slice(0, 120)}`);
        }
      }
    });
  }
  assert.deepEqual(findings, [], `hardcoded local paths found:\n${findings.join("\n")}`);
});

test("trace output stays opt-in", () => {
  // The runtime half of the same rule: writing a log must require an explicit
  // environment variable, and the default branch must return before any I/O.
  const source = readFileSync(join(ROOT, "lib", "index.js"), "utf8");
  assert.match(source, /process\.env\.DSH_SUBAGENT_ROLE_ROUTER_LOG/);
  assert.match(source, /if \(TRACE_PATH === ""\) return;/);
});
