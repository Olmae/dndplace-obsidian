import {createHash} from 'node:crypto';

export function hashBytes(value:string|Uint8Array):string{return createHash('sha256').update(value).digest('hex');}
export function stableHash(value:unknown):string{
  const sorted=(item:any):any=>Array.isArray(item)?item.map(sorted):item&&typeof item==='object'?Object.fromEntries(Object.keys(item).sort().map(key=>[key,sorted(item[key])])):item;
  return hashBytes(JSON.stringify(sorted(value)));
}
export function validHash(value:unknown):value is string{return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);}
export function presentationHash({title,metadata,board}:{title:string;metadata?:{icon?:string;favorite?:boolean};board?:unknown}):string{
  return stableHash({title,metadata:{icon:metadata?.icon??'',favorite:metadata?.favorite??false},board:board??null});
}
