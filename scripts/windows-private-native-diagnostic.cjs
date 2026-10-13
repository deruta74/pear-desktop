const {spawn}=require('node:child_process');
const {mkdtemp,rm}=require('node:fs/promises');
const {readFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {gzipSync}=require('node:zlib');
const path=require('node:path');
const timeoutMs=8000;
const target=path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const challenge='00000000-0000-4000-8000-000000000001';
const parentScript=String.raw`$ErrorActionPreference='Stop';[Console]::WriteLine('P0');try{$reader=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false,$true),$false,4096,$true);$r=$reader.ReadLine()|ConvertFrom-Json;[Console]::WriteLine('P1');$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);foreach($who in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))){$acl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($who,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))};[Console]::WriteLine('P2');[IO.Directory]::SetAccessControl($r.directory,$acl);[Console]::WriteLine('P3');exit 0}catch{[Console]::WriteLine('P99');exit 1}`;
function packed(script){const bytes=gzipSync(Buffer.from(script,'utf8')).toString('base64');return `$ErrorActionPreference='Stop';try{$m=[IO.MemoryStream]::new([Convert]::FromBase64String('${bytes}'));$g=[IO.Compression.GZipStream]::new($m,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8);$s=$r.ReadToEnd();$r.Dispose();&([ScriptBlock]::Create($s))}catch{[Console]::WriteLine('P98');exit 1}`;}
function execute(name,script,request,prepare=false,relocated=false){
 return new Promise(resolve=>{
 const encoded=Buffer.from(packed(script),'utf16le').toString('base64');const args=['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded];
 let stdout='',stderr='',types=[],phases=[],codes=[],committed=false,timedOut=false,spawnError=0,bindingValid=false,readEmpty=false,began=Date.now(),settled=false;
 const env=relocated?{...process.env,TEMP:request.parent,TMP:request.parent}:process.env;
 const child=spawn(target,args,{windowsHide:true,stdio:['pipe','pipe','pipe'],env});
 const timer=setTimeout(()=>{timedOut=true;child.stdin.destroy();child.kill('SIGKILL')},timeoutMs);
 const finish=exitCode=>{if(settled)return;settled=true;clearTimeout(timer);for(const line of stderr.split(/\r?\n/)){const m=/^N([0-9]{1,2}) ([0-9]{1,5})$/.exec(line);if(m){phases.push('N'+Number(m[1]));codes.push(Number(m[2]))}}resolve({name,timeoutMs,timedOut,spawnError,exitCode:Number.isInteger(exitCode)?exitCode:null,elapsedMs:Date.now()-began,encodedCharacters:encoded.length,phases,codes,types,bindingValid,readEmpty,committed,errorBytes:Buffer.byteLength(stderr)})};
 child.stdout.on('data',chunk=>{stdout+=chunk.toString('utf8');if(stdout.length>1048576){child.kill('SIGKILL');return;}let at;while((at=stdout.indexOf('\n'))>=0){const line=stdout.slice(0,at).trim();stdout=stdout.slice(at+1);if(/^P[0-9]{1,2}$/.test(line)){phases.push(line);continue;}try{const packet=JSON.parse(line);if(!['read','ready','committed','failure'].includes(packet.type))continue;types.push(packet.type);if(packet.type==='read'){readEmpty=packet.contents64===null&&packet.binding===null;bindingValid=typeof packet.binding==='string'&&/^[a-f0-9]{48}:[a-f0-9]{64}$/.test(packet.binding);}if(packet.type==='ready'&&prepare&&!committed){committed=true;child.stdin.end(JSON.stringify({version:1,action:'commit',challenge})+'\n');}if(packet.type==='committed')bindingValid=typeof packet.binding==='string'&&/^[a-f0-9]{48}:[a-f0-9]{64}$/.test(packet.binding);}catch{}}});
 child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString('utf8')).slice(-4096)});child.on('error',()=>{spawnError=1;finish(null)});child.on('close',finish);child.stdin.on('error',()=>{});
 const frame=JSON.stringify(request)+'\n';if(prepare)child.stdin.write(frame);else child.stdin.end(frame);
 });
}
function instrument(worker,raw){
 worker=worker.replace(/\r\n/g,'\n');
 worker='[Console]::WriteLine("P0");'+worker;
 worker=worker.replace("[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)",raw?"$reader=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false,$true),$false,4096,$true);[Console]::WriteLine('P1')":"[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::WriteLine('P1')");
 if(raw)worker=worker.replaceAll('[Console]::ReadLine()','$reader.ReadLine()');
 worker=worker.replace('Add-Type -TypeDefinition',"[Console]::WriteLine('P2');Add-Type -TypeDefinition");
 worker=worker.replace("'@\n$line=", "'@\n[Console]::WriteLine('P3');$line=");
 worker=worker.replace('$r=$line | ConvertFrom-Json',"[Console]::WriteLine('P4');$r=$line | ConvertFrom-Json");
 worker=worker.replace('static Exception Bad(){return new IOException("unavailable");}', 'static Exception Bad(){int code=Marshal.GetLastWin32Error();Console.Error.WriteLine("N99 "+(code>=0&&code<=65535?code:0));return new IOException("unavailable");}');
 worker=worker.replace('public GrantPath(string value,bool create){try{','public GrantPath(string value,bool create){try{Console.Error.WriteLine("N7 0");');
 worker=worker.replace('folder=Path.GetFullPath(value);','Console.Error.WriteLine("N20 0");folder=Path.GetFullPath(value);Console.Error.WriteLine("N21 0");Console.Error.WriteLine("N22 "+(folder==value?1:0));');
 worker=worker.replace('if(parent==null||(', 'Console.Error.WriteLine("N23 "+(parent==null?0:1));if(parent==null||(');
 worker=worker.replaceAll('GetDriveTypeW(root)','DiagnosticDriveType(root)');
 worker=worker.replace('static string Native(string p)', 'static uint DiagnosticDriveType(string root){Console.Error.WriteLine("N24 0");uint result=GetDriveTypeW(root);Console.Error.WriteLine("N25 "+result);return result;}static string Native(string p)');
 worker=worker.replace('SafeFileHandle h=OpenDir(current,false);if(h==null)throw Bad();chain.Add(h);','Console.Error.WriteLine("N26 0");SafeFileHandle h=OpenDir(current,false);int rootError=h==null?Marshal.GetLastWin32Error():0;Console.Error.WriteLine("N27 "+(h==null?0:1));Console.Error.WriteLine("N98 "+(rootError>=0&&rootError<=65535?rootError:0));if(h==null)throw Bad();chain.Add(h);');
 worker=worker.replace('static Info Stat(SafeFileHandle h,bool directory){Info i;', 'static Info Stat(SafeFileHandle h,bool directory){Console.Error.WriteLine("N28 "+(h.IsInvalid?0:1));Info i;');
 worker=worker.replace('if((i.Attr&0x400)!=0||((i.Attr&0x10)!=0)!=directory)', 'Console.Error.WriteLine("N29 0");Console.Error.WriteLine("N30 "+((i.Attr&0x400)!=0?1:0));Console.Error.WriteLine("N31 "+(((i.Attr&0x10)!=0)==directory?1:0));if((i.Attr&0x400)!=0||((i.Attr&0x10)!=0)!=directory)');
 worker=worker.replace('static SafeFileHandle OpenDir(string p,bool write){SafeFileHandle h=', 'static SafeFileHandle OpenDir(string p,bool write){Console.Error.WriteLine("N40 0");SafeFileHandle h=');

 worker=worker.replace('if(!GetVolumeInformationByHandleW(', 'Console.Error.WriteLine("N8 0");if(!GetVolumeInformationByHandleW(');
 worker=worker.replace('}Parent(chain[chain.Count-1]);','}Console.Error.WriteLine("N9 0");Parent(chain[chain.Count-1]);');
 worker=worker.replace('Private(dir,true);','Console.Error.WriteLine("N10 0");Private(dir,true);');
 worker=worker.replace('public GrantData Read(){','public GrantData Read(){Console.Error.WriteLine("N12 0");');
 worker=worker.replace('public void Prepare(string data,string wanted){','public void Prepare(string data,string wanted){Console.Error.WriteLine("N13 0");');
 worker=worker.replace('public string Commit(){','public string Commit(){Console.Error.WriteLine("N16 0");');
 worker=worker.replace('if(!SetFileInformationByHandle(tmp,3,','Console.Error.WriteLine("N17 0");if(!SetFileInformationByHandle(tmp,3,');
 return worker;
}
(async()=>{
 if(process.platform!=='win32')throw Error('Windows runner required');
 const source=readFileSync(path.join(process.cwd(),'src','plugins','api-server','backend','windows-private-path.ts'),'utf8');const match=source.match(/const WINDOWS_PRIVATE_WORKER = String\.raw`([\s\S]*?)`\.trim\(\);/);if(!match)throw Error('Fixed worker source missing');
 for(const control of [true,false]){
 const raw=false, label=control?'original':'candidate';
 const parent=await mkdtemp(path.join(tmpdir(),'pear-grant-native-diag-'));
 try{
 const protection=await execute('parent-'+label,parentScript,{directory:parent});console.log('WINDOWS_NATIVE_DIAG '+JSON.stringify(protection));if(protection.exitCode!==0||protection.timedOut)continue;
 const directory=path.join(parent,'owned');
 if(!match[1].includes('if(folder.Length>4096)throw Bad();')||match[1].includes('if(folder!=value||'))throw Error('Candidate normalization source not selected');
 const original=match[1].replace('if(folder.Length>4096)throw Bad();','if(folder!=value||folder.Length>4096)throw Bad();');
 const worker=instrument(control?original:match[1],raw);
 const read=()=>({version:1,operation:'read',directory,contents64:null,expected:null});
 console.log('WINDOWS_NATIVE_DIAG '+JSON.stringify(await execute('read-empty-'+label,worker,read())));
 const content=Buffer.from('{"version":1,"records":[]}','utf8').toString('base64');
 console.log('WINDOWS_NATIVE_DIAG '+JSON.stringify(await execute('prepare-commit-'+label,worker,{version:1,operation:'prepare',directory,contents64:content,expected:null},true)));
 console.log('WINDOWS_NATIVE_DIAG '+JSON.stringify(await execute('readback-'+label,worker,read())));
 }finally{await rm(parent,{recursive:true,force:true})}
 }
})().catch(()=>{console.error('WINDOWS_NATIVE_DIAG fixed-diagnostic-failure');process.exitCode=1});
