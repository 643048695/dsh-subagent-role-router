import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, isUnusableCandidate } from '../lib/index.js';

const config = {
  roleMode: true, exploreProvider: 'p', exploreModel: 'explore',
  patchProvider: 'p', patchModel: 'general', planProvider: 'p', planModel: 'plan',
  forkWindowSlicing: true, forkWindowTurns: 1, injectRouteContext: true,
  failoverEnabled: true, models: [{provider:'p',model:'a'}, {provider:'q',model:'b'}]
};
function harness(settings = config) {
  const listeners = new Map(), cleanups = [], seen = [];
  const seed = [];
  for (let turn=0; turn<3; turn++) {
    seed.push({type:'turn/start',seq:seed.length,time:1,data:{turn}});
    seed.push({type:'user/message',seq:seed.length,time:1,data:{id:`u${turn}`,role:'user',content:[{type:'text',text:`turn ${turn}`}],source:{kind:'user'}},surfaceOp:'append'});
    seed.push({type:'turn/end',seq:seed.length,time:1,data:{turn,reason:{kind:'completed'}}});
  }
  const parent = {session:{snapshotEvents:()=>seed},options:{provider:'parent',model:'parent',reasoningEffort:'max'}};
  const fork = {
    start(request) { seen.push(request); return Promise.resolve({request}); },
    async prepareContinuable() { await Promise.resolve(); return {seed}; }
  };
  const raw = {
    getProvider(name) { return name==='fork' ? fork : undefined; },
    async start(name, request) { seen.push(request); return request; },
    async startContinuable(spec) {
      const prepared = spec.provider === 'fork' ? await fork.prepareContinuable({parent:spec.request.parent}) : {};
      seen.push(spec); return {spec,...prepared,boundary:prepared.seed?.length};
    },
    async startActivation(spec) { seen.push(spec); return spec; }
  };
  const originals = {start:raw.start,continuable:raw.startContinuable,forkStart:fork.start,prepare:fork.prepareContinuable};
  const ctx = {
    subagents:raw, logger:{warn(){}},
    on(name,fn) { const list=listeners.get(name)??[];list.push(fn);listeners.set(name,list); return ()=>{const at=list.indexOf(fn);if(at>=0)list.splice(at,1);}; },
    effect(fn) { const off=fn(); if(typeof off==='function')cleanups.push(off); },
    inject(names,fn) { if(names.includes('subagents'))fn(ctx); }
  };
  apply(ctx,settings);
  async function waterfall(name,payload,value) {
    const list=listeners.get(name)??[];
    const run=i=>i===list.length?Promise.resolve(value):list[i](payload,()=>run(i+1));
    return run(0);
  }
  return {raw,parent,seed,fork,seen,originals,waterfall,dispose(){for(const fn of cleanups.reverse())fn();}};
}

