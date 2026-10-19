'use strict';
// PRIVATE PREPARATION ONLY. No admission to execute this driver or import SDK.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { performance } = require('node:perf_hooks');

// PURE_CONTROL_BEGIN: local VM qualification extracts ONLY this region.
function controlError(code) { const e = new Error(code); e.code = code; return e; }
function within(root, target) { return target === root || target.startsWith(root + '/'); }
function phaseBudget(now, start, phaseStart, cap) {
  if (now < start || now < phaseStart) throw controlError('clock_regression');
  if (now - start >= 960000) throw controlError('owned_work_cutoff');
  if (now - phaseStart >= cap) throw controlError('phase_cutoff');
}
function validateCopyRecord(r) {
  if (!within(r.destinationRoot, r.destination)) throw controlError('copy_escape');
  if (r.type === 'link') {
    if (r.absolute || !within(r.sourceRoot, r.sourceTarget) || !within(r.destinationRoot, r.destinationTarget)) throw controlError('copy_link_escape');
  } else if (r.type !== 'file' && r.type !== 'directory') throw controlError('copy_type');
  if (r.type === 'file' && r.after && r.links !== 1) throw controlError('copy_hardlink');
}
function artifactGate(entries) {
  const limits = { 'facts.json':262144, 'cases.json':1048576, 'esm-timeline.json':1048576, 'cjs-timeline.json':1048576, 'raw.log':2097152, 'hashes.json':524288, 'cleanup.json':262144, 'SUMMARY.md':65536 };
  let total = 0; const names = new Set();
  for (const e of entries) {
    if (!(e.name in limits) || names.has(e.name) || e.type !== 'file' || e.links !== 1 || !Number.isSafeInteger(e.bytes) || e.bytes < 0 || e.bytes > limits[e.name]) throw controlError('artifact_invalid');
    names.add(e.name); total += e.bytes;
  }
  if (names.size !== Object.keys(limits).length || total + 2048 > 8388608) throw controlError('artifact_incomplete');
  return total;
}
function patchText(original, patch, wanted) {
  const ls = patch.split('\n'); const blocks = []; let b;
  for (const l of ls) {
    if (l.startsWith('--- a/')) { b = { name:l.slice(6), lines:[] }; blocks.push(b); }
    else if (b) b.lines.push(l);
  }
  if (blocks.length !== 2 || blocks.map(x => x.name).join('|') !== 'dist/esm/server/webStandardStreamableHttp.js|dist/cjs/server/webStandardStreamableHttp.js') throw controlError('patch_files');
  for (const block of blocks) {
    if (block.lines.filter(l => l.startsWith('@@')).length !== 1 || block.lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).join('') !== '+                    stream.cleanup();' || block.lines.some(l => l.startsWith('-') && !l.startsWith('---'))) throw controlError('patch_growth');
  }
  b = blocks.find(x => x.name === wanted); if (!b) throw controlError('patch_target');
  const at = b.lines.findIndex(l => l.startsWith('@@'));
  const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(b.lines[at]); if (!m || +m[1] !== +m[3]) throw controlError('patch_hunk');
  const content = b.lines.slice(at + 1).filter(l => l !== '');
  if (content.some(l => ![' ', '+'].includes(l[0]))) throw controlError('patch_format');
  const before = content.filter(l => l[0] === ' ').map(l => l.slice(1));
  const after = content.map(l => l.slice(1)); const source = original.split('\n');
  if (before.length !== +m[2] || after.length !== +m[4] || source.slice(+m[1]-1, +m[1]-1+before.length).join('\n') !== before.join('\n')) throw controlError('patch_context');
  source.splice(+m[1]-1, before.length, ...after); return source.join('\n');
}
function newSupervisor(api, started) {
  const owned = new Map(); let stopping = false;
  return {
    own(child) { if (stopping || owned.has(child.id)) throw controlError('child_ownership'); owned.set(child.id,child); },
    done(id) { owned.delete(id); },
    async stop(deadline=Infinity) {
      stopping = true; const end = Math.min(api.now() + 10000,deadline);
      for (const child of owned.values()) api.signal(child, 'SIGTERM');
      await api.wait(Math.min(2000, Math.max(0,end-api.now())));
      for (const child of owned.values()) if (api.alive(child)) api.signal(child,'SIGKILL');
      while ([...owned.values()].some(c => api.alive(c)) && api.now() < end) await api.wait(Math.min(100,end-api.now()));
      if ([...owned.values()].some(c => api.alive(c))) throw controlError('child_drain_timeout');
      owned.clear();
    },
    check(phaseStart, cap) { if (stopping) throw controlError('supervisor_stopping'); phaseBudget(api.now(),started,phaseStart,cap); },
    size() { return owned.size; }
  };
}
// PURE_CONTROL_END

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r,ms));
const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(process.env.RUNNER_TEMP || '/invalid', 'sdk130-phase0-output');
const I = JSON.parse(fs.readFileSync(path.join(__dirname,'INPUTS.json'),'utf8'));
const start = performance.now();
const facts = { classification:'NO_ADOPTION', status:'failed', phase:'prepare', candidateClassification:'UNVALIDATED', candidateResolved:false, baselineRedObserved:false, patchedGreen:false, failures:[], provenance:{} };
const cases = []; const timelines = {esm:[],cjs:[]}; const hashes = {inputs:I.inputs, context:I.context, sdk:I.sdk};
const cleanup = { ownedChildren:0, tempRemoved:false, completed:false };
let work, baseline, patched, logBytes=0, evidenceIncomplete=false, baselineTree, evidenceDeadline=Infinity, childSpent=0, activeChildStart, activeChildScanCheck, drainDeadline, fullBindings;
const children = new Map();
const supervision = newSupervisor({ now:()=>performance.now(), wait:sleep, alive:c=>!c.closed, signal:(c,s)=>{ if (!c.closed && children.get(c.id)===c) { try { process.kill(-c.id,s); } catch(e) { if(e.code!=='ESRCH') throw e; } } } },start);
function out(name, value) {
  if(performance.now()>=evidenceDeadline)throw controlError('finalization_cutoff');
  const text = typeof value === 'string' ? value : JSON.stringify(value,null,2)+'\n';
  const caps = {'facts.json':262144,'cases.json':1048576,'esm-timeline.json':1048576,'cjs-timeline.json':1048576,'raw.log':2097152,'hashes.json':524288,'cleanup.json':262144,'SUMMARY.md':65536,'SHA256SUMS':2048};
  if (!(name in caps) || Buffer.byteLength(text)>caps[name]) throw controlError('output_cap');
  fs.mkdirSync(OUTPUT,{recursive:true,mode:0o700}); const temporary=path.join(OUTPUT,'.'+name+'.writing');let fd;try{fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.writeFileSync(fd,text);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,path.join(OUTPUT,name));}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
