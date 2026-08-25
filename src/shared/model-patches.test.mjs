import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('./patch.mjs', import.meta.url), 'utf8');
const { patches } = new Function(source.slice(source.indexOf('const FEATURES ='), source.indexOf('// ─── Main')) + '\nreturn { patches };')();
function apply(id, input) {
  const patch = patches.find(p => p.id === id);
  assert.ok(patch, id);
  assert.equal([...input.matchAll(patch.pattern)].length, 1, id);
  return input.replace(patch.pattern, patch.replacer);
}

const aliasEnv = apply('custom-alias-env', 'for(let[key,value]of Object.entries(vars))if(allowed.has(key.toUpperCase()))process.env[key]=value');
for (const enabled of [false, true]) {
  const env = {};
  runInNewContext(aliasEnv, {
    __clawgodPatches: { 'custom-alias-env': enabled },
    vars: { ANTHROPIC_DEFAULT_CUSTOM_MODEL: 'custom-provider-model' },
    allowed: new Set(), process: { env },
  });
  assert.equal(env.ANTHROPIC_DEFAULT_CUSTOM_MODEL, enabled ? 'custom-provider-model' : undefined);
}

const aliasSchema = apply('custom-alias-schema', '({model:z.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Pick a model`),run_in_background:false})');
for (const enabled of [false, true]) {
  const result = runInNewContext(aliasSchema, {
    __clawgodPatches: { 'custom-alias-schema': enabled },
    process: { env: { ANTHROPIC_DEFAULT_CUSTOM_MODEL: 'custom-provider-model' } },
    z: { enum(values) { return { optional() { return this; }, describe(description) { return {values, description}; } }; } },
  });
  assert.equal(result.model.values.includes('custom'), enabled);
  assert.equal(result.model.description, 'Pick a model' + (enabled ? ' Custom aliases are configured with ANTHROPIC_DEFAULT_<ALIAS>_MODEL.' : ''));
}

console.log('[model-patches.test] custom alias gates ok');

const metadata = apply('agent-model-metadata', 'async function*spawn({agentDefinition:def,toolUseContext:ctx,model:chosen,}){let perm=permissions(ctx),mode=perm.mode,resolved=resolve(def,chosen,mode,void 0);yield{agentType:def.agentType,...ctx.agentId&&{parentAgentId:ctx.agentId},}}');
for (const enabled of [false, true]) {
  const result = await runInNewContext(metadata + ';spawn({agentDefinition:{agentType:"test"},toolUseContext:{},model:"chosen"}).next()', {
    __clawgodPatches: { 'agent-model-metadata': enabled },
    permissions: () => ({mode:'default'}), resolve: () => 'resolved-model',
  });
  assert.equal(result.value.model, enabled ? 'resolved-model' : undefined);
}
console.log('[model-patches.test] resume metadata gate ok');

const hook = patches.find(p => p.id === 'hook-input-validation');
const hookCode = hook.replacer('if(result.updatedInput!==void 0){validate();}', 'result', 'parsed', 'tool');
const permission = patches.find(p => p.id === 'hook-permission-validation');
const permissionCode = 'if(' + permission.replacer('', 'decision', 'isEmpty', 'tool', '){validate()} // ');
for (const enabled of [false, true]) for (const name of ['Agent', 'Bash']) {
  let calls = 0;
  runInNewContext(hookCode, {
    __clawgodPatches: { 'hook-input-validation': enabled },
    result: {updatedInput:{model:'custom'}}, tool:{name}, validate:()=>calls++,
  });
  assert.equal(calls, enabled && name === 'Agent' ? 0 : 1);
  for (const changed of [false, true]) {
    calls = 0;
    runInNewContext(permissionCode, {
      __clawgodPatches: { 'hook-permission-validation': enabled },
      decision:{updatedInput:{model:changed?'permission-model':'hook-model'}},
      _cgHookInput:{model:'hook-model'}, tool:{name}, isEmpty:()=>false, validate:()=>calls++,
    });
    assert.equal(calls, enabled && name === 'Agent' && !changed ? 0 : 1);
  }
}
console.log('[model-patches.test] hook validation gates ok');

const writeGate = apply('custom-alias-env-write','function put(key,value){let upper=key.toUpperCase();return allowed.has(upper)||truthy.has(upper)&&enabled(value)}');
for (const enabled of [false,true]) {
  const allowed = new Set(['KNOWN']);
  const context = {__clawgodPatches:{'custom-alias-env-write':enabled},allowed,truthy:new Set(),enabled:()=>true};
  assert.equal(runInNewContext(writeGate+';put("ANTHROPIC_DEFAULT_CUSTOM_MODEL","value")',context),enabled);
  assert.equal(runInNewContext(writeGate+';put("KNOWN","value")',context),true);
}
console.log('[model-patches.test] project alias write gate ok');

const expressionSchema = apply('custom-alias-schema','({model:z(["sonnet","opus","haiku","fable"]).optional().describe(`Pick`+(extra?" extended":"")),run_in_background:false})');
for (const enabled of [false,true]) {
  const result=runInNewContext(expressionSchema,{
    __clawgodPatches:{'custom-alias-schema':enabled},extra:true,
    process:{env:{ANTHROPIC_DEFAULT_CUSTOM_MODEL:'custom-provider-model'}},
    z(values){return {optional(){return this;},describe(description){return {values,description};}};},
  });
  assert.equal(result.model.description,'Pick extended'+(enabled?' Custom aliases are configured with ANTHROPIC_DEFAULT_<ALIAS>_MODEL.':''));
  assert.equal(result.model.values.includes('custom'),enabled);
}
console.log('[model-patches.test] expression-based Agent model descriptions ok');
