import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// NO MORE "ctx IS NOT DEFINED".
//
// Live, twice: a helper used `ctx` without receiving it, and every child that
// took that branch died at its first step — invisible to unit tests because the
// branch is rare. The host throws the stack away, so it took a journal and a
// real failure to find it.
//
// This file is the guard that makes the class impossible: a tiny source scan
// that reports every `ctx.` use it cannot find a declaring scope for. It is
// validated against a sample of the exact old bug, so a silent regression in
// the checker itself fails too.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

/** Remove comments and string/template literals so scanning is about code. */
function stripLiterals(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') { while (i < n && source[i] !== '\n') i += 1; continue; }
    if (ch === '/' && next === '*') { i += 2; while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1; i += 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      out += '""';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Ranges of every function body, with its parameter list. */
function functionScopes(code) {
  const scopes = [];
  const open = /\bfunction\b\s*[A-Za-z0-9_$]*\s*\(([^)]*)\)\s*\{/g;
  let match;
  while ((match = open.exec(code)) !== null) {
    const bodyStart = match.index + match[0].length - 1;
    scopes.push({ start: bodyStart, end: matchingBrace(code, bodyStart), params: match[1] });
  }
  // `(a, b) => {` and `a => {` forms.
  const arrow = /(\([^()]*\)|[A-Za-z0-9_$]+)\s*=>\s*\{/g;
  while ((match = arrow.exec(code)) !== null) {
    const bodyStart = match.index + match[0].length - 1;
    scopes.push({ start: bodyStart, end: matchingBrace(code, bodyStart), params: match[1] });
  }
  return scopes.filter((scope) => scope.end > scope.start);
}

function matchingBrace(code, start) {
  let depth = 0;
  for (let i = start; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return code.length - 1;
}

/** Does this scope (or a local declaration inside it) provide `ctx`? */
function declaresCtx(code, scope) {
  if (/\bctx\b/.test(scope.params)) return true;
  const body = code.slice(scope.start, scope.end);
  return /(?:const|let|var)\s+ctx\b/.test(body) || /\{[^}]*\bctx\b[^}]*\}\s*=/.test(body);
}

/**
 * Every `ctx.` reference with no declaring scope around it.
 *
 * @param {string} source - file text.
 * @returns {Array<{offset: number, snippet: string}>} findings.
 */
function findUndeclaredCtx(source) {
  const code = stripLiterals(source);
  const scopes = functionScopes(code);
  const findings = [];
  const use = /\bctx\s*\./g;
  let match;
  while ((match = use.exec(code)) !== null) {
    const at = match.index;
    let scope = null;
    // Innermost enclosing body first.
    for (const candidate of scopes) {
      if (at > candidate.start && at < candidate.end) {
        if (scope === null || candidate.start > scope.start) scope = candidate;
      }
    }
    let declared = false;
    let cursor = scope;
    while (cursor !== null) {
      if (declaresCtx(code, cursor)) { declared = true; break; }
      cursor = scopes
        .filter((candidate) => cursor.start > candidate.start && cursor.end < candidate.end)
        .sort((a, b) => b.start - a.start)[0] ?? null;
    }
    if (!declared) findings.push({ offset: at, snippet: code.slice(Math.max(0, at - 60), at + 60).replace(/\s+/g, ' ') });
  }
  return findings;
}

test('the checker finds the exact bug that broke the live run', () => {
  // Trimmed from the real 5.10.1 source: the helper logs with `ctx` but the
  // parameter list only has state/agent/group/seed/id.
  const broken = `
    async function ensureCoordinatorRoute(state, agent, group, seed, id) {
      const outcome = await applyLiveRouteSelect(agent, target);
      if (first) {
        ctx.logger?.info?.("switched");
      }
    }
    function installChildRouteOverride(ctx, state) {
      return () => { on("agent/request", () => ensureCoordinatorRoute(state, agent, group, seed, id)); };
    }
  `;
  const findings = findUndeclaredCtx(broken);
  assert.equal(findings.length, 1, 'the bug must be reported');
  assert.match(findings[0].snippet, /ctx\.logger/);

  const fixed = broken.replace('ensureCoordinatorRoute(state, agent, group, seed, id)', 'ensureCoordinatorRoute(ctx, state, agent, group, seed, id)')
    .replace('async function ensureCoordinatorRoute(state,', 'async function ensureCoordinatorRoute(ctx, state,');
  assert.deepEqual(findUndeclaredCtx(fixed), [], 'the fix quiets it');
});

test('a nested arrow inside a function that receives ctx is not a finding', () => {
  const source = `
    function install(ctx, state) {
      const run = () => ctx.on("agent/request", () => ctx.logger?.warn?.("x"));
      run();
      const { ctx: local } = thing();
      return () => local.logger;
    }
  `;
  assert.deepEqual(findUndeclaredCtx(source), []);
});

test('the shipped plugin has no undeclared ctx reference', () => {
  for (const file of ['lib/index.js', 'lib/client.js']) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    const findings = findUndeclaredCtx(source);
    assert.deepEqual(findings, [], `${file} references ctx without a declaring scope:\n${findings.map((f) => f.snippet).join('\n')}`);
  }
});
