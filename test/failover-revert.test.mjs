import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, shouldFailover } from '../lib/index.js';

// "REVERT, DO NOT STOP" — the promise a live run earned.
//
// session-7a929cab / child 9c3d76ab: the user picked `group/1017` on a
// coordinator child; the gateway answered the next step 400 with no explanation
// and the child stopped dead. Two locks produced that: the plugin treated the
// user's own pick as untouchable, and the 400 was not on the old allowlist.
// What this file pins:
//
//   1. Any failure except a cancellation moves the child to the next candidate.
//   2. A MANUAL pick that fails is withdrawn and the child continues on its
//      page's ordered list — the list's head, not "whatever followed the pick".
//   3. The switch is announced over the same SSE stream the pickers use, so the
//      header can say what happened while the child keeps running.

const config = {
  roleMode: false,
  injectRouteContext: false,
  failoverEnabled: true,
  roleSlotCooldownSeconds: 0,
  models: [{ provider: 'p', model: 'a' }, { provider: 'q', model: 'b' }],
  coordinatorEnabled: true,
  coordinatorPresetPrefix: 'dsh-orchestrator-worker',
  coordinatorUiModels: [{ provider: 'magpie-anthropic', model: 'agy-cli/gemini-4-hydrogen' }],
  coordinatorResearchModels: [{ provider: 'magpie', model: 'group/dnq' }],
  coordinatorBackendModels: [
    { provider: 'magpie-responses', model: 'codex/gpt-6.2-sol' },
    { provider: 'magpie', model: 'group/1017' },
    { provider: 'magpie', model: 'group/dnq' }
  ],
  coordinatorCooldownPreset: 'medium',
  coordinatorCooldownSteps: [],
  coordinatorCooldownCap: 0,
  coordinatorNoFallback: false
};

function harness(settings = config) {
  const listeners = new Map();
  const cleanups = [];
  const routes = [];
  const warnings = [];
  const agents = new Map();

  const ctx = {
    logger: { warn: (...args) => warnings.push(args.join(' ')), info: () => {} },
    on(name, fn) {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
      return () => {
        const at = list.indexOf(fn);
        if (at >= 0) list.splice(at, 1);
      };
    },
    effect(fn) {
      const off = fn();
      if (typeof off === 'function') cleanups.push(off);
    },
    inject(names, fn) {
      if (names.includes('webServer')) {
        fn({
          logger: ctx.logger,
          effect(register) {
            const off = register();
            if (typeof off === 'function') cleanups.push(off);
          },
          webServer: {
            register(route) {
              routes.push(route);
              return () => {
                const at = routes.indexOf(route);
                if (at >= 0) routes.splice(at, 1);
              };
            }
          }
        });
      }
    },
    get(key) {
      if (key === 'agents') return { get: (id) => agents.get(id) };
      // The write endpoints verify membership against the host's parent catalog.
      if (key === 'subagents') {
        return {
          async listDescendants(root) {
            const forms = [root, root.startsWith('session-') ? root.slice(8) : 'session-' + root];
            const rows = [];
            for (const agent of agents.values()) {
              const header = agent.session?.header ?? {};
              if (header.origin !== 'subagent' || !forms.includes(header.parentSession)) continue;
              rows.push({ id: agent.id, mode: 'continuable', label: header.label ?? agent.id, parentId: header.parentSession, depth: 1 });
            }
            return rows;
          }
        };
      }
      return undefined;
    }
  };

  apply(ctx, settings);

  async function error(agent, failure, value, signal) {
    const list = listeners.get('agent/request-error') ?? [];
    const payload = { turn: 0, step: 0, agent, provider: 'p', failure, signal };
    const run = (i) => (i === list.length ? Promise.resolve(value) : list[i](payload, () => run(i + 1)));
    return run(0);
  }

  async function request(payload, value) {
    const list = listeners.get('agent/request') ?? [];
    const run = (i) => (i === list.length ? Promise.resolve(value) : list[i](payload, () => run(i + 1)));
    return run(0);
  }

  async function call({ method = 'POST', path, body, remote = '127.0.0.1' }) {
    const route = routes.find((entry) => entry.path === '/subagent-role-router');
    assert.ok(route, 'the plugin must claim /subagent-role-router');
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = {
      method,
      url: path,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      socket: { remoteAddress: remote },
      on(event, fn) {
        if (event === 'data' && payload !== '') fn(Buffer.from(payload));
        if (event === 'end') fn();
        return req;
      },
      destroy() {}
    };
    let status = 0;
    let raw = '';
    const res = {
      writeHead(code) { status = code; },
      end(chunk) { raw += chunk ?? ''; }
    };
    await route.handler(req, res);
    return { status, body: raw === '' ? null : JSON.parse(raw) };
  }

  /** Open the SSE stream and collect every frame the plugin writes. */
  function openEvents() {
    const route = routes.find((entry) => entry.path === '/subagent-role-router');
    assert.ok(route, 'the plugin must claim /subagent-role-router');
    const chunks = [];
    let onClose = null;
    const req = {
      method: 'GET',
      url: '/subagent-role-router/events',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      on(event, fn) { if (event === 'close') onClose = fn; return req; }
    };
    const res = { writeHead() {}, write(chunk) { chunks.push(String(chunk)); return true; }, end() {} };
    void route.handler(req, res);
    return {
      frames() {
        return chunks
          .join('')
          .split('\n\n')
          .map((block) => block.trim())
          .filter((block) => block.startsWith('data:'))
          .map((block) => JSON.parse(block.slice(5).trim()));
      },
      close() { if (typeof onClose === 'function') onClose(); }
    };
  }

  function liveChild(id, route = { provider: 'p', model: 'general' }) {
    const selects = [];
    const cancels = [];
    const followups = [];
    // The host serves whatever was selected last, so the fake must move too:
    // `requestContext()` is the plugin's only evidence of which route actually
    // failed, and a fixture that froze it would hide a real bug (it nearly did:
    // the first version of this harness reported the birth route forever).
    const served = { provider: route.provider, model: route.model };
    const agent = {
      id,
      status: 'running',
      session: {
        id,
        header: { origin: 'subagent', label: id, parentSession: 'parent-1' },
        requestContext: () => ({ provider: served.provider, model: served.model, contextWindow: 1000 }),
        requestHeader: () => ({ config: { ...served } }),
        snapshotEvents: () => []
      },
      model: {
        selects,
        select(selection) {
          selects.push({ ...selection });
          if (typeof selection.provider === 'string') served.provider = selection.provider;
          if (typeof selection.model === 'string') served.model = selection.model;
        }
      },
      cancel(cause, options) { cancels.push({ cause, options }); },
      followup(message) { followups.push(message); },
      cancels,
      followups,
      options: { provider: 'parent', model: 'parent' }
    };
    agents.set(id, agent);
    return agent;
  }

  /** Emit one durable session event to the plugin's recovery observer. */
  function emitSession(session, event) {
    const payload = { session, event };
    for (const fn of listeners.get('session/event') ?? []) fn(payload.session, payload.event);
  }

  return { agents, routes, warnings, error, request, call, openEvents, liveChild, emitSession, dispose() { for (const fn of cleanups.reverse()) fn(); } };
}

