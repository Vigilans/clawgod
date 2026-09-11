import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';

const patcher=join(dirname(fileURLToPath(import.meta.url)),'patch.mjs');
const source=readFileSync(patcher,'utf8');
const patches=new Function(source.slice(source.indexOf('const FEATURES ='),source.indexOf('// ─── Main'))+';return patches')();
const root=mkdtempSync(join(tmpdir(),'clawgod-patch-diagnostics-'));
let sequence=0;
function run(fixture,graph=false){
  const target=join(root,String(sequence++));
  mkdirSync(target);
  writeFileSync(join(target,'cli.original.cjs'),graph?'0;':fixture);
  const file=graph?join(target,'bunfs','chunk.js'):join(target,'cli.original.cjs');
  if(graph){mkdirSync(join(target,'bunfs'));writeFileSync(file,fixture);}
  const result=spawnSync(process.execPath,[patcher,'--target',target],{encoding:'utf8'});
  assert.ifError(result.error);
  return {...result,content:readFileSync(file,'utf8')};
}

try{
  for(const [id,fixture] of [
    ['custom-alias-env-write','function changed(key,value){return key==="ANTHROPIC_CUSTOM_HEADERS"&&!unsafe(value)}'],
    ['custom-alias-picker','const changed=env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION??"custom";'],
    ['custom-alias-command','const changed="Failed to validate model:";'],
    ['agent-model-metadata','const changed="Failed to write agent metadata:";'],
    ['growthbook-env-overrides-graph','class Changed{getEnvironmentOverrides(){return undefined}}'],
  ]) for(const graph of [false,true]){
    const result=run(fixture,graph);
    assert.equal(result.status,1,id);
    const patch=patches.find(p=>p.id===id);
    assert.ok(result.stdout.includes(`${patch.name} — regex stale`),result.stdout);
    assert.equal(result.content,fixture,'failed apply must leave source unchanged');
  }

  const absent=run('0;');
  assert.equal(absent.status,0);
  assert.match(absent.stdout,/Result: 0 applied/);
  assert.doesNotMatch(absent.stdout,/already applied/);

  const patch=patches.find(p=>p.id==='growthbook-env-overrides-graph');
  const original='class Features{getEnvironmentOverrides(){return null}}';
  const applied=original.replace(patch.pattern,patch.replacer);
  const recognized=run(applied,true);
  assert.equal(recognized.status,0,recognized.stdout);
  assert.ok(recognized.stdout.includes(`${patch.name} (already applied, runtime gate present)`));
  assert.equal(recognized.content,applied);
}finally{
  rmSync(root,{recursive:true,force:true});
}
console.log('[patch-diagnostics.test] stale required patches fail, absent variants skip and runtime gates prove prior application');
