import {ZipFile} from 'yazl';
import type {LocalBinding} from '../bindings/registry.js';
import {sameIdentity} from '../bindings/registry.js';
import {normalizeVaultPath,insideRoot,pathKey} from '../bindings/paths.js';
import type {prepareLocalDocument} from '../documents/identity.js';
import type {Diagnostic} from '../documents/links.js';
import {hashBytes,stableHash,presentationHash,validHash} from '../documents/hashes.js';
import {validateDTO} from '../protocol/validate.js';
import type {CapturedNote} from './queue.js';
import type {StoredBase} from './state.js';
import {validateStoredBase} from './state.js';

type Prepared=Omit<ReturnType<typeof prepareLocalDocument>,'metadata'|'identityStatus'>&{metadata:{icon?:string;favorite?:boolean};identityStatus:'new'|'bound'|'review'};
export type CapturedDocument={path:string;entityId:string|null;localFileHash:string;portableHash:string;metadataHash:string;assetHash:string;titleInputHash:string;title:string;source:string;metadata:{icon:string;favorite:boolean};board:unknown|null;base:StoredBase|null};
export type PackageCapture={version:1;identity:LocalBinding['identity'];root:string;documents:CapturedDocument[]};
export type SyncPackage={identity:LocalBinding['identity'];root:string;bytes:Uint8Array;packageHash:string;notes:CapturedNote[];capture:PackageCapture;captureHash:string};
type File={path:string;data:Buffer};
type Selection={binding:LocalBinding;documents:readonly Prepared[];bases:readonly StoredBase[];limits?:{notes?:number;bytes?:number}};
export class SyncPackageError extends Error{constructor(public code:string){super('Не удалось собрать перенос: '+code);this.name='SyncPackageError';}}
function need(value:unknown,code:string):asserts value{if(!value)throw new SyncPackageError(code);}
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value));
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;

