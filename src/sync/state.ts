import type {SyncIdentity} from '../protocol/types.js';
import type {BaseVersion} from './planner.js';
import {identityKey,sameIdentity} from '../bindings/registry.js';
import {insideRoot,normalizeVaultPath,pathKey} from '../bindings/paths.js';
import {hashBytes,validHash} from '../documents/hashes.js';
import {validateDTO} from '../protocol/validate.js';

export type SyncStorage={read:(key:string)=>Promise<string|null>;compareAndSwap:(key:string,expected:string|null,next:string)=>Promise<boolean>;putBlob:(data:Uint8Array)=>Promise<string>;readBlob:(hash:string)=>Promise<Uint8Array>};
export type StoredBase=BaseVersion&{serverTitle:string;titleInputHash:string;metadata:{icon:string;favorite:boolean};boardHash:string|null};
export type EntryStatus='prepared'|'written'|'acknowledged'|'pending'|'superseded';
export type JournalEntry={id:string;kind:'note'|'asset';path:string;expectedHash:string|null;preimageHash:string|null;outputHash:string;byteSize:number;status:EntryStatus;reason:string|null;entityId:string|null;nextBase:StoredBase|null;dependencies:string[];editorHash:string|null;editorToken:string|null;manualApproved:boolean};
export type VaultJournal={id:string;planHash:string;mode:'automatic'|'manual'|'restore'|'copy';status:'prepared'|'applying'|'completed'|'pending';cursor:string|null;entries:JournalEntry[]};
export type PendingRecord={id:string;path:string;entityId:string|null;reason:string;journalId:string|null;remote:StoredBase|null};
export type OwnWrite={path:string;hash:string;generation:number};
export type StateDocument={version:1;deviceId:string;identity:SyncIdentity;root:string;generation:number;cursor:string|null;checkpoint:number;bases:StoredBase[];pending:PendingRecord[];journals:VaultJournal[];ownWrites:OwnWrite[]};
export class SyncStateError extends Error{constructor(public code:string,message:string){super(message);this.name='SyncStateError';}}
function check(ok:unknown):asserts ok{if(!ok)throw new SyncStateError('state_corrupt','Журнал синхронизации требует проверки');}
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value);
const object=(value:any,keys:string[])=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const nullableId=(value:unknown)=>value===null||id(value);
const cursor=(value:unknown)=>value===null||typeof value==='string'&&/^[A-Za-z0-9_-]{1,2048}$/.test(value);
const positive=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
export function validateStoredBase(base:StoredBase,identity:SyncIdentity,root:string):void{
  check(object(base,['identity','entityId','path','localFileHash','basePortableHash','localMetadataHash','assetHash','serverSourceHash','projectionHash','serverRevision','remoteMetadataHash','serverTitle','titleInputHash','metadata','boardHash']));
  check(sameIdentity(base.identity,identity)&&insideRoot(base.path,root));validateDTO('baseVersion',{entityId:base.entityId,revision:base.serverRevision,sourceHash:base.serverSourceHash});
  check([base.localFileHash,base.basePortableHash,base.localMetadataHash,base.assetHash,base.projectionHash,base.remoteMetadataHash,base.titleInputHash].every(validHash));
  check(typeof base.serverTitle==='string'&&base.serverTitle.length>0&&base.serverTitle.length<=500&&object(base.metadata,['icon','favorite'])&&typeof base.metadata.icon==='string'&&base.metadata.icon.length<=80&&typeof base.metadata.favorite==='boolean'&&(base.boardHash===null||validHash(base.boardHash)));
}
export function validateState(value:StateDocument,deviceId:string,identity:SyncIdentity,root:string):StateDocument{
  check(object(value,['version','deviceId','identity','root','generation','cursor','checkpoint','bases','pending','journals','ownWrites'])&&value.version===1&&value.deviceId===deviceId&&sameIdentity(value.identity,identity)&&value.root===root&&positive(value.generation)&&positive(value.checkpoint)&&cursor(value.cursor));
  check(Array.isArray(value.bases)&&value.bases.length<=2000&&Array.isArray(value.pending)&&value.pending.length<=2000&&Array.isArray(value.journals)&&value.journals.length<=100&&Array.isArray(value.ownWrites)&&value.ownWrites.length<=2000);
  check(value.checkpoint<=value.journals.length);
  const paths=new Set<string>(),entities=new Set<string>();for(const base of value.bases){validateStoredBase(base,identity,root);check(!paths.has(pathKey(base.path))&&!entities.has(base.entityId));paths.add(pathKey(base.path));entities.add(base.entityId);}
  const journals=new Set<string>();for(const journal of value.journals){
    check(object(journal,['id','planHash','mode','status','cursor','entries'])&&id(journal.id)&&validHash(journal.planHash)&&!journals.has(journal.id)&&['automatic','manual','restore','copy'].includes(journal.mode)&&['prepared','applying','completed','pending'].includes(journal.status)&&cursor(journal.cursor)&&Array.isArray(journal.entries)&&journal.entries.length<=2032);journals.add(journal.id);
    const seen=new Set<string>();for(const entry of journal.entries){
      check(object(entry,['id','kind','path','expectedHash','preimageHash','outputHash','byteSize','status','reason','entityId','nextBase','dependencies','editorHash','editorToken','manualApproved'])&&id(entry.id)&&['note','asset'].includes(entry.kind)&&insideRoot(entry.path,root)&&!seen.has(pathKey(entry.path))&&validHash(entry.outputHash)&&positive(entry.byteSize)&&entry.byteSize<=10485760&&(entry.expectedHash===null||validHash(entry.expectedHash))&&entry.preimageHash===entry.expectedHash&&['prepared','written','acknowledged','pending','superseded'].includes(entry.status)&&nullableId(entry.reason)&&nullableId(entry.entityId)&&Array.isArray(entry.dependencies)&&entry.dependencies.length<=2000&&entry.dependencies.every(path=>insideRoot(path,root))&&(entry.editorHash===null||validHash(entry.editorHash))&&(entry.editorToken===null||id(entry.editorToken))&&typeof entry.manualApproved==='boolean');seen.add(pathKey(entry.path));
      if(journal.mode==='copy')check(entry.kind==='note'&&entry.nextBase===null&&entry.entityId===null&&entry.expectedHash===null&&entry.editorHash===null&&entry.editorToken===null&&entry.manualApproved&&entry.dependencies.length===0);
      else if(journal.mode==='restore')check(entry.kind==='note'&&entry.nextBase===null&&id(entry.entityId)&&entry.expectedHash!==null&&entry.manualApproved&&entry.dependencies.length===0);
      else if(entry.nextBase){validateStoredBase(entry.nextBase,identity,root);check(entry.kind==='note'&&entry.entityId===entry.nextBase.entityId&&entry.path===entry.nextBase.path&&entry.outputHash===entry.nextBase.localFileHash);}else check(entry.kind==='asset');
    }
  }
  for(const pending of value.pending){check(object(pending,['id','path','entityId','reason','journalId','remote'])&&id(pending.id)&&insideRoot(pending.path,root)&&nullableId(pending.entityId)&&id(pending.reason)&&nullableId(pending.journalId));if(pending.remote)validateStoredBase(pending.remote,identity,root);}
  for(const write of value.ownWrites)check(object(write,['path','hash','generation'])&&insideRoot(write.path,root)&&validHash(write.hash)&&positive(write.generation)&&write.generation<=value.generation);
  check(Buffer.byteLength(JSON.stringify(value))<=4194304);return structuredClone(value);
}
export function createSyncState({deviceId,storage}:{deviceId:string;storage:SyncStorage}){
  check(id(deviceId));
  const key=(identity:SyncIdentity)=>hashBytes(deviceId+'\n'+identityKey(identity));
  async function read(identity:SyncIdentity,root:string){
    root=normalizeVaultPath(root);const raw=await storage.read(key(identity));
    if(raw===null)return {raw,state:{version:1 as const,deviceId,identity:structuredClone(identity),root,generation:0,cursor:null,checkpoint:0,bases:[],pending:[],journals:[],ownWrites:[]} as StateDocument};
    check(Buffer.byteLength(raw)<=4194304);let state:StateDocument;try{state=JSON.parse(raw);}catch{throw new SyncStateError('state_corrupt','Журнал повреждён; автоматический обмен остановлен');}
    return {raw,state:validateState(state,deviceId,identity,root)};
  }
  return {
    storage,deviceId,
    load:async(identity:SyncIdentity,root:string)=>(await read(identity,root)).state,
    async update(identity:SyncIdentity,root:string,reduce:(state:StateDocument)=>StateDocument){
      for(let attempt=0;attempt<8;attempt++){
        const previous=await read(identity,root),next=reduce(structuredClone(previous.state));next.generation=previous.state.generation+1;
        const valid=validateState(next,deviceId,identity,normalizeVaultPath(root));
        if(await storage.compareAndSwap(key(identity),previous.raw,JSON.stringify(valid)))return valid;
      }throw new SyncStateError('state_busy','Журнал уже изменяется в другом окне');
    },
  };
}
export type SyncState=ReturnType<typeof createSyncState>;
