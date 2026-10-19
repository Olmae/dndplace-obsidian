import {sameIdentity} from '../bindings/registry.js';
import {validateDTO} from '../protocol/validate.js';
import {stableHash} from '../documents/hashes.js';
import {reviewCanApply} from './review.js';
import type {createProtocolClient} from '../protocol/client.js';
import type {TransferDTO,TransferRef,ReviewPlanDTO,PrepareTransfer} from '../protocol/transfers.js';
import type {QueueJob,SyncQueue,QueuePause} from './queue.js';

type PushClient=Pick<ReturnType<typeof createProtocolClient>,'identity'|'reserveTransfer'|'transferStatus'|'uploadTransfer'|'prepareTransfer'|'reviewTransfer'|'applyTransfer'>;
export type PushResult={state:'idle'}|{state:'review';jobId:string;plan:ReviewPlanDTO}|{state:'local-pending';jobId:string;receipt:{operationId:string;archiveRevision:number}};
export class SyncPushError extends Error{
  constructor(public code:string){super('Проверьте перенос перед продолжением: '+code);this.name='SyncPushError';}
}
function need(value:unknown,code:string):asserts value{if(!value)throw new SyncPushError(code);}
function pauseReason(error:unknown):QueuePause{
  const code=error&&typeof error==='object'&&'code' in error?error.code:null;
  if(['integration_unauthenticated','integration_forbidden','integration_context_changed'].includes(String(code)))return 'authorization';
  if(['plan_changed','review_conflict','unresolved_receipt','archive_conflict'].includes(String(code)))return 'conflict';
  if(['transfer_changed','receipt_mismatch','protocol_mismatch','package_corrupt','capture_changed','capture_corrupt'].includes(String(code)))return 'protocol';
  return 'network';
}

/** Captured-package sending only. A receipt remains local-pending until the coordinator
 * verifies entity mappings and records the captured local base; no vault files are touched here. */