test('every failure switches except a cancellation', () => {
  assert.equal(shouldFailover({ code: 'RATE_LIMIT' }), true);
  assert.equal(shouldFailover({ code: 'TIMEOUT' }), true);
  // The live case: a gateway's opaque 400 arrives as INVALID_REQUEST.
  assert.equal(shouldFailover({ code: 'INVALID_REQUEST', message: 'The request could not be completed.' }), true);
  assert.equal(shouldFailover({ code: 'UNKNOWN', message: 'anything' }), true);
  assert.equal(shouldFailover({ code: 'ABORTED' }), false);
  assert.equal(shouldFailover({ code: 'CANCELED' }), false);
  assert.equal(shouldFailover({ code: 'CANCELLED' }), false);
  assert.equal(shouldFailover(undefined), false);
});

test('a generic 400 on an ordinary subagent moves it to the next candidate', async () => {
  const h = harness();
  const child = h.liveChild('child-1', { provider: 'p', model: 'a' });
  const outcome = await h.error(child, { code: 'INVALID_REQUEST', message: 'The request could not be completed.' }, undefined);
  // NEVER `{kind:'retry'}`: the host reuses the step's frozen selection on a
  // retry, so retry would re-burn the same route. The hook cuts and resumes.
  assert.equal(outcome, undefined);
  assert.deepEqual(child.model.selects, [{ provider: 'q', model: 'b' }]);
  // The frozen attempt was cut with a hook cause and the inbox kept; then the
  // continuation was queued in the SAME synchronous window.
  assert.equal(child.cancels.length, 1);
  assert.deepEqual(child.cancels[0].cause, { kind: 'hook', reason: 'error-switch' });
  assert.deepEqual(child.cancels[0].options, { keepInbox: true });
  assert.equal(child.followups.length, 1, 'the child must be resumed, not left idle');
  const text = child.followups[0].content.map((part) => part.text).join('');
  assert.match(text, /继续/);
  assert.match(text, /q\/b/, 'the continuation names the route it moved to');
  assert.doesNotMatch(text, /retry/i);
  h.dispose();
});

test('a cancelled run never resurrects work on another model', async () => {
  const h = harness();
  const child = h.liveChild('child-1', { provider: 'p', model: 'a' });
  const sentinel = { kind: 'continue' };
  const outcome = await h.error(child, { code: 'ABORTED' }, sentinel);
  assert.equal(outcome, sentinel);
  assert.deepEqual(child.model.selects, []);
  assert.deepEqual(child.cancels, [], 'a cancelled run must not be re-cut to resume it');
  assert.deepEqual(child.followups, []);
  h.dispose();
});