/** Captures supplied snapshots only: no vault reads, network access, settings or credentials. */
export async function buildSyncPackages(selection:Selection):Promise<SyncPackage[]>{
  const {binding,limits}=selection,identity=structuredClone(binding.identity),root=normalizeVaultPath(binding.root);
  validateDTO('syncIdentity',identity);const maxNotes=limits?.notes??32,maxBytes=limits?.bytes??33554432;
  need(Number.isSafeInteger(maxNotes)&&maxNotes>0&&maxNotes<=32&&Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=33554432,'invalid_limits');
  need(Array.isArray(selection.documents)&&selection.documents.length<=2000&&Array.isArray(selection.bases)&&selection.bases.length<=2000,'selection_size');
  const documents=structuredClone(selection.documents).sort((a,b)=>compare(a.path,b.path)),bases=structuredClone(selection.bases),paths=new Set<string>(),entities=new Set<string>();
  for(const base of bases)validateStoredBase(base,identity,root);
  for(const note of documents){
    need(sameIdentity(note.identity,identity)&&normalizeVaultPath(note.path)===note.path&&insideRoot(note.path,root)&&/\.md$/i.test(note.path)&&!paths.has(pathKey(note.path)),'invalid_note');paths.add(pathKey(note.path));
    need(['new','bound'].includes(note.identityStatus)&&!note.diagnostics.some((item:Diagnostic)=>item.severity==='error')&&typeof note.source==='string'&&Buffer.byteLength(note.source)<=1048576&&Buffer.from(note.source).toString()===note.source&&hashBytes(note.source)===note.portableHash&&[note.localFileHash,note.metadataHash,note.assetHash,note.titleInputHash].every(validHash),'unreviewed_note');
    need(note.title.length>0&&note.title.length<=500&&presentationHash({title:note.title,metadata:note.metadata,board:note.board})===note.metadataHash,'invalid_metadata');
    need((note.metadata.icon??'').length<=32&&typeof (note.metadata.favorite??false)==='boolean','invalid_metadata');
    if(note.entityId!==null){need(!entities.has(note.entityId),'duplicate_entity');entities.add(note.entityId);need(bases.filter(base=>base.entityId===note.entityId).length===1,'base_required');}
    else need(note.identityStatus==='new','base_required');
  }
  function materialize(group:Prepared[]){
    const files:File[]=[],entries:any[]=[],assets=new Map<string,{path:string;originalRef:string;mime:string;sha256:string}>(),captured:CapturedDocument[]=[];
    function add(path:string,data:Uint8Array){normalizeVaultPath(path);files.push({path,data:Buffer.from(data)});}
    for(const note of group){
      const path=note.path.slice(root.length+1),base=note.entityId===null?null:bases.find(base=>base.entityId===note.entityId)!,metadata={icon:note.metadata.icon??'',favorite:note.metadata.favorite??false};
      const record:any={id:note.entityId??'local_'+stableHash([identity,path]),path,title:note.title,format:'markdown',revision:base?.serverRevision??1,sourceHash:note.portableHash,projectionHash:note.portableHash,metadata};
      const aliases=new Map<string,string>();
      for(const asset of note.assets){
        validateDTO('asset',{id:asset.sha256,mime:asset.mime,sha256:asset.sha256,byteSize:asset.byteSize,relativePath:asset.relativePath});
        need(insideRoot(asset.path,root)&&asset.data instanceof Uint8Array&&asset.data.byteLength===asset.byteSize&&hashBytes(asset.data)===asset.sha256,'invalid_asset');
        if(!assets.has(asset.relativePath)){assets.set(asset.relativePath,{path:asset.relativePath,originalRef:asset.relativePath,mime:asset.mime,sha256:asset.sha256});add(asset.relativePath,asset.data);}
      }
      for(const [target,assetPath] of note.assetTargets){need(assets.has(assetPath),'missing_asset');aliases.set(target,assetPath);}
      let board:unknown|null=note.board??null;
      if(board!==null){
        if(typeof board==='string'){try{board=JSON.parse(board);}catch{throw new SyncPackageError('invalid_board');}}
        need(board&&typeof board==='object'&&!Array.isArray(board)&&Array.isArray((board as any).nodes)&&Array.isArray((board as any).edges),'invalid_board');
        for(const node of (board as any).nodes){
          if(node?.kind==='image'&&node.url){const asset=note.assets.find(asset=>[asset.path,asset.relativePath,...note.assetTargets.filter(pair=>pair[1]===asset.relativePath).map(pair=>pair[0])].includes(node.url));need(asset,'missing_board_asset');aliases.set(node.url,asset.relativePath);}
        }
        const bytes=encode(board);need(bytes.byteLength<=4194304,'board_size');record.boardPath=`__dndplace_sync__/boards/${hashBytes(path)}.json`;add(record.boardPath,bytes);
      }
      if(aliases.size){
        record.preservedPath=`__dndplace_sync__/originals/${hashBytes(path)}.json`;
        add(record.preservedPath,encode({format:'markdown',source:note.source,sourceHash:note.portableHash,projectionHash:note.portableHash,sourceAssetMap:[...aliases].sort(([a],[b])=>compare(a,b))}));
      }
      add(path,Buffer.from(note.source));entries.push(record);
      captured.push({path:note.path,entityId:note.entityId,localFileHash:note.localFileHash,portableHash:note.portableHash,metadataHash:note.metadataHash,assetHash:note.assetHash,titleInputHash:note.titleInputHash,title:note.title,source:note.source,metadata,board:structuredClone(note.board??null),base:base?structuredClone(base):null});
    }
    add('dndplace-manifest.json',encode({version:1,instanceId:identity.instanceId,campaignId:identity.campaignId,entries,folders:[],...(assets.size?{assets:[...assets.values()].sort((a,b)=>compare(a.path,b.path))}:{})}));
    files.sort((a,b)=>compare(a.path,b.path));const keys=new Set<string>();
    for(const file of files){need(!keys.has(pathKey(file.path)),'package_collision');keys.add(pathKey(file.path));}
    for(const file of files){const parts=pathKey(file.path).split('/');for(let i=1;i<parts.length;i++)need(!keys.has(parts.slice(0,i).join('/')),'package_collision');}
    // Conservative bound for both local and central headers, UTF-8 names and timestamp extras.
    const bound=22+files.reduce((sum,file)=>sum+file.data.byteLength+2*Buffer.byteLength(file.path)+160,0);
    need(files.length<=2000,'entry_count');return {files,captured,bound};
  }
  const groups:Prepared[][]=[];let group:Prepared[]=[];
  for(const note of documents){
    const candidate=[...group,note];
    if(candidate.length>maxNotes||materialize(candidate).bound>maxBytes){need(group.length>0,'note_batch_size');groups.push(group);group=[note];need(materialize(group).bound<=maxBytes,'note_batch_size');}
    else group=candidate;
  }
  if(group.length)groups.push(group);
  const result:SyncPackage[]=[];
  for(const group of groups){
    const {files,captured}=materialize(group),zip=new ZipFile(),chunks:Buffer[]=[];let size=0;
    const reading=(async()=>{for await(const chunk of zip.outputStream){size+=chunk.length;need(size<=maxBytes,'package_size');chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks);})();
    for(const file of files)zip.addBuffer(file.data,file.path,{compress:false,mtime:new Date('2000-01-01T00:00:00.000Z'),forceDosTimestamp:true,mode:0o100600});zip.end();
    const bytes=await reading,capture:PackageCapture={version:1,identity:{...identity},root,documents:captured};
    const notes=captured.map(note=>({path:note.path,entityId:note.entityId,localFileHash:note.localFileHash,baseVersion:note.base?{entityId:note.base.entityId,revision:note.base.serverRevision,sourceHash:note.base.serverSourceHash}:null}));
    result.push({identity:{...identity},root,bytes,packageHash:hashBytes(bytes),notes,capture,captureHash:stableHash(capture)});
  }
  return result;
}
