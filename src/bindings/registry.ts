import type {SyncIdentity} from '../protocol/types.js';
import {validateDTO} from '../protocol/validate.js';
import {normalizeVaultPath,insideRoot,BindingError} from './paths.js';

export type LocalBinding={id:string;root:string;identity:SyncIdentity;paused?:boolean;pauseVersion?:number;automatic?:{deviceId:string}};
export function validAutomatic(value:unknown):boolean{return value===undefined||!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&'deviceId'in value&&typeof value.deviceId==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.deviceId);}
export function identityKey(identity:SyncIdentity):string{
  validateDTO('syncIdentity',identity);return JSON.stringify([identity.connectionId,identity.instanceId,identity.accountId,identity.campaignId,identity.bindingId]);
}
export function sameIdentity(a:SyncIdentity,b:SyncIdentity):boolean{return identityKey(a)===identityKey(b);}
export function bindingForFile(path:string,bindings:readonly LocalBinding[]):LocalBinding|null{
  normalizeVaultPath(path);const matches=bindings.filter(binding=>insideRoot(path,binding.root));
  if(matches.length>1)throw new BindingError('overlapping_roots','Файл относится сразу к нескольким кампаниям');
  return matches[0]&&!matches[0].paused?structuredClone(matches[0]):null;
}
