'use strict';
// OWN reviewed closed pnpm9 primitives. No general YAML/vendor loader.
const crypto=require('node:crypto');
const BASE_PATCHES={
  "@malept/flatpak-bundler@0.4.0": {
    "path": "patches/@malept__flatpak-bundler@0.4.0.patch",
    "sha256": "c787371eeb2af011ea934e8818a0dad6d7dcb2df31bbb1686babc7231af0183c"
  },
  "electron-is@3.0.0": {
    "path": "patches/electron-is@3.0.0.patch",
    "sha256": "08664a5453f092fe45542f9005ffc07527b1f207447318374cba0f4d30f466a0"
  },
  "kuromoji@0.1.2": {
    "path": "patches/kuromoji@0.1.2.patch",
    "sha256": "4a948f1ea45c61779fa371feb020253ccf7a24e1f7c6b2e250b3ce53d86216d4"
  },
  "mdui@2.1.4": {
    "path": "patches/mdui@2.1.4.patch",
    "sha256": "e6f91e8e974b4ccc0903ec27b2c840fa3a84048144098e96671fc9915df47ef1"
  },
  "vudio@2.1.1": {
    "path": "patches/vudio@2.1.1.patch",
    "sha256": "0e06c2ed11c02bdc490c209fa80070e98517c2735c641f5738b6e15d7dc1959d"
  }
};
for(const value of Object.values(BASE_PATCHES))Object.freeze(value);Object.freeze(BASE_PATCHES);
const sha256=s=>crypto.createHash('sha256').update(s).digest('hex');
const base64Bytes=s=>{const b=Buffer.from(s,'base64');return{length:b.length,canonical:b.toString('base64')};};
function createSourceAudit(kind,registrationHash){
 const PATCHES={...BASE_PATCHES};
 if(!['base','workspaceSDK','lockSDK'].includes(kind))throw new Error('source_profile_kind');
 if(kind==='lockSDK'&&(typeof registrationHash!=='string'||!/^([a-f0-9]{64})$/.test(registrationHash)))throw new Error('observed_registration_shape');
 if(kind!=='base')PATCHES['@modelcontextprotocol/sdk@1.30.0']={path:'patches/@modelcontextprotocol__sdk@1.30.0.patch',sha256:kind==='workspaceSDK'?'29fac29b9e3ad9b409117f99c739c33bf4b501ab3f41162f14cda02ca60d75d9':registrationHash};
 // CLOSED_PRIMITIVES_BEGIN
// PRIVATE bounded pnpm9 printed-profile source audit, never a runtime YAML loader.
// Pure data functions only. VM exposes strings and pure hash/base64 helpers, NO IO/SDK.
function auditFail(code,detail=''){const e=new Error(code+(detail?': '+detail:''));e.code=code;throw e;}
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const object=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
function expectMap(o,where){if(!object(o))auditFail('profile_map',where);return o;}
function exactKeys(o,allowed,where,required=allowed){expectMap(o,where);for(const k of Object.keys(o))if(!allowed.includes(k))auditFail('unknown_field',where+'.'+k);for(const k of required)if(!own(o,k))auditFail('missing_field',where+'.'+k);}
function stable(o){if(Array.isArray(o))return '['+o.map(stable).join(',')+']';if(object(o))return '{'+Object.keys(o).sort().map(k=>JSON.stringify(k)+':'+stable(o[k])).join(',')+'}';return JSON.stringify(o);}
function equal(a,b,where){if(stable(a)!==stable(b))auditFail('binding_mismatch',where);}
function strictJSON(text){
 if(typeof text!=='string'||text.length>65536)auditFail('json_size');let p=0,nodes=0;
 const ws=()=>{while(/[ \t\r\n]/.test(text[p]||'')&&p<text.length)p++;};
 const str=()=>{const a=p++;let escaped=false;while(p<text.length){const c=text[p++];if(escaped){escaped=false;continue;}if(c==='\\'){escaped=true;continue;}if(c==='"'){try{return JSON.parse(text.slice(a,p));}catch{auditFail('json_string');}}}auditFail('json_string');};
 function value(depth){ws();if(depth>16||++nodes>20000)auditFail('json_bound');const c=text[p];
  if(c==='"')return str();
  if(c==='{'){p++;const o=Object.create(null);ws();if(text[p]==='}'){p++;return o;}for(;;){ws();if(text[p]!=='"')auditFail('json_key');const k=str();if(own(o,k))auditFail('json_duplicate',k);ws();if(text[p++]!==':')auditFail('json_colon');o[k]=value(depth+1);ws();const next=text[p++];if(next==='}')return o;if(next!==',')auditFail('json_object');}}
  if(c==='['){p++;const a=[];ws();if(text[p]===']'){p++;return a;}for(;;){a.push(value(depth+1));if(a.length>4096)auditFail('json_array');ws();const next=text[p++];if(next===']')return a;if(next!==',')auditFail('json_array');}}
  const m=/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(p));if(!m)auditFail('json_value');p+=m[0].length;return JSON.parse(m[0]);
 }
 const result=value(0);ws();if(p!==text.length)auditFail('json_trailing');return result;
}
function scalar(s,key=false){
 if(typeof s!=='string'||s.length>16384)auditFail('profile_scalar');s=s.trim();if(!s)auditFail('profile_empty_scalar');
 if(s[0]==="'"){if(!/^'(?:[^']|'')*'$/.test(s))auditFail('profile_quote');return s.slice(1,-1).replace(/''/g,"'");}
 if(s[0]==='"'){try{const x=JSON.parse(s);if(typeof x!=='string')auditFail('profile_quote');return x;}catch{auditFail('profile_quote');}}
 if(/^[*&!]/.test(s)||s==='<<'||/^[>|](?:[-+0-9]*)$/.test(s))auditFail('profile_alias_tag_or_block',s);
 // In a YAML plain scalar, embedded quote characters are ordinary text.
 // Leading quotes still take only the strict quoted-string branches above.
 if(/[\[\]{}\x00-\x1f\x7f\uFFFD]/.test(s)||/(?:^| )#/.test(s)||/:\s/.test(s)||/^(?:[-?:]\s|[%@`])/.test(s))auditFail('profile_plain_scalar',s);
 if(key&&s==='<<')auditFail('profile_merge');return s;
}
function pair(s){let quote='',escape=false;for(let i=0;i<s.length;i++){const c=s[i];if(quote){if(quote==='"'&&escape){escape=false;continue;}if(quote==='"'&&c==='\\'){escape=true;continue;}if(c===quote){if(quote==="'"&&s[i+1]==="'"){i++;continue;}quote='';}continue;}if(c==="'"||c==='"'){quote=c;continue;}if(c===':'&&(i===s.length-1||s[i+1]===' '))return [scalar(s.slice(0,i),true),s.slice(i+1).trim()];}auditFail('profile_mapping_pair',s);}
function flowParts(s){let quote='',escape=false,start=0;const out=[];for(let i=0;i<s.length;i++){const c=s[i];if(quote){if(quote==='"'&&escape){escape=false;continue;}if(quote==='"'&&c==='\\'){escape=true;continue;}if(c===quote){if(quote==="'"&&s[i+1]==="'"){i++;continue;}quote='';}continue;}if(c==="'"||c==='"'){quote=c;continue;}if(/[\[\]{}]/.test(c))auditFail('profile_nested_flow');if(c===','){out.push(s.slice(start,i).trim());start=i+1;}}if(quote)auditFail('profile_quote');out.push(s.slice(start).trim());return out;}
function atom(s){if(s==='{}')return Object.create(null);if(s==='[]')return [];if(s.startsWith('{')){if(!s.endsWith('}'))auditFail('profile_flow');const o=Object.create(null);for(const x of flowParts(s.slice(1,-1))){const[k,v]=pair(x);if(own(o,k))auditFail('profile_duplicate',k);o[k]=scalar(v);}return o;}if(s.startsWith('[')){if(!s.endsWith(']'))auditFail('profile_flow');return flowParts(s.slice(1,-1)).map(x=>scalar(x));}return scalar(s);}
function printedProfile(raw){
 if(typeof raw!=='string'||raw.length>1048576||/[\r\t\0]/.test(raw))auditFail('profile_input');const lines=[];for(const [number,text]of raw.split('\n').entries()){if(!text.trim())continue;if(text.length>16384||text.trimStart().startsWith('#'))auditFail('profile_line');const indent=text.length-text.trimStart().length;if(indent%2||indent>12||text.slice(0,indent)!==' '.repeat(indent))auditFail('profile_indent');lines.push({indent,text:text.slice(indent),line:number+1});}if(lines.length>20000)auditFail('profile_lines');let p=0,nodes=0;
 function block(indent,depth){if(depth>6)auditFail('profile_depth');const list=lines[p]?.text.startsWith('- '),out=list?[]:Object.create(null);
  while(p<lines.length&&lines[p].indent===indent){if(++nodes>40000)auditFail('profile_nodes');const row=lines[p++];if(list){if(!row.text.startsWith('- '))auditFail('profile_mixed_block');out.push(atom(row.text.slice(2)));if(lines[p]?.indent>indent)auditFail('profile_complex_sequence');}
   else{if(row.text.startsWith('- '))auditFail('profile_mixed_block');const[k,v]=pair(row.text);if(own(out,k))auditFail('profile_duplicate',k);if(v){out[k]=atom(v);if(lines[p]?.indent>indent)auditFail('profile_unexpected_child');}else if(lines[p]?.indent>indent){if(lines[p].indent!==indent+2)auditFail('profile_indent_jump');out[k]=block(indent+2,depth+1);}else out[k]=Object.create(null);}
  }if(p<lines.length&&lines[p].indent>indent)auditFail('profile_indent');return out;
 }
 if(!lines.length||lines[0].indent!==0)auditFail('profile_root');const o=block(0,0);if(p!==lines.length)auditFail('profile_trailing');return o;
}
const NAME=/^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VERSION=/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
function npmName(s){if(typeof s!=='string'||s.length>214||!NAME.test(s))auditFail('registry_name',s);return s;}
function version(s){if(typeof s!=='string'||s.length>160||!VERSION.test(s))auditFail('registry_version',String(s));return s;}
function range(s){if(typeof s!=='string'||s.length>2048||!/^[0-9A-Za-z.*^~<>=|+ -]+$/.test(s)||/[/:@&!]/.test(s))auditFail('registry_range',String(s));return s;}
function identifier(text,depth=0){
 if(typeof text!=='string'||text.length>2048||depth>4)auditFail('registry_identifier_bound');const at=text.indexOf('('),head=at<0?text:text.slice(0,at),split=head.lastIndexOf('@');if(split<=0)auditFail('registry_identifier',text);const name=npmName(head.slice(0,split)),v=version(head.slice(split+1)),id=name+'@'+v,contexts=[];let patchHash;let p=head.length;
 while(p<text.length){if(text[p]!=='('||contexts.length>=16)auditFail('registry_context',text);const start=++p;let level=1;while(p<text.length&&level){if(text[p]==='(')level++;if(text[p]===')')level--;if(level)p++;}if(level)auditFail('registry_context',text);const inside=text.slice(start,p++);if(inside.startsWith('patch_hash=')){if(patchHash||!PATCHES[id]||inside!=='patch_hash='+PATCHES[id].sha256)auditFail('legacy_patch_context',id);patchHash=inside.slice(11);}else contexts.push(identifier(inside,depth+1));}
 return {full:text,id,name,version:v,contexts,patchHash};
}
function plainID(text){const parsed=identifier(text);if(parsed.contexts.length||parsed.patchHash)auditFail('package_identifier_context',text);return parsed;}
function validateOverrides(o){expectMap(o,'overrides');const rows=[];for(const [selector,value]of Object.entries(o)){let name=selector,constraint;const at=selector.lastIndexOf('@');if(at>0){name=selector.slice(0,at);constraint=range(selector.slice(at+1));}npmName(name);version(value);rows.push({selector,name,constraint,value});}return rows;}
function manifestAudit(text){const m=strictJSON(text);exactKeys(m,['name','desktopName','productName','version','description','main','type','license','repository','author','scripts','engines','dependencies','devDependencies','optionalDependencies','peerDependencies','auto-changelog'],'manifest',['name','version','dependencies','devDependencies']);const direct=[];for(const field of ['dependencies','devDependencies','optionalDependencies','peerDependencies'])if(own(m,field)){for(const [name,spec]of Object.entries(expectMap(m[field],field))){npmName(name);version(spec);direct.push({field,name,spec});}}return {value:m,direct};}
function workspaceAudit(raw,patches){const w=printedProfile(raw);exactKeys(w,['minimumReleaseAge','allowBuilds','overrides','patchedDependencies','engineStrict','minimumReleaseAgeExclude'],'workspace');if(w.minimumReleaseAge!=='360'||w.engineStrict!=='true')auditFail('workspace_policy');for(const [n,v]of Object.entries(expectMap(w.allowBuilds,'allowBuilds'))){npmName(n);if(!['true','false'].includes(v))auditFail('workspace_build_policy');}if(!Array.isArray(w.minimumReleaseAgeExclude))auditFail('workspace_exclude');for(const x of w.minimumReleaseAgeExclude)plainID(x);
 const overrideRows=validateOverrides(w.overrides);equal(Object.keys(w.patchedDependencies).sort(),Object.keys(PATCHES).sort(),'exact5_workspace_patch_ids');equal(Object.keys(patches).sort(),Object.values(PATCHES).map(x=>x.path).sort(),'exact5_patch_inputs');const exceptions=[];
 for(const [id,known]of Object.entries(PATCHES)){if(w.patchedDependencies[id]!==known.path||sha256(patches[known.path])!==known.sha256)auditFail('legacy_patch_binding',id);exceptions.push({id,...known});}
 return {value:w,overrideRows,exceptions};
}
function inspectLock(raw,manifest,workspace,label){
 const lock=printedProfile(raw);exactKeys(lock,['lockfileVersion','settings','overrides','patchedDependencies','importers','packages','snapshots'],label);if(lock.lockfileVersion!=='9.0')auditFail('lock_version');exactKeys(lock.settings,['autoInstallPeers','excludeLinksFromLockfile'],'settings');if(lock.settings.autoInstallPeers!=='true'||lock.settings.excludeLinksFromLockfile!=='false')auditFail('lock_settings');validateOverrides(lock.overrides);equal(lock.overrides,workspace.value.overrides,label+'_overrides');equal(Object.keys(lock.patchedDependencies).sort(),Object.keys(PATCHES).sort(),label+'_patches');for(const [id,known]of Object.entries(PATCHES))if(lock.patchedDependencies[id]!==known.sha256)auditFail('legacy_patch_binding',id);
 const packages=[],packageMap=new Map(),seenFold=new Set(),peerDeclarations=[],metadataURLs=[];
 for(const [id,entry]of Object.entries(expectMap(lock.packages,'packages'))){const parsed=plainID(id),fold=id.toLowerCase();if(seenFold.has(fold))auditFail('package_identifier_collision',id);seenFold.add(fold);exactKeys(entry,['resolution','peerDependencies','engines','hasBin','cpu','os','peerDependenciesMeta','libc','deprecated'],id,['resolution']);exactKeys(entry.resolution,['integrity'],id+'.resolution');const sri=entry.resolution.integrity,m=typeof sri==='string'&&/^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(sri);if(!m)auditFail('integrity_source',id);const b=base64Bytes(m[1]);if(b.length!==64||b.canonical!==m[1])auditFail('integrity_digest',id);packageMap.set(id,{id,integrity:sri});packages.push({id,integrity:sri});
  if(own(entry,'engines'))for(const [name,value]of Object.entries(expectMap(entry.engines,'engines'))){if(!['node','npm','pnpm','yarn','iojs','bun'].includes(name))auditFail('unknown_engine');range(value);}
  for(const k of ['hasBin'])if(own(entry,k)&&!['true','false'].includes(entry[k]))auditFail('package_boolean',k);
  for(const k of ['cpu','os','libc'])if(own(entry,k)){if(!Array.isArray(entry[k])||entry[k].some(x=>typeof x!=='string'||!/^!?[A-Za-z0-9_-]+$/.test(x)))auditFail('platform_metadata',k);}
  if(own(entry,'peerDependencies'))for(const [name,spec]of Object.entries(expectMap(entry.peerDependencies,'peers'))){npmName(name);range(spec);peerDeclarations.push({from:id,name,spec});}
  if(own(entry,'peerDependenciesMeta'))for(const [name,meta]of Object.entries(expectMap(entry.peerDependenciesMeta,'peerMeta'))){npmName(name);exactKeys(meta,['optional'],'peerMeta');if(!['true','false'].includes(meta.optional))auditFail('peer_metadata');}
  if(own(entry,'deprecated')){if(typeof entry.deprecated!=='string')auditFail('deprecated_metadata');for(const url of entry.deprecated.match(/https?:\/\/[^\s'"\]}]+/g)||[])metadataURLs.push({id,field:'deprecated',url});}
 }
 const snaps=expectMap(lock.snapshots,'snapshots'),snapshotHeaders=[],physicalRefs=[],contextRefs=[],seenPackages=new Set(),patchSnapshotIDs=new Set();
 function checkInstance(instance,owner){if(!packageMap.has(instance.id))auditFail('missing_registry_record',instance.id);if(instance.patchHash&&!PATCHES[instance.id])auditFail('unknown_patch',instance.id);for(const child of instance.contexts){contextRefs.push({from:owner,annotation:child.full,registryRecord:child.id,role:'peer_context_registry_identity_not_physical_edge'});checkInstance(child,owner);}}
 for(const [id,entry]of Object.entries(snaps)){const parsed=identifier(id);checkInstance(parsed,id);if(PATCHES[parsed.id]){if(parsed.patchHash!==PATCHES[parsed.id].sha256)auditFail('missing_patch_annotation',id);patchSnapshotIDs.add(parsed.id);}seenPackages.add(parsed.id);snapshotHeaders.push({id,registryRecord:parsed.id,patchHash:parsed.patchHash});exactKeys(entry,['dependencies','optionalDependencies','transitivePeerDependencies','optional'],id,[]);
  if(own(entry,'optional')&&!['true','false'].includes(entry.optional))auditFail('snapshot_optional');
  if(own(entry,'transitivePeerDependencies')){if(!Array.isArray(entry.transitivePeerDependencies))auditFail('transitive_peer_shape');for(const n of entry.transitivePeerDependencies)npmName(n);}
  for(const kind of ['dependencies','optionalDependencies'])if(own(entry,kind))for(const [name,ref]of Object.entries(expectMap(entry[kind],kind))){npmName(name);if(typeof ref!=='string'||!/^\d/.test(ref))auditFail('registry_reference',String(ref));const target=identifier(name+'@'+ref);if(!own(snaps,target.full))auditFail('missing_snapshot_reference',target.full);checkInstance(target,id);physicalRefs.push({from:id,kind,name,reference:ref,target:target.full,registryRecord:target.id});}
 }
 equal([...seenPackages].sort(),[...packageMap.keys()].sort(),label+'_package_snapshot_coverage');equal([...patchSnapshotIDs].sort(),Object.keys(PATCHES).sort(),label+'_exact5_patch_snapshots');
 exactKeys(lock.importers,['.'],'importers');const imp=lock.importers['.'];exactKeys(imp,['dependencies','devDependencies','optionalDependencies','peerDependencies'],'importer',[]);const importerRows=[];
 for(const field of ['dependencies','devDependencies','optionalDependencies','peerDependencies']){const expected={...(manifest.value[field]||{})},found=imp[field]||Object.create(null);if(field==='devDependencies')for(const name of Object.keys(expected))if(own(manifest.value.dependencies||{},name)){if(expected[name]!==manifest.value.dependencies[name])auditFail('ambiguous_duplicate_direct_spec',name);delete expected[name];}if(stable(Object.keys(found).sort())!==stable(Object.keys(expected).sort()))auditFail('importer_names_mismatch',JSON.stringify({label,field,extra:Object.keys(found).filter(k=>!own(expected,k)),missing:Object.keys(expected).filter(k=>!own(found,k))}));for(const [name,entry]of Object.entries(found)){npmName(name);exactKeys(entry,['specifier','version'],'importerEntry');version(entry.specifier);if(entry.specifier!==expected[name])auditFail('importer_specifier_mismatch',name);if(typeof entry.version!=='string'||!/^\d/.test(entry.version))auditFail('registry_reference');const target=identifier(name+'@'+entry.version);if(!own(snaps,target.full))auditFail('missing_importer_snapshot',target.full);checkInstance(target,'importer:'+field);importerRows.push({field,name,specifier:entry.specifier,version:entry.version,target:target.full,registryRecord:target.id});}}
 return {packages,snapshotHeaders,importers:importerRows,physicalRefs,contextRefs,peerDeclarations,metadataURLs};
}
// Explicit reviewed source-bearing fields visible in inherited package.json hunks.
// Whole patch SHA binding admits their other inert code bytes only as the same five
// inherited exceptions; this does not validate patch application or graph consistency.
function patchManifestAudit(patches){
 const expectedHunks={
  'patches/kuromoji@0.1.2.patch':'6c37357d090e2813fd514c54a5891173cda96881ef8cf6a719c3a879f2aa301a',
  'patches/mdui@2.1.4.patch':'bed64577e47ea6c9d8a0e53ee3be3bb221ae682981cbe9f1c7d1fed5b8c1badc'
 };
 const fields=[
  ['kuromoji','overrides','graceful-fs','^4.2.3','added'],
  ['kuromoji','dependencies','async','^2.0.1','removed'],
  ['kuromoji','dependencies','async','^2.3.0','added'],
  ['kuromoji','dependencies','doublearray','0.0.2','context'],
  ['kuromoji','dependencies','zlibjs','^0.3.1','removed'],
  ['kuromoji','dependencies','fflate','0.8.2','added'],
  ['kuromoji','devDependencies','browserify','^16.1.1','context'],
  ['mdui','dependencies','tslib','^2.8.1','context'],
  ['mdui','dependencies','@mdui/shared','^1.0.8','context'],
  ['mdui','dependencies','@mdui/jq','^3.0.3','context'],
  ['mdui','peerDependencies','solid-js','^1.9.7','added']
 ].map(([patch,field,name,spec,status])=>{npmName(name);range(spec);return{patch:patch==='kuromoji'?'patches/kuromoji@0.1.2.patch':'patches/mdui@2.1.4.patch',field,name,spec,status,source:'registry_range'};});
 const changedPaths=[];const seen=new Set();
 for(const [patch,text]of Object.entries(patches)){
  const lines=text.split('\n');for(let i=0;i<lines.length;i++)if(lines[i].startsWith('+++ ')){
   const target=lines[i].slice(4);if(!target.startsWith('b/')||target.includes('..'))auditFail('legacy_patch_target',target);
   changedPaths.push({patch,target:target.slice(2),role:target==='b/package.json'?'reviewed_package_manifest_hunk':'inherited_code_only_not_evaluated'});
   if(target==='b/package.json'){const end=lines.findIndex((line,j)=>j>i&&line.startsWith('diff --git'));const hunk=lines.slice(i,end<0?lines.length:end).join('\n');const normalized=hunk.endsWith('\n')?hunk:hunk+'\n';if(seen.has(patch)||!expectedHunks[patch]||sha256(normalized)!==expectedHunks[patch])auditFail('legacy_patch_manifest_hunk',patch);seen.add(patch);}
  }
 }
 equal([...seen].sort(),Object.keys(expectedHunks).sort(),'exact_inherited_manifest_hunks');
 return {fields,changedPaths,metadata:[{patch:'patches/kuromoji@0.1.2.patch',field:'bugs.url',url:'https://github.com/takuyaa/kuromoji.js/issues',role:'package_metadata_not_dependency_source'}],claim:'Visible package manifest source fields only. Other inherited code is not evaluated; patched dependency graph, resolution consistency, application and runtime remain unvalidated.'};
}
function auditSourceInputs(data){
 exactKeys(data,['manifest','originalManifest','candidateLock','baseLock','workspace','patches'],'auditInputs');const manifest=manifestAudit(data.manifest),original=manifestAudit(data.originalManifest),workspace=workspaceAudit(data.workspace,data.patches);const patchManifests=patchManifestAudit(data.patches);const candidate=inspectLock(data.candidateLock,manifest,workspace,'candidate'),base=inspectLock(data.baseLock,original,workspace,'base');
 const restored=strictJSON(data.manifest);if(restored.dependencies['@modelcontextprotocol/sdk']!=='1.30.0'||own(original.value.dependencies,'@modelcontextprotocol/sdk'))auditFail('sdk_manifest_delta');delete restored.dependencies['@modelcontextprotocol/sdk'];equal(restored,original.value,'only_exact_SDK_manifest_addition');
 if(candidate.packages.length!==950||base.packages.length!==896)auditFail('pinned_record_counts');
 const keySubstringHits=[];for(const [number,line]of data.candidateLock.split('\n').entries()){const m=/(?:git\+|git:|github:|gitlab:|bitbucket:|workspace:|link:|file:)/m.exec(line);if(m){const at=line.indexOf(':');const key=line.slice(0,at).trim(),value=line.slice(at+1).trim();if(m[0]!=='file:'||!key.endsWith('file'))auditFail('unclassified_protocol_text',line);keySubstringHits.push({line:number+1,key,value,role:key==='excludeLinksFromLockfile'?'setting_key':'dependency_name_key'});}}
 return {complete:true,scope:'EXACT_PINNED_PNPM9_PRINTED_PROFILE_REGISTRY_SOURCE_AUDIT_NOT_GENERAL_YAML_OR_LOCK_VALIDITY',bindings:{manifestSHA256:sha256(data.manifest),candidateSHA256:sha256(data.candidateLock),context:{'package.json':sha256(data.originalManifest),'pnpm-lock.yaml':sha256(data.baseLock),'pnpm-workspace.yaml':sha256(data.workspace),...Object.fromEntries(Object.entries(data.patches).map(([k,v])=>[k,sha256(v)]))}},manifest:{direct:manifest.direct,originalDirect:original.direct},overrides:workspace.overrideRows,patchExceptions:workspace.exceptions,patchManifestFields:patchManifests.fields,patchChangedPaths:patchManifests.changedPaths,patchManifestMetadata:patchManifests.metadata,patchManifestScope:patchManifests.claim,candidate,base,classification:{keySubstringHits,metadataURLs:candidate.metadataURLs},bounds:{inputUTF16CodeUnits:1048576,lines:20000,blockIndent:12,blockDepth:6,flatFlowOnly:true,instanceContextDepth:4,SDKCodeEvaluated:false},claims:'Registry source identity/integrity/reference/patch admission only; no general semver/range-satisfaction, installed selection, security/license/runtime or product lock validation.'};
}

 // CLOSED_PRIMITIVES_END
 return Object.freeze({printedProfile,manifestAudit,workspaceAudit,inspectLock,patchManifestAudit,identifier,stable,strictJSON});
}
module.exports=Object.freeze({createSourceAudit,BASE_PATCHES});
