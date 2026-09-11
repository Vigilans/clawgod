const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {spawn,spawnSync} = require('node:child_process');
const {once} = require('node:events');
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
  console.log('[launcher.test] native executable checks require Windows');
}else{
  (async()=>{
  const directory = fs.mkdtempSync(path.join(tmpdir(),'clawgod-launcher-'));
  let held,heldClosed;
  try{
    const profile = path.join(directory,'profile');
    const bin = path.join(profile,'.local','bin');
    fs.mkdirSync(bin,{recursive:true});
    const artifact = path.join(directory,'测试 目录 & ! %PATH%');
    fs.mkdirSync(artifact);
    const entry = path.join(artifact,'cli.cjs');
    fs.writeFileSync(entry,`const args=process.argv.slice(2);
if(args[0]==='--version')console.log('0.0.1 (Claude Code)');
else if(args[0]==='--help')console.log('--model --print');
else if(args[0]==='--hold'){console.log('ready');process.stdin.resume();}
else if(args[0]==='--stdio'){process.stdin.pipe(process.stdout);}
else{console.log(JSON.stringify({args,dir:process.env.CLAWGOD_DIR,native:process.env.CLAUDE_CODE_EXECPATH,runtime:process.execPath}));process.exit(args.includes('--fail')?7:0);}
`);
    fs.writeFileSync(path.join(artifact,'patches.json'),'{"theme":false}\n');
    const bunPath = spawnSync('bun',['-p','process.execPath'],{encoding:'utf8'}).stdout.trim();
    fs.copyFileSync(bunPath,path.join(directory,'downloaded-claude.exe'));
    for(const name of ['claude','clawgod'])fs.writeFileSync(path.join(bin,name+'.cmd'),'@rem clawgod launcher\r\n');
    const generator = path.join(directory,'generate.ps1');
    fs.writeFileSync(generator,`param($TemplatePath,$ProfilePath,$ClawDir,[switch]$Uninstall,[string]$Runtime)
$ErrorActionPreference='Stop'
$env:USERPROFILE=$ProfilePath
$env:LOCALAPPDATA=Join-Path $ProfilePath 'AppData\\Local'
$BinDir=Join-Path $ProfilePath '.local\\bin'
$BunBin=if($Runtime){$Runtime}else{(Get-Command bun -ErrorAction Stop).Source}
$NativeBinLabel='0.0.1'
$NativeBin=Join-Path (Split-Path $ProfilePath) 'downloaded-claude.exe'
function Write-OK($message){Write-Output $message}
function Write-Dim($message){Write-Output $message}
$template=[System.IO.File]::ReadAllText($TemplatePath)
if($Uninstall){$start=$template.IndexOf('# --- Uninstall');$end=$template.IndexOf('# --- Prerequisites')}
else{$start=$template.IndexOf('# Find and back up original claude');$end=$template.IndexOf('# --- Ensure BinDir is in PATH')}
. ([scriptblock]::Create($template.Substring($start,$end-$start)))
`);
    const generate = (...args)=>spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',generator,path.join(__dirname,'../templates/install.ps1'),profile,artifact,...args],{encoding:'utf8',timeout:30000});
    const generated = generate();
    assert.ifError(generated.error);
    assert.equal(generated.status,0,generated.stdout+generated.stderr);
    const launcher = path.join(bin,'claude.exe');
    const alias = path.join(bin,'clawgod.exe');
    const original = path.join(bin,'claude.orig.exe');
    const hash = file=>require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const originalHash = hash(original);
    assert.equal(originalHash,hash(bunPath));
    assert.equal(fs.statSync(launcher).ino,fs.statSync(alias).ino);
    assert.ok(!fs.existsSync(path.join(bin,'claude.cmd')));
    assert.ok(!fs.existsSync(path.join(bin,'clawgod.cmd')));
    assert.ok(!fs.existsSync(path.join(bin,'claude.orig.cmd')));
    for(const fail of [false,true]){
      const args = ['C:\\extension path\\claude.exe','--help','prompt with spaces & 字','',...(fail?['--fail']:[])];
      const result = spawnSync(fail?alias:launcher,args,{shell:false,encoding:'utf8'});
      assert.ifError(result.error);
      assert.equal(result.status,fail?7:0,result.stdout+result.stderr);
      const output = JSON.parse(result.stdout);
      assert.deepEqual(output.args,args);
      assert.equal(output.dir,artifact);
      assert.equal(output.native,original);
      assert.equal(fs.realpathSync(output.runtime),fs.realpathSync(bunPath));
    }
    const stdio = spawnSync(launcher,['--stdio'],{input:'{"type":"control_request"}\n',shell:false,encoding:'utf8'});
    assert.equal(stdio.status,0,stdio.stderr);
    assert.equal(stdio.stdout,'{"type":"control_request"}\n');
    held = spawn(launcher,['--hold'],{shell:false,stdio:['pipe','pipe','pipe']});
    heldClosed = once(held,'close');
    await once(held.stdout,'data',{signal:AbortSignal.timeout(10000)});
    const upgraded = generate();
    assert.equal(upgraded.status,0,upgraded.stdout+upgraded.stderr);
    assert.equal(hash(original),originalHash);
    assert.equal(fs.statSync(launcher).ino,fs.statSync(alias).ino);
    held.kill();
    await heldClosed;
    const installedHash = hash(launcher);
    const rejected = generate('-Runtime',path.join(directory,'missing-bun.exe'));
    assert.notEqual(rejected.status,0);
    assert.equal(hash(launcher),installedHash);
    const fixtureSource = fs.readFileSync(entry,'utf8');
    for(let i=0;i<2;i++){
      const removed = generate('-Uninstall');
      assert.equal(removed.status,0,removed.stdout+removed.stderr);
      assert.equal(hash(launcher),originalHash);
      assert.ok(!fs.existsSync(alias));
      assert.equal(fs.readFileSync(path.join(artifact,'patches.json'),'utf8'),'{"theme":false}\n');
    }
    fs.writeFileSync(entry,fixtureSource);
    const reinstalled = generate();
    assert.equal(reinstalled.status,0,reinstalled.stdout+reinstalled.stderr);
    assert.equal(hash(original),originalHash);
  }finally{
    if(held){if(held.exitCode===null&&held.signalCode===null)held.kill();await heldClosed;}
    fs.rmSync(directory,{recursive:true,force:true});
  }
  console.log('[launcher.test] compiled paths, argv, stdio, live upgrade, failure rollback and uninstall preserved');
  })().catch(error=>{console.error(error);process.exitCode=1;});
}
