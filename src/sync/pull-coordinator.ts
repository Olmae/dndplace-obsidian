import {posix} from 'node:path';
import type {LocalBinding} from '../bindings/registry.js';
import {sameIdentity} from '../bindings/registry.js';
import {normalizeVaultPath,insideRoot,pathKey} from '../bindings/paths.js';
import {validateDTO} from '../protocol/validate.js';
import {hashBytes,stableHash} from '../documents/hashes.js';
import type {SyncState} from './state.js';
import type {SyncQueue} from './queue.js';
import {planVaultWrites,planFingerprint} from './pull.js';
import type {DownloadDocument,FileSnapshot,AssetDescriptor,PullOptions,VaultPlan} from './pull.js';
import {applyVaultPlan,recoverVaultJournal} from './vault-writer.js';
import type {WriteAdapters} from './vault-writer.js';
import type {TransportOptions} from '../connection/transport.js';

export type PullSelection=readonly {path:string;entityId:string;revision:number}[];
type Controls=Pick<TransportOptions,'signal'|'timeoutMs'>;
type PullClient={identity:LocalBinding['identity'];document:(id:string,revision:number,options?:Controls)=>Promise<unknown>;asset:(descriptor:AssetDescriptor,options?:Controls)=>Promise<Uint8Array>};
type PullWriter=Omit<WriteAdapters,'state'|'assertContext'>;
function need(value:unknown,code:string):asserts value{if(!value)throw new Error('Получение заметок требует проверки: '+code);}

