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

const aliasSchema = apply('custom-alias-schema', '({model:z.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Pick a model`)})');
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
