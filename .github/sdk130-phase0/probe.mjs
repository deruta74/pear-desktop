// PRIVATE PREPARATION ONLY: SDK imports below are FUTURE isolated-runner authority.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
const [context,variant,mode,resultFile]=process.argv.slice(2);
if(!['baseline','patched'].includes(variant)||!['esm','cjs'].includes(mode)||process.platform!=='linux'||process.version!=='v24.20.0')throw new Error('probe_authority');
const sdk=fs.realpathSync(path.join(context,'node_modules/@modelcontextprotocol/sdk'));
if(!sdk.startsWith(path.resolve(context)+path.sep))throw new Error('sdk_escape');
const req=createRequire(path.join(sdk,'package.json'));
const load=async suffix=>mode==='esm'?import(pathToFileURL(path.join(sdk,'dist/esm',suffix)).href):req(path.join(sdk,'dist/cjs',suffix));
const {McpServer}=await load('server/mcp.js');
const {WebStandardStreamableHTTPServerTransport}=await load('server/webStandardStreamableHttp.js');
const {Client}=await load('client/index.js');
const {StreamableHTTPClientTransport,StreamableHTTPError}=await load('client/streamableHttp.js');
const {z}=req('zod');
const output={variant,mode,baselineRedObserved:false,allRequiredGreen:false,cases:[],timeline:[],evidenceIncomplete:false,limits:{requests:0,maxRequests:128,maxSessions:4,maxJobs:4,maxSockets:8,maxListeners:2}};
const started=performance.now();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function assert(x,code){if(!x)throw new Error(code);}
function key(id){assert(typeof id==='string'||Number.isSafeInteger(id),'typed_id');return typeof id+':'+String(id);}
function gate(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function errorName(e){return typeof e?.message==='string'?e.message.slice(0,160):'unknown_error';}
const unhandled=[];process.on('unhandledRejection',()=>{unhandled.push('unhandled_rejection');});
function outcomeRecord(id,bag){const record={id,phase:'pending'};bag.push(record);return {record,yes:()=>{record.phase='resolved';},no:()=>{record.phase='rejected';}};}
function outcome(p,id,bag){const tracker=outcomeRecord(id,bag);p.then(tracker.yes,tracker.no);return tracker.record;}
// OWN_DIAGNOSTIC_HELPERS_BEGIN: OWN test ownership only; never vendor source.
function newDiagnosticTombstone(row){return {row,k:row.k,id:row.id,physicalStarted:false,physicalDone:true,sdkSendStarted:false,sdkSendDone:false,sdkSendOutcome:'pending',retired:false};}
function startDiagnosticPhysical(t){if(!t)return;if(t.physicalStarted)throw new Error('diagnostic_physical_duplicate');t.physicalStarted=true;t.physicalDone=false;}
function finishDiagnosticPhysical(t){if(!t)return;if(!t.physicalStarted)throw new Error('diagnostic_physical_missing');t.physicalDone=true;}
async function diagnosticSend(t,injected,forward){
  if(!t||injected)return await forward();
  if(t.sdkSendStarted||t.retired)throw new Error('diagnostic_send_collision');t.sdkSendStarted=true;
  try{const value=await forward();t.sdkSendOutcome='resolved';return value;}catch(e){t.sdkSendOutcome='rejected';throw e;}finally{t.sdkSendDone=true;}
}
function diagnosticReady(t){return t.physicalDone&&t.sdkSendStarted&&t.sdkSendDone&&!t.retired;}
function retireDiagnosticTombstones(ctx,physical,mapsAtBaseline){
  if(!ctx.tombstones.size)return 0;
  if(physical!==0||!mapsAtBaseline||[...ctx.tombstones.values()].some(t=>!diagnosticReady(t)))throw new Error('diagnostic_terminal_unproven');
  const count=ctx.tombstones.size;for(const [k,t]of ctx.tombstones){if(ctx.tombstones.get(k)!==t)throw new Error('diagnostic_owner_changed');t.retired=true;ctx.tombstones.delete(k);}return count;
}
function observeBodyCompletion(response,rec){
  rec.bodyReads={json:'not_called',text:'not_called'};rec.bodySettled=!!rec.body;
  for(const method of ['json','text']){const read=response[method].bind(response);response[method]=async(...args)=>{rec.bodyReads[method]='pending';try{const value=await read(...args);rec.body=true;rec.bodySettled=true;rec.bodyReads[method]='fulfilled';return value;}catch(e){rec.body=false;rec.bodySettled=true;rec.bodyReads[method]='rejected';throw e;}};}return response;
}
function newInitializeTrace(){return {lastStage:'case_enter',failedWait:'none',stages:[]};}
function initializeStage(trace,stage,state={}){
  if(!['case_enter','client_bound','initialize_held','notification_begin','notification_denied','caller_abort','client_rejected','complete','failure'].includes(stage)||trace.stages.length>=12)throw new Error('initialize_trace_bound');
  if(!['none','initialize_held','notification_settle','notification_receipt','connect_reject'].includes(trace.failedWait))throw new Error('initialize_wait_bound');
  const snapshot={stage,failedWait:trace.failedWait};for(const name of ['clientBound','rowPresent','rowAborted','sdkDispatched','receiptMatched','notificationRejected','connectRejected'])if(state[name]!==undefined){if(typeof state[name]!=='boolean')throw new Error('initialize_trace_type');snapshot[name]=state[name];}
  trace.lastStage=stage;trace.stages.push(snapshot);return snapshot;
}
// OWN_DIAGNOSTIC_HELPERS_END
// Separate factory: late callbacks never close over SDK promise/request/owner inputs.
function newWaitGate(){
  let sig,yes,no;
  const promise=new Promise((resolve,reject)=>{yes=resolve;no=reject;});
  const clean=()=>{sig?.removeEventListener('abort',abort);sig=undefined;yes=undefined;no=undefined;};
  const done=(ok,value)=>{const fn=ok?yes:no;if(!fn)return;clean();fn(value);};
  const abort=()=>done(false,new Error('owned_abort'));
  return {promise,yes:v=>done(true,v),no:e=>done(false,e),bind(signal){sig=signal;sig.addEventListener('abort',abort,{once:true});if(sig.aborted)abort();}};
}
function ownedWait(p,signal){const gate=newWaitGate();gate.bind(signal);p.then(gate.yes,gate.no);return gate.promise;}
async function until(fn,ms=2000){const end=performance.now()+ms;while(!fn()){if(performance.now()>=end)throw new Error('observation_timeout');await delay(10);}}
async function bounded(p,ms=2000){let t;try{return await Promise.race([p,new Promise((_,reject)=>{t=setTimeout(()=>reject(new Error('operation_timeout')),ms);})]);}finally{clearTimeout(t);}}
function inspect(ctx){
  const types=[['_streamMapping',Map],['_requestToStreamMapping',Map],['_requestResponseMap',Map],['_resumableStreams',Set]];
  return Object.fromEntries([...types.map(([n,Type])=>{const m=ctx.transport[n];assert(m instanceof Type,'map_inspector_contract');return [n,m.size];}),...['_requestHandlerAbortControllers','_responseHandlers','_timeoutInfo'].map(n=>{const m=ctx.server.server[n];assert(m instanceof Map,'protocol_map_inspector_contract');return ['server'+n,m.size];})]);
}
const equalMaps=(a,b)=>Object.keys(a).every(k=>a[k]===b[k]);
function facade(inner,events){
  const f={
    get sessionId(){return inner.sessionId;},
    async start(){events.start++;return inner.start();},
    async send(message,options){events.sends.push({id:message.id,related:options?.relatedRequestId});return inner.send(message,options);},
    async close(){events.closeCalls++;return inner.close();}
  };
  if(typeof inner.setProtocolVersion==='function')f.setProtocolVersion=v=>inner.setProtocolVersion(v);
  inner.onmessage=(...args)=>{events.message++;return f.onmessage?.(...args);};
  inner.onerror=(...args)=>{events.error++;return f.onerror?.(...args);};
  inner.onclose=(...args)=>{events.close++;return f.onclose?.(...args);};
  return f;
}
async function readBody(stream,cap){const chunks=[];let bytes=0;for await(const part of stream){const b=Buffer.from(part);bytes+=b.length;if(bytes>cap)throw new Error('body_cap');chunks.push(b);}return Buffer.concat(chunks);}
async function responseBytes(body){if(!body)return Buffer.alloc(0);const reader=body.getReader(),parts=[];let bytes=0;try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>262144)throw new Error('response_cap');parts.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}return Buffer.concat(parts);}
function cancellationRoute(f,sid,id){
  const k=key(id);
  if(sid!==undefined){const ctx=f.sessions.get(sid);if(!ctx||ctx.retired)return {status:404};const row=ctx.rows.get(k);return row?.method==='initialize'?{status:400}:{status:202,row};}
  const negative=f.negativeInitialization;
  if(f.initializeNegativePolicy===true&&negative&&!negative.ctx.retired&&negative.ctx.rows.get(k)===negative.row&&negative.row.method==='initialize')return {status:400,negative:true};
  return {status:404};
}
let liveListeners=0;
async function fixture(cancelMode='owned'){
  assert(++liveListeners<=2,'listener_cap');
  const f={sessions:new Map(),all:new Set(),sockets:new Set(),clients:new Set(),clientCalls:0,httpOpen:0,httpFinished:0,source:0,physical:0,barriers:new Map(),outcomes:[],fetches:[],reservations:0,cancelMode,closed:false,nextSession:0,clientAttempts:0,enforceTombstones:false};
  const weak=[],finalized=[];const registry=new FinalizationRegistry(label=>finalized.push(label));
  function releaseRow(ctx,row){if(row.httpDone&&row.sendDone){clearTimeout(row.timer);ctx.rows.delete(row.k);if(f.negativeInitialization?.row===row)f.negativeInitialization=undefined;}}
  async function retire(ctx,reason='retire'){
    if(ctx.retired)return;ctx.retired=true;if(f.negativeInitialization?.ctx===ctx)f.negativeInitialization=undefined;ctx.retiredAt=performance.now();clearTimeout(ctx.expiry);ctx.life.abort(reason);f.sessions.delete(ctx.id);
    if(ctx.tombstones.size){output.evidenceIncomplete=true;output.timeline.push({name:'diagnostic_tombstones_unproven_at_close',count:ctx.tombstones.size,physical:f.physical,terminalObserved:false});}
    if(f.initializeReceipt?.ctx===ctx)f.initializeReceipt=undefined;
    for(const row of ctx.rows.values())clearTimeout(row.timer);
    await bounded(ctx.server.close().catch(()=>{}),500);assert(ctx.facade.sessionId===ctx.transport.sessionId,'dynamic_session_after_retire');
    ctx.facade.onmessage=undefined;ctx.facade.onerror=undefined;ctx.facade.onclose=undefined;
    for(const row of ctx.rows.values()){row.controller.abort('retired');clearTimeout(row.timer);}ctx.rows.clear();
    // All test inspection is read-only. Closed SDK maps are NOT cleared here.
  }
  async function session(){
    assert(f.sessions.size<4,'session_cap');
    const ctx={id:'',life:new AbortController(),rows:new Map(),tombstones:new Map(),injectedMessages:new WeakSet(),retired:false,retiredAt:0,events:{start:0,message:0,error:0,close:0,closeCalls:0,sends:[]},expiry:undefined,sentinel:{synthetic:'bearer_sentinel'}};
    ctx.transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:()=>`synthetic-${++f.nextSession}`,enableJsonResponse:true,onsessioninitialized:id=>{ctx.id=id;f.sessions.set(id,ctx);},onsessionclosed:()=>{ctx.life.abort('DELETE');f.sessions.delete(ctx.id);}});
    ctx.facade=facade(ctx.transport,ctx.events);
    const forwarded=ctx.facade.send;
    ctx.facade.send=async(message,options)=>{const t=message.id===undefined?undefined:ctx.tombstones.get(key(message.id)),injected=ctx.injectedMessages.has(message);try{return await diagnosticSend(t,injected,()=>forwarded(message,options));}finally{if(message.id!==undefined){const row=ctx.rows.get(key(message.id));if(row){row.sendDone=true;releaseRow(ctx,row);}}}};
    ctx.server=new McpServer({name:'phase0-synthetic',version:'0.0.0'},{capabilities:{tools:{}}});
    ctx.server.registerTool('read',{description:'Synthetic diagnostic only',inputSchema:{hold:z.string().optional(),kind:z.enum(['ok','toolError']).optional()}},async(args,extra)=>{
      f.source++;assert(f.physical<4,'job_cap');const row=ctx.rows.get(key(extra.requestId));assert(row,'owned_row_missing');
      if(args.kind==='toolError')return {isError:true,content:[{type:'text',text:'synthetic_error'}]};
      if(args.hold){
        const b=f.barriers.get(args.hold);assert(b,'barrier_missing');const t=ctx.tombstones.get(row.k);startDiagnosticPhysical(t);f.physical++;
        b.promise.finally(()=>{f.physical--;finishDiagnosticPhysical(t);});
        const signal=cancelMode==='sdk'?extra.signal:AbortSignal.any([row.controller.signal,extra.signal]);
        row.extraSignal=extra.signal;
        try{await ownedWait(b.promise,signal);}catch{return {isError:true,content:[{type:'text',text:'cancelled'}]};}
      }
      return {content:[{type:'text',text:'synthetic'}],structuredContent:{value:42}};
    });
    assert(ctx.facade.sessionId===undefined,'dynamic_session_before');
    await ctx.server.connect(ctx.facade);assert(ctx.events.start===1,'public_start');f.all.add(ctx);
    for(const [label,obj]of [['session',ctx],['server',ctx.server],['transport',ctx.transport],['bearer_sentinel',ctx.sentinel]]){weak.push(new WeakRef(obj));registry.register(obj,label);}
    return ctx;
  }
  const server=http.createServer(async(req,res)=>{
    f.httpOpen++;let ctx,row;let finished=false;
    const done=()=>{if(finished)return;finished=true;f.httpOpen--;f.httpFinished++;if(row){row.httpDone=true;releaseRow(ctx,row);}};
    res.once('finish',done);res.once('close',done);
    try{
      assert(++output.limits.requests<=128,'request_count');
      if(req.url!=='/mcp'){res.writeHead(404).end();return;}
      if(req.headers.authorization!=='Bearer synthetic-only'){res.writeHead(401).end();return;}
      if(req.method==='GET'){res.writeHead(405).end();return;}
      const sid=req.headers['mcp-session-id'];
      if(req.method==='DELETE'){
        ctx=f.sessions.get(sid);if(!ctx){res.writeHead(404).end();return;}
        // Actual transport DELETE path, then explicit owner retirement/drop.
        const response=await bounded(ctx.transport.handleRequest(new Request(f.url,{method:'DELETE',headers:{'mcp-session-id':sid}})));
        await retire(ctx,'DELETE');res.writeHead(response.status).end();return;
      }
      assert(req.method==='POST','method');const bytes=await readBody(req,65536);let body;try{body=JSON.parse(bytes);}catch{res.writeHead(400).end();return;}
      if(Array.isArray(body)||!body||typeof body!=='object'){res.writeHead(400).end();return;}
      // No session/ID reservation or source work precedes the array oracle.
      ctx=sid?f.sessions.get(sid):undefined;
      if(body.method==='notifications/cancelled'&&cancelMode==='owned'){
        const route=cancellationRoute(f,sid,body.params?.requestId);
        if(route.negative){f.initializeCancelAttempts=(f.initializeCancelAttempts||0)+1;const negative=f.negativeInitialization,binding=f.pendingClientBinding;if(binding&&negative&&body.params?.reason===binding.negativeReason)f.initializeReceipt={ctx:negative.ctx,row:negative.row,binding,status:route.status,missingSession:sid===undefined,id:body.params.requestId,rowAborted:negative.row.controller.signal.aborted,sdkDispatched:!!negative.row.sdkDispatched};}
        if(route.row)route.row.controller.abort('authenticated_cancel');
        res.writeHead(route.status).end();return;
      }
      if(!ctx&&body.method==='initialize'&&!sid)ctx=await session();
      if(!ctx){res.writeHead(404).end();return;}
      if(body.id!==undefined){
        const k=key(body.id);if(ctx.rows.has(k)||ctx.tombstones.has(k)){res.writeHead(409).end();return;}
        assert(ctx.rows.size<4&&ctx.tombstones.size<4,'row_cap');row={k,id:body.id,method:body.method,controller:new AbortController(),httpDone:false,sendDone:false,sdkDispatched:false};ctx.rows.set(k,row);if(f.enforceTombstones)ctx.tombstones.set(k,newDiagnosticTombstone(row));f.reservations++;
        row.timer=setTimeout(()=>row.controller.abort('deadline'),2000);
      }
      const headers={'content-type':'application/json',accept:req.headers.accept||'application/json, text/event-stream'};
      if(sid)headers['mcp-session-id']=sid;if(req.headers['mcp-protocol-version'])headers['mcp-protocol-version']=req.headers['mcp-protocol-version'];
      const request=new Request(f.url,{method:'POST',headers,body:bytes});
      if(body.method==='initialize'&&f.holdInitialize&&f.initializeNegativePolicy===true){assert(!f.negativeInitialization,'negative_initialize_owner_collision');f.negativeInitialization={ctx,row};}
      if(body.method==='initialize'&&f.holdInitialize)await ownedWait(f.initializeGate.promise,ctx.life.signal);
      if(row)row.sdkDispatched=true;
      const pending=ctx.transport.handleRequest(request);
      outcome(pending,body.id===undefined?'notification':key(body.id),f.outcomes);
      const response=await ownedWait(pending,ctx.life.signal);
      const payload=await responseBytes(response.body);
      const replyHeaders={'content-type':response.headers.get('content-type')||'application/json'};
      if(response.headers.has('mcp-session-id'))replyHeaders['mcp-session-id']=response.headers.get('mcp-session-id');
      res.writeHead(response.status,replyHeaders);res.end(payload);
      if(row&&body.method!=='tools/call'&&body.method!=='initialize'){
        // SDK-generated errors still pass through public send; do not invent completion.
        releaseRow(ctx,row);
      }
    }catch(e){if(!res.headersSent)res.writeHead(e.message==='owned_abort'?503:500);res.end();}
  });
  server.on('connection',socket=>{assert(f.sockets.size<8,'socket_cap');f.sockets.add(socket);socket.on('close',()=>f.sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.url=`http://127.0.0.1:${server.address().port}/mcp`;
  f.context=()=>{assert(f.sessions.size===1,'one_session');return [...f.sessions.values()][0];};
  f.barrier=name=>{const b=gate();f.barriers.set(name,b);return b;};
  f.retire=retire;f.weak=weak;f.finalized=finalized;f.registry=registry;f.initializeGate=gate();
  f.raw=async(body,sid,options={})=>{
    const headers={authorization:'Bearer synthetic-only',accept:'application/json, text/event-stream','content-type':'application/json'};
    if(sid)headers['mcp-session-id']=sid;
    const response=await fetch(f.url,{method:'POST',headers,body:JSON.stringify(body),signal:options.signal});
    const text=await response.text();let json;try{json=text?JSON.parse(text):undefined;}catch{}
    return {status:response.status,body:json,bytes:Buffer.byteLength(text),session:response.headers.get('mcp-session-id')};
  };
  f.initialize=async(id=77)=>{const x=await bounded(f.raw({jsonrpc:'2.0',id,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'raw',version:'0'}}}));assert(x.status===200&&x.body?.result,'initialize');await bounded(f.raw({jsonrpc:'2.0',method:'notifications/initialized'},x.session));await until(()=>f.httpOpen===0);return x.session;};
  f.call=(sid,id,hold,kind)=>f.raw({jsonrpc:'2.0',id,method:'tools/call',params:{name:'read',arguments:{...(hold?{hold}:{}),...(kind?{kind}:{})}}},sid);
  f.cancel=(sid,id)=>f.raw({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id}},sid);
  f.client=async(options)=>{
    const attempt=++f.clientAttempts;
    const transport=new StreamableHTTPClientTransport(new URL(f.url),{requestInit:{headers:{authorization:'Bearer synthetic-only'}},fetch:async(url,init)=>{
      assert(String(url)===f.url,'non_loopback_fetch');const rec={attempt,method:init?.method||'GET',headers:false,body:false};f.fetches.push(rec);
      const response=await fetch(url,init);rec.headers=true;rec.status=response.status;
      if(response.status===202||response.status===405||!response.body)rec.body=true;
      return observeBodyCompletion(response,rec);
    }});
    const client=new Client({name:'phase0-client',version:'0'},{capabilities:{}});f.clients.add(client);const binding={client,transport,attempt,negativeReason:'synthetic-initialize-denial-'+attempt};f.pendingClientBinding=binding;
    try{await client.connect(transport,options);return client;}finally{if(f.pendingClientBinding===binding)f.pendingClientBinding=undefined;}
  };
  f.clientCall=async(client,args,options)=>{f.clientCalls++;try{return await client.callTool({name:'read',arguments:args},undefined,options);}finally{f.clientCalls--;}};
  f.live=async(ctx,base)=>{await until(()=>ctx.rows.size===0&&f.httpOpen===0&&f.clientCalls===0&&equalMaps(inspect(ctx),base)&&(!ctx.tombstones.size||(f.physical===0&&[...ctx.tombstones.values()].every(diagnosticReady))));for(const client of f.clients)for(const n of ['_responseHandlers','_timeoutInfo'])assert(client[n] instanceof Map&&client[n].size===0,'client_sdk_pending_map');assert(equalMaps(inspect(ctx),base),'live_sdk_maps_retained');if(ctx.tombstones.size){assert(f.physical===0,'diagnostic_physical_not_zero');const count=retireDiagnosticTombstones(ctx,f.physical,equalMaps(inspect(ctx),base));output.timeline.push({name:'diagnostic_tombstones_retired',count,physical:0,allOldSDKSendsSettled:true,sdkMapsAtBaseline:true});}};
  f.dispose=async()=>{
    if(f.closed)return;f.closed=true;
    for(const ctx of f.all)await retire(ctx,'dispose');
    for(const c of f.clients)await c.close().catch(()=>{});f.clients.clear();
    f.initializeGate.resolve();for(const b of f.barriers.values())b.resolve();await delay(0);
    f.sessions.clear();f.all.clear();f.barriers.clear();f.pendingClientBinding=undefined;f.initializeReceipt=undefined;
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();for(const socket of f.sockets)socket.destroy();});
    await until(()=>f.sockets.size===0&&f.httpOpen===0&&f.physical===0,500);
    liveListeners--;assert(liveListeners>=0,'listener_count');
  };
  return f;
}
async function test(name,fn,required=true){
  let timer;const began=performance.now();let fixtureRef,postCollection;
  const use=async(mode='owned')=>{assert(!fixtureRef,'case_fixture_duplicate');fixtureRef=await fixture(mode);return fixtureRef;};
  try{const result=await Promise.race([fn(use),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('case_work_deadline')),6000);})]);postCollection=result?.collect;output.cases.push({name,required,status:'pass',ms:performance.now()-began});}
  catch(e){if(fixtureRef?.initializeTrace){const negative=fixtureRef.negativeInitialization,receipt=fixtureRef.initializeReceipt;try{initializeStage(fixtureRef.initializeTrace,'failure',{clientBound:!!fixtureRef.pendingClientBinding,rowPresent:!!negative&&negative.ctx.rows.get(negative.row.k)===negative.row,rowAborted:!!negative?.row.controller.signal.aborted,sdkDispatched:!!negative?.row.sdkDispatched,receiptMatched:!!receipt});}catch{output.evidenceIncomplete=true;}output.timeline.push({name:'initialize_negative_failure',...fixtureRef.initializeTrace,state:{rowAvailable:!!negative,rows:negative?.ctx.rows.size??0,httpOpen:fixtureRef.httpOpen,physical:fixtureRef.physical,cancelAttempts:fixtureRef.initializeCancelAttempts||0,notificationStatus:receipt?.status??null,idKind:negative?typeof negative.row.id:null}});}output.cases.push({name,required,status:'fail',code:errorName(e),ms:performance.now()-began});}
  finally{clearTimeout(timer);if(fixtureRef){try{await bounded(fixtureRef.dispose(),2000);}catch(e){output.cases.push({name:name+'_cleanup',required:true,status:'fail',code:errorName(e)});}fixtureRef=undefined;}}
  if(postCollection){try{assert(typeof global.gc==='function','GC_unavailable');for(let n=0;n<10;n++){global.gc();await delay(200);}const retained=postCollection.refs.filter(x=>x.deref()!==undefined).length;assert(retained===0&&postCollection.finalized.length===postCollection.refs.length,'late_retired_graph_retained_or_inconclusive');output.cases.push({name:name+'_retired_graph',required:true,status:'pass'});}catch(e){output.cases.push({name:name+'_retired_graph',required:true,status:'fail',code:errorName(e)});}}
  if(performance.now()-began>10000)output.cases.push({name:name+'_outer_deadline',required:true,status:'fail',code:'case_total_over_10s'});
}
async function ordinary(use){
  const f=await use();const client=await f.client();const ctx=f.context();assert(ctx.facade.sessionId===ctx.transport.sessionId&&ctx.facade.sessionId,'dynamic_session_after');
  const base=inspect(ctx),samples=[];
  for(let n=0;n<32;n++){const x=await bounded(f.clientCall(client,{}));assert(x.content?.[0]?.text==='synthetic','useful_synthetic_result');await until(()=>ctx.rows.size===0&&f.httpOpen===0);if(variant==='patched')await f.live(ctx,base);samples.push(inspect(ctx));if(variant==='patched')assert(equalMaps(samples.at(-1),base),'ordinary_json_retention');}
  output.timeline.push({name:'ordinary32',base,samples,httpFinished:f.httpFinished,outcomes:f.outcomes.map(x=>({...x}))});
  if(variant==='baseline'){
    assert(samples.every((x,n)=>x._streamMapping===base._streamMapping+n+1),'baseline_red_not_observed');
    assert(samples.every(x=>x._requestToStreamMapping===base._requestToStreamMapping&&x._requestResponseMap===base._requestResponseMap),'baseline_other_maps');output.baselineRedObserved=true;
  } else {await f.live(ctx,base);assert(ctx.events.start===1&&ctx.events.message>=34,'public_actual_forwarding');let forwarded;const witness=new Error('synthetic_public_error');ctx.server.server.onerror=e=>{forwarded=e;};ctx.transport.onerror(witness);assert(forwarded===witness&&ctx.events.error===1,'actual_public_onerror');}
}
await test('ordinary32',ordinary);
if(variant==='patched'){
  await test('safe_errors_discovery_arrays',async use=>{
    const f=await use();const sid=await f.initialize(),ctx=f.context(),base=inspect(ctx);const before=f.source,reserved=f.reservations;
    for(const x of [[],[{jsonrpc:'2.0',id:9,method:'tools/call'}],['bad',{}]])assert((await f.raw(x,sid)).status===400,'array_denial');
    assert(f.source===before&&f.reservations===reserved,'array_partial_reservation');
    for(const [id,method]of [[1,'tools/list'],[2,'ping'],[3,'resources/list']])await bounded(f.raw({jsonrpc:'2.0',id,method},sid));
    assert(f.source===before,'discovery_source_work');await f.live(ctx,base);
    const error=await bounded(f.call(sid,4,undefined,'toolError'));assert(error.body?.result?.isError===true,'tool_error');
    const invalid=await bounded(f.raw({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'read',arguments:{kind:42}}},sid));assert(invalid.body?.error||invalid.body?.result?.isError,'sdk_validation_error');await f.live(ctx,base);
  });
  await test('concurrent_complete',async use=>{
    const f=await use();const sid=await f.initialize(),ctx=f.context(),base=inspect(ctx);const a=f.barrier('a'),b=f.barrier('b');
    const p=f.call(sid,1,'a'),q=f.call(sid,2,'b');await until(()=>f.physical===2);a.resolve();assert((await bounded(p)).status===200,'first_completed');await until(()=>ctx.rows.size===1);assert(f.physical===1,'unrelated_job_lost');assert(inspect(ctx)._streamMapping===base._streamMapping+1,'live_other_map');b.resolve();await bounded(q);await f.live(ctx,base);
  });
  await test('owned_cancel_typed_zero_reuse',async use=>{
    const f=await use();const sid=await f.initialize(77),ctx=f.context(),base=inspect(ctx),a=f.barrier('n0'),b=f.barrier('s0');f.enforceTombstones=true;
    const p=f.call(sid,0,'n0'),q=f.call(sid,'0','s0');await until(()=>f.physical===2);
    assert((await f.call(sid,0)).status===409,'duplicate_id');assert((await f.cancel(sid,0)).status===202,'cancel_notification');
    const r=await bounded(p);assert(r.status===200&&r.body&&r.bytes>0,'original_cancel_json');assert(r.body.result?.isError===true,'cancel_error_shape');
    assert(!ctx.rows.has(key(0))&&ctx.tombstones.has(key(0)),'diagnostic_reservation_not_separate');assert((await f.call(sid,0)).status===409,'pending_physical_id_reuse');
    assert(ctx.rows.has(key('0')),'typed_id_confusion');assert(f.physical===2,'logical_abort_released_physical');
    for(const id of [0,0,999])assert((await f.cancel(sid,id)).status===202,'late_unknown_repeat');a.resolve();b.resolve();await bounded(q);await f.live(ctx,base);
    assert(f.physical===0&&ctx.tombstones.size===0,'diagnostic_reuse_before_terminal');assert((await bounded(f.call(sid,0))).status===200,'id_reuse');await f.live(ctx,base);
  });
  await test('actual_client_local_cancel_http',async use=>{
    const f=await use();const client=await f.client(),ctx=f.context(),base=inspect(ctx),b=f.barrier('client');const controller=new AbortController();let localRejected=false;
    const pending=f.clientCall(client,{hold:'client'},{signal:controller.signal}).catch(()=>{localRejected=true;});await until(()=>f.physical===1);const finishedBefore=f.httpFinished;controller.abort('synthetic');await bounded(pending);assert(localRejected,'client_local_abort');
    await until(()=>f.httpFinished>=finishedBefore+2&&ctx.rows.size===0,2000);await until(()=>f.fetches.filter(x=>x.method==='POST').every(x=>x.headers&&x.body));assert(f.fetches.filter(x=>x.method==='POST').every(x=>x.headers&&x.body),'client_original_fetch_body');assert(f.physical===1,'physical_slot_reclaimed');b.resolve();await f.live(ctx,base);
    output.timeline.push({name:'client_cancel',localRejected,httpFinished:f.httpFinished,fetches:f.fetches.map(x=>({...x}))});
  });
  await test('same_ids_across_sessions',async use=>{
    const f=await use();const a=await f.initialize(77),b=await f.initialize(77);const x=await Promise.all([f.call(a,0),f.call(b,0)]);assert(x.every(r=>r.status===200),'cross_session_ids');
  });
  await test('sdk_native_cancel_characterization',async use=>{
    const f=await use('sdk'),sid=await f.initialize(77),ctx=f.context();const a=f.barrier('zero'),b=f.barrier('one');
    const p=f.call(sid,0,'zero').catch(()=>{}),q=f.call(sid,1,'one').catch(()=>{});await until(()=>f.physical===2);await f.cancel(sid,0);await f.cancel(sid,1);
    await until(()=>ctx.rows.get(key(1))?.extraSignal.aborted===true);
    assert(ctx.rows.get(key(0))?.extraSignal.aborted===false,'SDK_zero_gap_not_observed');
    a.resolve();await bounded(p);b.resolve();await delay(50);
    assert(f.outcomes.some(x=>x.id===key(1)&&x.phase==='pending'),'native_suppression_not_observed');
    output.timeline.push({name:'SDK_native_characterization',zeroIgnored:true,nonzeroSuppressed:true,outcomes:f.outcomes.map(x=>({...x}))});
    await f.retire(ctx,'native_characterization_end');await bounded(q);
  });
  await test('request_expiry_physical_hold',async use=>{
    const f=await use();const sid=await f.initialize(),ctx=f.context(),base=inspect(ctx),b=f.barrier('expiry');const p=f.call(sid,1,'expiry');await until(()=>f.physical===1);const began=performance.now();const x=await bounded(p,2500);assert(x.status===200&&performance.now()-began<=2500,'deadline_wait_bound');assert(f.physical===1,'expiry_freed_physical');b.resolve();await f.live(ctx,base);
  });
  await test('serialization_before_cleanup_REQUIRED',async use=>{
    const f=await use();const sid=await f.initialize(),ctx=f.context(),base=inspect(ctx),a=f.barrier('serialize'),b=f.barrier('other');f.enforceTombstones=true;
    const p=f.call(sid,1,'serialize').catch(()=>{}),q=f.call(sid,2,'other');await until(()=>f.physical===2);const circular={};circular.self=circular;let observed=false;
    const injection={jsonrpc:'2.0',id:1,result:circular};ctx.injectedMessages.add(injection);
    try{await ctx.facade.send(injection,{relatedRequestId:1});}catch{observed=true;}finally{ctx.injectedMessages.delete(injection);}
    assert(observed,'serialization_failure_not_observed');
    // STRONG ORACLE: no expected-negative relabel. Proposed one-line hunk may fail.
    await until(()=>!ctx.rows.has(key(1)),500);
    assert(inspect(ctx)._streamMapping===base._streamMapping+1&&ctx.rows.has(key(2)),'serialization_cleanup_or_other_lost');
    const original=await bounded(p);assert(original?.status===500&&original.body?.jsonrpc==='2.0'&&original.body?.id===null&&original.body?.error?.code===-32603&&original.body.error.message==='Internal server error','serialization_fixed_500');
    const old=ctx.tombstones.get(key(1));assert(old&&!old.sdkSendStarted&&!old.sdkSendDone&&!old.physicalDone,'injected_send_counted_as_handler_terminal');output.timeline.push({name:'serialization_injected_send_not_handler',idKind:'number',id:1,rowRemoved:!ctx.rows.has(key(1)),tombstonePresent:ctx.tombstones.get(key(1))===old,physical:f.physical,physicalDone:old.physicalDone,sdkSendStarted:old.sdkSendStarted,sdkSendDone:old.sdkSendDone});assert(f.physical===2&&(await f.call(sid,1)).status===409,'exception_early_id_reuse');
    b.resolve();await bounded(q);assert(!old.sdkSendDone&&(await f.call(sid,1)).status===409,'old_handler_pending_id_reuse');a.resolve();await bounded(p);await f.live(ctx,base);
    assert(old.physicalDone&&old.sdkSendStarted&&old.sdkSendDone&&old.sdkSendOutcome==='rejected'&&old.retired&&f.physical===0,'old_handler_terminal_unproven');output.timeline.push({name:'serialization_old_handler_terminal',idKind:'number',id:1,physical:f.physical,physicalDone:old.physicalDone,sdkSendStarted:old.sdkSendStarted,sdkSendDone:old.sdkSendDone,sdkSendOutcome:old.sdkSendOutcome,tombstoneRetired:old.retired,sdkMapsAtBaseline:equalMaps(inspect(ctx),base)});assert((await bounded(f.call(sid,1))).status===200,'exception_post_terminal_reuse');await f.live(ctx,base);
  });
  await test('late_send_after_close_REQUIRED',async use=>{
    const f=await use();const sid=await f.initialize(),ctx=f.context(),b=f.barrier('late');const p=f.call(sid,1,'late').catch(()=>{});await until(()=>f.physical===1);const began=performance.now();await f.retire(ctx,'late_close');await bounded(p,500);assert(performance.now()-began<=500,'retired_wait_not_bounded');
    let late;try{await ctx.facade.send({jsonrpc:'2.0',id:1,result:{synthetic:true}},{relatedRequestId:1});late='resolved';}catch{late='rejected';}b.resolve();await until(()=>f.physical===0);assert(ctx.rows.size===0&&f.httpOpen===0,'late_close_owned_retention');output.timeline.push({name:'late_send',late,maps:inspect(ctx),outcomes:f.outcomes.map(x=>({...x}))});return {collect:{refs:[...f.weak],registry:f.registry,finalized:f.finalized}};
  });
  await test('DELETE_and_session_expiry',async use=>{
    const f=await use();let sid=await f.initialize(),ctx=f.context(),b=f.barrier('delete');let p=f.call(sid,1,'delete').catch(()=>{});await until(()=>f.physical===1);const response=await fetch(f.url,{method:'DELETE',headers:{authorization:'Bearer synthetic-only','mcp-session-id':sid}});await response.body?.cancel();assert(response.status===200,'DELETE_status');await bounded(p,500);assert(!f.sessions.has(sid),'DELETE_session_retained');b.resolve();await until(()=>f.physical===0);
    sid=await f.initialize();ctx=f.context();b=f.barrier('session_expiry');p=f.call(sid,1,'session_expiry').catch(()=>{});await until(()=>f.physical===1);const began=performance.now();ctx.expiry=setTimeout(()=>{void f.retire(ctx,'session_expiry');},2000);await bounded(p,2500);assert(performance.now()-began<=2500,'session_expiry_wait');b.resolve();
  });
  await test('public_optional_facade_contract',async()=>{
    for(const supported of [false,true]){
      const seen=[],events={start:0,sends:[],message:0,error:0,close:0,closeCalls:0};const inner={sessionId:undefined,async start(){},async send(m,o){seen.push([m,o]);},async close(){this.onclose?.('closed');}};
      if(supported)inner.setProtocolVersion=v=>seen.push(['version',v]);const f=facade(inner,events);assert(('setProtocolVersion'in f)===supported,'optional_setProtocolVersion');await f.start();inner.sessionId='dynamic';assert(f.sessionId==='dynamic','session_snapshot');const msg={jsonrpc:'2.0',id:0,result:{}},options={relatedRequestId:0};await f.send(msg,options);assert(seen[0][0]===msg&&seen[0][1]===options,'send_options_identity');
      let m,e,c;f.onmessage=(...x)=>{m=x;};f.onerror=(...x)=>{e=x;};f.onclose=(...x)=>{c=x;};inner.onmessage(msg,{requestInfo:{headers:{}}});const err=new Error('synthetic');inner.onerror(err);await f.close();assert(m[0]===msg&&e[0]===err&&c[0]==='closed'&&events.close===1,'event_forwarding');if(supported){f.setProtocolVersion('2025-11-25');assert(seen.at(-1)[1]==='2025-11-25','version_forward');}
    }
  });
  await test('initialize_cancel_negative',async use=>{
    const f=await use();f.holdInitialize=true;f.initializeNegativePolicy=true;f.initializeTrace=newInitializeTrace();const trace=f.initializeTrace;initializeStage(trace,'case_enter');const controller=new AbortController();let rejected=false;const pending=f.client({signal:controller.signal}).catch(()=>{rejected=true;});trace.failedWait='initialize_held';await until(()=>f.negativeInitialization&&f.pendingClientBinding);const {ctx,row}=f.negativeInitialization,binding=f.pendingClientBinding;assert(f.clients.has(binding.client)&&binding.transport.sessionId===undefined,'initialize_client_binding');initializeStage(trace,'client_bound',{clientBound:true});initializeStage(trace,'initialize_held',{rowPresent:ctx.rows.get(row.k)===row,rowAborted:row.controller.signal.aborted,sdkDispatched:row.sdkDispatched});
    initializeStage(trace,'notification_begin');trace.failedWait='notification_settle';let notificationRejected=false;try{await bounded(binding.client.notification({method:'notifications/cancelled',params:{requestId:row.id,reason:binding.negativeReason}}));}catch(e){assert(e instanceof StreamableHTTPError&&e.code===400,'initialize_notification_error');notificationRejected=true;}
    trace.failedWait='notification_receipt';await until(()=>f.initializeReceipt?.binding===binding);const receipt=f.initializeReceipt;assert(receipt.ctx===ctx&&receipt.row===row&&receipt.id===row.id&&receipt.missingSession&&receipt.status===400&&!receipt.rowAborted&&!receipt.sdkDispatched&&!row.controller.signal.aborted&&!row.sdkDispatched,'initialize_denial_receipt');assert(typeof receipt.id==='number'&&Number.isSafeInteger(receipt.id)&&receipt.id>=0&&receipt.id<128,'initialize_synthetic_id_bound');assert(notificationRejected&&f.fetches.some(x=>x.attempt===binding.attempt&&x.status===400&&x.headers&&x.body&&x.bodyReads.text==='fulfilled'),'initialize_denial_text_unobserved');initializeStage(trace,'notification_denied',{receiptMatched:true,notificationRejected,rowAborted:false,sdkDispatched:false});
    initializeStage(trace,'caller_abort');controller.abort('synthetic-initialize-negative');trace.failedWait='connect_reject';await bounded(pending);assert(rejected&&!row.controller.signal.aborted,'initialize_cancellation_routed');initializeStage(trace,'client_rejected',{connectRejected:rejected,rowAborted:row.controller.signal.aborted});trace.failedWait='none';initializeStage(trace,'complete');f.initializeGate.resolve();output.timeline.push({name:'initialize_negative',nonconformantExplicitNotification:true,nonconformantCallerAbort:true,attempts:f.initializeCancelAttempts,rejected,ownedInitializeAborted:row.controller.signal.aborted,receiptWitness:{status:receipt.status,missingSession:receipt.missingSession,idKind:typeof receipt.id,id:receipt.id,attempt:binding.attempt,sameRow:receipt.row===row,sameClientBinding:receipt.binding===binding,rowAborted:receipt.rowAborted,sdkDispatched:receipt.sdkDispatched,textBodyFulfilled:f.fetches.some(x=>x.attempt===binding.attempt&&x.status===400&&x.bodyReads.text==='fulfilled')},...trace});
  });
  await test('server_extra_signal_shutdown',async use=>{
    const f=await use();const sid=await f.initialize(),ctx=f.context(),b=f.barrier('shutdown');const p=f.call(sid,1,'shutdown').catch(()=>{});await until(()=>f.physical===1);const extra=ctx.rows.get(key(1)).extraSignal;await f.retire(ctx,'shutdown');assert(extra.aborted,'SDK_extra_signal_not_aborted');await bounded(p,500);assert(f.physical===1,'shutdown_freed_physical');b.resolve();
  });
  // Retired graph collection is isolated from the case's own fixture reference.
  await test('retired_graph_REQUIRED',async()=>{
    let f=await fixture(),sid=await f.initialize(),ctx=f.context(),b=f.barrier('retire');let pending=f.call(sid,1,'retire').catch(()=>{});await until(()=>f.physical===1);
    const refs=[...f.weak];const records=f.outcomes,registry=f.registry,finalized=f.finalized;const began=performance.now();await f.dispose();await bounded(pending,500);assert(performance.now()-began<=500,'retired_owner_wait');assert(f.sessions.size===0&&f.all.size===0&&f.clients.size===0&&f.sockets.size===0&&f.httpOpen===0,'retired_structural_roots');assert(records.some(x=>x.phase==='pending'),'retired_pending_promise_not_exercised');
    ctx=undefined;b=undefined;pending=undefined;sid=undefined;f=undefined;
    assert(typeof global.gc==='function','GC_unavailable');
    for(let n=0;n<10;n++){global.gc();await delay(200);}
    const retained=refs.filter(x=>x.deref()!==undefined).length;output.timeline.push({name:'retired_graph',retained,outcomes:records.map(x=>({...x}))});assert(registry instanceof FinalizationRegistry&&retained===0&&finalized.length===refs.length,'retired_graph_retained_or_inconclusive');await delay(2000);
  });
}
// Observe late owned rejections before deciding completeness, for BOTH variants.
await delay(2000);
output.requiredControlsPassed=output.cases.filter(x=>x.required).every(x=>x.status==='pass')&&unhandled.length===0&&liveListeners===0&&!output.evidenceIncomplete;
output.allRequiredGreen=variant==='patched'&&output.requiredControlsPassed;output.activeOwnedListeners=liveListeners;
output.inspectorSourceSHA256=crypto.createHash('sha256').update(inspect.toString()).digest('hex');output.unhandled=unhandled.length;output.elapsedMs=performance.now()-started;
if(Buffer.byteLength(JSON.stringify(output))>1048576)throw new Error('probe_output_cap');
fs.writeFileSync(resultFile,JSON.stringify(output,null,2)+'\n',{mode:0o600});
// A complete diagnostic with red required oracles is still returned to driver;
// only the driver sets job failure. This is NOT an expected-negative PASS.
