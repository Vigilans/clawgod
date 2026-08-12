import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('./patch.mjs',import.meta.url),'utf8');
const patches=new Function(source.slice(source.indexOf('const FEATURES ='),source.indexOf('// ─── Main'))+';return patches')();
function apply(id,fixture){const p=patches.find(p=>p.id===id);assert.equal([...fixture.matchAll(p.pattern)].length,1,id);return fixture.replace(p.pattern,p.replacer);}
for(const [id,fixture] of [
  ['computer-use-gate','function check(){return allowed()&&config().enabled}'],
  ['computer-use-gate','function check(){if(flag("hipaa"))return!1;return allowed()&&config().enabled}'],
  ['voice-mode','function check(){return!flag("tengu_amber_quartz_disabled",!1)}'],
  ['voice-mode','function check(){return allowed("allow_voice_mode")}'],
  ['agent-teams','function check(){if(!allowed(process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS)&&!allowed())return!1;if(!allowed("tengu_amber_flint",!0))return!1;return!0}'],
  ['agent-teams-graph','function check(){if(!env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS&&!allowed())return!1;if(!allowed("tengu_amber_flint",!0))return!1;return!0}'],
]) for(const enabled of [false,true]) {
  assert.equal(runInNewContext(apply(id,fixture)+';check()',{
    __clawgodPatches:{[id]:enabled},process:{env:{}},env:{},allowed:()=>false,config:()=>({enabled:false}),flag:()=>true,
  }),enabled,id);
}
for(const fixture of [
  'function read(){if(!parsed)parsed=!0;return cached}',
  'function read(){if(parsed)return cached;return parsed=!0,cached;let e=process.env.CLAUDE_INTERNAL_FC_OVERRIDES;if(e)cached=JSON.parse(e);return cached}',
]) for(const enabled of [false,true]) {
  const result=runInNewContext(apply('growthbook-env-overrides',fixture)+';read()',{
    __clawgodPatches:{'growthbook-env-overrides':enabled},parsed:false,cached:{native:true},process:{env:{CLAUDE_INTERNAL_FC_OVERRIDES:'{"override":true}'}},
  });
  assert.equal(result.override,enabled?true:undefined);
  assert.equal(result.native,enabled?undefined:true);
}
console.log('[version-gates.test] legacy and current gate shapes preserve native behavior when disabled');

for(const fixture of [
  'function read(){return}function next(){};read()',
  'class GrowthBook{readConfigOverrides(){return}getAllFeatures(){return 1}};new GrowthBook().readConfigOverrides()',
]) for(const enabled of [false,true]) {
  assert.equal(runInNewContext(apply('growthbook-config-overrides',fixture),{
    __clawgodPatches:{'growthbook-config-overrides':enabled},
  }),enabled?null:undefined);
}
console.log('[version-gates.test] GrowthBook function and class overrides ok');