/** Explicit selected-note pulls only. Does not invent paths or advance an incremental feed cursor. */
export function createPullCoordinator({binding,state,queue,client,writer,assertContext}:{binding:LocalBinding;state:SyncState;queue:SyncQueue;client:PullClient;writer?:PullWriter;assertContext:()=>void|Promise<void>}){
  binding=structuredClone(binding);const identity=binding.identity,root=normalizeVaultPath(binding.root);validateDTO('syncIdentity',identity);
  async function live(){
    await assertContext();need(!writer?.signal?.aborted,'cancelled');const current=await queue.snapshot();
    need(sameIdentity(identity,client.identity)&&sameIdentity(identity,current.identity)&&current.root===root&&queue.deviceId===state.deviceId,'context_changed');
  }
  async function pendingPaths(){const current=await queue.snapshot();return current.jobs.filter(job=>!['acknowledged','conflict'].includes(job.state)).flatMap(job=>job.notes);}
  async function blockPushes(plan:VaultPlan){
    const pending=await pendingPaths();
    for(const entry of plan.entries)if(entry.kind==='note'&&pending.some(note=>pathKey(note.path)===pathKey(entry.path)||note.entityId!==null&&note.entityId===entry.entityId))entry.blockedReason='push-pending';
    for(const asset of plan.entries.filter(entry=>entry.kind==='asset'))if(!plan.entries.some(note=>note.kind==='note'&&!note.blockedReason&&note.dependencies.includes(asset.path)))asset.blockedReason=asset.blockedReason??'note-pending';
    plan.hash=planFingerprint(plan);return plan;
  }
  function adapters(token:string):WriteAdapters{
    need(writer,'writer_unavailable');return {...writer,state,assertContext:async()=>{await live();await queue.renew(token);}};
  }
  return {
    async previewPull(selection:PullSelection,options:PullOptions={}):Promise<VaultPlan>{
      const chosen=structuredClone(selection),capturedOptions=structuredClone(options);need(writer,'writer_unavailable');
      need(Array.isArray(chosen)&&chosen.length>0&&chosen.length<=32,'selection_size');const paths=new Set<string>(),ids=new Set<string>();
      for(const note of chosen){need(normalizeVaultPath(note.path)===note.path&&insideRoot(note.path,root)&&/\.md$/i.test(note.path)&&!paths.has(pathKey(note.path))&&!ids.has(note.entityId),'selection_path');validateDTO('baseVersion',{entityId:note.entityId,revision:note.revision,sourceHash:'0'.repeat(64)});paths.add(pathKey(note.path));ids.add(note.entityId);}
      await live();const snapshot=await state.load(identity,root),notes:{path:string;document:DownloadDocument}[]=[],assets=new Map<string,{descriptor:AssetDescriptor;data:Uint8Array}>();let bytes=0;
      for(const note of chosen){
        await live();const document=structuredClone(validateDTO('document',await client.document(note.entityId,note.revision,{signal:writer.signal}))) as DownloadDocument;await live();
        need(document.id===note.entityId&&document.revision===note.revision&&hashBytes(document.markdown)===document.projectionHash,'document_changed');bytes+=Buffer.byteLength(JSON.stringify(document));need(bytes<=33554432,'batch_size');notes.push({path:note.path,document});
        for(const descriptor of document.assets){
          validateDTO('asset',descriptor);const existing=assets.get(descriptor.sha256);if(existing){need(stableHash(existing.descriptor)===stableHash(descriptor),'asset_changed');continue;}
          bytes+=descriptor.byteSize;need(bytes<=33554432,'batch_size');await live();const data=Uint8Array.from(await client.asset(descriptor,{signal:writer.signal}));await live();
          need(data.byteLength===descriptor.byteSize&&hashBytes(data)===descriptor.sha256,'asset_corrupt');assets.set(descriptor.sha256,{descriptor,data});
        }
      }
      const filePaths=new Set(notes.map(note=>note.path));for(const note of notes)for(const descriptor of note.document.assets){const path=normalizeVaultPath(posix.dirname(note.path)+'/'+descriptor.relativePath);need(insideRoot(path,root),'asset_path');filePaths.add(path);}
      const current:FileSnapshot[]=[];
      let snapshotBytes=0;for(const path of filePaths){await live();const data=await writer.vault.read(path);if(data!==null){need(data.byteLength<=(/\.md$/i.test(path)?1048576:10485760),'local_size');const editor=/\.md$/i.test(path)?writer.editor.snapshot(path):null;need(!editor||Buffer.byteLength(editor.text)<=1048576,'editor_size');snapshotBytes+=data.byteLength+(editor?Buffer.byteLength(editor.text):0);need(snapshotBytes<=33554432,'snapshot_size');current.push({path,data:Uint8Array.from(data),editor:editor?{...editor}:null});}}
      // A selected manual batch is not a complete change feed, so its cursor remains unchanged.
      return blockPushes(planVaultWrites({identity:{...identity},root,expectedCursor:snapshot.cursor,cursor:snapshot.cursor,notes,assets:[...assets.values()]},current,snapshot.bases,capturedOptions));
    },
    async applyPull(input:VaultPlan){
      const plan=structuredClone(input);need(plan.hash===planFingerprint(plan)&&sameIdentity(plan.identity,identity)&&plan.root===root,'plan_changed');need(writer,'writer_unavailable');await live();
      const token=await queue.resume('pull');
      try{await live();await queue.renew(token);return await applyVaultPlan(await blockPushes(plan),adapters(token));}
      finally{try{await queue.release(token);}catch{/* never release an expired or newer worker's lease */}}
    },
    async recoverPull(){
      need(writer,'writer_unavailable');await live();const current=await state.load(identity,root);if(!current.journals.some(journal=>journal.status!=='completed'))return current;
      const token=await queue.resume('pull');
      try{
        const pending=await pendingPaths();
        need(!current.journals.some(journal=>journal.entries.some(entry=>entry.status!=='acknowledged'&&pending.some(note=>pathKey(note.path)===pathKey(entry.path)||note.entityId!==null&&note.entityId===entry.entityId))),'push_pending');
        return await recoverVaultJournal(identity,{...adapters(token),root});
      }finally{try{await queue.release(token);}catch{/* keep a newer lease intact */}}
    },
  };
}
