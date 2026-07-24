const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'cli.cjs'),'utf8');
for(const platform of ['linux','win32']) {
  const paths=platform==='win32'?path.win32:path.posix;
  const root=platform==='win32'?'D:\\cache 测试':'/cache test';
  const native=paths.join(root,'anthropic.claude-code-2.1.250-test','resources','native-binary',platform==='win32'?'claude.exe':'claude');
  const files=new Map([[native,''],[paths.join(root,'cli.original.cjs'),''],[paths.join(root,'.source-version'),'2.1.241']]);
  let version='2.1.250',builds=0,fail=false,loaded;
  const fakeFs={
    existsSync:p=>files.has(p),readFileSync:p=>{if(!files.has(p))throw Error('missing');return files.get(p);},
    mkdirSync:p=>files.set(p,''),writeFileSync:(p,v)=>files.set(p,v),readdirSync:()=>[],
    rmSync(p){for(const key of [...files.keys()])if(key===p||key.startsWith(p+paths.sep))files.delete(key);},
    renameSync(from,to){for(const [key,value] of [...files])if(key===from||key.startsWith(from+paths.sep)){files.set(to+key.slice(from.length),value);files.delete(key);}},
  };
  function launch(){
    const env={CLAUDE_CODE_ENTRYPOINT:'claude-vscode'};
    const argv=['bun',paths.join(root,'cli.cjs'),native,'--help'];
    vm.runInNewContext(source,{
      __dirname:root,process:{platform,env,argv,execPath:'bun',pid:1,stderr:{write(){}},on(){}},
      require(name){
        if(name==='fs')return fakeFs;
        if(name==='path')return paths;
        if(name==='os')return {homedir:()=>root};
        if(name==='./feature-gates.cjs')return {isEnabled:()=>false};
        if(name==='./runtime-helpers.cjs')return {};
        if(name==='child_process')return {spawnSync(exe,args){
          if(exe===native)return {status:0,stdout:version+' (Claude Code)'};
          builds++;
          if(fail)return {status:1};
          const stage=args[2];
          files.set(stage,'');files.set(paths.join(stage,'cli.original.cjs'),'');files.set(paths.join(stage,'.source-version'),version);
          return {status:0};
        }};
        if(name.endsWith('cli.original.cjs')){loaded=name;return {};}
        throw Error(name);
      },
    });
    assert.deepEqual(argv,['bun',paths.join(root,'cli.cjs'),'--help']);
    assert.equal(env.CLAUDE_CODE_EXECPATH,native);
    return loaded;
  }
  const cached=paths.join(root,'versions',version,'cli.original.cjs');
  assert.equal(launch(),cached);
  assert.equal(launch(),cached);
  assert.equal(builds,1);
  assert.ok([...files.keys()].every(key=>!key.includes('.tmp-')));
  version='2.1.246';assert.equal(launch(),paths.join(root,'versions',version,'cli.original.cjs'));
  assert.equal(builds,2);
  fail=true;version='2.1.245';assert.equal(launch(),paths.join(root,'cli.original.cjs'));
  assert.ok([...files.keys()].every(key=>!key.includes('.tmp-')));
}
console.log('[cache.test] cold build, cache hit, version switch and failure fallback ok');