test('a manually picked route that fails is withdrawn, and the list head continues', async () => {
  const h = harness();
  const child = h.liveChild('child-1', { provider: 'p', model: 'a' });
  // The user picks the pool's SECOND entry — the "one after this pick" answer
  // would be the first entry only by accident; the rule is "revert to the list".
  const picked = await h.call({
    path: '/subagent-role-router/select',
    body: { childId: 'child-1', provider: 'q', model: 'b' }
  });
  assert.equal(picked.body.ok, true);

  const outcome = await h.error(child, { code: 'INVALID_REQUEST', message: 'The request could not be completed.' }, undefined);
  assert.equal(outcome, undefined);
  assert.deepEqual(child.model.selects, [{ provider: 'q', model: 'b' }, { provider: 'p', model: 'a' }]);
  assert.equal(child.cancels.length, 1);
  assert.equal(child.followups.length, 1);
  assert.match(child.followups[0].content.map((part) => part.text).join(''), /撤回/);

  const after = await h.call({ path: '/subagent-role-router/route?childId=child-1', method: 'GET' });
  assert.ok(!after.body.value.override, 'the dead pick must be withdrawn');
  h.dispose();
});

test('a coordinator child reverts to its group head, never to the general list', async () => {
  const h = harness();
  const child = h.liveChild('child-1', { provider: 'magpie-responses', model: 'codex/gpt-6.2-sol' });
  const grouped = await h.call({ path: '/subagent-role-router/group', body: { childId: 'child-1', group: 'backend' } });
  assert.equal(grouped.body.ok, true);
  // The pick is the group's SECOND entry; the head is codex.
  const picked = await h.call({
    path: '/subagent-role-router/select',
    body: { childId: 'child-1', provider: 'magpie', model: 'group/1017' }
  });
  assert.equal(picked.body.ok, true);

  const outcome = await h.error(child, { code: 'INVALID_REQUEST', message: 'Open Design: [code=upstream_error] The request could not be completed.' }, undefined);
  assert.equal(outcome, undefined);
  assert.deepEqual(child.model.selects.at(-1), { provider: 'magpie-responses', model: 'codex/gpt-6.2-sol' });
  const after = await h.call({ path: '/subagent-role-router/route?childId=child-1', method: 'GET' });
  assert.ok(!after.body.value.override, 'the dead pick must be withdrawn');
  assert.equal(after.body.coordinator.group, 'backend');
  h.dispose();
});

test('the switch is announced on the SSE stream the header listens to', async () => {
  const h = harness();
  const child = h.liveChild('child-1', { provider: 'p', model: 'a' });
  const events = h.openEvents();
  await h.call({ path: '/subagent-role-router/select', body: { childId: 'child-1', provider: 'q', model: 'b' } });
  await h.error(child, { code: 'INVALID_REQUEST', message: 'The request could not be completed.' }, undefined);

  const failover = events.frames().filter((frame) => frame.type === 'failover');
  assert.equal(failover.length, 1, 'exactly one announcement per switch');
  assert.equal(failover[0].childId, 'child-1');
  // The host writes `parentSession` on the child header; the older spellings
  // are only fallbacks. A pill with no parent would leak into every page.
  assert.equal(failover[0].parentSessionId, 'parent-1');
  assert.deepEqual(failover[0].from, { provider: 'q', model: 'b', reasoningEffort: '' });
  assert.deepEqual(failover[0].to, { provider: 'p', model: 'a', reasoningEffort: '' });
  assert.equal(failover[0].manual, true, 'the UI words a withdrawn pick differently');
  assert.match(failover[0].error, /INVALID_REQUEST/);
  events.close();
  h.dispose();
});

test('after every candidate has failed the real error surfaces', async () => {
  const h = harness();
  const child = h.liveChild('child-1', { provider: 'p', model: 'a' });
  const first = await h.error(child, { code: 'INVALID_REQUEST', message: 'bad' }, undefined);
  assert.equal(first, undefined);
  assert.equal(child.cancels.length, 1);
  const sentinel = { kind: 'surface' };
  const second = await h.error(child, { code: 'INVALID_REQUEST', message: 'bad again' }, sentinel);
  assert.equal(second, sentinel, 'two candidates, one switch, then the error');
  assert.equal(child.cancels.length, 1, 'the exhausted episode must not cut again');
  assert.equal(child.followups.length, 1, 'no continuation may be queued for a dead pool');
  h.dispose();
});

test('a committed assistant message re-opens the switch budget', async () => {
  const h = harness();
  const child = h.liveChild('child-1', { provider: 'p', model: 'a' });
  const first = await h.error(child, { code: 'INVALID_REQUEST', message: 'bad' }, undefined);
  assert.equal(first, undefined);
  assert.deepEqual(child.model.selects, [{ provider: 'q', model: 'b' }]);
  // The route B really answered: this is the ONLY success signal.
  h.emitSession(child.session, {
    type: 'assistant/message',
    data: { turn: 1, step: 3, message: { source: { provider: 'q', model: 'b' } } }
  });
  // A later failure on B may switch again — the old per-run counter never reset.
  const second = await h.error(child, { code: 'INVALID_REQUEST', message: 'bad again' }, undefined);
  assert.equal(second, undefined);
  assert.deepEqual(child.model.selects.at(-1), { provider: 'p', model: 'a' });
  assert.equal(child.cancels.length, 2);
  h.dispose();
});
