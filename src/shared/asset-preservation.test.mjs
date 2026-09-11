import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';

const here=dirname(fileURLToPath(import.meta.url));
const root=mkdtempSync(join(tmpdir(),'clawgod-assets-'));
try{
  mkdirSync(join(root,'bunfs'));
  const binary=Buffer.from([0x28,0xb5,0x2f,0xfd,0,0x80,0xff]);
  for(const name of ['bundle.js','bundle.mjs'])writeFileSync(join(root,'bunfs',name),binary);
  writeFileSync(join(root,'cli.original.js'),'// @bun\nimport "/$bunfs/root/chunk.js";');
  writeFileSync(join(root,'bunfs','chunk.js'),
    '// @bun\nconst asset="/$bunfs/root/bundle.js",title="中文 ✓";function userType(){return"external"}');
  writeFileSync(join(root,'pathmap.json'),JSON.stringify({
    '/$bunfs/root/chunk.js':'bunfs/chunk.js',
    '/$bunfs/root/bundle.js':'bunfs/bundle.js',
  }));
  for(const [script,args] of [['post-process.mjs',[root]],['patch.mjs',['--target',root]]]){
    const result=spawnSync(process.execPath,[join(here,script),...args],{encoding:'utf8'});
    assert.ifError(result.error);
    assert.equal(result.status,0,result.stdout+result.stderr);
    for(const name of ['bundle.js','bundle.mjs'])assert.deepEqual(readFileSync(join(root,'bunfs',name)),binary,script+' '+name);
    const chunk=readFileSync(join(root,'bunfs','chunk.js'),'utf8');
    assert.ok(chunk.includes('"./bundle.js"'));
    assert.ok(chunk.includes('中文 ✓'));
  }
  assert.ok(readFileSync(join(root,'bunfs','chunk.js'),'utf8').includes('__clawgodPatches?.["user-type-ant"]'));
}finally{
  rmSync(root,{recursive:true,force:true});
}
console.log('[asset-preservation.test] post-processing and patching preserve binary .js/.mjs assets');
