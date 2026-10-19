import type {LocalBinding} from '../bindings/registry.js';
import {normalizeVaultPath,insideRoot,pathKey} from '../bindings/paths.js';
import {prepareLocalDocument} from '../documents/identity.js';
import type {MappedDocument} from '../documents/identity.js';
import {scanReferences} from '../documents/links.js';
import {readFrontmatter} from '../documents/frontmatter.js';
import {resolveAssetCandidates,boardImageReferences} from '../documents/assets.js';
import {hashBytes,presentationHash} from '../documents/hashes.js';
import type {StoredBase} from '../sync/state.js';
import {validateStoredBase} from '../sync/state.js';

export function localNoteChoices(paths:readonly string[],binding:LocalBinding){
  if(paths.length>50000)throw Error('too_many_paths');
  const seen=new Set<string>(),notes=[];
  for(const path of paths){
    try{if(normalizeVaultPath(path)!==path||!insideRoot(path,binding.root))continue;}catch{continue;}
    if(seen.has(pathKey(path)))throw Error('case_collision');seen.add(pathKey(path));
    if(/\.md$/i.test(path))notes.push({id:path,path,title:path.split('/').at(-1)!.replace(/\.md$/i,''),revision:0});
  }
  if(notes.length>2000)throw Error('too_many_notes');return notes.sort((a,b)=>a.path.localeCompare(b.path));
}

/** Reads only explicitly selected Markdown and referenced in-root images through guarded IO. */
export async function loadLocalDocuments(options:{binding:LocalBinding;bases:StoredBase[];paths:readonly string[];selected:readonly string[];read:(path:string)=>Promise<Uint8Array|null>;snapshotEditor:(path:string)=>{text:string;token:string}|null;readBlob:(hash:string)=>Promise<Uint8Array>;assertContext:()=>void|Promise<void>}){
  const {binding,bases,paths,selected,read,snapshotEditor,readBlob,assertContext}=options;
  const notes=localNoteChoices(paths,binding),known=new Set(notes.map(note=>note.path));
  if(selected.length<1||selected.length>32||new Set(selected).size!==selected.length||selected.some(path=>!known.has(path)))throw Error('selection');
  for(const base of bases)validateStoredBase(base,binding.identity,binding.root);
  const entries:MappedDocument[]=bases.map(base=>({path:base.path,entityId:base.entityId,identity:base.identity,serverTitle:base.serverTitle,titleInputHash:base.titleInputHash,metadata:base.metadata}));
  const assets=new Map<string,{path:string;data:Uint8Array}>(),documents=[];let totalBytes=0;
  const budget=(bytes:number)=>{totalBytes+=bytes;if(totalBytes>33554432)throw Error('capture_size');};
  for(const path of selected){
    await assertContext();const bytes=await read(path);await assertContext();if(!bytes||bytes.byteLength>1052672)throw Error('missing_note');
    const disk=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),editor=snapshotEditor(path);
    if(editor?.token==='multiple-editors')throw Error('multiple_editors');
    const source=editor?.text??disk;if(Buffer.byteLength(source)>1052672)throw Error('note_size');budget(Buffer.byteLength(source));
    const portable=readFrontmatter(source).identity;
    const ownIdentity=portable&&(['instanceId','accountId','campaignId','bindingId'] as const).every(key=>portable[key]===binding.identity[key]);
    const base=bases.find(base=>portable?ownIdentity&&base.entityId===portable.entityId:base.path===path),entry=base?entries.find(entry=>entry.entityId===base.entityId):undefined;
    if(base?.boardHash&&entry){
      const data=await readBlob(base.boardHash);await assertContext();if(hashBytes(data)!==base.boardHash||data.byteLength>4194304)throw Error('board_corrupt');budget(data.byteLength);
      const raw=new TextDecoder('utf-8',{fatal:true}).decode(data);let parsed:unknown;try{parsed=JSON.parse(raw);}catch{throw Error('board_corrupt');}
      const candidates=[raw,parsed],board=candidates.find(board=>presentationHash({title:base.serverTitle,metadata:base.metadata,board})===base.localMetadataHash);
      if(board===undefined)throw Error('board_corrupt');entry.board=board;
    }
    const references=[...scanReferences(source).assets,...boardImageReferences(entry?.board)];
    for(const reference of references){
      const candidates=resolveAssetCandidates(reference,path,binding,paths);
      if(candidates.length!==1||assets.has(candidates[0]))continue;
      const assetPath=candidates[0];await assertContext();const data=await read(assetPath);await assertContext();if(!data)throw Error('missing_asset');budget(data.byteLength);assets.set(assetPath,{path:assetPath,data});
    }
    documents.push(prepareLocalDocument({path,source},binding,{entries,assets:[...assets.values()],existingPaths:paths}));
  }
  await assertContext();return documents;
}
