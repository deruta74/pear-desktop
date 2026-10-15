'use strict';
// Built-in-only diagnostic. Importing this module performs no I/O or native action.
const {execFile,spawn}=require('node:child_process');
const {performance}=require('node:perf_hooks');
const {createHash}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const MAX_BUFFER=256*1024;
const BINDING=Object.freeze({sourceHead:'768a7bdc2b750676ceb1dbc13410331118b40545',sourceTree:'463a65e1d42b4bc038e0a3526773dd67226ed603',failedRun:38792484036,failedAttempt:1,failedWindowsJob:116620305604,rawWindowsLogSHA256:'a66fe793a9aae00cca337544d2170d85fcf1e2cabbc80ba6363d03f4c0b8f457',reviewSealSHA256:'9c9a6b35a87b214e85046122bb79c3801f159f56b04e44d1d47c160b709ed980'});
function validPid(pid){if(!Number.isSafeInteger(pid)||pid<=0||pid>2147483647)throw Error('Invalid owned PID');return pid;}
function original(pid){validPid(pid);return `$ErrorActionPreference='Stop';$pending=[System.Collections.Generic.Queue[int]]::new();$pending.Enqueue(${pid});$seen=@{};$rows=@();while($pending.Count -gt 0){$id=$pending.Dequeue();if($seen.ContainsKey($id)){continue};$seen[$id]=$true;$p=Get-CimInstance Win32_Process -Filter ("ProcessId = "+$id);if($null -ne $p){$rows+=@{pid=[int]$p.ProcessId;parent=[int]$p.ParentProcessId;creation=$p.CreationDate.ToUniversalTime().ToString('o')};foreach($c in @(Get-CimInstance Win32_Process -Filter ("ParentProcessId = "+$id))){$pending.Enqueue([int]$c.ProcessId)}}};ConvertTo-Json -InputObject @($rows) -Compress`;}
function plan(pid){return [{kind:'original-cim-structure-8000',timeoutMs:8000,script:original(pid),format:'structure',byteEquivalent:true}];}
function parseOwned(text,pid,parent){
 if(typeof text!=='string'||Buffer.byteLength(text)>MAX_BUFFER)throw Error('Output limit');
 const value=JSON.parse(text);
 if(!Array.isArray(value)||value.length>1)throw Error('Owned cardinality');
 for(const r of value){if(!r||typeof r!=='object'||Object.keys(r).sort().join(',')!=='creation,parent,pid'||r.pid!==pid||r.parent!==parent||typeof r.creation!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{1,7}Z$/.test(r.creation)||!Number.isFinite(Date.parse(r.creation)))throw Error('Invalid owned row');}
 return value;
}
// Fixed structural metadata only. Payload values never leave this function.
function classifyStructure(text,pid,parent,{heldSubjectLive=false,queryFailed=false}={}){
 validPid(pid);validPid(parent);
 const summary={outputWithinCap:null,jsonValid:null,topLevelArray:null,rowCountCapped:null,rowCountOverflow:null,ownedLeaderCount:null,allRowsObjects:null,allRowsExactExpectedKeys:null,unknownKeysPresent:null,allNativeBasicTypes:null,allCohortPidsPositive:null,allCreationNonempty:null,leaderFound:null,leaderParentMatchesOwnedCollector:null,leaderCreationString:null,leaderUtcFormat:null,leaderDateParseable:null,allRowsAreOwnedSubject:null,extraRowsPresent:null,nativeBasicSchemaWouldPass:null,sourceFirstCohortChecksWouldPass:null,strictDiagnosticWouldPass:null,firstStrictReason:'query_error',heldSubjectLive:heldSubjectLive===true,ownedIdentityValidated:false,nativeRevalidationPerformed:false,completeRetirement:false};
 if(queryFailed)return summary;
 summary.outputWithinCap=typeof text==='string'&&Buffer.byteLength(text)<=MAX_BUFFER;
 if(!summary.outputWithinCap){summary.firstStrictReason='output_limit';return summary;}
 let rows;try{rows=JSON.parse(text);summary.jsonValid=true;}catch{summary.jsonValid=false;summary.firstStrictReason='invalid_json';return summary;}
 summary.topLevelArray=Array.isArray(rows);
 if(!summary.topLevelArray){summary.strictDiagnosticWouldPass=false;summary.nativeBasicSchemaWouldPass=false;summary.sourceFirstCohortChecksWouldPass=false;summary.firstStrictReason='not_array';return summary;}
 summary.rowCountCapped=Math.min(rows.length,32);summary.rowCountOverflow=rows.length>32;summary.extraRowsPresent=rows.length>1;
 if(summary.rowCountOverflow){summary.strictDiagnosticWouldPass=false;summary.firstStrictReason='cardinality';return summary;}
 const object=r=>r!==null&&typeof r==='object'&&!Array.isArray(r);
 const keys=['creation','parent','pid'];
 const exact=r=>object(r)&&Object.keys(r).sort().join(',')==='creation,parent,pid';
 const basic=r=>object(r)&&Number.isSafeInteger(r.pid)&&Number.isSafeInteger(r.parent)&&typeof r.creation==='string'&&!!r.creation;
 const utc=r=>typeof r.creation==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{1,7}Z$/.test(r.creation);
 summary.allRowsObjects=rows.every(object);summary.allRowsExactExpectedKeys=rows.every(exact);summary.unknownKeysPresent=rows.some(r=>object(r)&&Object.keys(r).some(k=>!keys.includes(k)));
 summary.allNativeBasicTypes=rows.every(r=>object(r)&&Number.isSafeInteger(r.pid)&&Number.isSafeInteger(r.parent)&&typeof r.creation==='string');
 summary.allCohortPidsPositive=rows.every(r=>object(r)&&Number.isSafeInteger(r.pid)&&r.pid>0);
 summary.allCreationNonempty=rows.every(r=>object(r)&&typeof r.creation==='string'&&!!r.creation);
 summary.nativeBasicSchemaWouldPass=rows.every(basic);
 const leaders=rows.filter(r=>object(r)&&r.pid===pid);summary.ownedLeaderCount=leaders.length>1?'many':leaders.length;summary.leaderFound=leaders.length>0;
 const first=leaders[0];summary.sourceFirstCohortChecksWouldPass=summary.heldSubjectLive&&summary.nativeBasicSchemaWouldPass&&summary.allCohortPidsPositive&&!!first&&first.parent===parent&&!!first.creation;
 if(leaders.length===1){summary.leaderParentMatchesOwnedCollector=first.parent===parent;summary.leaderCreationString=typeof first.creation==='string';summary.leaderUtcFormat=utc(first);summary.leaderDateParseable=typeof first.creation==='string'&&Number.isFinite(Date.parse(first.creation));}
 summary.allRowsAreOwnedSubject=rows.every(r=>object(r)&&r.pid===pid);
 let reason=rows.length>1?'cardinality':'accepted';
 if(reason==='accepted')for(const r of rows){
  if(!object(r))reason='row_not_object';
  else if(!exact(r))reason='unexpected_keys';
  else if(!Number.isSafeInteger(r.pid))reason='invalid_pid';
  else if(r.pid!==pid)reason='pid_mismatch';
  else if(!Number.isSafeInteger(r.parent))reason='invalid_parent';
  else if(r.parent!==parent)reason='parent_mismatch';
  else if(typeof r.creation!=='string')reason='creation_type';
  else if(!utc(r))reason='creation_format';
  else if(!Number.isFinite(Date.parse(r.creation)))reason='creation_value';
  if(reason!=='accepted')break;
 }
 summary.firstStrictReason=reason;summary.strictDiagnosticWouldPass=reason==='accepted';
 summary.ownedIdentityValidated=summary.strictDiagnosticWouldPass&&leaders.length===1&&summary.heldSubjectLive;
 return summary;
}
function safeCode(x){return x==null?null:Number.isSafeInteger(x)?x:['ENOENT','EACCES','EPERM','ESRCH','ETIMEDOUT','ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(x)?x:'other';}
function safeSignal(x){return x==null?null:['SIGTERM','SIGKILL','SIGINT','SIGABRT'].includes(x)?x:'other';}
// Each resource remains registered from handle admission through an actual close.
function createRegistry(){
 const owners=[];
 function admit(child,kind){
  let resolveClosed;
  const record={id:owners.length+1,kind,pid:Number.isSafeInteger(child.pid)?child.pid:null,closed:false,errorObserved:false,exitObserved:false,exitCode:null,exitSignal:null,closeCode:null,closeSignal:null,killRequests:0};
  const closedPromise=new Promise(resolve=>{resolveClosed=resolve});
  const owner={child,record,closedPromise,requestKill(){if(record.closed)return;record.killRequests++;try{child.kill();}catch{} }};
  // Neither exitCode/signalCode, callback nor kill() return can set closed=true.
  child.on('error',()=>{record.errorObserved=true});
  child.on('exit',(code,signal)=>{record.exitObserved=true;record.exitCode=safeCode(code);record.exitSignal=safeSignal(signal)});
  child.once('close',(code,signal)=>{record.closed=true;record.closeCode=safeCode(code);record.closeSignal=safeSignal(signal);resolveClosed()});
  owners.push(owner);return owner;
 }
 return {admit,owners,snapshot:()=>owners.map(x=>({...x.record})),allClosed:()=>owners.every(x=>x.record.closed),waitAllClosed:()=>Promise.all(owners.map(x=>x.closedPromise)),killQueries(){for(const x of owners)if(x.record.kind==='query')x.requestKill()}};
}
function runQuery(spec,{exec=execFile,pid,parent,signal,abortGraceMs=1000,registry=createRegistry(),onUncertainty=()=>{},heldSubjectLive=()=>false}={}){
 return new Promise(resolve=>{
 const started=performance.now();let child,owner,spawnAt=null,settled=false,aborted=false,uncertain=false,callbackSeen=false,callbackAt=null,callbackError=null,stdout='',stderr='',completion='callback',graceTimer,callbackTimer;
 const finish=()=>{
  if(settled||(!uncertain&&(!callbackSeen||!owner?.record.closed)))return;
  settled=true;clearTimeout(graceTimer);clearTimeout(callbackTimer);signal?.removeEventListener('abort',abort);
  const elapsed=performance.now()-started;
  const r={kind:spec.kind,resourceId:owner?.record.id??null,byteEquivalentToOriginalCommand:spec.byteEquivalent,timeoutMs:spec.timeoutMs,spawnLatencyMs:spawnAt===null?null:spawnAt-started,callbackElapsedMs:callbackAt===null?null:callbackAt-started,totalElapsedMs:elapsed,exit:child?.exitCode??null,signal:safeSignal(callbackError?.signal??child?.signalCode),code:safeCode(callbackError?.code),killed:callbackError?.killed===true||child?.killed===true,timeout:callbackError?.killed===true&&callbackAt!==null&&callbackAt-started>=spec.timeoutMs,timeoutInterpretation:'inferred-from-killed-and-deadline-elapsed',cancelled:aborted,completion,callbackObserved:callbackSeen,physicalClosed:owner?.record.closed===true,closeUncertain:uncertain,stdoutBytes:Buffer.byteLength(stdout),stderrBytes:Buffer.byteLength(stderr),parseStatus:callbackError?'query-error':'not-parsed'};
  try{const queryFailed=!callbackSeen||!!callbackError;r.structure=classifyStructure(stdout,pid,parent,{queryFailed,heldSubjectLive:heldSubjectLive()&&r.physicalClosed&&!r.closeUncertain});r.parseStatus=queryFailed?'query-error':r.structure.ownedIdentityValidated?'accepted':'rejected';}
  catch{r.structure=classifyStructure('',pid,parent,{queryFailed:true});r.parseStatus='rejected';}
  resolve(r);
 };
 const fail=(reason)=>{
  if(settled||uncertain)return;
  uncertain=true;completion=reason;owner?.requestKill();
  // Logical settlement does not release registry ownership of an unclosed handle.
  graceTimer=setTimeout(finish,abortGraceMs);
  onUncertainty(reason);
  if(owner?.record.closed)finish();
 };
 const abort=()=>{aborted=true;fail(callbackSeen?'abort-before-close':'abort-no-callback')};
 if(signal?.aborted){aborted=true;uncertain=true;completion='cancelled-before-spawn';finish();return;}
 try{
  child=exec('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',spec.script],{timeout:spec.timeoutMs,maxBuffer:MAX_BUFFER,windowsHide:true},(error,out,err)=>{
   if(settled)return;callbackSeen=true;callbackAt=performance.now();callbackError=error;stdout=out??'';stderr=err??'';finish();
  });
  owner=registry.admit(child,'query');child.once('spawn',()=>{spawnAt=performance.now()});
  owner.closedPromise.then(()=>{if(callbackSeen||uncertain)finish()});
  signal?.addEventListener('abort',abort,{once:true});
  callbackTimer=setTimeout(()=>fail(callbackSeen?'callback-without-close':'deadline-callback-unavailable'),spec.timeoutMs+1500);
 }catch{callbackError={code:'other'};callbackSeen=true;fail('spawn-threw');}
 });
}
function retireOwned(child,{graceMs=1500,fallbackMs=1500,owner}={}){
 // Main passes its admission-time owner. A direct caller gets a new observer,
 // which intentionally cannot infer any historical close from exit properties.
 owner??=createRegistry().admit(child,'subject');
 return new Promise(resolve=>{
  let done=false,fallback=false,t1,t2;
  const finish=()=>{if(done)return;done=true;clearTimeout(t1);clearTimeout(t2);resolve({resourceId:owner.record.id,closed:owner.record.closed,fallback,exit:owner.record.exitCode,signal:owner.record.exitSignal,closeCode:owner.record.closeCode,closeSignal:owner.record.closeSignal})};
  if(owner.record.closed){finish();return;}
  owner.closedPromise.then(finish);
  try{child.stdin.end();}catch{}
  t1=setTimeout(()=>{fallback=true;owner.requestKill();t2=setTimeout(finish,fallbackMs)},graceMs);
 });
}
async function main(){
 if(process.platform!=='win32'||process.argv.length!==4||process.argv[2]!=='--output')throw Error('Windows explicit output invocation required');
 const output=path.resolve(process.argv[3]);if(fs.existsSync(output))throw Error('Output must not exist');
 const started=performance.now(),controller=new AbortController(),registry=createRegistry();
 const result={schema:3,probeProtocol:'owned-cim-structure-v1',diagnosticBaseCarrier:'80001e357aa4053bafe62ca611b0e6bb711701b0',priorDiagnosticRun:38802434706,priorRejectionCause:'UNKNOWN',originalFailureCause:'UNKNOWN',diagnosticOnly:true,notPRGreen:true,binding:BINDING,collectorSHA256:createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),carrierCommit:/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA||'')?process.env.GITHUB_SHA:null,diagnosticRun:/^\d+$/.test(process.env.GITHUB_RUN_ID||'')?process.env.GITHUB_RUN_ID:null,metadata:{platform:process.platform,osRelease:os.release(),node:process.version,arch:process.arch,logicalCpuCount:os.availableParallelism()},limits:{queries:1,queryMaxMs:8000,wholeAbortMs:80000,hardExitMs:89000,maxBuffer:MAX_BUFFER},queries:[],owned:null,retirement:null,failedMeasurement:false,hardDeadlineReached:false,ownedIdentityValidated:false,nativeRevalidationPerformed:false,completeRetirement:false,retirementScope:'direct-node-handle-only'};
 let owned,ownedOwner,measuring=true,written=false,resolveHard;
 const hardReached=new Promise(resolve=>{resolveHard=resolve});
 const fail=reason=>{result.failedMeasurement=true;result.failureReason??=reason;controller.abort();registry.killQueries()};
 const write=()=>{if(written)return;result.resources=registry.snapshot();result.physicalCloseUncertainty=!registry.allClosed();result.cancelled=controller.signal.aborted;fs.writeFileSync(output,JSON.stringify({...result,totalElapsedMs:performance.now()-started},null,2)+'\n',{flag:'wx'});written=true};
 const whole=setTimeout(()=>{result.wholeDeadlineReached=true;fail('whole-deadline')},80000);
 const hard=setTimeout(()=>{
  result.hardDeadlineReached=true;fail('hard-deadline');
  try{if(ownedOwner&&!ownedOwner.record.closed){owned.stdin.end();ownedOwner.requestKill()}}catch{}
  try{write()}catch{}process.exitCode=2;resolveHard();process.exit(2);
 },89000);
 try{
  result.sourceBindings={};
  for(const [file,expected] of Object.entries({'tests/api-music-comments-native.test.ts':'a797dded0c146bd1bfa1a16589d06f44ff0c0b1aaedc93fbe2e3c8a69e845fe0','tests/api-music-queue-actions-native.test.ts':'bcffcdc910bcba16c148154690f0180689b01db27674186b7f208c9aa158085e'})){const actual=createHash('sha256').update(fs.readFileSync(path.resolve(file))).digest('hex');result.sourceBindings[file]=actual;if(actual!==expected)throw Error('Source byte mismatch')}
  owned=spawn(process.execPath,['-e',"process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"],{stdio:['pipe','ignore','ignore'],windowsHide:true});
  ownedOwner=registry.admit(owned,'subject');
  owned.on('error',()=>fail('owned-child-error'));
  owned.stdin.on?.('error',()=>{result.stdinErrorObserved=true;fail('owned-stdin-error')});
  owned.on('exit',()=>{if(measuring)fail('owned-child-exited')});
  const admitted=await new Promise(resolve=>{owned.once('spawn',()=>resolve(true));owned.once('error',()=>resolve(false))});
  if(!admitted||!Number.isSafeInteger(owned.pid))throw Error('Owned child admission failed');
  result.owned={pid:owned.pid,parent:process.pid,creationSource:'transient-structural-check-only',fixture:'direct-node-stdin-held-no-descendants',electronEquivalent:false};
  for(const spec of plan(owned.pid)){
   if(result.failedMeasurement||controller.signal.aborted||ownedOwner.record.closed||ownedOwner.record.exitObserved)break;
   const observation=await runQuery(spec,{pid:owned.pid,parent:process.pid,signal:controller.signal,registry,onUncertainty:reason=>fail(reason),heldSubjectLive:()=>!ownedOwner.record.closed&&!ownedOwner.record.exitObserved&&owned.exitCode===null&&owned.signalCode===null});result.queries.push(observation);
   if(observation.closeUncertain||!observation.physicalClosed){fail('query-close-uncertain');break;}
   result.ownedIdentityValidated=observation.structure?.ownedIdentityValidated===true;
   if(!result.ownedIdentityValidated){fail('owned-identity-not-validated');break;}
  }
 }catch{result.collectorFailure='fixed-metadata-failure';fail('collector-failure')}
 finally{
  measuring=false;
  if(ownedOwner)result.retirement=await retireOwned(owned,{owner:ownedOwner});
  if(!result.retirement?.closed)fail('subject-close-uncertain');
  if(result.queries.length!==1)fail('partial-observations');
  // Never remove the last whole bound merely because a logical result settled.
  if(!registry.allClosed())await Promise.race([registry.waitAllClosed(),hardReached]);
  if(!registry.allClosed()&&!result.hardDeadlineReached)throw Error('Unbounded ownership');
  if(registry.allClosed()||result.hardDeadlineReached){clearTimeout(whole);clearTimeout(hard)}
  result.wholeDeadlineReached??=false;
  if(result.failedMeasurement||result.hardDeadlineReached)process.exitCode=2;
  write();
 }
}
module.exports={BINDING,original,plan,parseOwned,classifyStructure,createRegistry,runQuery,retireOwned};
if(require.main===module)main().catch(()=>{process.stderr.write('COLLECTOR_FIXED_FAILURE\n');process.exitCode=2});
