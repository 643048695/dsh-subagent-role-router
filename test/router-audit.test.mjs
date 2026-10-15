import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

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
