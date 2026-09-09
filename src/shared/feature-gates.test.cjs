const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const meta = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'patch.mjs'), '--dump-features'], {encoding:'utf8'}));
const source = fs.readFileSync(path.join(__dirname, 'feature-gates.cjs'), 'utf8').replace('// {{CLAWGOD:FEATURES_META}}', `const CLAWGOD_FEATURES_META=${JSON.stringify(meta)};`);
function load(config, env = {}) {
  const module = {exports:{}};
  const context = { module, __dirname:'/install', process:{env, argv:[], stderr:{write(){}}}, require(name) {
    if (name === 'path') return path;
    if (name === 'fs') return {readFileSync() { if(config === undefined) throw Object.assign(new Error('missing'),{code:'ENOENT'}); return JSON.stringify(config); }};
    throw new Error(name);
  }};
  vm.runInNewContext(source, context);
  return {gates:context.__clawgodPatches, ...module.exports};
}
assert.equal(load().gates['custom-alias-schema'], true);
assert.equal(load({'custom-model-aliases':false}).gates['custom-alias-schema'], false);
assert.equal(load({'custom-model-aliases':false}, {CLAWGOD_FEATURE_CUSTOM_MODEL_ALIASES:'true'}).gates['custom-alias-schema'], true);
assert.equal(load({}, {CLAWGOD_FEATURE_PROVIDER_CONFIG:'false'}).isEnabled('provider-config'), false);
assert.equal(load({}, {CLAWGOD_FEATURE_PROVIDER_CONFIG:'invalid'}).isEnabled('provider-config'), true);
assert.throws(()=>load({enabled:[]}), /Legacy patches.json/);
const disabled = Object.fromEntries([...new Set(Object.values(meta).flat())].map(id=>[id,false]));
assert.ok(Object.values(load(disabled).gates).every(value=>value === false));

const cli = fs.readFileSync(path.join(__dirname, 'cli.cjs'),'utf8');
for (const platform of ['linux','win32']) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const home = platform === 'win32' ? 'C:\\Users\\test' : '/users/test';
  const root = paths.join(home,'.clawgod');
  let writes=0, loaded;
  const fakeFs={
    existsSync(){return true;},
    readFileSync(file){
      if (file.endsWith('provider.json')) return '{"baseURL":"https://test.invalid"}';
      if (file.endsWith('features.json')) return '{"test":true}';
      throw Error('Unexpected read: '+file);
    },
    writeFileSync(){writes++;}, mkdirSync(){writes++;}, renameSync(){writes++;},
    readdirSync(){return [];}, rmSync(){writes++;},
  };
  const env={};
  vm.runInNewContext(cli, {
    __dirname:root, process:{platform,env,argv:['bun','cli.cjs'],execPath:'bun',stderr:{write(){}},on(){}},
    require(name){
      if(name==='fs')return fakeFs;
      if(name==='path')return paths;
      if(name==='os')return {homedir:()=>home};
      if(name==='child_process')return {spawnSync(){throw Error('Unexpected subprocess');}};
      if(name==='./feature-gates.cjs')return load(disabled);
      if(name==='./runtime-helpers.cjs')return {};
      if(name.endsWith('cli.original.cjs')){loaded=name;return {};}
      throw Error(name);
    },
  });
  assert.equal(writes,0,platform);
  assert.equal(env.ANTHROPIC_BASE_URL,undefined);
  assert.equal(env.CLAUDE_INTERNAL_FC_OVERRIDES,undefined);
  assert.ok(loaded.endsWith('cli.original.cjs'));
}
console.log('[feature-gates.test] config precedence and disabled wrapper actions ok');
