const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {tmpdir} = require('node:os');

const cli = fs.readFileSync(path.join(__dirname,'cli.cjs'),'utf8');
for(const platform of ['linux','win32']) for(const available of [false,true]){
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const root = platform === 'win32' ? 'D:\\测试 目录\\clawgod & tools' : '/test directory';
  const args = ['with spaces','a&b',...Array.from({length:12},(_,i)=>String(i))];
  const stop = {};
  let spawned,exit;
  assert.throws(()=>vm.runInNewContext(cli,{
    __dirname:root,console:{error(){}},
    process:{platform,argv:['bun',paths.join(root,'cli.cjs'),'import',...args],exit(code){exit=code;throw stop;}},
    require(name){
      if(name==='path')return paths;
      if(name==='os')return {};
      if(name==='fs')return {existsSync:()=>available};
      if(name==='child_process')return {spawnSync(executable,argv,options){spawned={executable,argv,options};return {status:7};}};
      throw Error('Unexpected module: '+name);
    },
  }),error=>error===stop);
  assert.equal(exit,available?7:127);
  if(available){
    assert.equal(spawned.executable,paths.join(root,'clawgod-import'+(platform==='win32'?'.exe':'')));
    assert.deepEqual(Array.from(spawned.argv),args);
    assert.equal(spawned.options.stdio,'inherit');
  }else assert.equal(spawned,undefined);
}
console.log('[launcher.test] import arguments and exit codes preserved');

if(process.platform !== 'win32'){
  console.log('[launcher.test] native .cmd checks require Windows');
}else{
  const directory = fs.mkdtempSync(path.join(tmpdir(),'clawgod-launcher-'));
  try{
    const artifact = path.join(directory,'测试 目录 & ! %PATH%');
    fs.mkdirSync(artifact);
    const entry = path.join(artifact,'cli.cjs');
    fs.writeFileSync(entry,'console.log(JSON.stringify({args:process.argv.slice(2),dir:process.env.CLAWGOD_DIR}));process.exit(process.argv.includes("--fail")?7:0);');
    const generator = path.join(directory,'generate.ps1');
    fs.writeFileSync(generator,`param($TemplatePath,$ClawDir,$OutputPath)
$ErrorActionPreference='Stop'
$bunPathInCmd=(Get-Command bun -ErrorAction Stop).Source
$template=[System.IO.File]::ReadAllText($TemplatePath)
$start=$template.IndexOf('$clawPathInCmd =')
$end=$template.IndexOf('# Find and back up original claude')
. ([scriptblock]::Create($template.Substring($start,$end-$start)))
[System.IO.File]::WriteAllText($OutputPath,$launcherContent,(New-Object System.Text.UTF8Encoding $false))
`);
    const launcher = path.join(directory,'claude.cmd');
    const generated = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',generator,path.join(__dirname,'../templates/install.ps1'),artifact,launcher],{encoding:'utf8'});
    assert.ifError(generated.error);
    assert.equal(generated.status,0,generated.stdout+generated.stderr);
    for(const fail of [false,true]){
      const args = ['C:\\extension path\\claude.exe','--help','prompt with spaces & 字',...(fail?['--fail']:[])];
      const command = `""${launcher}" ${args.map(arg=>`"${arg}"`).join(' ')}"`;
      const result = spawnSync('cmd.exe',['/d','/s','/c',command],{windowsVerbatimArguments:true,encoding:'utf8'});
      assert.ifError(result.error);
      assert.equal(result.status,fail?7:0,result.stdout+result.stderr);
      assert.deepEqual(JSON.parse(result.stdout),{args,dir:artifact});
    }
  }finally{
    fs.rmSync(directory,{recursive:true,force:true});
  }
  console.log('[launcher.test] native .cmd paths, argv and exit codes preserved');
}
