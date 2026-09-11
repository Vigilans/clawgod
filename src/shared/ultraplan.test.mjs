import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';

const source=readFileSync(new URL('./patch.mjs',import.meta.url),'utf8');
const patches=new Function(source.slice(source.indexOf('const FEATURES ='),source.indexOf('// ─── Main'))+';return patches')();
const patch=patches.find(p=>p.id==='ultraplan');
for(const [description,availability,original,policyGate] of [
  ['description:`Draft a plan`,','','!1',''],
  ['get description(){return`Draft a plan`},','','allowed()',''],
  ['get description(){return`Draft a plan`},','availability:["claude-ai"],','allowed()','policyGate:policy,'],
]) {
  const fixture=`({type:"local-jsx",name:"ultraplan",${description}argumentHint:"<prompt>",${availability}isEnabled:()=>${original},${policyGate}load:()=>loader()})`;
  assert.equal([...fixture.matchAll(patch.pattern)].length,1,fixture);
  assert.equal([...fixture.replace('name:"ultraplan"','name:"other"').matchAll(patch.pattern)].length,0);
  const patched=fixture.replace(patch.pattern,patch.replacer);
  for(const enabled of [undefined,false,true]) for(const native of [false,true]) {
    let calls=0;
    const policy={policy:'allow_remote_sessions',featureLabel:'Remote sessions'};
    const loaded={call:()=>{}};
    const context={
      __clawgodPatches:enabled===undefined?undefined:{ultraplan:enabled},
      allowed:()=>{calls++;return native},policy,loader:()=>loaded,
    };
    const result=runInNewContext(patched,context);
    assert.equal(result.isEnabled(),enabled!==false||original!=='!1'&&native);
    assert.equal(calls,enabled===false&&original!=='!1'?1:0);
    assert.equal(result.name,'ultraplan');
    assert.equal(result.description,'Draft a plan');
    assert.equal(result.argumentHint,'<prompt>');
    assert.equal(JSON.stringify(result.availability),availability?'["claude-ai"]':undefined);
    assert.equal(result.policyGate,policyGate?policy:undefined);
    assert.equal(result.load(),loaded);
  }
}
console.log('[ultraplan.test] legacy and current command gates preserve availability, policy and loader metadata');