test('explicit Mnemon model and token controls survive every request',async()=>{
  // Plugin coexistence: Mnemon spawns its own helpers with a private
  // provider/model pair. Under the default "pool" birth policy the router
  // would replace that pick, so the documented escape hatch is an exemption
  // rule — exactly what a real profile adds for plugin-borne children.
  const h=harness({...config,exemptRules:[{name:'mnemon',match:'label',pattern:'Mnemon'}]});
  const agentOptions={provider:'memory',model:'fixed',maxTokens:8192,reasoningEffort:'low'};
  const request={parent:h.parent,prompt:'review',agentOptions};
  const result=await h.raw.startActivation({provider:'spawn',label:'Mnemon idle checkpoint review',request});
  assert.equal(result.request,request);
  const route=await h.waterfall('agent/request',{agent:{id:'memory',session:{header:{origin:'subagent'},snapshotEvents:()=>[]}}},agentOptions);
  assert.deepEqual(route,agentOptions);h.dispose();
});
test('pool birth policy replaces a caller-written model with the role pool',async()=>{
  // The host copies the parent route into spawn options (observed 2026-11-09:
  // every child born with the main conversation's magpie-responses +
  // codex/gpt-6.1-sol). That is the parent's habit, not a user choice: the
  // pool wins, while non-model controls (maxTokens) survive the rewrite.
  const h=harness(); const agentOptions={provider:'magpie-responses',model:'codex/gpt-6.1-sol',maxTokens:8192};
  const request={parent:h.parent,prompt:'review the failing test',agentOptions};
  const result=await h.raw.startActivation({provider:'spawn',label:'code review helper',request});
  assert.equal(result.request.agentOptions.provider,'p');
  assert.equal(result.request.agentOptions.model,'explore');
  assert.equal(result.request.agentOptions.maxTokens,8192);h.dispose();
});
test('explicit birth policy lets a full route through and refuses a short/ambiguous id',async()=>{
  // The explicit policy still takes responsibility for a caller's FULL route,
  // but a bare short name is never handed to the host unchanged: it must be
  // resolved to one configured route or refused. Both halves are the contract.
  const h=harness({...config,birthRoutePolicy:'explicit'});
  const full={provider:'memory',model:'memory/fixed',maxTokens:8192};
  const request={parent:h.parent,prompt:'review the failing test',agentOptions:full};
  const result=await h.raw.startActivation({provider:'spawn',label:'code review helper',request});
  assert.equal(result.request,request,'a full provider/model route keeps the explicit-policy pass-through');
  await assert.rejects(
    h.raw.startActivation({
      provider:'spawn',
      label:'code review helper',
      request:{parent:h.parent,prompt:'review the failing test',agentOptions:{provider:'memory',model:'fixed',maxTokens:8192}}
    }),
    (error)=>error?.code==='BIRTH_ROUTE_AMBIGUOUS',
    'a short model id under an explicit policy is refused instead of reaching the host'
  );h.dispose();
});
test('token-only options get role default without dropping maxTokens or tool policy',async()=>{
  const h=harness(); const toolFilter={allow:['read','edit']};
  const result=await h.raw.startActivation({provider:'spawn',label:'Mnemon remember',request:{parent:h.parent,prompt:'remember this',agentOptions:{maxTokens:8192},toolFilter}});
  assert.equal(result.request.agentOptions.model,'general');assert.equal(result.request.agentOptions.maxTokens,8192);
  assert.equal(result.request.toolFilter,toolFilter);h.dispose();
});
test('round-robin is once per child, never once per request',async()=>{
  const h=harness({...config,roleMode:false});
  const a=await h.raw.start('spawn',{parent:h.parent,prompt:'a'}),b=await h.raw.start('spawn',{parent:h.parent,prompt:'b'});
  assert.equal(a.agentOptions.model,'a');assert.equal(b.agentOptions.model,'b');
  const route={...a.agentOptions};
  for(let i=0;i<3;i++)assert.deepEqual(await h.waterfall('agent/request',{agent:{id:'a',session:{header:{origin:'subagent'},snapshotEvents:()=>[]}}},route),route);
  h.dispose();
});
test('concurrent team fork is unchanged while ordinary fork is sliced; parent untouched',async()=>{
  const h=harness();const snapshot=h.parent.session.snapshotEvents;
  const team={provider:'fork',label:'agent-teams:team:成员',request:{parent:h.parent,prompt:'work',agentOptions:{provider:'team',model:'team/team-model'}}};
  const ordinary={provider:'fork',label:'michengai-btw:question',request:{parent:h.parent,prompt:'explain'}};
  const [t,b]=await Promise.all([h.raw.startContinuable(team),h.raw.startContinuable(ordinary)]);
  assert.equal(t.spec,team);assert.equal(t.seed,h.seed);assert.equal(t.boundary,h.seed.length);
  assert.equal(b.spec.request.agentOptions.model,'explore');assert.equal(b.seed.length,3);assert.equal(b.boundary,3);
  assert.equal(h.parent.session.snapshotEvents,snapshot);assert.equal(snapshot().length,9);h.dispose();
});
test('team descriptor rather than header exempts failover and route injection',async()=>{
  const h=harness(); const agent={id:'member',session:{header:{origin:'subagent'},snapshotEvents:()=>[{type:'subagent/descriptor',data:{label:'agent-teams:x:成员'}}]},inbox:{nextStep:[],prepend(){throw Error('must not inject');}}};
  const sentinel={kind:'continue'};
  assert.equal(await h.waterfall('agent/request-error',{agent,failure:{code:'TIMEOUT'}},sentinel),sentinel);
  assert.equal(await h.waterfall('agent/pre-step',{agent},sentinel),sentinel);h.dispose();
});
test('unload restores provider and service hooks, without overwriting later wrappers',()=>{
  const h=harness();h.dispose();
  assert.equal(h.raw.start,h.originals.start);assert.equal(h.fork.start,h.originals.forkStart);assert.equal(h.fork.prepareContinuable,h.originals.prepare);
  const second=harness();const newer=()=>{};second.raw.start=newer;second.dispose();assert.equal(second.raw.start,newer);
});
test('main session route is not affected',async()=>{
  const h=harness(); const route={provider:'main',model:'main'};
  assert.equal(await h.waterfall('agent/request',{agent:{id:'root',session:{header:{}}}},route),route);h.dispose();
});

