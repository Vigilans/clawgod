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
for (const platform of ['linux','win32']) for (const thirdParty of [false,true]) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const home = platform === 'win32' ? 'C:\\Users\\test' : '/users/test';
  const root = paths.join(home,'.clawgod');
  let writes=0, loaded;
  const fakeFs={
    existsSync(){return true;},
    readFileSync(file){
      if (file.endsWith('provider.json')) return '{"baseURL":"https://test.invalid"}';
      if (file.endsWith('features.json')) return '{"test":true}';
      if (file.endsWith('settings.json')) return '{"disableRemoteControl":true}';
      throw Error('Unexpected read: '+file);
    },
    writeFileSync(){writes++;}, mkdirSync(){writes++;}, renameSync(){writes++;},
    readdirSync(){return [];}, rmSync(){writes++;},
  };
  const env=thirdParty ? {ANTHROPIC_BASE_URL:'https://test.invalid'} : {};
  vm.runInNewContext(cli, {
    __dirname:root, process:{platform,env,argv:['bun','cli.cjs'],execPath:'bun',stderr:{write(){}},on(){}},
    require(name){
      if(name==='fs')return fakeFs;
      if(name==='path')return paths;
      if(name==='os')return {homedir:()=>home};
      if(name==='child_process')return {spawnSync(){throw Error('Unexpected subprocess');}};
      if(name==='./feature-gates.cjs')return load({...disabled,'remove-attribution-header':thirdParty});
      if(name==='./runtime-helpers.cjs')return {};
      if(name.endsWith('cli.original.cjs')){loaded=name;return {};}
      throw Error(name);
    },
  });
  assert.equal(writes,thirdParty?1:0,platform);
  assert.equal(env.ANTHROPIC_BASE_URL,thirdParty?'https://test.invalid':undefined);
  assert.equal(env.CLAUDE_CODE_ATTRIBUTION_HEADER,thirdParty?'0':undefined);
  assert.equal(env.CLAUDE_INTERNAL_FC_OVERRIDES,undefined);
  assert.ok(loaded.endsWith('cli.original.cjs'));
}
console.log('[feature-gates.test] config precedence and disabled wrapper actions ok');

const {mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync} = fs;
const {tmpdir} = require('node:os');
const {spawnSync} = require('node:child_process');
const directory = mkdtempSync(path.join(tmpdir(), 'clawgod-migration-test-'));
try {
  const helper = path.join(directory,'feature-gates.cjs');
  const config = path.join(directory,'patches.json');
  writeFileSync(helper,source);
  const run = (...args) => spawnSync(process.execPath,[helper,...(args.length?args:['--migrate'])],{encoding:'utf8',env:{}});
  const original = '\ufeff{ "enabled": ["features.anthropic-user-type", "features.custom-model-aliases"] }\n';
  writeFileSync(config,original);
  assert.equal(run('--check').status,0);
  assert.equal(run('--enabled','custom-model-aliases').stdout,'1\n');
  assert.equal(readFileSync(config,'utf8'),original);
  assert.equal(readdirSync(directory).filter(name=>name.includes('.legacy-')).length,0);
  assert.equal(run().status,0);
  const converted = JSON.parse(readFileSync(config,'utf8'));
  assert.equal(converted['anthropic-user-type'],true);
  assert.equal(converted['message-filter'],true);
  assert.equal(converted['custom-model-aliases'],true);
  assert.equal(converted.theme,false);
  assert.equal(converted['provider-config'],false);
  assert.equal(converted['classifier-tuning'],undefined);
  const backup = readdirSync(directory).find(name=>name.includes('.legacy-'));
  assert.equal(readFileSync(path.join(directory,backup),'utf8'),original);
  const once = readFileSync(config,'utf8');
  assert.equal(run().status,0);
  assert.equal(readFileSync(config,'utf8'),once);
  assert.equal(readdirSync(directory).filter(name=>name.includes('.legacy-')).length,1);
  writeFileSync(config,'{"enabled":["unknown-capability"]}');
  assert.notEqual(run().status,0);
  assert.equal(readFileSync(config,'utf8'),'{"enabled":["unknown-capability"]}');
  writeFileSync(config,'{"enabled":[]}');
  assert.equal(run().status,0);
  assert.ok(Object.values(JSON.parse(readFileSync(config,'utf8'))).every(value=>value === false));
} finally { rmSync(directory,{recursive:true,force:true}); }
console.log('[feature-gates.test] legacy migration, backup and repeat install ok');
