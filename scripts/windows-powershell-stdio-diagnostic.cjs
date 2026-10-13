const {spawn}=require('node:child_process');
const path=require('node:path');
const timeoutMs=8000;
const frame='{"version":1,"operation":"probe"}\n';
const target=path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const cases=[
 ['startup',false,'[Console]::WriteLine("P2");exit 0'],
 ['console-eof',true,'$line=[Console]::ReadLine();if($null -eq $line){throw "fixed"};[Console]::WriteLine("P2");exit 0'],
 ['console-open',false,'$line=[Console]::ReadLine();if($null -eq $line){throw "fixed"};[Console]::WriteLine("P2");exit 0'],
 ['encoding-eof',true,'[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::WriteLine("P1");$line=[Console]::ReadLine();if($null -eq $line){throw "fixed"};[Console]::WriteLine("P2");exit 0'],
 ['encoding-open',false,'[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::WriteLine("P1");$line=[Console]::ReadLine();if($null -eq $line){throw "fixed"};[Console]::WriteLine("P2");exit 0'],
 ['raw-eof',true,'$reader=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false,$true),$false,4096,$true);[Console]::WriteLine("P1");$line=$reader.ReadLine();if($null -eq $line){throw "fixed"};[Console]::WriteLine("P2");exit 0'],
 ['raw-open',false,'$reader=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false,$true),$false,4096,$true);[Console]::WriteLine("P1");$line=$reader.ReadLine();if($null -eq $line){throw "fixed"};[Console]::WriteLine("P2");exit 0'],
 ['compiler',true,'Add-Type -TypeDefinition "public static class GrantProbe { public static int Value() { return 7; } }";if([GrantProbe]::Value() -ne 7){throw "fixed"};[Console]::WriteLine("P2");exit 0'],
];
async function probe([name,end,body]) {
 const script='$ErrorActionPreference="Stop";[Console]::WriteLine("P0");try{'+body+'}catch{[Console]::WriteLine("P99");exit 1}';
 const args=['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];
 return await new Promise(resolve=>{
  const began=Date.now();let output='',errorBytes=0,timedOut=false,settled=false,spawnError=0;
  const child=spawn(target,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const finish=(code,signal)=>{if(settled)return;settled=true;clearTimeout(timer);const stages=output.split(/\r?\n/).filter(line=>/^P(?:0|1|2|99)$/.test(line));resolve({name,end,timeoutMs,timedOut,exitCode:Number.isInteger(code)?code:null,signal:signal==='SIGKILL'?'SIGKILL':null,spawnError,elapsedMs:Date.now()-began,stages,errorBytes,otherOutput:output.split(/\r?\n/).some(line=>line&&!/^P(?:0|1|2|99)$/.test(line))});};
  const timer=setTimeout(()=>{timedOut=true;child.stdin.destroy();child.kill('SIGKILL');},timeoutMs);
  child.stdout.on('data',data=>{output=(output+data.toString('utf8')).slice(-4096)});
  child.stderr.on('data',data=>{errorBytes+=data.length});
  child.on('error',()=>{spawnError=1;finish(null,null)});
  child.stdin.on('error',()=>{});
  child.on('close',finish);
  if(end)child.stdin.end(frame);else child.stdin.write(frame);
 });
}
(async()=>{if(process.platform!=='win32')throw Error('Windows runner required');for(const item of cases)console.log('WINDOWS_STDIO_DIAG '+JSON.stringify(await probe(item)));})().catch(()=>{console.error('WINDOWS_STDIO_DIAG fixed-diagnostic-failure');process.exitCode=1});
