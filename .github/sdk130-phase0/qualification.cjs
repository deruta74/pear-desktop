'use strict';
// OWN closed data comparison only. No IO, vendor import/evaluation or usable-lock writer.
const crypto=require('node:crypto'),{createSourceAudit}=require('./source-audit.cjs');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex'),SDK='@modelcontextprotocol/sdk@1.30.0',SDK_NAME='@modelcontextprotocol/sdk',SDK_SRI='sha512-xKd8OIzlqNzcqcNumGAa6g+PW2kjD5vrpcKOnfldAUPP3j7lnqMPwlTXQm8gF+UwH72z0lqaRbjr9hqGz0eITA==';
const INPUT_PINS={baseLock:'369082d23c177293e7d6a463f47965ee1565455d9599dfee42a58cd585c70cba',comparisonLock:'65a643aeb716a1244421aad864bf21be4898706ffaaa345de440bc482c6bf01f',baseManifest:'973f6e067390931c6b0e2a8d9dfe3df74c99418070b352be717f34cdd7d16c8c',manifest:'467e5ac91be8516726be4af5e63cc10f893688b57b70b64abb5836f5a4e18396',baseWorkspace:'0a69f8427ba6059055a6d53dcbe30f6398160f52e40b325c21b7db92ca05cfa8',workspace:'340d493fe473e28327d89f30ff67b29767cd5f57b4131171e1fa9b23da612741'};
function need(value,code){if(!value){const e=new Error(code);e.code=code;throw e;}}
const copy=x=>JSON.parse(JSON.stringify(x));
function qualifyGeneratedLock(data,generatedRaw){
 try{
  for(const[k,h]of Object.entries(INPUT_PINS))need(typeof data[k]==='string'&&sha(data[k])===h,'profile_input_binding');
  need(typeof generatedRaw==='string'&&Buffer.byteLength(generatedRaw)>0&&Buffer.byteLength(generatedRaw)<=1048576,'generated_lock_bound');
  const base=createSourceAudit('base'),workspaceSDK=createSourceAudit('workspaceSDK'),legacyPatches={...data.patches};delete legacyPatches['patches/@modelcontextprotocol__sdk@1.30.0.patch'];
  const originalManifest=base.manifestAudit(data.baseManifest),manifest=base.manifestAudit(data.manifest),baseWorkspace=base.workspaceAudit(data.baseWorkspace,legacyPatches),workspace=workspaceSDK.workspaceAudit(data.workspace,data.patches),baseResult=base.inspectLock(data.baseLock,originalManifest,baseWorkspace,'M73_base');
  const restored=copy(manifest.value);need(restored.dependencies[SDK_NAME]==='1.30.0','manifest_sdk');delete restored.dependencies[SDK_NAME];need(base.stable(restored)===base.stable(originalManifest.value),'manifest_delta');
  const oldWorkspace=copy(baseWorkspace);delete oldWorkspace.value.overrides['@xmldom/xmldom@<0.8.15'];oldWorkspace.value.overrides['@xmldom/xmldom@<0.8.12']='0.8.13';
  const comparison=base.inspectLock(data.comparisonLock,manifest,oldWorkspace,'known_comparison_only'),current=base.printedProfile(data.baseLock),expected=base.printedProfile(data.comparisonLock),actual=base.printedProfile(generatedRaw);
  need(baseResult.packages.length===896&&comparison.packages.length===950,'known_profile_record_count');need(comparison.packages.find(x=>x.id===SDK)?.integrity===SDK_SRI,'known_sdk_integrity');
  const observedRegistration=actual.patchedDependencies?.[SDK];need(typeof observedRegistration==='string'&&/^[a-f0-9]{64}$/.test(observedRegistration),'observed_registration_shape');
  const generatedAudit=createSourceAudit('lockSDK',observedRegistration),generated=generatedAudit.inspectLock(generatedRaw,manifest,workspace,'generated');
  // Explicit known M71-candidate -> current M73 security changes; no new YAML is emitted.
  const oldXML='@xmldom/xmldom@0.8.13',newXML='@xmldom/xmldom@0.8.15';need(expected.packages[oldXML]&&expected.snapshots[oldXML]&&current.packages[newXML]&&current.snapshots[newXML],'known_security_nodes');
  delete expected.packages[oldXML];expected.packages[newXML]=copy(current.packages[newXML]);delete expected.snapshots[oldXML];expected.snapshots[newXML]=copy(current.snapshots[newXML]);
  const priorPlist=copy(current.snapshots['plist@3.1.0']);need(priorPlist.dependencies['@xmldom/xmldom']==='0.8.15','M73_plist_edge');priorPlist.dependencies['@xmldom/xmldom']='0.8.13';need(base.stable(priorPlist)===base.stable(expected.snapshots['plist@3.1.0']),'only_known_plist_delta');expected.snapshots['plist@3.1.0']=copy(current.snapshots['plist@3.1.0']);expected.overrides=copy(current.overrides);expected.overrides['@modelcontextprotocol/sdk@1.30.0>jose']='6.2.12';
  // Observed registration is a bounded variable from the actual new generated lock,
  // independently bound to the exact raw patch by workspaceAudit; never guessed.
  const beforeSDK=comparison.snapshotHeaders.filter(x=>x.registryRecord===SDK),afterSDK=generated.snapshotHeaders.filter(x=>x.registryRecord===SDK);need(beforeSDK.length===1&&afterSDK.length===1&&afterSDK[0].patchHash===observedRegistration,'SDK_snapshot_registration');
  const suffix='(patch_hash='+observedRegistration+')',strip=s=>s.split(suffix).join('');need(afterSDK[0].id.split(suffix).length===2&&strip(afterSDK[0].id)===beforeSDK[0].id,'SDK_snapshot_context_delta');
  const beforeImporter=expected.importers['.'].dependencies[SDK_NAME],afterImporter=actual.importers['.'].dependencies[SDK_NAME];need(afterImporter.version.split(suffix).length===2&&strip(afterImporter.version)===beforeImporter.version&&afterImporter.specifier==='1.30.0','SDK_importer_registration');
  const sdkSnapshot=expected.snapshots[beforeSDK[0].id];delete expected.snapshots[beforeSDK[0].id];expected.snapshots[afterSDK[0].id]=sdkSnapshot;expected.importers['.'].dependencies[SDK_NAME]={...beforeImporter,version:afterImporter.version};expected.patchedDependencies[SDK]=observedRegistration;
  for(const section of ['packages','snapshots'])for(const[k,v]of Object.entries(current[section]))need(base.stable(expected[section][k])===base.stable(v),'M73_existing_record_preservation');
  for(const field of ['dependencies','devDependencies','optionalDependencies','peerDependencies'])for(const[k,v]of Object.entries(current.importers['.'][field]||{}))need(base.stable(expected.importers['.'][field]?.[k])===base.stable(v),'M73_importer_preservation');
  need(base.stable(actual)===base.stable(expected),'unknown_semantic_delta');
  return Object.freeze({complete:true,classification:'EXACT_EXPECTED_SEMANTIC_PROFILE_ONLY',generatedLockBytes:Buffer.byteLength(generatedRaw),generatedLockSHA256:sha(generatedRaw),observedSDKRegistration:observedRegistration,SDKRawPatchSHA256:sha(data.patches['patches/@modelcontextprotocol__sdk@1.30.0.patch']),baseRegistryRecords:baseResult.packages.length,candidateRegistryRecords:generated.packages.length,expectedSemanticSHA256:sha(base.stable(expected)),M73SecurityPreserved:true,legacyFivePreserved:true,productionGraphValidated:false,vendorEvaluated:false});
 }catch(cause){const e=new Error('PENDING_STATIC_GRAPH');e.code='PENDING_STATIC_GRAPH';e.reason=typeof cause?.code==='string'&&/^[A-Za-z0-9_]{1,64}$/.test(cause.code)?cause.code:'closed_profile_rejected';throw e;}
}
function verifyInstalledSDK(items,expected){
 need(Array.isArray(items)&&items.length===693&&expected.baseline693.length===693&&expected.patchedTargets.length===2,'installed_sdk_inventory_count');const wanted=new Map(expected.baseline693.map(x=>[x.path,x]));for(const x of expected.patchedTargets){need(wanted.has(x.path),'expected_patch_target');wanted.set(x.path,x);}const seen=new Set();for(const x of items){need(!seen.has(x.path),'installed_sdk_duplicate');seen.add(x.path);const y=wanted.get(x.path);need(y&&x.bytes===y.bytes&&x.sha256===y.sha256,'installed_sdk_source_mismatch');}return{complete:true,files:693,patchedTargets:2,sourceMatchOnly:true,SDKExecuted:false};
}
function remainingPMBudget(spent){need(Number.isFinite(spent)&&spent>=0&&spent<480000,'managed_PM_budget');return 480000-spent;}
module.exports=Object.freeze({qualifyGeneratedLock,verifyInstalledSDK,remainingPMBudget});
