import {posix,win32} from 'node:path';
import {validateDTO} from '../protocol/validate.js';
import type {LocalBinding} from './registry.js';
import {validAutomatic} from './registry.js';

export type RootAdapter={vaultRealPath:string;configDir?:string;inspect:(relativePath:string)=>Promise<{exists:boolean;directory:boolean;symlink:boolean;realPath:string}>};
export class BindingError extends Error{constructor(public code:string,message:string){super(message);this.name='BindingError';}}
export function pathKey(path:string):string{return path.normalize('NFC').toLowerCase();}
export function normalizeVaultPath(value:string):string{
  if(typeof value!=='string'||!value||value.length>2048||/[\\:\x00-\x1f\x7f]/.test(value)||value.startsWith('/'))throw new BindingError('unsafe_path','Выберите обычную папку внутри хранилища');
  const path=value.normalize('NFC'),parts=path.split('/');
  if(parts.length>21||parts.some(part=>!part||part.startsWith('.')||part.trim()!==part||/[. ]$/.test(part)||/[<>"|?*]/.test(part)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))throw new BindingError('unsafe_path','Путь содержит скрытый или непереносимый раздел');
  return path;
}
export function insideRoot(path:string,root:string):boolean{
  const parts=normalizeVaultPath(path).split('/'),parent=normalizeVaultPath(root).split('/');return parts.length>parent.length&&parent.every((part,i)=>pathKey(part)===pathKey(parts[i]));
}
function safeRealPath(candidate:string,vault:string):boolean{
  if(typeof candidate!=='string'||typeof vault!=='string'||/[\x00-\x1f]/.test(candidate+vault))return false;
  const api=/^[a-z]:[\\/]|^\\\\/i.test(vault)?win32:posix;
  if(!api.isAbsolute(candidate)||!api.isAbsolute(vault))return false;
  const relative=api.relative(vault,candidate);return !!relative&&!api.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+api.sep);
}
export async function validateRoots(roots:LocalBinding[],adapter:RootAdapter):Promise<LocalBinding[]>{
  if(!Array.isArray(roots)||roots.length>200||!adapter?.inspect)throw new BindingError('invalid_roots','Не удалось проверить папки кампаний');
  const ids=new Set<string>(),normalized:LocalBinding[]=[];
  for(const root of roots){
    if(!root||Object.keys(root).some(key=>!['id','root','identity','paused','pauseVersion','automatic'].includes(key))||(root.paused!==undefined&&typeof root.paused!=='boolean')||(root.pauseVersion!==undefined&&(!Number.isSafeInteger(root.pauseVersion)||root.pauseVersion<1))||!validAutomatic(root.automatic)||typeof root.id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(root.id)||ids.has(root.id))throw new BindingError('invalid_roots','Повторяется привязка кампании');
    ids.add(root.id);validateDTO('syncIdentity',root.identity);const path=normalizeVaultPath(root.root);
    if(adapter.configDir&&(pathKey(path)===pathKey(adapter.configDir)||pathKey(path).startsWith(pathKey(adapter.configDir)+'/')))throw new BindingError('config_root','Папка настроек не участвует в обмене');
    for(const existing of normalized)if(pathKey(path)===pathKey(existing.root)||insideRoot(path,existing.root)||insideRoot(existing.root,path))throw new BindingError('overlapping_roots','Папки кампаний не должны пересекаться');
    const parts=path.split('/');
    for(let i=1;i<=parts.length;i++){
      const entry=await adapter.inspect(parts.slice(0,i).join('/'));
      if(!entry?.exists||!entry.directory||entry.symlink||!safeRealPath(entry.realPath,adapter.vaultRealPath))throw new BindingError('unsafe_root','Папка недоступна или ведёт за пределы хранилища');
      const api=/^[a-z]:[\\/]|^\\\\/i.test(adapter.vaultRealPath)?win32:posix;
      if(pathKey(api.relative(adapter.vaultRealPath,entry.realPath).split(api.sep).join('/'))!==pathKey(parts.slice(0,i).join('/')))throw new BindingError('aliased_root','Физический путь папки отличается от выбранного');
    }
    normalized.push({...structuredClone(root),root:path});
  }
  return normalized;
}
