import type {TransportOptions} from '../connection/transport.js';
import type {SyncIdentity} from './types.js';
import {validateDTO} from './validate.js';
import {hashBytes} from '../documents/hashes.js';

export type ReserveTransfer={deviceId:string;clientTransferId:string;packageHash:string};
export type TransferRef=ReserveTransfer&{id:string};
export type TransferDTO=TransferRef&{bindingId:string;state:'reserved'|'receiving'|'ready'|'planning'|'review'|'applying'|'applied'|'canceled'|'expired'|'failed';expiresAt:string;planId:string|null;planHash:string|null;operationId:string|null;receipt:{operationId:string;archiveRevision:number}|null};
export type PrepareTransfer={baseVersions:Array<{entityId:string;revision:number;sourceHash:string}>;choices:Array<{path:string;action:'skip'|'create'|'copy'|'replace';targetId?:string;expectedRevision?:number;confirmConflict?:boolean}>};
export type ApplyTransfer={planId:string;planHash:string;operationId:string;confirmed:true};
type Diagnostic={code:string;message:string;severity:'info'|'warning'|'error'};
type Preview={title:string;content:string}|null;
export type ReviewPlanDTO={planId:string;planHash:string;bindingId:string;archiveRevision:number;expiresAt:string;stale:boolean;rows:Array<{path:string;title:string;status:'new'|'changed'|'unchanged'|'conflict'|'error'|'unsupported';action:'skip'|'create'|'copy'|'replace';entityId:string|null;expectedRevision:number|null;before:Preview;after:Preview;diagnostics:Diagnostic[]}>;totals:{created:number;updated:number;skipped:number;folders:number};diagnostics:Diagnostic[]};
type Request=(path:string,options?:TransportOptions)=>Promise<unknown>;
type Upload=(path:string,bytes:Uint8Array,options?:Omit<TransportOptions,'method'|'body'>)=>Promise<unknown>;
type Controls=Pick<TransportOptions,'signal'|'timeoutMs'>;
const invalid=():never=>{throw new Error('Перенос или сравнение изменилось. Проверьте синхронизацию');};
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value);

/** Every callback must enforce the captured account/instance, including binary uploads. */
export function createTransferClient({identity,request,upload}:{identity:SyncIdentity;request:Request;upload:Upload}){
  validateDTO('syncIdentity',identity);const captured=Object.freeze({...identity});
  const root=`campaigns/${encodeURIComponent(captured.campaignId)}/bindings/${encodeURIComponent(captured.bindingId)}/transfers`;
  function reference(input:TransferRef):TransferRef{
    const ref=structuredClone(input);if(!validId(ref.id))return invalid();
    validateDTO('reserveRequest',{deviceId:ref.deviceId,clientTransferId:ref.clientTransferId,packageHash:ref.packageHash});
    return {id:ref.id,deviceId:ref.deviceId,clientTransferId:ref.clientTransferId,packageHash:ref.packageHash};
  }
  function transfer(value:unknown,expected:ReserveTransfer&{id?:string}):TransferDTO{
    const dto=validateDTO('transfer',value) as TransferDTO;
    if(dto.bindingId!==captured.bindingId||dto.deviceId!==expected.deviceId||dto.clientTransferId!==expected.clientTransferId||dto.packageHash!==expected.packageHash||expected.id!==undefined&&dto.id!==expected.id)return invalid();
    if((dto.receipt!==null)!==(dto.state==='applied')||(dto.operationId!==null)!==(dto.receipt!==null))return invalid();
    if(['review','applying','applied'].includes(dto.state)&&dto.planId===null)return invalid();
    return structuredClone(dto);
  }
  async function status(ref:TransferRef,options:Controls={}){return transfer(await request(root+'/'+ref.id,options),ref);}
  function review(value:unknown):ReviewPlanDTO{
    const dto=validateDTO('reviewPlan',value) as ReviewPlanDTO;if(dto.bindingId!==captured.bindingId)return invalid();return structuredClone(dto);
  }
  function committed(dto:TransferDTO,input:ApplyTransfer){
    if(dto.planId!==input.planId||dto.planHash!==input.planHash||dto.state!=='applied'||dto.operationId!==input.operationId||dto.receipt?.operationId!==input.operationId)return invalid();
    return dto;
  }
  return {
    async reserveTransfer(input:ReserveTransfer,options:Controls={}){
      const body=structuredClone(input);validateDTO('reserveRequest',body);
      return transfer(await request(root,{...options,method:'POST',body}),body);
    },
    async transferStatus(input:TransferRef,options:Controls={}){return status(reference(input),options);},
    async uploadTransfer(input:TransferRef,data:Uint8Array,options:Controls={}){
      const ref=reference(input);if(!(data instanceof Uint8Array)||data.byteLength<1||data.byteLength>33554432)return invalid();
      const bytes=Uint8Array.from(data);if(hashBytes(bytes)!==ref.packageHash)return invalid();
      await status(ref,options);return transfer(await upload(root+'/'+ref.id+'/upload',bytes,options),ref);
    },
    async prepareTransfer(input:TransferRef,command:PrepareTransfer,options:Controls={}){
      const ref=reference(input),body=structuredClone(command);validateDTO('prepareRequest',body);await status(ref,options);
      const plan=review(await request(root+'/'+ref.id+'/plan',{...options,method:'POST',body})),saved=await status(ref,options);
      if(saved.planId!==plan.planId||saved.planHash!==plan.planHash||saved.state!=='review')return invalid();return plan;
    },
    async reviewTransfer(input:TransferRef,options:Controls={}){
      const ref=reference(input),saved=await status(ref,options),plan=review(await request(root+'/'+ref.id+'/plan',options));
      if(saved.planId!==plan.planId||saved.planHash!==plan.planHash)return invalid();return plan;
    },
    async applyTransfer(input:TransferRef,command:ApplyTransfer,options:Controls={}){
      const ref=reference(input),body=structuredClone(command);validateDTO('applyRequest',body);
      const before=await status(ref,options);
      if(before.state==='applied')return committed(before,body);
      if(before.state!=='review'||before.planId!==body.planId||before.planHash!==body.planHash||before.operationId!==null)return invalid();
      // Raw archive-operation JSON is not an acknowledgement. Only the separately persisted,
      // identity-bound transfer receipt can confirm this operation. Lost responses remain uncertain.
      await request(root+'/'+ref.id+'/apply',{...options,method:'POST',body});
      return committed(await status(ref,options),body);
    },
    async cancelTransfer(input:TransferRef,options:Controls={}){
      const ref=reference(input),before=await status(ref,options);if(before.state==='applied')return invalid();
      const result=transfer(await request(root+'/'+ref.id,{...options,method:'DELETE'}),ref);if(result.state!=='canceled')return invalid();return result;
    },
  };
}
