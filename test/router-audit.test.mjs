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
  const h=harness(); const agentOptions={provider:'memory',model:'fixed',maxTokens:8192,reasoningEffort:'low'};
  const request={parent:h.parent,prompt:'review',agentOptions};
  const result=await h.raw.startActivation({provider:'spawn',label:'Mnemon idle checkpoint review',request});
  assert.equal(result.request,request);
  const route=await h.waterfall('agent/request',{agent:{id:'memory',session:{header:{origin:'subagent'},snapshotEvents:()=>[]}}},agentOptions);
  assert.deepEqual(route,agentOptions);h.dispose();
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
  const team={provider:'fork',label:'agent-teams:team:成员',request:{parent:h.parent,prompt:'work',agentOptions:{provider:'team',model:'team-model'}}};
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

// DSH 0.2.x shape: the in-process fork backend exposes ONLY
// `prepareContinuable` — no `start`, and no separate driver package. The whole
// window-slicing feature therefore has to ride on that one method. A harness
// that still offers `fork.start` cannot catch a regression here, which is why
// this case builds the 0.2.x surface explicitly.
test('0.2.x fork backend without start is still sliced through prepareContinuable',async()=>{
  const listeners=new Map(),cleanups=[];
  const seed=[];
  for(let turn=0;turn<4;turn++){
    seed.push({type:'turn/start',seq:seed.length,time:1,data:{turn}});
    seed.push({type:'user/message',seq:seed.length,time:1,data:{id:`u${turn}`,role:'user',content:[{type:'text',text:`turn ${turn}`}],source:{kind:'user'}},surfaceOp:'append'});
    seed.push({type:'turn/end',seq:seed.length,time:1,data:{turn,reason:{kind:'completed'}}});
  }
  const parent={session:{snapshotEvents:()=>seed},options:{provider:'parent',model:'parent'}};
  const fork={
    name:'fork',
    capabilities:{agentOptions:true,agentPreset:false,outputSchema:true,depthLimit:true},
    inheritsParentContext:true,
    async prepareContinuable(){ return {seed}; }
  };
  const original=fork.prepareContinuable;
  const raw={getProvider:(n)=>n==='fork'?fork:undefined,async startActivation(spec){return spec;}};
  const ctx={
    subagents:raw,
    on(n,f){const l=listeners.get(n)??[];l.push(f);listeners.set(n,l);return()=>{};},
    effect(fn){const off=fn();if(typeof off==='function')cleanups.push(off);},
    inject(names,fn){if(names.includes('subagents'))fn(ctx);}
  };
  apply(ctx,{...config,forkWindowSlicing:true,forkWindowTurns:2});
  assert.notEqual(fork.prepareContinuable,original,'provider must be wrapped');

  const prepared=await fork.prepareContinuable({parent});
  assert.ok(prepared.seed.length<seed.length,'seed must be sliced down');
  assert.equal(prepared.seed.length,6,'two completed turns = 6 events');

  // Disabled: the provider must hand back the full history untouched.
  for(const off of cleanups.reverse())off();
  assert.equal(fork.prepareContinuable,original,'unload must restore the provider');
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

const subagent = (id, served) => ({
  id,
  session: {
    header: { origin: 'subagent' },
    snapshotEvents: () => [],
    requestContext: () => served
  }
});

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

test('an explicit model bypasses the pool and occupies no lane',async()=>{
  const h=poolHarness();
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'pinned',agentOptions:{provider:'x',model:'y'}}});
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'pooled'}});
  assert.deepEqual(h.models(),['y','m1']);h.dispose();
});

test('a role failure fails over inside its own pool, not the base pool',async()=>{
  const h=poolHarness({patchModels:[{provider:'p',model:'m1'},{provider:'p',model:'m2'}]});
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'work'}});
  const child=h.pending[0];
  const agent=subagent(child.childId,{provider:'p',model:'m1'});
  const retry=await h.waterfall('agent/request-error',{agent,turn:1,step:1,failure:{code:'TIMEOUT'}},undefined);
  assert.deepEqual(retry,{kind:'retry'});
  const seed={provider:'p',model:'m1',reasoningEffort:'max',maxTokens:100};
  const switched=await h.waterfall('agent/request',{agent},seed);
  assert.equal(switched.provider,'p');
  assert.equal(switched.model,'m2');
  assert.equal(switched.maxTokens,100);
  assert.equal(switched.reasoningEffort,undefined);h.dispose();
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
  const agent=subagent(h.pending[0].childId,{provider:'p',model:'m1'});
  const retry=await h.waterfall('agent/request-error',{agent,turn:1,step:1,failure:{code:'UNKNOWN_MODEL',message:'no such model'}},undefined);
  assert.deepEqual(retry,{kind:'retry'});
  const switched=await h.waterfall('agent/request',{agent},{provider:'p',model:'m1'});
  assert.equal(switched.model,'m2');h.dispose();
});

test('a malformed request still surfaces instead of switching candidates',async()=>{
  const h=poolHarness({patchModels:[{provider:'p',model:'m1'},{provider:'p',model:'m2'}]});
  h.raw.startActivation({provider:'spawn',label:'general task',request:{parent:h.parent,prompt:'work'}});
  const agent=subagent(h.pending[0].childId,{provider:'p',model:'m1'});
  const sentinel={kind:'continue'};
  const outcome=await h.waterfall('agent/request-error',{agent,turn:1,step:1,failure:{code:'INVALID_REQUEST',message:'messages[2].content: expected string'}},sentinel);
  assert.equal(outcome,sentinel);h.dispose();
});
