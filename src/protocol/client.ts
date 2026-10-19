import type {TransportOptions} from '../connection/transport.js';
import {validateDTO} from './validate.js';
import {createTransferClient} from './transfers.js';
import type {AssetDescriptor} from '../sync/pull.js';
import {hashBytes} from '../documents/hashes.js';
import type {ConnectionDTO,SyncIdentity} from './types.js';
import type {HistoryPage,HistoryDetail} from '../history/types.js';

type Transport={bytes?:(path:string,options?:TransportOptions)=>Promise<Uint8Array>;json:(path:string,options?:TransportOptions)=>Promise<unknown>;uploadZip?:(path:string,bytes:Uint8Array,options?:Omit<TransportOptions,'method'|'body'>)=>Promise<unknown>};
export async function verifyConnection(transport:Transport,options:Pick<TransportOptions,'signal'|'timeoutMs'>={}):Promise<ConnectionDTO>{return validateDTO('connection',await transport.json('connection',options)) as ConnectionDTO;}
export function createProtocolClient(transport:Transport,identity:SyncIdentity){
  validateDTO('syncIdentity',identity);const captured=Object.freeze({...identity});
  async function request(path:string,options:TransportOptions={}){
    const connection=await verifyConnection(transport,{signal:options.signal,timeoutMs:options.timeoutMs});
    if(connection.account.id!==captured.accountId||connection.instanceId!==captured.instanceId)throw new Error('Аккаунт или сайт изменился. Подключитесь заново');
    return transport.json(path,{...options,expectedAccountId:captured.accountId,expectedInstanceId:captured.instanceId});
  }
  const root=`campaigns/${encodeURIComponent(captured.campaignId)}/bindings/${encodeURIComponent(captured.bindingId)}`;
  return {
    identity:captured,
    ...createTransferClient({identity:captured,request,upload:async(path,bytes,options={})=>{
      if(!transport.uploadZip)throw new Error('Загрузка ZIP недоступна');
      const connection=await verifyConnection(transport,{signal:options.signal,timeoutMs:options.timeoutMs});
      if(connection.account.id!==captured.accountId||connection.instanceId!==captured.instanceId)throw new Error('Аккаунт или сайт изменился. Подключитесь заново');
      return transport.uploadZip(path,bytes,{...options,expectedAccountId:captured.accountId,expectedInstanceId:captured.instanceId});
    }}),
    async asset(input:AssetDescriptor,options:Pick<TransportOptions,'signal'|'timeoutMs'>={}){
      const descriptor=structuredClone(input);validateDTO('asset',descriptor);if(!transport.bytes)throw new Error('Загрузка изображений недоступна');
      const connection=await verifyConnection(transport,options);if(connection.account.id!==captured.accountId||connection.instanceId!==captured.instanceId)throw new Error('Аккаунт или сайт изменился. Подключитесь заново');
      const bytes=Uint8Array.from(await transport.bytes(root+'/assets/'+descriptor.id,{...options,expectedAccountId:captured.accountId,expectedInstanceId:captured.instanceId,maxBytes:descriptor.byteSize}));
      if(bytes.byteLength!==descriptor.byteSize||hashBytes(bytes)!==descriptor.sha256)throw new Error('Изображение повреждено при загрузке');return bytes;
    },
    async campaigns(){return validateDTO('campaigns',await request('campaigns'));},
    async bindings(){return validateDTO('bindings',await request(`campaigns/${encodeURIComponent(captured.campaignId)}/bindings`));},
    async index(cursor?:string){return validateDTO('indexPage',await request(root+'/archive',{query:{cursor}}));},
    async document(noteId:string,revision:number,options:Pick<TransportOptions,'signal'|'timeoutMs'>={}){if(!/^[A-Za-z0-9_-]{1,200}$/.test(noteId)||!Number.isSafeInteger(revision)||revision<1)throw new Error('Неверная запись или версия');return validateDTO('document',await request(root+'/documents/'+noteId,{...options,query:{revision}}));},
    async history(noteId:string,cursor?:string){
      if(!/^[A-Za-z0-9_-]{1,200}$/.test(noteId)||cursor!==undefined&&!/^[A-Za-z0-9_-]{1,2048}$/.test(cursor))throw Error('Неверная запись истории');
      const page=validateDTO('historyPage',await request(root+'/history',{query:{entityType:'note',entityId:noteId,cursor,limit:50}})) as HistoryPage;
      if(page.rows.some((row,index)=>row.entityType!=='note'||row.entityId!==noteId||index>0&&page.rows[index-1].id<=row.id))throw Error('История относится к другой записи');return page;
    },
    async historyChange(noteId:string,changeId:number){
      if(!/^[A-Za-z0-9_-]{1,200}$/.test(noteId)||!Number.isSafeInteger(changeId)||changeId<1)throw Error('Неверная версия истории');
      const detail=validateDTO('historyDetail',await request(root+'/history/'+changeId)) as HistoryDetail;
      if(detail.change.entityType!=='note'||detail.change.entityId!==noteId||!detail.document||detail.document.id!==noteId||detail.document.revision!==detail.change.revision||hashBytes(detail.document.markdown)!==detail.document.projectionHash)throw Error('История относится к другой записи');return detail;
    },
    async changes(cursor?:string){return validateDTO('changePage',await request(root+'/changes',{query:{cursor}}));},
  };
}
