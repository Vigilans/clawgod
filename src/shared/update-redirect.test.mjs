import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('./patch.mjs',import.meta.url),'utf8');
const patches=new Function(source.slice(source.indexOf('const FEATURES ='),source.indexOf('// ─── Main'))+';return patches;')();
const patch=patches.find(p=>p.id==='update-redirect');
const original='cmd.command("update").alias("upgrade").description("Update Claude").action(async()=>{nativeUpdate()})';
assert.equal([...original.matchAll(patch.pattern)].length,1);
const code=original.replace(patch.pattern,patch.replacer);
for(const platform of ['linux','win32']) for(const enabled of [false,true]) {
  let action,spawn,native=0,allowUnknown;
  const stop={};
  const env={CLAWGOD_DIR:'custom-directory'};
  const cmd={command(){return this;},alias(){return this;},description(){return this;},allowUnknownOption(value){allowUnknown=value;return this;},action(fn){action=fn;return this;}};
  runInNewContext(code,{
    cmd,__clawgodPatches:{'update-redirect':enabled},
    process:{platform,env,argv:['bun','cli.cjs','update','--version','2.1.250'],stderr:{write(){}},exit(){throw stop;}},
    nativeUpdate(){native++;},
    require(name){assert.equal(name,'child_process');return {spawnSync(executable,args,options){spawn={executable,args,options};return {status:0};}};},
  });
  try{await action();}catch(error){assert.equal(error,stop);}
  assert.equal(native,enabled?0:1);
  assert.equal(allowUnknown,enabled);
  if(enabled){
    const installer=platform==='win32'?Buffer.from(spawn.args.at(-1),'base64').toString('utf16le'):spawn.args.at(-1);
    assert.ok(installer.includes('raw.githubusercontent.com/Vigilans/clawgod/dev/install.'+(platform==='win32'?'ps1':'sh')));
    assert.equal(env.CLAWGOD_VERSION,'2.1.250');
    assert.equal(spawn.options.env.CLAWGOD_DIR,'custom-directory');
  }else assert.equal(spawn,undefined);
}
console.log('[update-redirect.test] fork URLs, arguments and disabled native path ok');
