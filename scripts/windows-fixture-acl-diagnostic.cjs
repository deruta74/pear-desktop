const {spawn,spawnSync}=require('node:child_process');
const {mkdtemp,rm}=require('node:fs/promises');
const {readFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const path=require('node:path');
const timeoutMs=8000;
const target=path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const markers=output=>String(output||'').split(/\r?\n/).filter(line=>/^P(?:[0-6]|99)$/.test(line));
const command=script=>['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];
function syncProbe(name,script,input,env) {
 const began=Date.now();const result=spawnSync(target,command(script),{input,encoding:'utf8',timeout:timeoutMs,maxBuffer:4096,windowsHide:true,env});
 return {name,sync:true,timeoutMs,timedOut:result.error?.code==='ETIMEDOUT',exitCode:Number.isInteger(result.status)?result.status:null,spawnError:result.error&&result.error.code!=='ETIMEDOUT'?1:0,elapsedMs:Date.now()-began,stages:markers(result.stdout),errorBytes:Buffer.byteLength(result.stderr||'')};
}
async function asyncProbe(name,script,input,env) {
 return await new Promise(resolve=>{
 const began=Date.now();let output='',errorBytes=0,timedOut=false,settled=false,spawnError=0;
 const child=spawn(target,command(script),{windowsHide:true,stdio:['pipe','pipe','pipe'],env});
 const timer=setTimeout(()=>{timedOut=true;child.stdin.destroy();child.kill('SIGKILL')},timeoutMs);
 const finish=code=>{if(settled)return;settled=true;clearTimeout(timer);resolve({name,sync:false,timeoutMs,timedOut,exitCode:Number.isInteger(code)?code:null,spawnError,elapsedMs:Date.now()-began,stages:markers(output),errorBytes})};
 child.stdout.on('data',data=>output=(output+data.toString('utf8')).slice(-4096));child.stderr.on('data',data=>errorBytes+=data.length);child.on('error',()=>{spawnError=1;finish(null)});child.on('close',finish);child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
(async()=>{
 if(process.platform!=='win32')throw Error('Windows runner required');
 const frame='{"operation":"parent","path":"unused","directory":true}\n';
 const start='$ErrorActionPreference="Stop";[Console]::WriteLine("P0");try{';
 const end='}catch{[Console]::WriteLine("P99");exit 1}';
 for(const [name,body] of [
 ['sync-startup','[Console]::WriteLine("P6");exit 0'],
 ['sync-console','[Console]::WriteLine("P1");$r=[Console]::ReadLine();[Console]::WriteLine("P6");exit 0'],
 ['sync-encoding','[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::WriteLine("P1");$r=[Console]::ReadLine();[Console]::WriteLine("P6");exit 0'],
 ['sync-raw','[Console]::WriteLine("P1");$reader=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false,$true),$false,4096,$true);$r=$reader.ReadLine();[Console]::WriteLine("P6");exit 0'],
 ])console.log('WINDOWS_FIXTURE_DIAG '+JSON.stringify(syncProbe(name,start+body+end,frame,process.env)));
 const source=readFileSync(path.join(process.cwd(),'tests','api-music-grants.test.ts'),'utf8');
 const match=source.match(/const ACL_FIXTURE = String\.raw`([\s\S]*?)`;/);
 if(!match)throw Error('Fixed fixture source missing');
 let script='[Console]::WriteLine("P0");'+match[1];
 script=script.replace("[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)","[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::WriteLine('P1')");
 script=script.replace("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)","[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::WriteLine('P2')");
 script=script.replace('$r=[Console]::ReadLine()|ConvertFrom-Json;','$r=[Console]::ReadLine()|ConvertFrom-Json;[Console]::WriteLine("P3");');
 script=script.replace('if($r.operation -eq', '[Console]::WriteLine("P4");if($r.operation -eq');
 script=script.replace('[IO.Directory]::SetAccessControl($r.path,$acl);','[Console]::WriteLine("P5");[IO.Directory]::SetAccessControl($r.path,$acl);[Console]::WriteLine("P6");');
 script=script.replace('}catch{','}catch{[Console]::WriteLine("P99");');
 for(const relocated of [false,true]){
 const folder=await mkdtemp(path.join(tmpdir(),'pear-grant-diag-'));
 try{
 const input=JSON.stringify({operation:'parent',path:folder,directory:true})+'\n';const env=relocated?{...process.env,TEMP:folder,TMP:folder}:process.env;
 console.log('WINDOWS_FIXTURE_DIAG '+JSON.stringify(syncProbe('sync-fixture-'+(relocated?'temp':'default'),script,input,env)));
 console.log('WINDOWS_FIXTURE_DIAG '+JSON.stringify(await asyncProbe('async-fixture-'+(relocated?'temp':'default'),script,input,env)));
 }finally{await rm(folder,{recursive:true,force:true})}
 }
})().catch(()=>{console.error('WINDOWS_FIXTURE_DIAG fixed-diagnostic-failure');process.exitCode=1});
