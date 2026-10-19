import {randomUUID} from 'node:crypto';
import type {SyncIdentity} from '../protocol/types.js';
import type {SyncStorage} from './state.js';
import {identityKey,sameIdentity} from '../bindings/registry.js';
import {insideRoot,normalizeVaultPath,pathKey} from '../bindings/paths.js';
import {hashBytes,stableHash,validHash} from '../documents/hashes.js';
import {validateDTO} from '../protocol/validate.js';
import type {ReviewPlanDTO} from '../protocol/transfers.js';

export type CapturedNote={path:string;entityId:string|null;localFileHash:string;baseVersion:{entityId:string;revision:number;sourceHash:string}|null};
export type OverwriteIntent={entityId:string;revision:number;sourceHash:string};
export type QueueStatus='queued'|'staged'|'review'|'applying'|'awaiting-receipt'|'acknowledged'|'local-pending'|'conflict';
export type QueueReceipt={operationId:string;archiveRevision:number};
export type QueueJob={overwrite?:OverwriteIntent;id:string;operationId:string;packageHash:string;byteSize:number;notes:CapturedNote[];state:QueueStatus;transferId:string|null;planId:string|null;planHash:string|null;approved:boolean;receipt:QueueReceipt|null;captureHash:string|null;reviewHash:string|null};
export type QueueTransition={state:QueueStatus;transferId?:string;planId?:string;planHash?:string;receipt?:QueueReceipt};
export type QueuePause='manual'|'network'|'authorization'|'conflict'|'protocol'|'storage';
type BindingQueue={identity:SyncIdentity;root:string;paused:boolean;pauseReason:QueuePause|null;jobs:QueueJob[]};
type CampaignScope=Omit<SyncIdentity,'bindingId'>;
type Lease={ownerId:string;bindingId:string;token:string;expiresAt:number;mode:'push'|'pull'};
type QueueDocument={version:1;deviceId:string;scope:CampaignScope;generation:number;lease:Lease|null;bindings:BindingQueue[]};

export class SyncQueueError extends Error{
  constructor(public code:string){super('Очередь синхронизации требует проверки: '+code);this.name='SyncQueueError';}
}
function check(value:unknown,code='queue_corrupt'):asserts value{if(!value)throw new SyncQueueError(code);}
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)));
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const natural=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const statuses:QueueStatus[]=['queued','staged','review','applying','awaiting-receipt','acknowledged','local-pending','conflict'];
const reasons:QueuePause[]=['manual','network','authorization','conflict','protocol','storage'];
const transitions:Record<QueueStatus,QueueStatus[]>={queued:['staged','conflict'],staged:['review','conflict'],review:['applying','conflict'],applying:['awaiting-receipt','acknowledged','local-pending','conflict'],'awaiting-receipt':['acknowledged','local-pending','conflict'],acknowledged:[],'local-pending':['acknowledged'],conflict:[]};

function validateNotes(notes:CapturedNote[],root:string){
  check(Array.isArray(notes)&&notes.length>0&&notes.length<=32,'invalid_capture');
  const paths=new Set<string>(),entities=new Set<string>();
  for(const note of notes){
    check(exact(note,['path','entityId','localFileHash','baseVersion'])&&typeof note.path==='string'&&normalizeVaultPath(note.path)===note.path&&insideRoot(note.path,root)&&/\.md$/i.test(note.path)&&validHash(note.localFileHash)&&(note.entityId===null||id(note.entityId)),'invalid_capture');
    check(!paths.has(pathKey(note.path))&&(note.entityId===null||!entities.has(note.entityId)),'invalid_capture');paths.add(pathKey(note.path));if(note.entityId)entities.add(note.entityId);
    if(note.baseVersion!==null){validateDTO('baseVersion',note.baseVersion);check(note.entityId===note.baseVersion.entityId,'invalid_capture');}
    else check(note.entityId===null,'invalid_capture');
  }
}

export function validateOverwriteIntent(overwrite:OverwriteIntent,notes:CapturedNote[]){
  check(exact(overwrite,['entityId','revision','sourceHash'])&&notes.length===1&&notes[0].entityId!==null&&notes[0].baseVersion!==null,'invalid_overwrite');
  validateDTO('baseVersion',overwrite);const base=notes[0].baseVersion!;
  check(overwrite.entityId===notes[0].entityId&&overwrite.revision>=base.revision&&(overwrite.revision!==base.revision||overwrite.sourceHash===base.sourceHash),'invalid_overwrite');
}

