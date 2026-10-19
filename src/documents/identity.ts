import type {SyncIdentity} from '../protocol/types.js';
import type {LocalBinding} from '../bindings/registry.js';
import {sameIdentity} from '../bindings/registry.js';
import {insideRoot,normalizeVaultPath,pathKey} from '../bindings/paths.js';
import {readFrontmatter,stripIdentity,DocumentError} from './frontmatter.js';
import type {PortableIdentity} from './frontmatter.js';
import {scanReferences,resolveNoteLink} from './links.js';
import type {Diagnostic} from './links.js';
import {hashBytes,stableHash,presentationHash} from './hashes.js';
import {collectLocalAssets,boardImageReferences} from './assets.js';
import type {LocalAsset} from './assets.js';

export type MappedDocument={path:string;entityId:string;identity:SyncIdentity;serverTitle:string;titleInputHash:string;metadata?:{icon?:string;favorite?:boolean};board?:unknown;aliases?:string[]};
export type DocumentIndex={entries:readonly MappedDocument[];assets:readonly LocalAsset[];existingPaths?:readonly string[]};
function samePortable(value:PortableIdentity,identity:SyncIdentity){return ['instanceId','accountId','campaignId','bindingId'].every(key=>value[key as keyof PortableIdentity]===identity[key as keyof SyncIdentity]);}
export function prepareLocalDocument(file:{path:string;source:string},binding:LocalBinding,index:DocumentIndex){
  const path=normalizeVaultPath(file.path);if(!insideRoot(path,binding.root)||!/\.md$/i.test(path))throw new DocumentError('outside_note','Выберите Markdown-запись внутри папки кампании');
  const diagnostics:Diagnostic[]=[],localFileHash=hashBytes(file.source),identity=structuredClone(binding.identity);
  let parsed:ReturnType<typeof readFrontmatter>,source=file.source;
  try{parsed=readFrontmatter(file.source);source=stripIdentity(file.source);}catch(error){
    if(!(error instanceof DocumentError))throw error;
    diagnostics.push({code:error.code,severity:'error',message:error.message});
    return {identity,path,entityId:null,identityStatus:'review' as const,localFileHash,portableHash:hashBytes(source),metadataHash:stableHash({}),assetHash:stableHash([]),title:path.split('/').at(-1)!.replace(/\.md$/i,''),titleInputHash:stableHash({}),source,metadata:{},board:undefined,assets:[],assetTargets:[],links:[],diagnostics};
  }
  if(Buffer.byteLength(source)>1048576)throw new DocumentError('note_size','Текст записи превышает 1 МБ');
  const scoped=index.entries.filter(entry=>sameIdentity(entry.identity,identity));
  const exact=scoped.filter(entry=>pathKey(entry.path)===pathKey(path));
  let matches=parsed.identity?scoped.filter(entry=>entry.entityId===parsed.identity!.entityId):exact;
  let status:'new'|'bound'|'review'=matches.length===1?'bound':'new',entry=matches.length===1?matches[0]:undefined;
  const review=(code:string,message:string)=>{status='review';diagnostics.push({code,severity:'error',message});};
  if(parsed.identity&&!samePortable(parsed.identity,identity)){entry=undefined;review('foreign_identity','Запись перенесена из другой кампании или подключения');}
  else if(parsed.identity&&matches.length!==1)review(matches.length?'duplicate_identity':'unmapped_identity','Служебная отметка не совпадает с локальной привязкой');
  else if(!parsed.identity&&exact.length>1)review('duplicate_path','Путь связан сразу с несколькими записями');
  if(entry){
    if(!insideRoot(entry.path,binding.root))review('cross_root_move','Запись была перемещена между папками кампаний');
    if(exact.some(row=>row.entityId!==entry!.entityId))review('path_collision','Путь уже занят другой связанной записью');
    if(path!==entry.path){
      if(pathKey(path)===pathKey(entry.path))review('case_rename','Изменение регистра пути требует подтверждения');
      else if(!index.existingPaths||index.existingPaths.some(value=>pathKey(value)===pathKey(entry!.path)))review('copy_or_move','Нужно выбрать: переместить привязку или создать копию');
    }
  }
  const references=scanReferences(source);diagnostics.push(...references.diagnostics);
  const fallback=path.split('/').at(-1)!.replace(/\.md$/i,''),authorTitle=parsed.title??references.h1??fallback,kind=parsed.title?'yaml':references.h1?'h1':'file';
  const titleInputHash=stableHash({kind,value:authorTitle}),title=entry&&titleInputHash===entry.titleInputHash?entry.serverTitle:authorTitle;
  if(!title||title.length>500)review('invalid_title','Название должно содержать от 1 до 500 символов');
  const metadata=structuredClone(entry?.metadata??{}),board=structuredClone(entry?.board);
  const assets=collectLocalAssets([...references.assets,...boardImageReferences(board)],path,binding,index.assets);diagnostics.push(...assets.diagnostics);
  const links=references.links.map(reference=>({...reference,...resolveNoteLink(reference.target,path,binding,scoped,reference.kind)}));
  for(const link of links)if(['ambiguous','missing','outside'].includes(link.status))diagnostics.push({code:'link_'+link.status,severity:'warning',message:'Ссылка сохранена без привязки: '+link.target});
  return {identity,path,entityId:entry?.entityId??null,identityStatus:status,localFileHash,portableHash:hashBytes(source),metadataHash:presentationHash({title,metadata,board}),assetHash:assets.assetHash,title,titleInputHash,source,metadata,board,assets:assets.assets,assetTargets:assets.targets,links,diagnostics};
}