// ── role candidate pools: spillover, overflow, cooldowns ─────────────────────
//
// This harness differs from `harness()` in one way only: `startActivation`
// hands back a receipt whose `result` promise is settled by the test, so lane
// occupancy can be held open across several delegations. That is what makes
// "3 lanes, 4 concurrent tasks" observable at all.

function poolHarness(overrides = {}) {
  const listeners = new Map(), cleanups = [], seen = [], warns = [], pending = [];
  let seq = 0;
  const parent = {session:{snapshotEvents:()=>[]},options:{provider:'parent',model:'parent'}};
  const raw = {
    getProvider() { return undefined; },
    startActivation(spec) {
      seen.push(spec);
      const childId = `child-${++seq}`;
      let resolve, reject;
      const result = new Promise((res, rej) => { resolve = res; reject = rej; });
      const receipt = { childId, result, dispose(){} };
      pending.push({ childId, resolve, reject, receipt });
      return receipt;
    }
  };
  const ctx = {
    subagents:raw,
    logger:{ warn(...args) { warns.push(args); } },
    on(name,fn) { const list=listeners.get(name)??[];list.push(fn);listeners.set(name,list); return ()=>{const at=list.indexOf(fn);if(at>=0)list.splice(at,1);}; },
    effect(fn) { const off=fn(); if(typeof off==='function')cleanups.push(off); },
    inject(names,fn) { if(names.includes('subagents'))fn(ctx); }
  };
  const settings = {
    roleMode: true, forkWindowSlicing: false, injectRouteContext: false,
    failoverEnabled: true, roleSlotCooldownSeconds: 15,
    models: [{provider:'base',model:'base-a'},{provider:'base',model:'base-b'}],
    patchModels: [{provider:'p',model:'m1'},{provider:'p',model:'m2'},{provider:'p',model:'m3'}],
    ...overrides
  };
  apply(ctx, settings);
  async function waterfall(name,payload,value) {
    const list=listeners.get(name)??[];
    const run=i=>i===list.length?Promise.resolve(value):list[i](payload,()=>run(i+1));
    return run(0);
  }
  const flush = () => new Promise((r) => setImmediate(r));
  return { raw, seen, warns, pending, parent, waterfall, flush,
    models() { return seen.map((spec) => spec.request.agentOptions.model); },
    dispose() { for (const fn of cleanups.reverse()) fn(); } };
}

// ── the recovery contract on a fixture ──────────────────────────────────────
//
// The plugin no longer answers the host's `agent/request-error` waterfall with
// `{ kind: "retry" }`: a retry re-runs the SAME frozen selection, so it is not a
// route change. The live switch is `model.select(target)` + `cancel({kind:"hook"},
// {keepInbox:true})` + `followup(continuation)` in ONE synchronous window, and
// the handler returns `undefined`. Tests therefore need an agent that exposes the
// same three functions and records them, plus a mutable served route so a
// second failure is attributed to the NEW selection rather than the previous one.
const subagent = (id, served, withSelect = false) => {
  const state = { ...served };
  const cancels = [];
  const followups = [];
  const selects = [];
  const agent = {
    id,
    status: 'running',
    cancels,
    followups,
    session: {
      header: { origin: 'subagent' },
      snapshotEvents: () => [],
      requestContext: () => ({ ...state })
    },
    cancel(cause, options) { cancels.push({ cause, options }); },
    followup(message) { followups.push(message); }
  };
  if (withSelect) {
    // The host's front door (`model.select`) and its durable selection fold.
    // A selection moves `served` too: the NEXT request context is the new route.
    agent.model = {
      selects,
      current: () => ({ ...state }),
      select(selection) {
        selects.push({ ...selection });
        state.provider = selection.provider;
        state.model = selection.model;
      }
    };
  }
  return agent;
};