/** Durable scheduler primitives only. Network and local-base acknowledgement belong to the push coordinator. */
export function createSyncQueue({identity,root,deviceId,storage,clock=Date.now,leaseMs=30000}:{identity:SyncIdentity;root:string;deviceId:string;storage:SyncStorage;clock?:()=>number;leaseMs?:number}){
  validateDTO('syncIdentity',identity);identity=Object.freeze({...identity});root=normalizeVaultPath(root);
  check(id(deviceId)&&Number.isSafeInteger(leaseMs)&&leaseMs>=1000&&leaseMs<=300000,'invalid_queue');
  const {bindingId:_,...scope}=identity,ownerId=randomUUID(),key=hashBytes('push-queue-v1\n'+deviceId+'\n'+stableHash(scope));
  const currentTime=()=>{const now=clock();check(natural(now),'invalid_clock');return now;};
  function validate(state:QueueDocument){
    check(exact(state,['version','deviceId','scope','generation','lease','bindings'])&&state.version===1&&state.deviceId===deviceId&&exact(state.scope,['connectionId','instanceId','accountId','campaignId'])&&stableHash(state.scope)===stableHash(scope)&&natural(state.generation)&&Array.isArray(state.bindings)&&state.bindings.length<=200);
    const bindingIds=new Set<string>(),roots:string[]=[],jobIds=new Set<string>(),operationIds=new Set<string>();let jobCount=0;
    for(const binding of state.bindings){
      check(exact(binding,['identity','root','paused','pauseReason','jobs']));identityKey(binding.identity);
      const {bindingId,...bindingScope}=binding.identity;
      check(stableHash(bindingScope)===stableHash(scope)&&!bindingIds.has(bindingId)&&normalizeVaultPath(binding.root)===binding.root&&typeof binding.paused==='boolean'&&(binding.pauseReason===null||reasons.includes(binding.pauseReason))&&binding.paused===(binding.pauseReason!==null)&&Array.isArray(binding.jobs));
      check(!roots.some(other=>pathKey(other)===pathKey(binding.root)||insideRoot(other,binding.root)||insideRoot(binding.root,other)));
      bindingIds.add(bindingId);roots.push(binding.root);
      for(const job of binding.jobs){
        jobCount++;check(jobCount<=100&&exact(job,['id','operationId','packageHash','byteSize','notes','state','transferId','planId','planHash','approved','receipt','captureHash','reviewHash',...(Object.hasOwn(job,'overwrite')?['overwrite']:[])])&&uuid(job.id)&&uuid(job.operationId)&&!jobIds.has(job.id)&&!operationIds.has(job.operationId)&&validHash(job.packageHash)&&natural(job.byteSize)&&job.byteSize>0&&job.byteSize<=33554432&&statuses.includes(job.state)&&typeof job.approved==='boolean');
        jobIds.add(job.id);operationIds.add(job.operationId);validateNotes(job.notes,binding.root);
        if(Object.hasOwn(job,'overwrite')){validateOverwriteIntent(job.overwrite!,job.notes);check(job.captureHash!==null,'overwrite_capture_missing');}
        check((job.captureHash===null||validHash(job.captureHash))&&(job.reviewHash===null||validHash(job.reviewHash)));
        check((job.transferId===null||id(job.transferId))&&(job.planId===null||id(job.planId))&&(job.planHash===null||validHash(job.planHash))&&(job.planId===null)===(job.planHash===null));
        if(!['queued','conflict'].includes(job.state))check(job.transferId!==null);
        if(['review','applying','awaiting-receipt','acknowledged','local-pending'].includes(job.state))check(job.planId!==null);
        if(job.approved)check(job.planId!==null);
        if(['applying','awaiting-receipt','acknowledged','local-pending'].includes(job.state))check(job.approved);
        if(job.receipt!==null)check(exact(job.receipt,['operationId','archiveRevision'])&&job.receipt.operationId===job.operationId&&natural(job.receipt.archiveRevision));
        check(['acknowledged','local-pending'].includes(job.state)===(job.receipt!==null));
      }
    }
    if(state.lease!==null)check(exact(state.lease,['ownerId','bindingId','token','expiresAt','mode'])&&uuid(state.lease.ownerId)&&uuid(state.lease.token)&&bindingIds.has(state.lease.bindingId)&&natural(state.lease.expiresAt)&&['push','pull'].includes(state.lease.mode));
    check(Buffer.byteLength(JSON.stringify(state))<=4194304,'queue_full');return state;
  }
  function binding(state:QueueDocument){
    const existing=state.bindings.find(row=>row.identity.bindingId===identity.bindingId);
    if(existing){check(sameIdentity(existing.identity,identity)&&existing.root===root,'queue_context_changed');return existing;}
    const created:BindingQueue={identity:{...identity},root,paused:false,pauseReason:null,jobs:[]};state.bindings.push(created);return created;
  }
  async function read(){
    const raw=await storage.read(key);if(raw===null)return {raw,state:{version:1,deviceId,scope:{...scope},generation:0,lease:null,bindings:[]} as QueueDocument};
    check(Buffer.byteLength(raw)<=4194304);let value:QueueDocument;try{value=JSON.parse(raw);}catch{throw new SyncQueueError('queue_corrupt');}
    // Older connection-preview queues contain no capture/review blobs. Keep them readable,
    // but the coordinator will not acknowledge jobs lacking those durable facts.
    if(value&&Array.isArray(value.bindings))for(const row of value.bindings)if(Array.isArray(row?.jobs))for(const job of row.jobs)if(job&&typeof job==='object'){if(!Object.hasOwn(job,'captureHash'))job.captureHash=null;if(!Object.hasOwn(job,'reviewHash'))job.reviewHash=null;}
    if(value?.lease&&!Object.hasOwn(value.lease,'mode'))value.lease.mode='push';
    validate(value);binding(value);return {raw,state:value};
  }
  async function update<T>(reduce:(state:QueueDocument,binding:BindingQueue)=>T):Promise<T>{
    for(let attempt=0;attempt<8;attempt++){
      const previous=await read(),next=structuredClone(previous.state),result=reduce(next,binding(next));next.generation++;
      validate(next);if(await storage.compareAndSwap(key,previous.raw,JSON.stringify(next)))return structuredClone(result);
    }
    throw new SyncQueueError('queue_busy');
  }
  function held(state:QueueDocument,token:string,allowPaused=false){
    check(state.lease?.ownerId===ownerId&&state.lease.bindingId===identity.bindingId&&state.lease.token===token&&state.lease.expiresAt>currentTime(),'lease_lost');
    check(allowPaused||!binding(state).paused,'queue_paused');
  }
  const find=(row:BindingQueue,jobId:string)=>{const job=row.jobs.find(job=>job.id===jobId);check(job,'job_missing');return job;};
  return {
    get deviceId(){return deviceId;},
    async snapshot(){const {state}=await read();return structuredClone(binding(state));},
    async enqueue(input:{packageBytes:Uint8Array;notes:CapturedNote[];capture?:Uint8Array;overwrite?:OverwriteIntent},jobId:string=randomUUID()){
      check(exact(input,['packageBytes','notes',...(Object.hasOwn(input,'capture')?['capture']:[]),...(Object.hasOwn(input,'overwrite')?['overwrite']:[])])&&input.packageBytes instanceof Uint8Array&&input.packageBytes.byteLength>0&&input.packageBytes.byteLength<=33554432&&uuid(jobId),'invalid_capture');
      const notes=structuredClone(input.notes),bytes=Uint8Array.from(input.packageBytes);validateNotes(notes,root);
      const overwrite=input.overwrite===undefined?undefined:structuredClone(input.overwrite);
      if(Object.hasOwn(input,'overwrite')){
        validateOverwriteIntent(overwrite!,notes);check(input.capture instanceof Uint8Array,'overwrite_capture_missing');
        let facts:any;try{facts=JSON.parse(Buffer.from(input.capture!).toString('utf8'));}catch{throw new SyncQueueError('overwrite_capture_missing');}
        check(stableHash(facts?.overwrite??null)===stableHash(overwrite),'overwrite_capture_changed');
      }
      const packageHash=hashBytes(bytes),operationId=randomUUID();
      check(input.capture===undefined||input.capture instanceof Uint8Array&&input.capture.byteLength>0&&input.capture.byteLength<=33554432,'invalid_capture');
      const captured=input.capture===undefined?null:Uint8Array.from(input.capture),captureHash=captured===null?null:hashBytes(captured);
      check(await storage.putBlob(bytes)===packageHash,'package_corrupt');if(captured)check(await storage.putBlob(captured)===captureHash,'capture_corrupt');
      return update((state,row)=>{
        check(!state.lease||state.lease.mode!=='pull'||state.lease.expiresAt<=currentTime(),'pull_busy');
        const existing=row.jobs.find(job=>job.id===jobId);
        if(existing){check(existing.packageHash===packageHash&&existing.byteSize===bytes.byteLength&&existing.captureHash===captureHash&&stableHash(existing.notes)===stableHash(notes)&&stableHash(existing.overwrite??null)===stableHash(overwrite??null),'operation_reused');return existing;}
        if(overwrite)check(!row.jobs.some(job=>!['acknowledged','conflict'].includes(job.state)),'capture_pending');
        check(!row.jobs.some(job=>!['acknowledged','conflict'].includes(job.state)&&job.notes.some(note=>notes.some(next=>pathKey(next.path)===pathKey(note.path)))),'capture_pending');
        const job:QueueJob={id:jobId,operationId,packageHash,byteSize:bytes.byteLength,notes,...(overwrite?{overwrite}:{}),state:'queued',transferId:null,planId:null,planHash:null,approved:false,receipt:null,captureHash,reviewHash:null};row.jobs.push(job);return job;
      });
    },
    async packageBytes(jobId:string){
      const {state}=await read(),job=find(binding(state),jobId),bytes=Uint8Array.from(await storage.readBlob(job.packageHash));
      check(bytes.byteLength===job.byteSize&&hashBytes(bytes)===job.packageHash,'package_corrupt');return bytes;
    },
    async captureBytes(jobId:string){
      const {state}=await read(),job=find(binding(state),jobId);check(job.captureHash,'capture_missing');
      const bytes=Uint8Array.from(await storage.readBlob(job.captureHash));check(hashBytes(bytes)===job.captureHash,'capture_corrupt');return bytes;
    },
    async saveReview(token:string,jobId:string,input:ReviewPlanDTO){
      const plan=structuredClone(input);validateDTO('reviewPlan',plan);check(plan.bindingId===identity.bindingId,'review_changed');
      const bytes=Buffer.from(JSON.stringify(plan)),reviewHash=hashBytes(bytes);check(await storage.putBlob(bytes)===reviewHash,'review_corrupt');
      return update((state,row)=>{held(state,token);const job=find(row,jobId);check(job.state==='staged'&&job.planId===null,'stale_transition');job.planId=plan.planId;job.planHash=plan.planHash;job.reviewHash=reviewHash;job.state='review';return job;});
    },
    async review(jobId:string){
      const {state}=await read(),job=find(binding(state),jobId);check(job.reviewHash,'review_missing');
      const bytes=await storage.readBlob(job.reviewHash);check(hashBytes(bytes)===job.reviewHash,'review_corrupt');
      const plan=validateDTO('reviewPlan',JSON.parse(Buffer.from(bytes).toString('utf8'))) as ReviewPlanDTO;check(plan.bindingId===identity.bindingId&&plan.planId===job.planId&&plan.planHash===job.planHash,'review_changed');return plan;
    },
    async resume(mode:'push'|'pull'='push'){
      check(['push','pull'].includes(mode),'invalid_lease');const token=randomUUID();return update((state,row)=>{
        check(!row.paused,'queue_paused');const now=currentTime();check(state.lease===null||state.lease.expiresAt<=now,'queue_busy');
        state.lease={ownerId,bindingId:identity.bindingId,token,expiresAt:now+leaseMs,mode};return token;
      });
    },
    async renew(token:string){return update(state=>{held(state,token);state.lease!.expiresAt=currentTime()+leaseMs;});},
    async release(token:string){return update(state=>{held(state,token,true);state.lease=null;});},
    async pause(reason:QueuePause='manual'){
      check(reasons.includes(reason),'invalid_pause');return update((state,row)=>{row.paused=true;row.pauseReason=reason;if(state.lease?.ownerId===ownerId&&state.lease.bindingId===identity.bindingId)state.lease=null;});
    },
    async retry(){return update((_,row)=>{row.paused=false;row.pauseReason=null;});},
    async approve(jobId:string,planId:string,planHash:string){
      return update((_,row)=>{const job=find(row,jobId);check(!row.paused&&job.state==='review'&&job.planId===planId&&job.planHash===planHash,'review_changed');job.approved=true;return job;});
    },
    async transition(token:string,jobId:string,expected:QueueStatus,change:QueueTransition){
      const captured=structuredClone(change);
      check(captured&&typeof captured==='object'&&!Array.isArray(captured)&&Object.keys(captured).every(key=>['state','transferId','planId','planHash','receipt'].includes(key)),'invalid_transition');
      return update((state,row)=>{
        held(state,token);const job=find(row,jobId);check(job.state===expected&&transitions[expected]?.includes(captured.state),'stale_transition');
        if(captured.state==='applying')check(job.approved,'review_required');
        for(const field of ['transferId','planId','planHash'] as const){if(captured[field]!==undefined){check(job[field]===null||job[field]===captured[field],'review_changed');job[field]=captured[field];}}
        if(captured.receipt!==undefined)job.receipt=structuredClone(captured.receipt);
        job.state=captured.state;return job;
      });
    },
  };
}
export type SyncQueue=ReturnType<typeof createSyncQueue>;
