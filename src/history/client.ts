import type {SyncIdentity} from '../protocol/types.js';
import type {HistoryPage,HistoryDetail} from './types.js';
import {sameIdentity} from '../bindings/registry.js';
import {normalizeVaultPath} from '../bindings/paths.js';
import {stableHash,hashBytes} from '../documents/hashes.js';
import {validateDTO} from '../protocol/validate.js';
import {TransportError} from '../connection/transport.js';
type Client={identity:SyncIdentity;history:(noteId:string,cursor?:string)=>Promise<HistoryPage>;historyChange:(noteId:string,changeId:number)=>Promise<HistoryDetail>};
export type HistoryResult<T>={value:T;origin:'server'|'cache';fetchedAt:string};
const transient=(error:unknown)=>error instanceof TransportError&&(['network_error','timeout'].includes(error.code)||error.code==='server_error'&&(error.status??0)>=500);

/** Bounded panel-lifetime cache. Reopening a panel offline does not fabricate history. */
export function createHistoryReader(options:{identity:SyncIdentity;root:string;open:(signal:AbortSignal)=>Promise<Client>;clock?:()=>number}){
  const identity=structuredClone(options.identity),root=normalizeVaultPath(options.root),cache=new Map<string,{result:HistoryResult<unknown>;bytes:number}>();let closed=false,cacheBytes=0;
  function clear(){cache.clear();cacheBytes=0;}
  async function live(signal:AbortSignal){if(closed||signal.aborted)throw Error('history_cancelled');const client=await options.open(signal);if(closed||signal.aborted||!sameIdentity(identity,client.identity))throw Error('history_context_changed');return client;}
  async function read<T>(kind:'page'|'detail',noteId:string,selector:string|number|undefined,signal:AbortSignal):Promise<HistoryResult<T>>{
    if(!/^[A-Za-z0-9_-]{1,200}$/.test(noteId)||kind==='page'&&selector!==undefined&&(typeof selector!=='string'||!/^[A-Za-z0-9_-]{1,2048}$/.test(selector))||kind==='detail'&&(!Number.isSafeInteger(selector)||Number(selector)<1))throw Error('history_selection');
    const key=stableHash([identity,root,kind,noteId,selector??null]);
    try{
      const client=await live(signal),value=kind==='page'?await client.history(noteId,selector as string|undefined):await client.historyChange(noteId,selector as number);await live(signal);
      validateDTO(kind==='page'?'historyPage':'historyDetail',value);
      if(kind==='page'){
        const page=value as HistoryPage;if(page.rows.some((row,index)=>row.entityType!=='note'||row.entityId!==noteId||index>0&&page.rows[index-1].id<=row.id))throw Error('history_context_changed');
      }else{
        const detail=value as HistoryDetail;if(detail.change.id!==selector||detail.change.entityType!=='note'||detail.change.entityId!==noteId||!detail.document||detail.document.id!==noteId||detail.document.revision!==detail.change.revision||hashBytes(detail.document.markdown)!==detail.document.projectionHash)throw Error('history_context_changed');
      }
      const result={value:structuredClone(value),origin:'server' as const,fetchedAt:new Date((options.clock??Date.now)()).toISOString()},bytes=Buffer.byteLength(JSON.stringify(result));
      const old=cache.get(key);if(old){cacheBytes-=old.bytes;cache.delete(key);}
      if(bytes<=16777216){while(cache.size>=20||cacheBytes+bytes>16777216){const first=cache.keys().next().value;if(first===undefined)break;cacheBytes-=cache.get(first)!.bytes;cache.delete(first);}cache.set(key,{result,bytes});cacheBytes+=bytes;}
      return structuredClone(result) as HistoryResult<T>;
    }catch(error){
      if(closed||signal.aborted)throw error;
      if(!transient(error)){clear();throw error;}
      await live(signal);const saved=cache.get(key);if(!saved)throw Error('history_unavailable');return {...structuredClone(saved.result),origin:'cache'} as HistoryResult<T>;
    }
  }
  return {invalidate:clear,page:(noteId:string,cursor:string|undefined,signal:AbortSignal)=>read<HistoryPage>('page',noteId,cursor,signal),detail:(noteId:string,changeId:number,signal:AbortSignal)=>read<HistoryDetail>('detail',noteId,changeId,signal),dispose(){closed=true;clear();}};
}