test('one candidate behaves exactly like the old single-value role route',async()=>{
  const h=poolHarness({patchModels:[{provider:'p',model:'only'}],roleSlotCooldownSeconds:15});
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'do work'}});
  assert.deepEqual(h.seen[0].request.agentOptions,{provider:'p',model:'only'});
  assert.deepEqual(h.models(),['only']);h.dispose();
});

test('a busy lane spills the next task onto the next candidate',async()=>{
  const h=poolHarness();
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'one'}});
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'two'}});
  assert.deepEqual(h.models(),['m1','m2']);h.dispose();
});

test('three busy lanes share the fourth task with the first lane',async()=>{
  const h=poolHarness();
  for (let i=0;i<4;i++) h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:`t${i}`}});
  assert.deepEqual(h.models(),['m1','m2','m3','m1']);h.dispose();
});

test('a settled lane is handed back and wins the next task again',async()=>{
  const h=poolHarness();
  for (let i=0;i<3;i++) h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:`t${i}`}});
  assert.deepEqual(h.models(),['m1','m2','m3']);
  h.pending[0].resolve({status:'ok'});
  await h.flush();
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'after'}});
  assert.deepEqual(h.models(),['m1','m2','m3','m1']);h.dispose();
});

test('a failed candidate is skipped by the next delegation',async()=>{
  const h=poolHarness();
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'first'}});
  const child=h.pending[0];
  child.resolve({status:'ok'});
  await h.flush();
  await h.waterfall('agent/request-error',{agent:subagent(child.childId,{provider:'p',model:'m1'}),failure:{code:'RATE_LIMIT'}},undefined);
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'second'}});
  assert.deepEqual(h.models(),['m1','m2']);
  assert.ok(h.warns.some((args)=>String(args[0]).includes('skipping it for new delegations')));h.dispose();
});

test('a zero cooldown keeps the failed candidate in rotation',async()=>{
  const h=poolHarness({roleSlotCooldownSeconds:0});
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'first'}});
  const child=h.pending[0];
  child.resolve({status:'ok'});
  await h.flush();
  await h.waterfall('agent/request-error',{agent:subagent(child.childId,{provider:'p',model:'m1'}),failure:{code:'RATE_LIMIT'}},undefined);
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'second'}});
  assert.deepEqual(h.models(),['m1','m1']);h.dispose();
});

test('a fully cooled pool still serves the delegation and says so',async()=>{
  const h=poolHarness();
  for (const model of ['m1','m2','m3']) {
    await h.waterfall('agent/request-error',{agent:subagent(`ghost-${model}`,{provider:'p',model}),failure:{code:'SERVER'}},undefined);
  }
  const before=h.warns.length;
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'still needed'}});
  assert.equal(h.seen.length,1);
  assert.ok(h.warns.length>before);
  assert.ok(h.warns.some((args)=>String(args[0]).includes('cooling down')));h.dispose();
});

