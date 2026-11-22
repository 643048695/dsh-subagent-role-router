import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// `npm test` must run EVERY test file on every supported Node (20 and 22), and
// it must be impossible to forget a new file. A bare `test/*.test.mjs` glob is
// only expanded by Node 22's own test runner — Node 20 and cmd/PowerShell pass
// it through literally and the run dies with "Could not find". So the script
// lists the files explicitly, and this test keeps that list honest.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const TEST_DIR = join(ROOT, "test");

const onDisk = readdirSync(TEST_DIR)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort();

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const script = String(pkg?.scripts?.test ?? "");

const args = script
  .split(/\s+/)
  .map((token) => token.replace(/^["']|["']$/g, ""))
  .filter(Boolean);

const listed = args
  .filter((token) => token.startsWith("test/") && token.endsWith(".mjs"))
  .map((token) => token.slice("test/".length));

test("the test script enumerates files, never a glob or a directory", () => {
  assert.match(script, /node --test/, "scripts.test should invoke node --test");
  assert.ok(
    !/[*?[\]]/.test(script),
    `scripts.test must not contain a glob (Node 20 does not expand it): ${script}`,
  );
  const bare = args.filter((token) => token === "test" || token === "test/");
  assert.deepEqual(bare, [], "scripts.test must not point at the directory itself");
});

test("every test file on disk is listed in scripts.test", () => {
  const missing = onDisk.filter((name) => !listed.includes(name));
  assert.deepEqual(
    missing,
    [],
    `add these to scripts.test: ${missing.map((n) => `test/${n}`).join(" ")}`,
  );
});

test("scripts.test lists nothing that no longer exists", () => {
  const ghost = listed.filter((name) => !onDisk.includes(name));
  assert.deepEqual(ghost, [], `scripts.test names missing files: ${ghost.join(", ")}`);
});
