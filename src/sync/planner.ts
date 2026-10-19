import type {SyncIdentity} from '../protocol/types.js';
import {sameIdentity} from '../bindings/registry.js';
import {normalizeVaultPath,pathKey} from '../bindings/paths.js';
import type {Diagnostic} from '../documents/links.js';
import {validHash} from '../documents/hashes.js';
import {validateDTO} from '../protocol/validate.js';

export type LocalVersion={identity:SyncIdentity;entityId:string|null;path:string;localFileHash:string;portableHash:string;metadataHash:string;assetHash:string;identityStatus:'new'|'bound'|'review';diagnostics:readonly Diagnostic[]};
export type BaseVersion={identity:SyncIdentity;entityId:string;path:string;localFileHash:string;basePortableHash:string;localMetadataHash:string;assetHash:string;serverSourceHash:string;projectionHash:string;serverRevision:number;remoteMetadataHash:string};
export type RemoteVersion={identity:SyncIdentity;entityId:string;revision:number;sourceHash:string;projectionHash:string;metadataHash:string};
export type SyncAction='unchanged'|'pull'|'push'|'create'|'conflict'|'missing'|'copy-review';
type Input={identity:SyncIdentity;local:LocalVersion|null;base:BaseVersion|null;remote:RemoteVersion|null};
export function planSync({identity,local,base,remote}:Input){
  validateDTO('syncIdentity',identity);
  const choose=(action:SyncAction,reason:string,needsBaseRefresh=false)=>({action,reason,identity:structuredClone(identity),entityId:base?.entityId??remote?.entityId??local?.entityId??null,path:local?.path??base?.path??null,localFileHash:local?.localFileHash??null,baseVersion:base?{entityId:base.entityId,revision:base.serverRevision,sourceHash:base.serverSourceHash}:null,needsBaseRefresh});
  for(const row of [local,base,remote])if(row&&!sameIdentity(row.identity,identity))return choose('copy-review','identity_changed');
  if(local){
    normalizeVaultPath(local.path);
    if(![local.localFileHash,local.portableHash,local.metadataHash,local.assetHash].every(validHash))throw new Error('Повреждены контрольные суммы локальной записи');
    if(local.identityStatus==='review'||local.diagnostics.some(value=>value.severity==='error'))return choose('copy-review','local_review');
  }
  if(base){
    normalizeVaultPath(base.path);validateDTO('baseVersion',{entityId:base.entityId,revision:base.serverRevision,sourceHash:base.serverSourceHash});
    if(![base.localFileHash,base.basePortableHash,base.localMetadataHash,base.assetHash,base.projectionHash,base.remoteMetadataHash].every(validHash))throw new Error('Повреждена исходная версия записи');
  }
  if(remote){validateDTO('baseVersion',{entityId:remote.entityId,revision:remote.revision,sourceHash:remote.sourceHash});if(![remote.projectionHash,remote.metadataHash].every(validHash))throw new Error('Повреждена версия сайта');}
  if(base&&[local?.entityId,remote?.entityId].some(value=>value!==undefined&&value!==base.entityId))return choose('copy-review','entity_changed');
  if(!base){
    if(!local&&!remote)return choose('unchanged','empty');
    if(!local)return choose('pull','initial_pull');
    if(local.identityStatus==='new'&&local.entityId===null&&!remote)return choose('create','new_note');
    return choose('copy-review','missing_base');
  }
  if(!local||!remote)return choose('missing',!local?'local_missing':'remote_missing');
  if(local.path!==base.path&&pathKey(local.path)===pathKey(base.path))return choose('copy-review','case_rename');
  const localChanged=local.portableHash!==base.basePortableHash||local.metadataHash!==base.localMetadataHash||local.assetHash!==base.assetHash||local.path!==base.path;
  const remoteChanged=remote.revision!==base.serverRevision||remote.sourceHash!==base.serverSourceHash||remote.projectionHash!==base.projectionHash||remote.metadataHash!==base.remoteMetadataHash;
  if(!localChanged&&!remoteChanged)return choose('unchanged','equal');
  if(localChanged&&remoteChanged){
    if(local.path===base.path&&local.portableHash===remote.projectionHash&&local.metadataHash===remote.metadataHash&&local.assetHash===base.assetHash)return choose('unchanged','converged',true);
    return choose('conflict','two_sided_edit');
  }
  return choose(localChanged?'push':'pull',localChanged?'local_changed':'remote_changed');
}
