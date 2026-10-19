import type {Settings} from './settings.js';
import type {LocalBinding} from '../bindings/registry.js';
import {sameIdentity} from '../bindings/registry.js';
import {stableHash} from '../documents/hashes.js';

/** Local pause retains the root reservation and every durable recovery identity. */
export function changeBindingPause(settings:Settings,expected:LocalBinding,paused:boolean):Settings{
  const current=settings.bindings?.find(binding=>binding.id===expected.id);
  if(typeof paused!=='boolean'||!current||current.root!==expected.root||!sameIdentity(current.identity,expected.identity)||!!current.paused!==!!expected.paused||current.pauseVersion!==expected.pauseVersion||!Number.isSafeInteger((current.pauseVersion??0)+1)){
    throw new Error('Привязка изменилась. Откройте настройки заново.');
  }
  return {...settings,bindings:settings.bindings!.map(binding=>binding.id===expected.id?{...binding,paused,pauseVersion:(binding.pauseVersion??0)+1}:binding)};
}
export function changeBindingAutomatic(settings:Settings,expected:LocalBinding,deviceId:string,enabled:boolean):Settings{
  const current=settings.bindings?.find(binding=>binding.id===expected.id);
  if(!current||stableHash(current)!==stableHash(expected)||typeof enabled!=='boolean'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(deviceId))throw new Error('Привязка изменилась. Откройте настройки заново.');
  const next=changeBindingPause(settings,expected,!!expected.paused),binding=next.bindings!.find(row=>row.id===expected.id)!;
  if(enabled)binding.automatic={deviceId};else delete binding.automatic;return next;
}