function log(buf) {
  if (logBytes + buf.length > 2097152) { evidenceIncomplete=true; throw controlError('log_cap'); }
  const fd=fs.openSync(path.join(OUTPUT,'raw.log'),fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.size!==logBytes)throw controlError('log_file_binding');fs.writeSync(fd,buf);}finally{fs.closeSync(fd);} logBytes+=buf.length;
}
function regular(file, limit=4194304) {
  const st=fs.lstatSync(file); if(!st.isFile() || st.isSymbolicLink() || st.size>limit) throw controlError('input_type'); return fs.readFileSync(file);
}
function checkInput(file, expected) { const b=regular(file); if(sha(b)!==expected) throw controlError('input_hash'); return b; }
function cleanEnvironment(heap) {
  const e = {PATH:process.env.PATH,HOME:path.join(work,'config'),XDG_CONFIG_HOME:path.join(work,'config'),XDG_CACHE_HOME:path.join(work,'config','cache'),TMPDIR:path.join(work,'tmp'),LANG:'C.UTF-8',TZ:'UTC',NODE_OPTIONS:`--max-old-space-size=${heap}`,CI:'true',NPM_CONFIG_USERCONFIG:path.join(work,'config','empty.npmrc'),NPM_CONFIG_GLOBALCONFIG:path.join(work,'config','global.npmrc'),NPM_CONFIG_REGISTRY:'https://registry.npmjs.org/',NPM_CONFIG_IGNORE_SCRIPTS:'true',PNPM_CONFIG_PM_ON_FAIL:'error'};
  return Object.fromEntries(Object.entries(e).filter(([,v])=>typeof v==='string'));
}
function checkWork(phaseStart=start,cap=960000){supervision.check(phaseStart,cap);const now=performance.now();const overhead=now-start-childSpent-(activeChildStart===undefined?0:now-activeChildStart);if(overhead>=120000)throw controlError('copy_check_overhead_cutoff');}
function walk(root, visit, checkBudget=true, scope='single_tree') {
  const aggregate=['owned_work_pre_copy','owned_work_copy_resample','owned_work_post_copy','owned_work_monitor'].includes(scope);
  if(!aggregate&&scope!=='single_tree')throw controlError('walk_scope');
  const limit=aggregate?500000:100000,stack=[root];let n=0,total=0,lastCount=0,lastCheck=performance.now();
  const phase=()=>{const value=scope.includes('copy')?'copy':typeof activeChildScanCheck==='function'?activeChildScanCheck.phase:facts.phase;return ['prepare','tool_version','install','probe','copy','complete'].includes(value)?value:'unknown';};
  const witness=complete=>({phase:phase(),scope,limit,visited:n,bytes:total,complete});
  const checkpoint=force=>{if(!aggregate)return;const now=performance.now();if(force||n-lastCount>=128||now-lastCheck>=50){if(checkBudget)checkWork();if(typeof activeChildScanCheck==='function')activeChildScanCheck();lastCheck=performance.now();lastCount=n;}};
  try{
    checkpoint(true);
    while(stack.length) {
      if(checkBudget)checkWork();checkpoint(false);
      const file=stack.pop(),s=fs.lstatSync(file);++n;checkpoint(false);if(n>limit)throw controlError('tree_count');
      if(s.isDirectory()){const entries=fs.readdirSync(file);checkpoint(false);for(const x of entries){stack.push(path.join(file,x));checkpoint(false);}}
      else if(s.isFile()){total+=s.size;if(total>3221225472)throw controlError('disk_cap');}
      else if(!s.isSymbolicLink())throw controlError('tree_type');
      visit(file,s);checkpoint(false);
    }
    checkpoint(true);
    if(aggregate){facts.walkSamples??={};facts.walkSamples[scope]={...witness(true),sample:true,census:false};}
    return {files:n,bytes:total};
  }catch(e){facts.walkFailure??=witness(false);throw e;}
}
// LIVE_INSTALL_SAMPLING_BEGIN: private resource sampling, never SDK/copy admission.
const liveInstallOwners=new WeakSet();let activeLiveInstallOwner;
function publishLiveInstallOwner(owner){facts.liveInstallSampling={mode:owner.mode,retired:owner.state.retired,completedSamples:owner.state.completedSamples,cumulative:{...owner.counts},...(owner.state.failure?{failure:owner.state.failure}:{})};}
function beginLiveInstallOwner(tracked,kind,check){
  if(kind!=='install'||!tracked?.valid||tracked.closed||children.get(tracked.id)!==tracked||check!==activeChildScanCheck||typeof check!=='function'||activeLiveInstallOwner!==undefined||typeof work!=='string')throw controlError('live_sample_owner');
  const owner=Object.freeze({mode:'LIVE_INSTALL_BUDGET_SAMPLE',kind,scope:'owned_work_monitor',root:work,tracked,check,counts:{lstat:0,readdir:0,total:0,rootChecks:0},state:{retired:false,completedSamples:0}});
  liveInstallOwners.add(owner);activeLiveInstallOwner=owner;publishLiveInstallOwner(owner);return owner;
}
function retireLiveInstallOwner(owner){owner.state.retired=true;if(activeLiveInstallOwner===owner)activeLiveInstallOwner=undefined;liveInstallOwners.delete(owner);publishLiveInstallOwner(owner);}
function liveInstallBudgetSample(owner){
  const limit=500000,reserve=8388608,cap=3221225472;let fd,pin,primary,primaryOperation,closeFailure,operation='checkpoint',n=0,total=0,lastCount=0,lastCheck=performance.now(),goneLstat=0,goneReaddir=0;
  const validOwner=()=>{if(!owner||!liveInstallOwners.has(owner)||activeLiveInstallOwner!==owner||owner.state.retired||owner.mode!=='LIVE_INSTALL_BUDGET_SAMPLE'||owner.kind!=='install'||owner.scope!=='owned_work_monitor'||owner.root!==work||!owner.tracked.valid||owner.tracked.closed||children.get(owner.tracked.id)!==owner.tracked||owner.check!==activeChildScanCheck)throw controlError('live_sample_owner');};
  const checkpoint=force=>{operation='checkpoint';validOwner();checkWork();const now=performance.now(),due=n-lastCount>=128||now-lastCheck>=50;if(force||due){owner.check();if(due){lastCount=n;lastCheck=performance.now();}}};
  const charge=op=>{checkpoint(false);operation=op;if(++n>limit){operation='count';throw controlError('tree_count');}};
  const rootType=s=>{if(!s||!s.isDirectory()||s.isSymbolicLink()||![s.dev,s.ino].every(x=>Number.isSafeInteger(x)&&x>=0))throw controlError('live_root_type');};
  const rootIdentity=s=>{operation='root_identity';rootType(s);const opened=fs.fstatSync(fd);rootType(opened);if(opened.dev!==pin.dev||opened.ino!==pin.ino||s.dev!==pin.dev||s.ino!==pin.ino)throw controlError('live_root_identity');checkpoint(true);};
  const rootRecheck=()=>{charge('root_identity');owner.counts.rootChecks++;rootIdentity(fs.lstatSync(work));};
  const vanished=op=>{if(op==='lstat'){goneLstat++;owner.counts.lstat++;}else{goneReaddir++;owner.counts.readdir++;}if(++owner.counts.total>4096){operation='churn';throw controlError('live_sample_churn');}checkpoint(true);rootRecheck();checkpoint(true);};
  const code=e=>typeof e?.code==='string'&&/^[A-Za-z0-9_]{1,64}$/.test(e.code)?e.code:'other';
  const diagnostic=complete=>({phase:'install',scope:'owned_work_monitor',mode:'LIVE_INSTALL_BUDGET_SAMPLE',limit,visited:n,bytes:total,complete,mutable:true,sample:true,census:false,operation,vanished:{lstat:goneLstat,readdir:goneReaddir,total:goneLstat+goneReaddir},cumulative:{...owner.counts}});
  validOwner(); // Invalid capability fails before IO or dereferencing its counters.
  try{
    checkpoint(true);operation='root_open';
    if(!Number.isInteger(fs.constants.O_DIRECTORY)||fs.constants.O_DIRECTORY<=0||!Number.isInteger(fs.constants.O_NOFOLLOW)||fs.constants.O_NOFOLLOW<=0)throw controlError('live_root_flags');
    const opened=fs.openSync(work,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);if(!Number.isInteger(opened)||opened<0)throw controlError('live_root_fd');fd=opened;
    operation='root_identity';pin=fs.fstatSync(fd);rootType(pin);checkpoint(true);
    const stack=[work];
    while(stack.length){
      const file=stack.pop();if(!within(work,file))throw controlError('live_sample_escape');
      charge(file===work?'root_identity':'lstat');if(file===work)owner.counts.rootChecks++;
      let s;try{s=fs.lstatSync(file);}catch(e){if(file!==work&&e.code==='ENOENT'){vanished('lstat');continue;}throw e;}
      checkpoint(false);if(file===work)rootIdentity(s);
      if(s.isDirectory()){
        operation='readdir';let entries;try{entries=fs.readdirSync(file);}catch(e){if(file!==work&&e.code==='ENOENT'){vanished('readdir');continue;}throw e;}
        checkpoint(false);for(const name of entries){if(typeof name!=='string'||!name||name==='.'||name==='..'||name.includes('/')||name.includes('\\')){operation='escape';throw controlError('live_sample_escape');}stack.push(path.join(file,name));checkpoint(false);}
      }else if(s.isFile()){operation='bytes';if(!Number.isSafeInteger(s.size)||s.size<0)throw controlError('live_sample_stat');total+=s.size;if(total>cap)throw controlError('disk_cap');if(total+reserve>cap)throw controlError('owned_temp_cap');}
      else if(!s.isSymbolicLink()){operation='type';throw controlError('tree_type');}
      checkpoint(false);
    }
    rootRecheck();checkpoint(true);
  }catch(e){primary=e;primaryOperation=operation;}
  finally{if(fd!==undefined){try{operation='root_close';fs.closeSync(fd);}catch(e){closeFailure=e;}}}
  if(!primary&&!closeFailure){try{checkpoint(true);}catch(e){primary=e;primaryOperation=operation;}}
  if(primary||closeFailure){
    operation=primaryOperation||'root_close';const detail={...diagnostic(false),...(primary?{primaryCode:code(primary)}:{}),...(closeFailure?{closeCode:code(closeFailure)}:{})};
    facts.walkFailure??=detail;owner.state.failure??={operation,primaryCode:primary?code(primary):null,closeCode:closeFailure?code(closeFailure):null};publishLiveInstallOwner(owner);
    if(primary&&closeFailure){const both=new AggregateError([primary,closeFailure],'Live sampler primary and root close failed');both.code='live_root_primary_and_close';throw both;}
    if(primary)throw primary;const failed=controlError('live_root_close');failed.cause=closeFailure;throw failed;
  }
  owner.state.completedSamples++;publishLiveInstallOwner(owner);facts.walkSamples??={};facts.walkSamples.owned_work_monitor=diagnostic(true);return{files:n,bytes:total};
}
function ownedWorkBudget(){
  const sampled=activeLiveInstallOwner!==undefined?liveInstallBudgetSample(activeLiveInstallOwner):walk(work,()=>{},true,'owned_work_monitor');
  if(sampled.bytes+8388608>3221225472)throw controlError('owned_temp_cap');
  if(activeLiveInstallOwner===undefined&&facts.walkSamples?.owned_work_monitor)facts.walkSamples.owned_work_monitor.mutable=false;
  return sampled;
}
// LIVE_INSTALL_SAMPLING_END
function copyTree(source,destination) {
  const cap=3221225472;const sourceSize=walk(source,()=>{}).bytes;const before=walk(work,()=>{},true,'owned_work_pre_copy').bytes+8388608;
  if(before+sourceSize>cap)throw controlError('copy_temp_headroom');
  let charged=before,lastSample=performance.now();
  const boundary=extra=>{checkWork();if(charged+extra>cap)throw controlError('copy_temp_cap');if(performance.now()-lastSample>=250){const actual=walk(work,()=>{},true,'owned_work_copy_resample').bytes+8388608;if(actual+extra>cap)throw controlError('copy_temp_cap');charged=Math.max(charged,actual);lastSample=performance.now();}};
  boundary(0);fs.mkdirSync(destination,{mode:0o700});
  walk(source,(file,st)=>{
    if(file===source)return;const dst=path.join(destination,path.relative(source,file));
    const record={sourceRoot:source,destinationRoot:destination,destination:dst,type:st.isDirectory()?'directory':st.isSymbolicLink()?'link':'file'};
    if(st.isSymbolicLink()){const link=fs.readlinkSync(file);Object.assign(record,{absolute:path.isAbsolute(link),sourceTarget:fs.realpathSync(file),destinationTarget:path.resolve(path.dirname(dst),link)});}
    validateCopyRecord(record);boundary(st.isFile()?st.size:0);
    if(st.isDirectory())fs.mkdirSync(dst,{recursive:true,mode:0o700});
    else if(st.isSymbolicLink())fs.symlinkSync(fs.readlinkSync(file),dst);
    else{fs.mkdirSync(path.dirname(dst),{recursive:true,mode:0o700});fs.copyFileSync(file,dst,fs.constants.COPYFILE_EXCL);const after=fs.lstatSync(dst);validateCopyRecord({...record,after:true,links:after.nlink});charged+=after.size;if(after.size!==st.size)throw controlError('copy_source_changed');boundary(0);}
  });
  walk(destination,(f,st)=>{if(st.isSymbolicLink()&&!within(destination,fs.realpathSync(f)))throw controlError('copied_symlink_escape');});
  if(walk(work,()=>{},true,'owned_work_post_copy').bytes+8388608>cap)throw controlError('copy_temp_cap');
}
function sdkAt(context) {
  const loc=fs.realpathSync(path.join(context,'node_modules','@modelcontextprotocol','sdk'));
  if(!within(context,loc)) throw controlError('sdk_escape');
  if(JSON.parse(regular(path.join(loc,'package.json')).toString()).version!=='1.30.0') throw controlError('sdk_version'); return loc;
}
function sdkInventory(context, patchedMode=false, final=false) {
  const sdk=sdkAt(context), items=[];
  walk(sdk,(file,s)=>{ if(s.isSymbolicLink()) throw controlError('sdk_symlink'); if(s.isFile()) { if(s.nlink!==1) throw controlError('sdk_hardlink'); items.push({path:path.relative(sdk,file),bytes:s.size,sha256:sha(fs.readFileSync(file))}); } if(final&&performance.now()>=evidenceDeadline)throw controlError('finalization_cutoff'); },!final);
  items.sort((a,b)=>a.path.localeCompare(b.path));
  for(const pin of I.sdk) { const name=pin.member.replace(/^package\//,''); const got=items.find(x=>x.path===name); if(!got || (!patchedMode || !I.patchTargets.includes(name)) && got.sha256!==pin.sha256) throw controlError('sdk_member_hash'); }
  return {sdk,items,tree:sha(Buffer.from(JSON.stringify(items)))};
}
function ownPids(child) {
  const todo=[child.id], seen=new Set(); let rss=0;
  while(todo.length) { const id=todo.pop(); if(seen.has(id)) continue; seen.add(id); if(seen.size>32) throw controlError('owned_descendant_cap');
    try { const status=fs.readFileSync(`/proc/${id}/status`,'utf8'); rss += +( /^VmRSS:\s+(\d+)/m.exec(status)?.[1] || 0)*1024;
      const descendants=fs.readFileSync(`/proc/${id}/task/${id}/children`,'utf8').trim(); if(descendants) for(const x of descendants.split(/\s+/)) todo.push(+x);
    } catch(e) { if(!['ENOENT','ESRCH'].includes(e.code)) throw e; }
  }
  return rss;
}
async function child(command,args,cwd,cap,kind,env) {
  checkWork(performance.now(),cap);const began=performance.now();activeChildStart=began;
  let raw,tracked,failure,stopAt,monitor,disk,killTimer,drainTimer,versionTimer,installSamplingOwner,settled=false,resolveOutcome;
  const versionOutput=kind==='tool_version'?{stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:undefined;const versionCounts={stdout:0,stderr:0};
  const outcome=new Promise(resolve=>{resolveOutcome=resolve;});
  const observe=code=>{facts.childEvents??=[];if(facts.childEvents.length<64)facts.childEvents.push({kind,code});};
  const settle=value=>{if(!settled){settled=true;resolveOutcome(value);}};
  const signal=s=>{if(tracked?.valid&&!tracked.closed&&children.get(tracked.id)===tracked){try{process.kill(-tracked.id,s);}catch(e){if(e.code!=='ESRCH'){failure??=controlError('child_signal');observe('signal_error');}}}};
  const stop=code=>{
    failure??=controlError(code);if(stopAt!==undefined)return;stopAt=performance.now();drainDeadline??=stopAt+10000;signal('SIGTERM');
    killTimer=setTimeout(()=>signal('SIGKILL'),Math.min(2000,Math.max(0,drainDeadline-performance.now())));
    drainTimer=setTimeout(()=>{observe('close_drain_timeout');for(const detach of [()=>raw?.stdout?.destroy?.(),()=>raw?.stderr?.destroy?.(),()=>raw?.unref?.()]){try{detach();}catch{observe('owned_handle_detach_error');}}settle({forced:true});},Math.max(0,drainDeadline-performance.now()));
  };
  const nonDiskCheck=()=>{try{supervision.check(began,cap);let sum=process.memoryUsage().rss;for(const c of children.values())if(!c.closed){const rss=ownPids(c);sum+=rss;if(rss>(kind==='install'?2147483648:1073741824))throw controlError('rss_cap');}if(sum>4294967296)throw controlError('aggregate_rss_cap');}catch(e){throw controlError(kind==='tool_version'&&e.code==='phase_cutoff'?'tool_version_timeout':e.code||'monitor_error');}};
  const scanCheck=()=>{if(failure)throw failure;nonDiskCheck();};scanCheck.phase=kind;
  try {
    try{raw=cp.spawn(command,args,{cwd,env,detached:true,stdio:['ignore','pipe','pipe']});}catch(e){if(kind==='tool_version')throw controlError('tool_version_spawn_error');throw e;}
    tracked={id:raw.pid,closed:false,valid:Number.isInteger(raw.pid)&&raw.pid>0};
    raw.on('error',()=>{observe(tracked.valid?'child_error':'invalid_pid_late_error');if(tracked.valid)stop(kind+'_spawn_error');else settle({invalid:true});});
    raw.once('close',(code,signalName)=>{tracked.closed=true;settle({code,signal:signalName});});
    for(const stream of [raw.stdout,raw.stderr])stream?.on('error',()=>{observe(tracked.valid?'stdio_error':'invalid_pid_stdio_error');if(tracked.valid)stop('child_stdio_error');});
    if(!tracked.valid){observe('invalid_pid');raw.stdout?.destroy?.();raw.stderr?.destroy?.();raw.unref?.();throw controlError(kind==='tool_version'?'tool_version_spawn_error':'child_spawn');}
    children.set(tracked.id,tracked);supervision.own(tracked);activeChildScanCheck=scanCheck;
    if(kind==='install')installSamplingOwner=beginLiveInstallOwner(tracked,kind,scanCheck);
    for(const [name,stream]of [['stdout',raw.stdout],['stderr',raw.stderr]])stream?.on('data',b=>{try{if(kind==='tool_version'){versionCounts[name]=Math.min(129,versionCounts[name]+b.length);if(versionCounts[name]>128){stop('tool_version_'+name+'_cap');return;}versionOutput[name]=Buffer.concat([versionOutput[name],b]);}else log(b);}catch(e){stop(e.code||'log_error');}});
    if(kind==='tool_version')versionTimer=setTimeout(()=>stop('tool_version_timeout'),Math.max(0,cap-(performance.now()-began)));
    monitor=setInterval(()=>{try{nonDiskCheck();}catch(e){stop(e.code||'monitor_error');}},100);
    disk=setInterval(()=>{try{ownedWorkBudget();}catch(e){stop(e.code||'disk_monitor');}},250);
    const result=await outcome;if(kind==='tool_version'){facts.toolPreflight??={};facts.toolPreflight.probeExitCode=Number.isInteger(result.code)?result.code:null;facts.toolPreflight.probeSignalled=!!result.signal;}
    if(result.forced)throw controlError('child_drain_timeout');if(failure)throw failure;if(kind==='tool_version'&&result.signal)throw controlError('tool_version_signal');if(result.code!==0)throw controlError(kind+'_exit');if(kind==='tool_version')return {...versionOutput,code:result.code};
  }finally{
    if(installSamplingOwner)retireLiveInstallOwner(installSamplingOwner);
    if(activeChildScanCheck===scanCheck)activeChildScanCheck=undefined;
    for(const timer of [monitor,disk])if(timer!==undefined)clearInterval(timer);
    for(const timer of [killTimer,drainTimer,versionTimer])if(timer!==undefined)clearTimeout(timer);
    if(kind==='tool_version'){facts.toolPreflight??={};facts.toolPreflight.stdoutBytes=versionCounts.stdout;facts.toolPreflight.stderrBytes=versionCounts.stderr;}
    childSpent+=performance.now()-began;activeChildStart=undefined;
    if(tracked?.valid&&tracked.closed){children.delete(tracked.id);supervision.done(tracked.id);}
  }
}
function probeRequired(value,variant,mode){
  if(!value||value.variant!==variant||value.mode!==mode||value.evidenceIncomplete||!Array.isArray(value.cases)||value.requiredControlsPassed!==true||value.unhandled!==0||value.activeOwnedListeners!==0||value.cases.some(c=>c.required&&c.status!=='pass'))throw controlError('probe_required_controls');
  if(variant==='baseline'&&value.baselineRedObserved!==true)throw controlError('baseline_not_reproduced');
  if(variant==='patched'&&value.allRequiredGreen!==true)throw controlError('required_patched_oracle');
}
function observeM71(options,final=false){
  const listing=cp.execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','ls-tree','-r','-z',I.base],{...options,encoding:'utf8'});const rows=listing.split('\0').filter(Boolean);if(rows.length!==I.m71Source.paths||rows.length>4096||sha(Buffer.from(listing))!==I.m71Source.lsTreeSHA256)throw controlError('m71_source_count_or_inventory');
  let bytes=0;const digest=crypto.createHash('sha256');
  for(const row of rows){
    if(final){if(performance.now()>=evidenceDeadline)throw controlError('finalization_cutoff');}else checkWork();
    const match=/^(100644|100755|120000) blob ([0-9a-f]{40})\t(.+)$/.exec(row);if(!match)throw controlError('m71_source_mode');
    const [,mode,expected,name]=match;if(name.startsWith('/')||name.split('/').some(x=>x==='..'||x===''))throw controlError('m71_source_path');
    let parent=ROOT;for(const component of name.split('/').slice(0,-1)){parent=path.join(parent,component);const st=fs.lstatSync(parent);if(!st.isDirectory()||st.isSymbolicLink())throw controlError('m71_parent_type');}
    const file=path.join(ROOT,name),st=fs.lstatSync(file);let data;
    if(mode==='120000'){if(!st.isSymbolicLink())throw controlError('m71_source_type');data=Buffer.from(fs.readlinkSync(file));}
    else{if(!st.isFile()||st.isSymbolicLink()||st.size>67108864||Boolean(st.mode&0o111)!==(mode==='100755'))throw controlError('m71_source_type');data=fs.readFileSync(file);}
    bytes+=data.length;if(bytes>1073741824)throw controlError('m71_source_bytes');
    const actual=crypto.createHash('sha1').update(Buffer.from('blob '+data.length+'\0')).update(data).digest('hex');if(actual!==expected)throw controlError('m71_worktree_bytes_changed');digest.update(name+'\0'+actual+'\0');
  }
  return {paths:rows.length,bytes,digestSHA256:digest.digest('hex')};
}
function sourcePostcheck(final=false){
  if(!fullBindings)throw controlError('full8_binding_not_established');
  for(const [name,h]of Object.entries({...fullBindings,...I.context}))checkInput(path.join(ROOT,name),h);
  const options={cwd:ROOT,encoding:'utf8',timeout:5000,maxBuffer:1048576,env:{PATH:process.env.PATH,HOME:process.env.RUNNER_TEMP,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'}};
  const git=(...args)=>cp.execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],options).trim();
  if(git('rev-parse','HEAD')!==facts.provenance.source||git('rev-parse','HEAD^{tree}')!==facts.provenance.sourceTree||git('status','--porcelain=v1','--untracked-files=all')!=='')throw controlError('source_worktree_changed');
  if(baselineTree&&sdkInventory(baseline,false,final).tree!==baselineTree.tree)throw controlError('baseline_mutated');
  const m71=observeM71(options,final);facts.sourcePostcheck={full8:true,context:true,head:true,tree:true,worktreeClean:true,m71ActualWorktree:m71,baseline:baselineTree?'unchanged':'not_established'};
}
// SOURCE_ADMISSION_BEGIN
// Reviewed source-only audit is external evidence; this payload digest vouches for
// that immutable record. No runtime YAML parser, URL substring scan, or resolver.
const SOURCE_ADMISSION_SHA256 = '04cc1742096be943752ed5c54b65bd46aae1115213b1822082ecde44dae6c934';
function canonicalSourceAdmission(value) {
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonicalSourceAdmission).join(',')+']';
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonicalSourceAdmission(value[k])).join(',')+'}';
}
function admitRegistrySources(lock) {
  const a=I.sourceAdmission;
  if(!a||sha(Buffer.from(canonicalSourceAdmission(a)))!==SOURCE_ADMISSION_SHA256)throw controlError('source_admission');
  if(a.kind!=='reviewed-registry-source-admission-v1'||a.completeSourceFieldAudit!==true||a.candidateIntegrityOnlyRecords!==950||a.baseIntegrityOnlyRecords!==896)throw controlError('source_admission');
  if(a.manifestSHA256!==I.manifestSHA256||a.candidateSHA256!==I.candidateSHA256||sha(Buffer.from(lock))!==a.candidateSHA256)throw controlError('source_admission_binding');
  checkInput(path.join(__dirname,'inputs/package.json'),a.manifestSHA256);
  if(canonicalSourceAdmission(a.context)!==canonicalSourceAdmission(I.context))throw controlError('source_admission_context');
  for(const [name,h]of Object.entries(a.context))checkInput(path.join(ROOT,name),h);
  if(a.patchExceptions.length!==5)throw controlError('source_admission_patch');
  for(const patch of a.patchExceptions)if(a.context[patch.path]!==patch.sha256)throw controlError('source_admission_patch');
}
// SOURCE_ADMISSION_END

// TOOL_PREFLIGHT_BEGIN
// NODE_BINARY_HASH_BEGIN
// Node is distinct from4MiB source/launcher documents: <=256MiB, <=1MiB reads.
function hashNodeBinary(file) {
  const maximum=268435456,chunkMaximum=1048576;
  let fd,stage='stat',declaredBytes,readBytes=0,readChunks=0,lastRequested=0,lastReturned=null;
  const diagnostics=()=>({stage,declaredBytes:Number.isSafeInteger(declaredBytes)&&declaredBytes>=0?declaredBytes:null,readBytes,readChunks,lastRequested,lastReturned,maximumBytes:maximum,maximumChunkBytes:chunkMaximum});
  const failure=code=>{const e=controlError(code);e.nodeHash=diagnostics();return e;};
  const type=st=>{if(!st||typeof st.isFile!=='function'||typeof st.isSymbolicLink!=='function'||!st.isFile()||st.isSymbolicLink())throw failure('node_binary_type');};
  const size=st=>{if(!Number.isSafeInteger(st.size)||st.size<=0||st.size>maximum)throw failure('node_binary_size');};
  const identity=st=>{if(![st.dev,st.ino,st.mtimeMs,st.ctimeMs].every(Number.isFinite))throw failure('node_binary_identity');};
  const stat=()=>{try{return fs.lstatSync(file);}catch{throw failure('node_binary_stat');}};
  const fstat=()=>{try{return fs.fstatSync(fd);}catch{throw failure('node_binary_fstat');}};
  try {
    checkWork();const before=stat();declaredBytes=before?.size;type(before);size(before);identity(before);
    stage='open';try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}catch{throw failure('node_binary_open');}
    if(!Number.isInteger(fd)||fd<0){fd=undefined;throw failure('node_binary_open');}
    const same=st=>{type(st);if(st.size>before.size)throw failure('node_binary_grow');if(st.size<before.size)throw failure('node_binary_shrink');identity(st);if(st.size!==before.size)throw failure('node_binary_size');if(st.dev!==before.dev||st.ino!==before.ino||st.mtimeMs!==before.mtimeMs||st.ctimeMs!==before.ctimeMs)throw failure('node_binary_identity');};
    stage='opened_stat';same(fstat());let buffer;try{buffer=Buffer.alloc(Math.min(chunkMaximum,before.size));}catch{throw failure('node_binary_buffer');}
    const digest=crypto.createHash('sha256');let position=0;
    while(position<before.size){
      stage='read_stat';checkWork();same(fstat());lastRequested=Math.min(buffer.length,before.size-position);let count;stage='read';
      try{count=fs.readSync(fd,buffer,0,lastRequested,position);}catch{throw failure('node_binary_read');}
      lastReturned=Number.isInteger(count)&&count>=0&&count<=chunkMaximum+1?count:null;
      if(!Number.isInteger(count)||count!==lastRequested)throw failure('node_binary_read_length');
      digest.update(buffer.subarray(0,count));position+=count;readBytes+=count;readChunks++;
    }
    stage='final_descriptor_stat';checkWork();same(fstat());stage='final_path_stat';same(stat());stage='digest';const result=digest.digest('hex');checkWork();return {sha256:result,bytes:before.size,readChunks};
  } catch(e) {if(!e.nodeHash)e.nodeHash=diagnostics();throw e;}
  finally {if(fd!==undefined){stage='close';try{fs.closeSync(fd);}catch{throw failure('node_binary_close');}}}
}
// NODE_BINARY_HASH_END

