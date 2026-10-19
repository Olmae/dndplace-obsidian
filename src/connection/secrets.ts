import {randomUUID} from 'node:crypto';

type HostSecrets={getSecret:(name:string)=>string|null;setSecret:(name:string,value:string)=>void};
const deviceName='dndplace-device-id';
const validName=(name:string)=>name===deviceName||/^dndplace-key-[a-f0-9-]{36}$/.test(name);
export function createSecretStore(host:unknown){
  const api=host as HostSecrets|undefined;
  if(!api||typeof api.getSecret!=='function'||typeof api.setSecret!=='function')throw new Error('Нужен Obsidian с защищённым хранилищем ключей');
  const check=(name:string)=>{if(!validName(name))throw new Error('Недопустимое имя секрета');};
  return {
    get(name:string):string|undefined{check(name);return api.getSecret(name)||undefined;},
    set(name:string,value:string){check(name);api.setSecret(name,value);},
    clear(name:string){check(name);api.setSecret(name,'');},
  };
}
export type SecretStore=ReturnType<typeof createSecretStore>;
export function installationId(store:SecretStore):string{
  const existing=store.get(deviceName);
  if(existing){if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(existing))throw new Error('Повреждён идентификатор установки');return existing;}
  const created=randomUUID();store.set(deviceName,created);if(store.get(deviceName)!==created)throw new Error('Не удалось сохранить идентификатор установки');return created;
}