test('an off-list birth model is replaced by the pool and occupies a lane (default policy)',async()=>{
  // The host copies the parent route into every spawn, so "someone named a
  // model" no longer implies "the user picked it": an off-list pick is
  // replaced and DOES occupy a lane, exactly like any pool traffic.
  const h=poolHarness();
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'copied from parent',agentOptions:{provider:'x',model:'y'}}});
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'pooled'}});
  assert.deepEqual(h.models(),['m1','m2']);h.dispose();
});
test('birth picks follow the page whitelist: exact provider survives, unknown provider is replaced, model-only normalizes',async()=>{
  // Provider-tuple semantics, made explicit:
  //   * an EXACT provider+model pair is the page's route: honoured, no lane;
  //   * an UNKNOWN provider is NOT approved just because the model name also
  //     appears on the page — gateway aliases are not interchangeable for a
  //     birth handoff, so the pick falls through to the role pool and is
  //     replaced by that pool's exact pair (and drops the rejected route's
  //     inherited effort);
  //   * a MODEL-ONLY pick that names exactly one configured route is normalized
  //     to that route's provider+model (a short name must never reach the host).
  // Honoured picks bypass pool routing and occupy no lane — the pooled spawn
  // still starts from the next free lane.
  const h=poolHarness();
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'exact',agentOptions:{provider:'p',model:'m2'}}});
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'renamed provider',agentOptions:{provider:'gateway-alias',model:'base-b',reasoningEffort:'xhigh'}}});
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'model only',agentOptions:{model:'m3'}}});
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'pooled'}});
  const born=h.seen.map((spec)=>spec.request.agentOptions);
  assert.deepEqual(born[0],{provider:'p',model:'m2'},'the exact configured provider/model is honoured unchanged');
  assert.deepEqual(born[1],{provider:'p',model:'m1'},'an unknown provider is replaced by the role pool, effort included');
  assert.deepEqual(born[2],{provider:'p',model:'m3'},'a model-only pick is normalized to the one configured route');
  assert.deepEqual(born[3],{provider:'p',model:'m2'},'the pooled spawn starts from the next free lane (m1 is busy)');
  assert.deepEqual(h.models(),['m2','m1','m3','m2']);h.dispose();
});
test('an explicit model bypasses the pool and occupies no lane under the explicit policy',async()=>{
  const h=poolHarness({birthRoutePolicy:'explicit'});
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'pinned',agentOptions:{provider:'x',model:'x/y'}}});
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'pooled'}});
  assert.deepEqual(h.seen[0].request.agentOptions,{provider:'x',model:'x/y'},
    'the explicit policy lets a full provider/model route through unchanged');
  assert.deepEqual(h.models(),['x/y','m1']);h.dispose();
});

test('a role failure fails over inside its own pool, not the base pool',async()=>{
  const h=poolHarness({patchModels:[{provider:'p',model:'m1'},{provider:'p',model:'m2'}]});
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'work'}});
  const child=h.pending[0];
  const agent=subagent(child.childId,{provider:'p',model:'m1'},true);
  const outcome=await h.waterfall('agent/request-error',{agent,turn:1,step:1,failure:{code:'TIMEOUT'}},undefined);
  // THE NEW CONTRACT: no retry verdict — the plugin selects the next candidate
  // and cuts+resumes the in-flight attempt in one synchronous window.
  assert.equal(outcome,undefined);
  assert.deepEqual(agent.model.selects,[{provider:'p',model:'m2'}]);
  assert.equal(agent.cancels.length,1);
  assert.deepEqual(agent.cancels[0],{cause:{kind:'hook',reason:'error-switch'},options:{keepInbox:true}});
  assert.equal(agent.followups.length,1,'the cut attempt is resumed on the new route');
  assert.equal(agent.followups[0].source.form,'failover-continuation');
  assert.match(agent.followups[0].content.map((part)=>part.text).join(''),/p\/m2/);
  // The rebuilt request itself is never rewritten (the host freezes the
  // selection and throws on a proposal that differs); the target is re-picked
  // through the front door while the seed still lags.
  const seed={provider:'p',model:'m1',reasoningEffort:'max',maxTokens:100};
  const switched=await h.waterfall('agent/request',{agent},seed);
  assert.deepEqual(switched,seed);
  assert.equal(agent.model.selects.length,2,'the target is re-picked while the seed lags');
  h.dispose();
});

// ── unusable candidates: a dead row must not win the pool forever ────────────
//
// Found on a live run: a candidate the gateway refused with
// `model [gpt-6.1-sol] is not allowed for user type [personal_free_user]` came
// back as `INVALID_REQUEST`, which was not failover-eligible — so the row was
// neither skipped nor cooled, kept looking idle (it never ran long), and won its
// turn in the pool on every delegation only to fail once more.

