import {randomUUID} from 'node:crypto';
import {posix} from 'node:path';
import type {SyncIdentity} from '../protocol/types.js';
import {validateDTO} from '../protocol/validate.js';
import {sameIdentity} from '../bindings/registry.js';
import {normalizeVaultPath,insideRoot,pathKey} from '../bindings/paths.js';
import {hashBytes,stableHash,presentationHash} from '../documents/hashes.js';
import {attachIdentity,stripIdentity,readFrontmatter} from '../documents/frontmatter.js';
import {scanReferences} from '../documents/links.js';
import type {StoredBase,JournalEntry} from './state.js';
import {validateStoredBase} from './state.js';

export type AssetDescriptor={id:string;mime:string;sha256:string;byteSize:number;relativePath:string};
export type DownloadDocument={protocolVersion:1;id:string;revision:number;title:string;markdown:string;sourceHash:string;projectionHash:string;metadata:{icon:string;favorite:boolean};assets:AssetDescriptor[];board:string|null;diagnostics:unknown[]};
export type DownloadBatch={identity:SyncIdentity;root:string;expectedCursor:string|null;cursor:string|null;notes:{path:string;document:DownloadDocument}[];assets:{descriptor:AssetDescriptor;data:Uint8Array}[]};
export type FileSnapshot={path:string;data:Uint8Array;editor?:{text:string;token:string}|null};
export type PlannedEntry=JournalEntry&{output:Uint8Array;preimage:Uint8Array|null;editorPreimage:Uint8Array|null;blockedReason:string|null};
export type VaultPlan={id:string;identity:SyncIdentity;root:string;mode:'automatic'|'manual'|'restore'|'copy';expectedCursor:string|null;cursor:string|null;entries:PlannedEntry[];blobs:Uint8Array[];hash:string};
export type PullOptions={mode?:'automatic'|'manual';manual?:{path:string;diskHash:string;editorHash:string;editorToken:string}[]};
export function planFingerprint(plan:Pick<VaultPlan,'id'|'identity'|'root'|'mode'|'expectedCursor'|'cursor'|'entries'|'blobs'>):string{
  return stableHash({id:plan.id,identity:plan.identity,root:plan.root,mode:plan.mode,expectedCursor:plan.expectedCursor,cursor:plan.cursor,entries:plan.entries.map(({output,preimage,editorPreimage,...entry})=>entry),blobs:plan.blobs.map(hashBytes)});
}
export function planVaultWrites(batch:DownloadBatch,current:readonly FileSnapshot[],bases:readonly StoredBase[],options:PullOptions={}):VaultPlan{
  validateDTO('syncIdentity',batch.identity);const root=normalizeVaultPath(batch.root),mode=options.mode??'automatic';
  if(!['automatic','manual'].includes(mode)||batch.notes.length>32||batch.assets.length>2000||[batch.expectedCursor,batch.cursor].some(value=>value!==null&&(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,2048}$/.test(value))))throw new Error('Некорректный пакет обновления');
  const snapshots=new Map<string,FileSnapshot>(),seenNotes=new Set<string>(),seenIds=new Set<string>(),entries:PlannedEntry[]=[],blobs:Uint8Array[]=[];
  for(const file of current){if(!insideRoot(file.path,root)||snapshots.has(pathKey(file.path)))throw new Error('Неоднозначный снимок файлов');snapshots.set(pathKey(file.path),file);}
  for(const base of bases)validateStoredBase(base,batch.identity,root);
  const downloads=new Map<string,{descriptor:AssetDescriptor;data:Uint8Array}>();let downloadedBytes=0;
  for(const file of batch.assets){
    validateDTO('asset',file.descriptor);if(!(file.data instanceof Uint8Array)||file.data.byteLength!==file.descriptor.byteSize||hashBytes(file.data)!==file.descriptor.sha256)throw new Error('Изображение повреждено при загрузке');
    const existing=downloads.get(file.descriptor.sha256);if(existing&&stableHash(existing.descriptor)!==stableHash(file.descriptor))throw new Error('Неоднозначное изображение');
    if(!existing)downloadedBytes+=file.data.byteLength;downloads.set(file.descriptor.sha256,file);
  }
  if(downloadedBytes>33554432)throw new Error('Пакет превышает 32 МБ');
  function entry(kind:'note'|'asset',path:string,output:Uint8Array,nextBase:StoredBase|null,reason:string|null=null):PlannedEntry{
    const snapshot=snapshots.get(pathKey(path)),expectedHash=snapshot?hashBytes(snapshot.data):null;
    return {id:randomUUID(),kind,path,expectedHash,preimageHash:expectedHash,outputHash:hashBytes(output),byteSize:output.byteLength,status:'prepared',reason:null,entityId:nextBase?.entityId??null,nextBase,dependencies:[],editorHash:snapshot?.editor?hashBytes(snapshot.editor.text):null,editorToken:snapshot?.editor?.token??null,manualApproved:false,output:Buffer.from(output),preimage:snapshot?Buffer.from(snapshot.data):null,editorPreimage:snapshot?.editor?Buffer.from(snapshot.editor.text):null,blockedReason:reason};
  }
  for(const note of batch.notes){
    validateDTO('document',note.document);const remote=note.document,path=normalizeVaultPath(note.path);
    if(!insideRoot(path,root)||!/\.md$/i.test(path)||seenNotes.has(pathKey(path))||seenIds.has(remote.id)||hashBytes(remote.markdown)!==remote.projectionHash)throw new Error('Некорректная запись в пакете');seenNotes.add(pathKey(path));seenIds.add(remote.id);
    let output=remote.markdown,reason:string|null=null;
    try{output=attachIdentity(remote.markdown,{version:1,instanceId:batch.identity.instanceId,accountId:batch.identity.accountId,campaignId:batch.identity.campaignId,bindingId:batch.identity.bindingId,entityId:remote.id});}catch{reason='identity-review';}
    let portable=remote.markdown,titleInputHash=stableHash({});
    try{portable=stripIdentity(output);const yaml=readFrontmatter(portable),h1=scanReferences(portable).h1;titleInputHash=stableHash({kind:yaml.title?'yaml':h1?'h1':'file',value:yaml.title??h1??posix.basename(path,'.md')});}catch{reason='identity-review';}
    const boardHash=remote.board===null?null:hashBytes(remote.board);if(remote.board!==null)blobs.push(Buffer.from(remote.board));
    const metadataHash=presentationHash({title:remote.title,metadata:remote.metadata,board:remote.board});
    const nextBase:StoredBase={identity:structuredClone(batch.identity),entityId:remote.id,path,localFileHash:hashBytes(output),basePortableHash:hashBytes(portable),localMetadataHash:metadataHash,assetHash:stableHash([]),serverSourceHash:remote.sourceHash,projectionHash:remote.projectionHash,serverRevision:remote.revision,remoteMetadataHash:metadataHash,serverTitle:remote.title,titleInputHash,metadata:structuredClone(remote.metadata),boardHash};
    const planned=entry('note',path,Buffer.from(output),nextBase,reason),base=bases.find(base=>base.entityId===remote.id),snapshot=snapshots.get(pathKey(path));
    const approval=mode==='manual'?options.manual?.find(row=>row.path===path&&row.diskHash===planned.expectedHash&&row.editorHash===planned.editorHash&&row.editorToken===planned.editorToken):undefined;
    planned.manualApproved=!!approval;
    if(snapshot&&!base)planned.blockedReason='collision';
    if(base&&(!sameIdentity(base.identity,batch.identity)||base.path!==path))planned.blockedReason='path-review';
    if(base&&snapshot&&hashBytes(snapshot.data)!==base.localFileHash&&!approval)planned.blockedReason='local-changed';
    if(base&&!snapshot)planned.blockedReason='local-missing';
    for(const descriptor of remote.assets){
      const file=downloads.get(descriptor.sha256);if(!file||stableHash(file.descriptor)!==stableHash(descriptor)){planned.blockedReason='missing-asset';continue;}
      const assetPath=normalizeVaultPath(posix.dirname(path)+'/'+descriptor.relativePath);if(!insideRoot(assetPath,root))throw new Error('Изображение вне папки кампании');planned.dependencies.push(assetPath);
      if(!entries.some(row=>pathKey(row.path)===pathKey(assetPath))){const asset=entry('asset',assetPath,file.data,null);if(asset.expectedHash!==null&&asset.expectedHash!==asset.outputHash)asset.blockedReason='asset-collision';entries.push(asset);}
    }
    nextBase.assetHash=stableHash([...new Set(remote.assets.map(asset=>JSON.stringify([asset.relativePath,asset.relativePath])))].sort());
    entries.push(planned);
  }
  entries.sort((a,b)=>a.kind===b.kind?0:a.kind==='asset'?-1:1);
  if(entries.reduce((sum,entry)=>sum+entry.byteSize,0)>33554432)throw new Error('Пакет локальных файлов превышает 32 МБ');
  const value={id:randomUUID(),identity:structuredClone(batch.identity),root,mode,expectedCursor:batch.expectedCursor,cursor:batch.cursor,entries,blobs};return {...value,hash:planFingerprint(value)};
}
