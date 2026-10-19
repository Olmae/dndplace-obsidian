import {randomUUID} from 'node:crypto';
import {validateBaseUrl} from './transport.js';
import type {LocalBinding} from '../bindings/registry.js';
import {sameIdentity,validAutomatic} from '../bindings/registry.js';
import {normalizeVaultPath,insideRoot,pathKey} from '../bindings/paths.js';
import {validateDTO} from '../protocol/validate.js';

export type Connection={id:string;name:string;baseUrl:string;secretName:string;enabled:false;verified?:{accountId:string;instanceId:string;accountName:string}};
export type Settings={version:1;connections:Connection[];bindings?:LocalBinding[]};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value);
function check(ok:unknown):asserts ok{if(!ok)throw new Error('Повреждены настройки подключения');}
export function newConnection({name,baseUrl}:{name:string;baseUrl:string}):Connection{
  check(typeof name==='string'&&name.trim().length>0&&name.length<=80);const connectionId=randomUUID();
  return {id:connectionId,name:name.trim(),baseUrl:validateBaseUrl(baseUrl),secretName:'dndplace-key-'+connectionId,enabled:false};
}
export function readSettings(value:unknown):Settings{
  if(value===null||value===undefined)return {version:1,connections:[]};
  check(object(value)&&value.version===1&&Array.isArray(value.connections)&&value.connections.length<=50&&Object.keys(value).every(key=>['version','connections','bindings'].includes(key)));
  const seen=new Set<string>();
  for(const row of value.connections){
    check(object(row)&&Object.keys(row).every(key=>['id','name','baseUrl','secretName','enabled','verified'].includes(key))&&id(row.id)&&!seen.has(row.id)&&typeof row.name==='string'&&row.name.trim().length>0&&row.name.length<=80&&typeof row.baseUrl==='string'&&row.secretName==='dndplace-key-'+row.id&&row.enabled===false);
    check(validateBaseUrl(row.baseUrl)===row.baseUrl);seen.add(row.id);
    if(row.verified!==undefined)check(object(row.verified)&&Object.keys(row.verified).every(key=>['accountId','instanceId','accountName'].includes(key))&&id(row.verified.accountId)&&id(row.verified.instanceId)&&typeof row.verified.accountName==='string'&&row.verified.accountName.length<=200);
  }
  if(value.bindings!==undefined){
    check(Array.isArray(value.bindings)&&value.bindings.length<=200);const roots:LocalBinding[]=[],ids=new Set<string>();
    for(const row of value.bindings){
      check(object(row)&&Object.keys(row).every(key=>['id','root','identity','paused','pauseVersion','automatic'].includes(key))&&validAutomatic(row.automatic)&&id(row.id)&&!ids.has(row.id)&&(row.paused===undefined||typeof row.paused==='boolean')&&(row.pauseVersion===undefined||(Number.isSafeInteger(row.pauseVersion)&&Number(row.pauseVersion)>0)));validateDTO('syncIdentity',row.identity);
      const binding=row as LocalBinding,connection=(value.connections as Connection[]).find(connection=>connection.id===binding.identity.connectionId);
      check(connection?.verified&&connection.verified.accountId===binding.identity.accountId&&connection.verified.instanceId===binding.identity.instanceId&&normalizeVaultPath(binding.root)===binding.root);
      check(!roots.some(other=>sameIdentity(other.identity,binding.identity)||pathKey(other.root)===pathKey(binding.root)||insideRoot(binding.root,other.root)||insideRoot(other.root,binding.root)));ids.add(binding.id);roots.push(binding);
    }
  }
  return structuredClone(value) as Settings;
}