export function createPushRunner({queue,client,assertContext}:{queue:SyncQueue;client:PushClient;assertContext:()=>void|Promise<void>}){
  return {async run():Promise<PushResult>{
    const initial=await queue.snapshot();need(sameIdentity(initial.identity,client.identity),'integration_context_changed');
    await assertContext();need(!initial.paused,'queue_paused');
    const next=initial.jobs.find(job=>!['acknowledged','local-pending','conflict'].includes(job.state));if(!next)return {state:'idle'};
    const token=await queue.resume();let job=next;
    async function live(){await assertContext();const current=await queue.snapshot();need(sameIdentity(current.identity,client.identity),'integration_context_changed');await queue.renew(token);}
    async function request<T>(action:()=>Promise<T>):Promise<T>{await live();const value=await action();await live();return value;}
    const ref=():TransferRef=>{need(job.transferId,'transfer_changed');return {id:job.transferId,deviceId:deviceId(),clientTransferId:job.id,packageHash:job.packageHash};};
    function deviceId(){return queue.deviceId;}
    function transfer(value:TransferDTO){
      validateDTO('transfer',value);
      need(value.bindingId===initial.identity.bindingId&&value.deviceId===deviceId()&&value.clientTransferId===job.id&&value.packageHash===job.packageHash&&(job.transferId===null||value.id===job.transferId),'transfer_changed');
      return value;
    }
    function command():PrepareTransfer{
        return {baseVersions:job.overwrite?[job.overwrite]:job.notes.flatMap(note=>note.baseVersion?[note.baseVersion]:[]),choices:job.notes.map(note=>({path:note.path.slice(initial.root.length+1),action:note.entityId===null?'create' as const:'replace' as const,...(note.entityId!==null?{targetId:note.entityId,expectedRevision:job.overwrite?.revision??note.baseVersion!.revision}:{}),...(job.overwrite?{confirmConflict:true}:{})}))};
    }
    function checkedPlan(plan:ReviewPlanDTO){
      validateDTO('reviewPlan',plan);
      need(plan.bindingId===initial.identity.bindingId&&plan.planId===job.planId&&plan.planHash===job.planHash&&!plan.stale,'plan_changed');
      need(reviewCanApply(job,plan,initial.root),'review_conflict');
      return plan;
    }
    async function saved(value:TransferDTO):Promise<PushResult>{
      const result=transfer(value);
      need(result.state==='applied'&&result.planId===job.planId&&result.planHash===job.planHash&&result.operationId===job.operationId&&result.receipt?.operationId===job.operationId,'receipt_mismatch');
      job=await queue.transition(token,job.id,job.state,{state:'local-pending',receipt:result.receipt});
      return {state:'local-pending',jobId:job.id,receipt:result.receipt};
    }
    async function apply():Promise<PushResult>{
      need(job.planId&&job.planHash&&job.approved,'plan_changed');
      return saved(await request(()=>client.applyTransfer(ref(),{planId:job.planId!,planHash:job.planHash!,operationId:job.operationId,confirmed:true})));
    }
    try{
      // A different window may have completed the selected job between snapshot and lease.
      const refreshed=(await queue.snapshot()).jobs.find(job=>!['acknowledged','local-pending','conflict'].includes(job.state));
      if(!refreshed)return {state:'idle'};job=refreshed;
      if(job.overwrite){const facts=JSON.parse(Buffer.from(await queue.captureBytes(job.id)).toString('utf8'));need(stableHash(facts.overwrite??null)===stableHash(job.overwrite),'capture_changed');}
      for(let step=0;step<4;step++){
        if(job.state==='queued'){
          const reserved=transfer(await request(()=>client.reserveTransfer({deviceId:deviceId(),clientTransferId:job.id,packageHash:job.packageHash})));
          job=await queue.transition(token,job.id,'queued',{state:'staged',transferId:reserved.id});continue;
        }
        if(job.state==='staged'){
          let status=transfer(await request(()=>client.transferStatus(ref())));
          if(['reserved','receiving'].includes(status.state)){
            const bytes=await queue.packageBytes(job.id);status=transfer(await request(()=>client.uploadTransfer(ref(),bytes)));
          }
          need(['ready','review'].includes(status.state),'unresolved_receipt');
          const plan=await request(()=>client.prepareTransfer(ref(),command()));validateDTO('reviewPlan',plan);need(plan.bindingId===initial.identity.bindingId,'plan_changed');
          job=await queue.saveReview(token,job.id,plan);return {state:'review',jobId:job.id,plan};
        }
        if(job.state==='review'){
          const plan=await request(()=>client.reviewTransfer(ref()));
          if(!job.approved)return {state:'review',jobId:job.id,plan};
          checkedPlan(plan);job=await queue.transition(token,job.id,'review',{state:'applying'});return await apply();
        }
        if(job.state==='applying'||job.state==='awaiting-receipt'){
          const status=transfer(await request(()=>client.transferStatus(ref())));
          if(status.state==='applied')return await saved(status);
          // No new transfer, ID or review is substituted for an uncertain operation.
          // Replaying the exact confirmed command is safe only while that same plan still exists.
          need(status.state==='review'&&status.planId===job.planId&&status.planHash===job.planHash&&status.receipt===null,'unresolved_receipt');
          checkedPlan(await request(()=>client.reviewTransfer(ref())));return await apply();
        }
      }
      throw new SyncPushError('queue_state');
    }catch(error){
      // Persist uncertainty before pausing; storage/lease failures leave the previous durable
      // applying record intact so another worker must recover its receipt, not create a new job.
      try{if(job.state==='applying')job=await queue.transition(token,job.id,'applying',{state:'awaiting-receipt'});}catch{/* recover from the last durable state */}
      try{await queue.pause(pauseReason(error));}catch{/* keep the original failure visible */}
      throw error;
    }finally{try{await queue.release(token);}catch{/* paused, expired or superseded leases must never release a newer owner */}}
  }};
}
