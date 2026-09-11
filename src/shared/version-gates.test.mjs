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

for(const method of [
  'getEnvironmentOverrides(){if(this.environmentOverridesParsed)return this.environmentOverrides;return this.environmentOverridesParsed=!0,this.environmentOverrides;let e=this.deps.readEnvironmentOverrides();if(!e)return this.environmentOverrides;try{this.environmentOverrides=JSON.parse(e)}catch{}return this.environmentOverrides}',
  'getEnvironmentOverrides(){return null}',
]) for(const enabled of [false,true]) for(const raw of [undefined,'','invalid','null','{"off":false,"nested":{"value":"override"}}']) {
  const stub=method.includes('return null');
  const fixture='class GrowthBook{constructor(deps){this.deps=deps;this.environmentOverridesParsed=false;this.environmentOverrides=null;this.environmentOverridesRaw=undefined}'+method+
    'checkGateCachedOrBlocking(key){let overrides=this.getEnvironmentOverrides();if(overrides&&key in overrides)return Boolean(overrides[key]);return true}};new GrowthBook(deps)';
  let reads=0;
  const client=runInNewContext(apply('growthbook-env-overrides-graph',fixture),{
    __clawgodPatches:{'growthbook-env-overrides-graph':enabled},
    deps:{readEnvironmentOverrides:()=>{reads++;return raw}},
  });
  const result=client.getEnvironmentOverrides();
  assert.equal(client.getEnvironmentOverrides(),result);
  assert.equal(reads,enabled?(stub?2:1):0);
  assert.equal(client.checkGateCachedOrBlocking('off'),enabled&&raw?.startsWith('{')?false:true);
  assert.equal(client.checkGateCachedOrBlocking('missing'),true);
  assert.equal(result?.nested?.value,enabled&&raw?.startsWith('{')?'override':undefined);
  if(!enabled)assert.equal(result,null);
}
console.log('[version-gates.test] graph env overrides parse once, preserve false and respect disabled gates');

const dynamicOverrides=apply('growthbook-env-overrides-graph',
  'class GrowthBook{environmentOverrides=null;environmentOverridesRaw=void 0;constructor(deps){this.deps=deps}getEnvironmentOverrides(){return null}reset(){this.environmentOverrides=null,this.environmentOverridesRaw=void 0}};new GrowthBook(deps)');
let raw='{"enabled":true}',parses=0,reads=0;
const gates={'growthbook-env-overrides-graph':true};
const client=runInNewContext(dynamicOverrides,{
  __clawgodPatches:gates,
  deps:{readEnvironmentOverrides:()=>{reads++;return raw}},
  JSON:{parse(value){parses++;return JSON.parse(value)}},
});
assert.equal(client.getEnvironmentOverrides().enabled,true);
client.getEnvironmentOverrides();
assert.equal(parses,1);
raw='{"enabled":false}';
assert.equal(client.getEnvironmentOverrides().enabled,false);
assert.equal(parses,2);
client.reset();
assert.equal(client.getEnvironmentOverrides().enabled,false);
assert.equal(parses,3);
gates['growthbook-env-overrides-graph']=false;
const beforeDisabled=reads;
assert.equal(client.getEnvironmentOverrides(),null);
assert.equal(reads,beforeDisabled);
gates['growthbook-env-overrides-graph']=true;
for(raw of ['"text"','7','true','[]','null','invalid','',undefined]) {
  assert.equal(client.getEnvironmentOverrides(),null);
}
console.log('[version-gates.test] compact getter handles config changes, reset, disabled reads and invalid values');
