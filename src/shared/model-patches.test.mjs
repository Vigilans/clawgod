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

const guardedEnv = 'function put(key,value){let upper=key.toUpperCase();return allowed.has(upper)||truthy.has(upper)&&isTrue(value)||falsy.has(upper)&&isFalse(value)||upper==="ANTHROPIC_CUSTOM_HEADERS"&&!unsafeHeaders(value)}';
const patchedEnv = apply('custom-alias-env-write', guardedEnv);
for (const enabled of [false, true]) {
  const context = {
    __clawgodPatches: { 'custom-alias-env-write': enabled },
    allowed: new Set(['KNOWN']), truthy: new Set(['DISABLE_TELEMETRY']),
    falsy: new Set(['OTEL_LOG_RAW_API_BODIES']),
    isTrue: value => value === '1', isFalse: value => value === '0',
    unsafeHeaders: value => value.includes('Authorization'),
  };
  for (const [key, value] of [
    ['KNOWN', 'value'], ['UNKNOWN', 'value'],
    ['DISABLE_TELEMETRY', '1'], ['DISABLE_TELEMETRY', '0'],
    ['OTEL_LOG_RAW_API_BODIES', '0'], ['OTEL_LOG_RAW_API_BODIES', '1'],
    ['ANTHROPIC_CUSTOM_HEADERS', 'X-Label: demo'],
    ['ANTHROPIC_CUSTOM_HEADERS', 'Authorization: test'],
  ]) {
    const call = `;put(${JSON.stringify(key)},${JSON.stringify(value)})`;
    assert.equal(runInNewContext(patchedEnv + call, context), runInNewContext(guardedEnv + call, context), key);
  }
  for (const suffix of ['MODEL', 'NAME', 'DESCRIPTION', 'SUPPORTED_CAPABILITIES']) {
    assert.equal(runInNewContext(patchedEnv + `;put("ANTHROPIC_DEFAULT_MY_ALIAS_${suffix}","value")`, context), enabled);
  }
}

for (const envObject of ['process.env', 'env']) for (const label of ['custom', 'display(custom)??custom']) {
  const picker = apply('custom-alias-picker',
    `if(custom&&!options.some((option)=>option.value===custom))options.push({value:custom,label:${envObject}.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME??${label},description:${envObject}.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION??\`Custom model (\${custom})\`});`);
  for (const enabled of [false, true]) for (const custom of [undefined, 'native-model']) {
    const env = {
      ANTHROPIC_DEFAULT_CUSTOM_MODEL: 'provider-model',
      ANTHROPIC_DEFAULT_CUSTOM_NAME: 'Display name',
      ANTHROPIC_DEFAULT_OTHER_ALIAS_MODEL: 'second-model',
      ANTHROPIC_DEFAULT_OTHER_ALIAS_DESCRIPTION: 'Second description',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'native-opus',
    };
    const options = [{value: 'opus'}];
    const context = {
      __clawgodPatches: { 'custom-alias-picker': enabled },
      process: {env}, env, custom, options, display: () => 'Native display',
    };
    runInNewContext(picker, context);
    runInNewContext(picker, context);
    assert.equal(options.length, 1 + (custom ? 1 : 0) + (enabled ? 2 : 0));
    if (custom) assert.equal(options.find(option => option.value === custom).label, label.includes('display') ? 'Native display' : custom);
    if (enabled) {
      assert.equal(options.find(option => option.value === 'custom').label, 'provider-model');
      assert.equal(options.find(option => option.value === 'custom').description, 'Custom Display name model');
      assert.equal(options.find(option => option.value === 'other-alias').description, 'Second description');
    }
  }
}

for (const guard of [
  'if(!model||builtIn(model))return{ok:!0,model:model};try{',
  'if(!model)return{ok:!0,model:model};if(builtIn(model))return{ok:!0,model:model.trim().toLowerCase()};try{',
]) {
  const command = 'async function choose(model){' + guard + 'return await validate(model)}catch(error){throw error}}';
  const patched = apply('custom-alias-command', command);
  for (const enabled of [false, true]) for (const value of [undefined, ' Opus ', 'custom', ' OTHER-ALIAS ', 'unknown']) {
    let calls = 0;
    const context = {
      __clawgodPatches: { 'custom-alias-command': enabled },
      process: {env: {ANTHROPIC_DEFAULT_CUSTOM_MODEL: 'provider-model', ANTHROPIC_DEFAULT_OTHER_ALIAS_MODEL: 'second-model'}},
      builtIn: model => model.trim().toLowerCase() === 'opus',
      validate: async model => { calls++; return {ok: false, model}; }, value,
    };
    const result = await runInNewContext(patched + ';choose(value)', context);
    const custom = value === 'custom' || value === ' OTHER-ALIAS ';
    assert.equal(result.ok, value === undefined || value === ' Opus ' || enabled && custom);
    assert.equal(calls, result.ok ? 0 : 1);
    if (!enabled || !custom) {
      const native = await runInNewContext(command + ';choose(value)', context);
      assert.equal(JSON.stringify(result), JSON.stringify(native));
    }
  }
}
console.log('[model-patches.test] expanded env guards, picker labels and split command validation ok');

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
