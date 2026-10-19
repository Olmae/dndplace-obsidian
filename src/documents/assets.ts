import type {LocalBinding} from '../bindings/registry.js';
import {insideRoot,pathKey} from '../bindings/paths.js';
import {resolveLocalTarget} from './links.js';
import type {Reference,Diagnostic} from './links.js';
import {hashBytes,stableHash} from './hashes.js';

export type LocalAsset={path:string;data:Uint8Array;symlink?:boolean};
export type PreparedAsset={path:string;sha256:string;byteSize:number;mime:'image/png'|'image/jpeg'|'image/webp';relativePath:string;data:Uint8Array};
function sniff(data:Uint8Array):PreparedAsset['mime']|null{
  const bytes=Buffer.from(data);
  if(bytes.length>=45&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){
    let offset=8,first=true,ended=false;
    while(offset+12<=bytes.length){
      const size=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8);if(offset+12+size>bytes.length||type==='acTL')return null;
      if(first&&(type!=='IHDR'||size!==13||!bytes.readUInt32BE(offset+8)||!bytes.readUInt32BE(offset+12)||bytes.readUInt32BE(offset+8)>16384||bytes.readUInt32BE(offset+12)>16384))return null;
      first=false;offset+=12+size;if(type==='IEND'){ended=size===0&&offset===bytes.length;break;}
    }return ended?'image/png':null;
  }
  if(bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes.at(-2)===255&&bytes.at(-1)===217){
    let offset=2,dimensions=false;
    while(offset+4<=bytes.length){
      if(bytes[offset]!==255)return null;const marker=bytes[offset+1];if(marker===218)break;
      const size=bytes.readUInt16BE(offset+2);if(size<2||offset+2+size>bytes.length)return null;
      if([192,193,194].includes(marker)){if(size<8)return null;const height=bytes.readUInt16BE(offset+5),width=bytes.readUInt16BE(offset+7);if(!width||!height||width>16384||height>16384)return null;dimensions=true;}
      offset+=2+size;
    }return dimensions?'image/jpeg':null;
  }
  if(bytes.length>=20&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&bytes.readUInt32LE(4)+8===bytes.length){
    let offset=12;while(offset+8<=bytes.length){const type=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4);if(offset+8+size>bytes.length||type==='ANIM'||type==='ANMF'||type==='VP8X'&&(bytes[offset+8]&2))return null;offset+=8+size+(size%2);}return offset===bytes.length?'image/webp':null;
  }return null;
}
export function resolveAssetCandidates(reference:Reference,from:string,binding:LocalBinding,paths:readonly string[]):string[]{
  const target=resolveLocalTarget(reference.target,from,binding,{decode:reference.kind!=='wiki'});if(target.status!=='local')return [];
  const scoped=paths.filter(path=>{try{return insideRoot(path,binding.root);}catch{return false;}}),exact=(path:string)=>scoped.filter(value=>pathKey(value)===pathKey(path));
  let candidates=exact(target.path);
  if(!candidates.length&&reference.kind==='wiki'){
    const rooted=resolveLocalTarget(reference.target,binding.root+'/_root.md',binding,{decode:false});if(rooted.status==='local')candidates=exact(rooted.path);
    if(!candidates.length&&!reference.target.split('#')[0].includes('/'))candidates=scoped.filter(path=>pathKey(path.split('/').at(-1)!)===pathKey(reference.target.split('#')[0]));
  }
  return candidates;
}
export function boardImageReferences(value:unknown):Reference[]{
  if(value===null||value===undefined)return [];let board:any=value;
  if(typeof board==='string'){try{board=JSON.parse(board);}catch{throw Error('invalid_board');}}
  if(!board||typeof board!=='object'||Array.isArray(board)||!Array.isArray(board.nodes)||!Array.isArray(board.edges)||board.nodes.length>10000)throw Error('invalid_board');
  return board.nodes.filter((node:any)=>node?.kind==='image'&&typeof node.url==='string'&&node.url).map((node:any)=>({target:node.url,kind:'markdown' as const}));
}

export function collectLocalAssets(references:readonly Reference[],from:string,binding:LocalBinding,index:readonly LocalAsset[]){
  const assets:PreparedAsset[]=[],diagnostics:Diagnostic[]=[],targets:Array<[string,string]>=[],seen=new Map<string,PreparedAsset>();let total=0;
  for(const reference of references){
    const target=resolveLocalTarget(reference.target,from,binding,{decode:reference.kind!=='wiki'});
    const failure=(code:string,message:string,severity:Diagnostic['severity']='error')=>diagnostics.push({code,message,severity});
    if(target.status==='external'){failure('external_image','Внешняя ссылка сохранена без загрузки изображения','warning');continue;}
    if(target.status!=='local'){failure('outside_asset','Изображение находится вне папки кампании');continue;}
    const candidates=resolveAssetCandidates(reference,from,binding,index.map(row=>row.path)).flatMap(path=>index.filter(row=>row.path===path));
    if(candidates.length!==1){failure(candidates.length?'ambiguous_asset':'missing_asset','Не удалось однозначно найти изображение: '+reference.target);continue;}
    const file=candidates[0];
    if(file.symlink||!(file.data instanceof Uint8Array)||file.data.byteLength>10485760){failure('unsafe_asset','Изображение недоступно или превышает 10 МБ');continue;}
    const mime=sniff(file.data),extension=/\.png$/i.test(file.path)?'png':/\.jpe?g$/i.test(file.path)?'jpg':/\.webp$/i.test(file.path)?'webp':null;
    if(!mime||!extension||mime!==({'png':'image/png','jpg':'image/jpeg','webp':'image/webp'} as const)[extension]){failure('invalid_image','Нужен статичный PNG, JPEG или WebP');continue;}
    const sha256=hashBytes(file.data);let asset=seen.get(sha256);
    if(!asset){total+=file.data.byteLength;if(total>33554432){failure('asset_batch_size','Изображения превышают 32 МБ');continue;}asset={path:file.path,sha256,byteSize:file.data.byteLength,mime,relativePath:`_assets/dndplace/${sha256}.${extension}`,data:Buffer.from(file.data)};seen.set(sha256,asset);assets.push(asset);}
    targets.push([reference.target,asset.relativePath]);
  }
  return {assets,diagnostics,targets,assetHash:stableHash([...new Set(targets.map(pair=>JSON.stringify(pair)))].sort())};
}
