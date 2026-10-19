import {createDesktopTransport} from './transport.js';
import type {TransportOptions} from './transport.js';
import type {SecretStore} from './secrets.js';
import {newConnection,readSettings} from './settings.js';
import type {Settings} from './settings.js';
import {verifyConnection} from '../protocol/client.js';

type Input={name:string;baseUrl:string;secret:string;signal?:AbortSignal};
type Dependencies={settings:Settings;store:SecretStore;saveSettings:(settings:Settings)=>Promise<void>;transportFactory?:(options:{baseUrl:string;getSecret:()=>Promise<string|undefined>})=>{json:(path:string,options?:TransportOptions)=>Promise<unknown>}};
export async function connectAndStore(input:Input,{settings,store,saveSettings,transportFactory=createDesktopTransport}:Dependencies){
  const record=newConnection(input),transport=transportFactory({baseUrl:record.baseUrl,getSecret:async()=>input.secret});
  const checked=await verifyConnection({json:(path,options)=>transport.json(path,{...options,signal:input.signal})});
  if(input.signal?.aborted)throw new Error('Подключение отменено');
  record.verified={accountId:checked.account.id,instanceId:checked.instanceId,accountName:checked.account.name};
  const next=readSettings({...settings,connections:[...settings.connections,record]});
  try{
    store.set(record.secretName,input.secret);
    if(store.get(record.secretName)!==input.secret)throw new Error('Не удалось сохранить ключ');
    await saveSettings(next);
  }catch(error){store.clear(record.secretName);throw error;}
  return {connection:record,settings:next,readiness:checked.readiness};
}