// The pinned action declares dest/bin_dest; ambient PATH is diagnostic only.
function saveToolPreflight(status) {
  facts.toolPreflight.status=status; out('facts.json',facts); out('hashes.json',hashes);
}
function bindPnpmLauncher() {
  facts.toolPreflight={status:'binding_pending',selection:'explicit_setup_outputs',expectedVersion:'11.28.6',ambientSelection:'missing',probeClassification:'not_started'};
  try {
    const absolute=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&path.isAbsolute(value)&&path.normalize(value)===value&&!/[\x00-\x1f\x7f]/.test(value);
    const expected=path.join(process.env.RUNNER_TEMP,'sdk130-pnpm-tool'),configured=process.env.PNPM_CONFIGURED_DEST,dest=process.env.PNPM_SETUP_DEST,bin=process.env.PNPM_SETUP_BIN_DEST;
    if(!absolute(expected)||!absolute(configured)||!absolute(dest)||!absolute(bin)||configured!==expected||dest!==expected||!within(dest,bin))throw controlError('pnpm_setup_binding');
    const rootStat=fs.lstatSync(dest);if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||fs.realpathSync(dest)!==dest)throw controlError('pnpm_setup_binding');
    const binReal=fs.realpathSync(bin);if(!absolute(binReal)||!within(dest,binReal)||!fs.statSync(bin).isDirectory())throw controlError('pnpm_setup_binding');
    const launcher=path.join(bin,'pnpm'),selected=fs.lstatSync(launcher),real=fs.realpathSync(launcher);
    if((!selected.isFile()&&!selected.isSymbolicLink())||!absolute(real)||!within(dest,real))throw controlError('pnpm_setup_binding');
    const target=fs.lstatSync(real),bytes=regular(real),digest=sha(bytes),link=selected.isSymbolicLink()?fs.readlinkSync(launcher):null;
    const ambient=process.env.PNPM_AMBIENT_BIN;
    facts.toolPreflight={...facts.toolPreflight,configuredRoot:'RUNNER_TEMP/sdk130-pnpm-tool',declaredBin:path.relative(dest,bin),launcher:path.relative(dest,launcher),realLauncher:path.relative(dest,real),launcherKind:link===null?'file':'symlink',launcherSHA256:digest,realLauncherSHA256:digest,ambientSelection:typeof ambient!=='string'||ambient.length===0?'missing':ambient===launcher?'same':'different'};
    const nodeBinary=hashNodeBinary(process.execPath);hashes.tools={node:process.version,nodeSHA256:nodeBinary.sha256,nodeBinaryBytes:nodeBinary.bytes,nodeBinaryReadChunks:nodeBinary.readChunks,declaredPnpm:'11.28.6',cliSHA256:digest};facts.toolPreflight.nodeBinaryHash={stage:'complete',bytes:nodeBinary.bytes,readChunks:nodeBinary.readChunks,maximumBytes:268435456,maximumChunkBytes:1048576};saveToolPreflight('bound_before_probe');
    return {launcher,real,digest,link,selectedDev:selected.dev,selectedIno:selected.ino,targetDev:target.dev,targetIno:target.ino};
  } catch(e) { const code=typeof e.code==='string'&&(e.code.startsWith('node_binary_')||['owned_work_cutoff','copy_check_overhead_cutoff','clock_regression','phase_cutoff','supervisor_stopping'].includes(e.code))?e.code:'pnpm_setup_binding';facts.toolPreflight.probeClassification='not_started';if(e.nodeHash){facts.toolPreflight.nodeBinaryHash={...e.nodeHash,failureCode:code};saveToolPreflight('node_hash_rejected');}else{facts.toolPreflight.bindingFailure=code;saveToolPreflight('binding_rejected');}throw controlError(code); }
}
function recheckPnpmLauncher(binding) {
  try {
    const selected=fs.lstatSync(binding.launcher),real=fs.realpathSync(binding.launcher),target=fs.lstatSync(real);
    if(real!==binding.real||selected.dev!==binding.selectedDev||selected.ino!==binding.selectedIno||target.dev!==binding.targetDev||target.ino!==binding.targetIno||sha(regular(real))!==binding.digest||(selected.isSymbolicLink()?fs.readlinkSync(binding.launcher):null)!==binding.link)throw controlError('pnpm_launcher_changed');
  } catch(e) { saveToolPreflight('launcher_changed');throw controlError('pnpm_launcher_changed'); }
}
async function probePnpmLauncher(binding) {
  const cwd=path.join(work,'tool-version');fs.mkdirSync(cwd,{mode:0o700});
  if(fs.readdirSync(cwd).length!==0)throw controlError('tool_version_cwd');
  let result;
  facts.toolPreflight.probeClassification='running';saveToolPreflight('probing');
  try { result=await child(binding.real,['--version'],cwd,5000,'tool_version',cleanEnvironment(1024)); }
  catch(e) { facts.toolPreflight.probeClassification=e.code||'tool_version_spawn_error';saveToolPreflight('probe_rejected');throw e; }
  const stdout=result?.stdout,stderr=result?.stderr;
  const reject=code=>{facts.toolPreflight.probeClassification=code;saveToolPreflight('probe_rejected');throw controlError(code);};
  if(!Buffer.isBuffer(stdout)||!Buffer.isBuffer(stderr))reject('tool_version_format');
  facts.toolPreflight.stdoutBytes=stdout.length;facts.toolPreflight.stderrBytes=stderr.length;
  if(stdout.length>128)reject('tool_version_stdout_cap');if(stderr.length>128)reject('tool_version_stderr_cap');
  if(stderr.length!==0)reject('tool_version_stderr');if([...stdout].some(n=>n>127))reject('tool_version_encoding');
  const text=stdout.toString('ascii'),match=/^((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\r?\n)?$/.exec(text);
  if(!match||match[0].length!==text.length)reject('tool_version_format');
  facts.toolPreflight.observedParsedVersion=match[1];facts.toolPreflight.probeClassification='parsed';saveToolPreflight('observed_before_version_admission');
  if(match[1]!=='11.28.6')reject('tool_version_mismatch');
  hashes.tools.pnpm=match[1];facts.toolPreflight.probeClassification='exact_version';saveToolPreflight('exact_version_admitted');
}
// TOOL_PREFLIGHT_END

async function main() {
  out('raw.log',''); facts.provenance=JSON.parse(regular(path.join(OUTPUT,'provenance.json')).toString());
  fullBindings={...I.inputs,'.github/sdk130-phase0/INPUTS.json':facts.provenance.inputManifestSHA256,'.github/workflows/sdk130-json-phase0.yml':facts.provenance.workflowSHA256};if(Object.keys(fullBindings).sort().join('|')!==[...I.allowedPaths].sort().join('|'))throw controlError('full8_binding');for(const [name,h]of Object.entries(fullBindings))if(facts.provenance.sourceHashes[name]!==h)throw controlError('full8_guard_snapshot');sourcePostcheck();
  // provenance.json is a transient guard input, never a publishable output.
  fs.unlinkSync(path.join(OUTPUT,'provenance.json'));
  if(process.platform!=='linux' || process.version!=='v24.20.0' || !process.env.RUNNER_TEMP) throw controlError('tool_platform');
  for(const [name,h] of Object.entries(I.inputs)) checkInput(path.join(ROOT,name),h);
  for(const [name,h] of Object.entries(I.context)) checkInput(path.join(ROOT,name),h);
  const archive=regular(path.join(__dirname,'inputs/sdk-1.30.0.tgz'));
  if('sha512-'+crypto.createHash('sha512').update(archive).digest('base64')!==I.sdkSRI) throw controlError('sdk_sri');
  const original=JSON.parse(checkInput(path.join(ROOT,'package.json'),I.context['package.json']).toString()); const proposed=JSON.parse(JSON.stringify(original)); proposed.dependencies['@modelcontextprotocol/sdk']='1.30.0';
  if(sha(Buffer.from(JSON.stringify(proposed,null,2)+'\n'))!==I.manifestSHA256) throw controlError('canonical_manifest');
  const lock=regular(path.join(__dirname,'inputs/pnpm-lock.UNVALIDATED.yaml')).toString();
  admitRegistrySources(lock);
  work=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'sdk130-phase0-')); fs.chmodSync(work,0o700); baseline=path.join(work,'baseline');patched=path.join(work,'patched');fs.mkdirSync(baseline);
  for(const x of ['config','tmp','store']) fs.mkdirSync(path.join(work,x),{mode:0o700}); for(const x of ['empty.npmrc','global.npmrc'])fs.writeFileSync(path.join(work,'config',x),'');
  for(const [name,h] of Object.entries(I.context)) { if(name==='package.json'||name==='pnpm-lock.yaml') continue; const dst=path.join(baseline,name);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.writeFileSync(dst,checkInput(path.join(ROOT,name),h)); }
  fs.copyFileSync(path.join(__dirname,'inputs/package.json'),path.join(baseline,'package.json')); fs.copyFileSync(path.join(__dirname,'inputs/pnpm-lock.UNVALIDATED.yaml'),path.join(baseline,'pnpm-lock.yaml'));
  const pnpmBinding=bindPnpmLauncher();
  await probePnpmLauncher(pnpmBinding);
  recheckPnpmLauncher(pnpmBinding);
  const pnpmReal=pnpmBinding.real;
  const installStart=performance.now(); facts.phase='install';
  await child(pnpmReal,['install','--frozen-lockfile','--ignore-scripts','--ignore-pnpmfile','--package-import-method=copy','--store-dir',path.join(work,'store'),'--registry=https://registry.npmjs.org/','--network-concurrency=4','--fetch-retries=0','--fetch-timeout=60000','--pm-on-fail=error'],baseline,480000,'install',cleanEnvironment(1024));
  ownedWorkBudget(); // Capability retired by child finally: strict ready boundary before SDK.
  facts.installMs=performance.now()-installStart;
  function frozenContext(){ for(const [name,h] of Object.entries(I.context)) { if(['package.json','pnpm-lock.yaml'].includes(name))continue;checkInput(path.join(baseline,name),h); }checkInput(path.join(baseline,'package.json'),I.manifestSHA256);checkInput(path.join(baseline,'pnpm-lock.yaml'),I.candidateSHA256); }
  frozenContext(); baselineTree=sdkInventory(baseline); hashes.baseline=baselineTree.items;
  let probeSpent=0;
  async function probe(context,variant,mode) {
    if(probeSpent>=360000)throw controlError('probe_aggregate_cutoff'); const probeStarted=performance.now(); const result=path.join(work,`${variant}-${mode}.json`);
    // No inherited NODE_PATH/preload/proxy/auth. Only this future runner executes SDK.
    let childError;
    try{await child(process.execPath,['--expose-gc','--max-old-space-size=512',path.join(__dirname,'probe.mjs'),context,variant,mode,result],context,Math.min(360000-probeSpent,960000-(performance.now()-start)),'probe',cleanEnvironment(512));}catch(e){childError=e;}
    probeSpent+=performance.now()-probeStarted;
    let value,harvestError;
    if(fs.existsSync(result)){
      try{
        const bytes=regular(result,1048576),identity={requestedVariant:variant,requestedMode:mode,resultBytes:bytes.length,resultSHA256:sha(bytes)};
        try{value=JSON.parse(bytes.toString());if(bytes.length>131072){cases.push({variant,mode,...identity,declaredVariant:value.variant,declaredMode:value.mode,partial:true,evidenceIncomplete:true,prefix:bytes.subarray(0,32768).toString(),prefixTruncated:true});timelines[mode].push({variant,partial:true,evidenceIncomplete:true});harvestError=controlError('probe_evidence_oversize');}else{const mismatch=value.variant!==variant||value.mode!==mode;cases.push({variant,mode,...identity,declaredVariant:value.variant,declaredMode:value.mode,bindingMismatch:mismatch,partial:!!childError,cases:value.cases,baselineRedObserved:value.baselineRedObserved,requiredControlsPassed:value.requiredControlsPassed,allRequiredGreen:value.allRequiredGreen,limits:value.limits});timelines[mode].push({variant,partial:!!childError,bindingMismatch:mismatch,timeline:value.timeline});if(mismatch)harvestError=controlError('probe_binding');}}
        catch(e){if(e.code==='probe_binding')throw e;cases.push({variant,mode,...identity,partial:true,parseFailure:true,prefix:bytes.subarray(0,32768).toString(),prefixTruncated:bytes.length>32768});harvestError=controlError('probe_result_parse');}
      }catch(e){harvestError=e;cases.push({variant,mode,partial:true,harvestFailure:e.code||'result_read_failure',childFailure:childError?.code});}
    }
    if(childError)throw childError;
    if(harvestError)throw harvestError;
    if(probeSpent>360000)throw controlError('probe_aggregate_cutoff');
    if(!value)throw controlError('probe_result_missing');probeRequired(value,variant,mode);
    if(sdkInventory(baseline).tree!==baselineTree.tree)throw controlError('baseline_mutated');return value;
  }
  const b=[];for(const mode of ['esm','cjs'])b.push(await probe(baseline,'baseline',mode));
  facts.baselineRedObserved=b.every(x=>x.baselineRedObserved===true);
  if(!facts.baselineRedObserved)throw controlError('baseline_not_reproduced');
  checkWork(); copyTree(baseline,patched); const patchedSdk=sdkAt(patched); const patch=regular(path.join(__dirname,'normal-json-cleanup.patch')).toString();
  for(const target of I.patchTargets){const f=path.join(patchedSdk,target), before=regular(f).toString(), after=patchText(before,patch,target); fs.writeFileSync(f,after);}
  const patchedTree=sdkInventory(patched,true); const delta=patchedTree.items.filter(x=>baselineTree.items.find(y=>y.path===x.path)?.sha256!==x.sha256);
  if(delta.length!==2||delta.some(x=>!I.patchTargets.includes(x.path))||patchedTree.items.length!==baselineTree.items.length)throw controlError('sdk_patch_tree'); hashes.patched=delta; frozenContext();
  const g=[];for(const mode of ['esm','cjs'])g.push(await probe(patched,'patched',mode));
  facts.patchedGreen=g.every(x=>x.allRequiredGreen===true); if(!facts.patchedGreen)throw controlError('required_patched_oracle');
  sourcePostcheck(); checkWork(); facts.phase='complete';facts.status='diagnostic_pass_only';
}
async function finish(error) {
  const began=performance.now(); if(error)facts.failures.push(String(error.code||'finite_failure')); if(evidenceIncomplete)facts.failures.push('evidence_incomplete');
  try{await supervision.stop(drainDeadline);}catch(e){facts.failures.push(e.code||'drain_failure');} cleanup.ownedChildren=supervision.size();
  const deadline=performance.now()+120000; evidenceDeadline=deadline;
  try {
    try{sourcePostcheck(true);}catch(e){facts.failures.push(e.code||'source_postcheck');}
    if(work){fs.rmSync(work,{recursive:true,force:true,maxRetries:0});cleanup.tempRemoved=!fs.existsSync(work);}cleanup.completed=cleanup.ownedChildren===0&&(!work||cleanup.tempRemoved);
    if(!cleanup.completed)facts.failures.push('cleanup_incomplete');
    if(performance.now()>deadline)throw controlError('finalization_cutoff');
    if(facts.failures.length){facts.status='failed';facts.classification='NO_ADOPTION';facts.patchedGreen=false;}
    facts.totalDriverMs=performance.now()-start;facts.ownedChildMs=childSpent;facts.copyCheckOverheadMs=performance.now()-start-childSpent-(activeChildStart===undefined?0:performance.now()-activeChildStart);facts.finalizationMs=performance.now()-began;
    out('facts.json',facts);out('cases.json',cases);out('esm-timeline.json',timelines.esm);out('cjs-timeline.json',timelines.cjs);out('hashes.json',hashes);out('cleanup.json',cleanup);out('SUMMARY.md',`# SDK130 Phase0\n\n${facts.status}; NO_ADOPTION pending root review.\nBaseline RED: ${facts.baselineRedObserved}; patched GREEN: ${facts.patchedGreen}.\n`);
    const entries=fs.readdirSync(OUTPUT).filter(x=>x!=='SHA256SUMS').map(name=>{const s=fs.lstatSync(path.join(OUTPUT,name));return {name,type:s.isFile()?'file':'invalid',links:s.nlink,bytes:s.size};}); artifactGate(entries);
    out('SHA256SUMS',entries.sort((a,b)=>a.name.localeCompare(b.name)).map(x=>sha(fs.readFileSync(path.join(OUTPUT,x.name)))+'  '+x.name+'\n').join(''));
    if(performance.now()>=deadline)throw controlError('finalization_cutoff');
  }catch(e){facts.status='failed';facts.failures.push(e.code||'publication_failure');try{out('facts.json',facts);}catch{}process.stdout.write('phase0 publication_failed NO_ADOPTION\n');process.exitCode=1;return;}
  if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,'publishable=true\n'); process.stdout.write(`phase0 ${facts.status} NO_ADOPTION\n`);if(error||facts.failures.length)process.exitCode=1;
}
if(require.main===module) main().then(()=>finish(),e=>finish(e));