test('a model-level 400 counts as an unusable candidate, a malformed request does not',()=>{
  assert.equal(isUnusableCandidate({code:'INVALID_REQUEST',message:'WorkBuddy AI: model [gpt-6.1-sol] is not allowed for user type [personal_free_user]'}),true);
  assert.equal(isUnusableCandidate({code:'INVALID_REQUEST',message:'no such model: foo/bar'}),true);
  assert.equal(isUnusableCandidate({code:'UNKNOWN_MODEL',message:'whatever'}),true);
  assert.equal(isUnusableCandidate({code:'UNSUPPORTED_REASONING_EFFORT',message:'x'}),true);
  // A genuine request bug must fail fast instead of burning the whole pool.
  assert.equal(isUnusableCandidate({code:'INVALID_REQUEST',message:'messages[3].content: expected string'}),false);
  assert.equal(isUnusableCandidate({code:'TIMEOUT',message:'timeout'}),false);
  assert.equal(isUnusableCandidate(undefined),false);
});

test('an unusable candidate is cooled down and the next task skips it',async()=>{
  const h=poolHarness();
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'first'}});
  const child=h.pending[0];
  child.resolve({status:'ok'});
  await h.flush();
  await h.waterfall('agent/request-error',{
    agent:subagent(child.childId,{provider:'p',model:'m1'}),
    failure:{code:'INVALID_REQUEST',message:'model [m1] is not allowed for user type [personal_free_user]'}
  },undefined);
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'second'}});
  assert.deepEqual(h.models(),['m1','m2']);
  assert.ok(h.warns.some((args)=>String(args[0]).includes('cannot serve this request')));h.dispose();
});

test('an unusable candidate also fails over inside its own pool',async()=>{
  const h=poolHarness({patchModels:[{provider:'p',model:'m1'},{provider:'p',model:'m2'}]});
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'work'}});
  const agent=subagent(h.pending[0].childId,{provider:'p',model:'m1'},true);
  const outcome=await h.waterfall('agent/request-error',{agent,turn:1,step:1,failure:{code:'UNKNOWN_MODEL',message:'no such model'}},undefined);
  assert.equal(outcome,undefined,'a switch is a cut+resume, never a retry verdict');
  assert.deepEqual(agent.model.selects,[{provider:'p',model:'m2'}]);
  assert.equal(agent.cancels.length,1);
  assert.deepEqual(agent.cancels[0],{cause:{kind:'hook',reason:'error-switch'},options:{keepInbox:true}});
  assert.equal(agent.followups.length,1,'the resumed task is queued in the same window');
  assert.equal(agent.followups[0].source.form,'failover-continuation');
  const switched=await h.waterfall('agent/request',{agent},{provider:'p',model:'m1'});
  assert.deepEqual(switched,{provider:'p',model:'m1'});h.dispose();
});

test('an unexplained 400 switches once, then the real error surfaces',async()=>{
  // REVERSED ON PURPOSE (live session-7a929cab): the gateway answered a
  // perfectly good coordinator step with a bare 400 and the child stopped dead.
  // A subagent now moves to the next candidate on ANY failure except a
  // cancellation; the per-episode failed set keeps it to one round trip per
  // candidate, so a genuinely malformed request still surfaces (as the real
  // error) instead of looping forever.
  const h=poolHarness({patchModels:[{provider:'p',model:'m1'},{provider:'p',model:'m2'}]});
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'work'}});
  const agent=subagent(h.pending[0].childId,{provider:'p',model:'m1'},true);
  const outcome=await h.waterfall('agent/request-error',{agent,turn:1,step:1,failure:{code:'INVALID_REQUEST',message:'messages[2].content: expected string'}},undefined);
  assert.equal(outcome,undefined,'the first failure switches instead of asking for a retry');
  assert.deepEqual(agent.model.selects,[{provider:'p',model:'m2'}]);
  assert.equal(agent.cancels.length,1);
  assert.deepEqual(agent.cancels[0],{cause:{kind:'hook',reason:'error-switch'},options:{keepInbox:true}});
  assert.equal(agent.followups.length,1);
  const sentinel={kind:'continue'};
  // The second failure is attributed to the NEW selection (the fixture moves
  // `served` on select), and both candidates are now in the failed episode.
  const surfaced=await h.waterfall('agent/request-error',{agent,turn:1,step:2,failure:{code:'INVALID_REQUEST',message:'messages[2].content: expected string'}},sentinel);
  assert.equal(surfaced,sentinel,'the pool is exhausted after one switch, so the error must reach the user');
  assert.equal(agent.cancels.length,1,'nothing else was cut once the candidates ran out');h.dispose();
});
