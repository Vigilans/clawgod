import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';
import helpers from './runtime-helpers.cjs';
const source=readFileSync(new URL('./patch.mjs',import.meta.url),'utf8');
const patches=new Function(source.slice(source.indexOf('const FEATURES ='),source.indexOf('// ─── Main'))+';return patches')();
function apply(id,fixture){const p=patches.find(p=>p.id===id);assert.equal([...fixture.matchAll(p.pattern)].length,1,id);return fixture.replace(p.pattern,p.replacer);}
const timeout=apply('classifier-timeout','function deadline(tokens){let steps=Math.max(0,Math.ceil((tokens-50000)/50000));return Math.min(cap,base+steps*1e4)}');
const model=apply('classifier-model','function choose(){let main=mainModel(),cfg=config(),model=resolve(cfg?.modelByMainModel,{vet:validate})??fallback(cfg?.model,"model");if(model)return{value:model,src:"gb"};return{value:"native",src:"default"}}');
const retries=apply('classifier-retries','function attempts(){let count=config()?.maxRetries;return typeof count==="number"&&Number.isInteger(count)&&count>=0?{value:count,src:"gb"}:{value:limit,src:"default"}}');
for(const enabled of [false,true]) {
  const result=runInNewContext(timeout+';deadline(50000)',{
    __clawgodPatches:{'classifier-timeout':enabled},__clawgodHelpers:helpers,
    process:{env:{CLAWGOD_CLASSIFIER_TIMEOUT_MS:'200000'}},cap:120000,base:60000,
  });
  assert.equal(result,enabled?200000:60000);
  const selected=runInNewContext(model+';choose()',{
    __clawgodPatches:{'classifier-model':enabled},process:{env:{CLAWGOD_CLASSIFIER_MODEL:' custom-model '}},
    mainModel:()=>'',config:()=>({}),resolve:()=>undefined,fallback:()=>undefined,validate:()=>true,
  });
  assert.equal(selected.value,enabled?'custom-model':'native');
  for(const value of ['7','-1','', 'invalid']) {
    const count=runInNewContext(retries+';attempts()',{
      __clawgodPatches:{'classifier-retries':enabled},process:{env:{CLAWGOD_CLASSIFIER_RETRIES:value}},config:()=>({maxRetries:2}),limit:4,
    });
    assert.equal(count.value,enabled&&value==='7'?7:2);
  }
}
console.log('[classifier.test] emitted timeout/model/retries gates ok');
