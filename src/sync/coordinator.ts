import type {LocalBinding} from '../bindings/registry.js';
import {randomUUID} from 'node:crypto';
import {sameIdentity} from '../bindings/registry.js';
import {insideRoot,normalizeVaultPath} from '../bindings/paths.js';
import {hashBytes,stableHash,validHash,presentationHash} from '../documents/hashes.js';
import type {createProtocolClient} from '../protocol/client.js';
import {validateDTO} from '../protocol/validate.js';
import type {SyncState,StoredBase} from './state.js';
import {validateStoredBase} from './state.js';
import type {SyncQueue,QueueJob,OverwriteIntent} from './queue.js';
import {validateOverwriteIntent} from './queue.js';
import {buildSyncPackages} from './packages.js';
import type {SyncPackage,PackageCapture} from './packages.js';
import {createPushRunner} from './push.js';
import {planSync} from './planner.js';
import type {DownloadDocument} from './pull.js';
import {createPullCoordinator} from './pull-coordinator.js';
import {createLocalRestoreCoordinator} from './local-restore.js';
import {settlePendingForBase} from './journal.js';
import type {WriteAdapters} from './vault-writer.js';

type Documents=Parameters<typeof buildSyncPackages>[0]['documents'];
type Client=Pick<ReturnType<typeof createProtocolClient>,'identity'|'index'|'document'|'reserveTransfer'|'transferStatus'|'uploadTransfer'|'prepareTransfer'|'reviewTransfer'|'applyTransfer'>&Partial<Pick<ReturnType<typeof createProtocolClient>,'asset'>>;
export type PushPreview={id:string;identity:LocalBinding['identity'];root:string;generation:number;actions:ReturnType<typeof planSync>[];packages:SyncPackage[]};
export type KeepLocalPreview=PushPreview&{overwrite:OverwriteIntent};
export class SyncCoordinatorError extends Error{constructor(public code:string){super('Синхронизация требует проверки: '+code);this.name='SyncCoordinatorError';}}
function need(value:unknown,code:string):asserts value{if(!value)throw new SyncCoordinatorError(code);}

/** Manual exchange orchestration. Push acknowledgement uses captured snapshots without
 * writing vault files; selected pulls delegate only to the guarded journal writer. */
export function createSyncCoordinator({binding,state,queue,client,assertContext,writer}:{binding:LocalBinding;state:SyncState;queue:SyncQueue;client:Client;assertContext:()=>void|Promise<void>;writer?:Omit<WriteAdapters,'state'|'assertContext'>}){
  binding=structuredClone(binding);validateDTO('syncIdentity',binding.identity);const identity=binding.identity,root=normalizeVaultPath(binding.root);
  async function live(){await assertContext();const current=await queue.snapshot();need(sameIdentity(identity,client.identity)&&sameIdentity(identity,current.identity)&&current.root===root&&queue.deviceId===state.deviceId,'context_changed');}
  async function request<T>(action:()=>Promise<T>):Promise<T>{await live();const result=await action();await live();return result;}
  function validateCapture(capture:PackageCapture,notes:QueueJob['notes']){
    need(capture&&capture.version===1&&sameIdentity(capture.identity,identity)&&capture.root===root&&Array.isArray(capture.documents)&&capture.documents.length>0&&capture.documents.length<=32,'capture_changed');
    const derived=capture.documents.map(note=>{
      need(normalizeVaultPath(note.path)===note.path&&insideRoot(note.path,root)&&/\.md$/i.test(note.path)&&typeof note.source==='string'&&Buffer.byteLength(note.source)<=1048576&&hashBytes(note.source)===note.portableHash&&[note.localFileHash,note.metadataHash,note.assetHash,note.titleInputHash].every(validHash),'capture_changed');
      need(presentationHash({title:note.title,metadata:note.metadata,board:note.board})===note.metadataHash,'capture_changed');
      if(note.base)validateStoredBase(note.base,identity,root);need((note.entityId===null)===(note.base===null)&&(!note.base||note.base.entityId===note.entityId),'capture_changed');
      return {path:note.path,entityId:note.entityId,localFileHash:note.localFileHash,baseVersion:note.base?{entityId:note.base.entityId,revision:note.base.serverRevision,sourceHash:note.base.serverSourceHash}:null};
    });
    need(stableHash(derived)===stableHash(notes)&&new Set(capture.documents.map(note=>note.path)).size===capture.documents.length,'capture_changed');
  }
  async function captureFor(job:QueueJob){
    const bytes=await queue.captureBytes(job.id),stored=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    need(stored&&stored.version===1&&stored.packageHash===job.packageHash&&stored.captureHash===stableHash(stored.capture)&&stableHash(stored.overwrite??null)===stableHash(job.overwrite??null),'capture_changed');validateCapture(stored.capture,job.notes);return stored.capture as PackageCapture;
  }
  async function currentOverwrite(expected:OverwriteIntent){
    validateDTO('baseVersion',expected);const remote=validateDTO('document',await request(()=>client.document(expected.entityId,expected.revision))) as DownloadDocument;
    need(remote.id===expected.entityId&&remote.revision===expected.revision&&remote.sourceHash===expected.sourceHash&&hashBytes(remote.markdown)===remote.projectionHash,'overwrite_changed');return remote;
  }
  async function enqueuePreview(input:PushPreview,overwrite?:OverwriteIntent){
    const preview=structuredClone(input);need(typeof preview.id==='string'&&/^[a-f0-9-]{36}$/.test(preview.id),'preview_changed');await live();
    need(sameIdentity(preview.identity,identity)&&preview.root===root,'context_changed');const snapshot=await state.load(identity,root);need(snapshot.generation===preview.generation,'preview_changed');
    const packages=structuredClone(preview.packages);for(const pack of packages){need(sameIdentity(pack.identity,identity)&&pack.root===root&&hashBytes(pack.bytes)===pack.packageHash&&stableHash(pack.capture)===pack.captureHash,'package_changed');validateCapture(pack.capture,pack.notes);if(overwrite)validateOverwriteIntent(overwrite,pack.notes);}
    if(overwrite)need(packages.length===1,'overwrite_selection');
    const jobs:QueueJob[]=[];for(const pack of packages){await live();const hash=stableHash([preview.id,pack.packageHash]),id=`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;jobs.push(await queue.enqueue({packageBytes:pack.bytes,notes:pack.notes,...(overwrite?{overwrite}:{}),capture:Buffer.from(JSON.stringify({version:1,packageHash:pack.packageHash,captureHash:pack.captureHash,capture:pack.capture,...(overwrite?{overwrite}:{})}))},id));}return jobs;
  }
  return {
    async automaticPullVersions(ids:readonly string[]){
      need(ids.length>0&&ids.length<=32&&new Set(ids).size===ids.length,'selection_changed');
      const result:Array<{entityId:string;revision:number}>=[],cursors=new Set<string>();let cursor:string|undefined,revision:number|undefined;
      do{const page=validateDTO('indexPage',await request(()=>client.index(cursor))) as any;need(revision===undefined||revision===page.archiveRevision,'snapshot_changed');revision=page.archiveRevision;
        for(const row of page.rows)if(ids.includes(row.id)){need(!result.some(value=>value.entityId===row.id),'snapshot_changed');result.push({entityId:row.id,revision:row.revision});}
        cursor=page.nextCursor??undefined;if(cursor){need(!cursors.has(cursor)&&cursors.size<40,'snapshot_changed');cursors.add(cursor);}
      }while(cursor);return result;
    },
    async previewKeepLocal(input:Documents[number],target:OverwriteIntent):Promise<KeepLocalPreview>{
      const document=structuredClone(input),expected=structuredClone(target);await live();const snapshot=await state.load(identity,root),base=snapshot.bases.find(row=>row.entityId===document.entityId);
      need(!snapshot.journals.some(journal=>['prepared','applying'].includes(journal.status)),'pull_in_progress');
      need(base&&base.path===document.path&&sameIdentity(document.identity,identity)&&document.identityStatus==='bound'&&expected.entityId===document.entityId&&!document.diagnostics.some(row=>row.severity==='error'),'overwrite_selection');
      const remote=await currentOverwrite(expected),metadataHash=presentationHash({title:remote.title,metadata:remote.metadata,board:remote.board});
      need(document.portableHash!==remote.projectionHash||document.metadataHash!==metadataHash||document.assetHash!==base.assetHash,'overwrite_unchanged');
      const action=planSync({identity,local:document,base,remote:{identity,entityId:remote.id,revision:remote.revision,sourceHash:remote.sourceHash,projectionHash:remote.projectionHash,metadataHash}});
      need(['conflict','pull','push'].includes(action.action),'overwrite_selection');
      const packages=await buildSyncPackages({binding,documents:[document],bases:snapshot.bases});need(packages.length===1,'overwrite_selection');validateOverwriteIntent(expected,packages[0].notes);await live();
      return {id:randomUUID(),identity:{...identity},root,generation:snapshot.generation,actions:[action],packages,overwrite:expected};
    },
    async applyKeepLocal(input:KeepLocalPreview){
      const preview=structuredClone(input);need(preview.packages?.length===1,'overwrite_selection');validateOverwriteIntent(preview.overwrite,preview.packages[0].notes);await currentOverwrite(preview.overwrite);return enqueuePreview(preview,preview.overwrite);
    },
    ...createLocalRestoreCoordinator({binding,state,queue,writer,assertContext:live}),
    ...createPullCoordinator({binding,state,queue,writer,assertContext:live,client:{identity:client.identity,document:client.document,asset:async(descriptor,options)=>{need(client.asset,'asset_unavailable');return client.asset(descriptor,options);}}}),
    async previewPush(documents:Documents):Promise<PushPreview>{
      const local=structuredClone(documents);await live();const snapshot=await state.load(identity,root),rows=new Map<string,any>();let cursor:string|undefined,revision:number|undefined;const cursors=new Set<string>();
      do{
        const page=validateDTO('indexPage',await request(()=>client.index(cursor))) as any;
        need(revision===undefined||page.archiveRevision===revision,'snapshot_changed');revision=page.archiveRevision;
        for(const row of page.rows){need(!rows.has(row.id)&&rows.size<2000,'index_changed');rows.set(row.id,row);}
        cursor=page.nextCursor??undefined;if(cursor){need(!cursors.has(cursor)&&cursors.size<40,'index_changed');cursors.add(cursor);}
      }while(cursor);
      const actions:ReturnType<typeof planSync>[]=[],selected:Documents[number][]=[];
      for(const note of local){
        const base=snapshot.bases.find(base=>base.entityId===note.entityId)??null,row=note.entityId===null?null:rows.get(note.entityId);let remote=null;
        if(row){const doc=validateDTO('document',await request(()=>client.document(row.id,row.revision))) as DownloadDocument;need(doc.id===row.id&&doc.revision===row.revision&&hashBytes(doc.markdown)===doc.projectionHash,'snapshot_changed');remote={identity,entityId:doc.id,revision:doc.revision,sourceHash:doc.sourceHash,projectionHash:doc.projectionHash,metadataHash:presentationHash({title:doc.title,metadata:doc.metadata,board:doc.board})};}
        const action=planSync({identity,local:note,base,remote});actions.push(action);if(['create','push'].includes(action.action))selected.push(note);
      }
      return {id:randomUUID(),identity:{...identity},root,generation:snapshot.generation,actions,packages:await buildSyncPackages({binding,documents:selected,bases:snapshot.bases})};
    },
    async applyPush(preview:PushPreview){need(!Object.hasOwn(preview,'overwrite'),'overwrite_requires_review');return enqueuePreview(preview);},
    runPush:()=>createPushRunner({queue,client,assertContext:live}).run(),
    async recoverPending(){
      await live();const pending=(await queue.snapshot()).jobs.filter(job=>job.state==='local-pending');if(!pending.length)return [];
      const token=await queue.resume(),acknowledged:string[]=[];
      try{
        for(const candidate of pending){
          await live();await queue.renew(token);const job=(await queue.snapshot()).jobs.find(job=>job.id===candidate.id)!;if(job.state!=='local-pending')continue;
          need(job.receipt?.operationId===job.operationId&&job.approved,'receipt_changed');
          const capture=await captureFor(job),review=await queue.review(job.id);need(review.rows.length===capture.documents.length,'review_changed');
          const next:StoredBase[]=[],seen=new Set<string>();
          for(const note of capture.documents){
            const row=review.rows.find(row=>row.path===note.path.slice(root.length+1));need(row?.entityId&&!seen.has(row.entityId),'review_changed');seen.add(row.entityId);
            need(['create','replace','skip'].includes(row.action)&&(!note.entityId||row.entityId===note.entityId),'review_changed');
            const revision=row.action==='create'?1:row.action==='replace'?(row.expectedRevision??0)+1:job.overwrite?.revision??note.base?.serverRevision;
            need(revision&&Number.isSafeInteger(revision),'review_changed');const remote=validateDTO('document',await request(()=>client.document(row.entityId!,revision))) as DownloadDocument;
            need(remote.id===row.entityId&&remote.revision===revision&&remote.sourceHash===note.portableHash&&hashBytes(remote.markdown)===remote.projectionHash&&remote.title===note.title&&stableHash(remote.metadata)===stableHash(note.metadata),'commit_changed');
            const boardHash=note.board===null?null:await state.storage.putBlob(Buffer.from(JSON.stringify(note.board)));
            next.push({identity:{...identity},entityId:remote.id,path:note.path,localFileHash:note.localFileHash,basePortableHash:note.portableHash,localMetadataHash:note.metadataHash,assetHash:note.assetHash,serverSourceHash:remote.sourceHash,projectionHash:remote.projectionHash,serverRevision:remote.revision,remoteMetadataHash:presentationHash({title:remote.title,metadata:remote.metadata,board:remote.board}),serverTitle:remote.title,titleInputHash:note.titleInputHash,metadata:structuredClone(note.metadata),boardHash});
          }
          await live();await queue.renew(token);
          await state.update(identity,root,current=>{
            need(!current.journals.some(journal=>['prepared','applying'].includes(journal.status)),'pull_in_progress');
            for(const base of next){
              validateStoredBase(base,identity,root);const old=current.bases.find(row=>row.entityId===base.entityId),captured=capture.documents.find(row=>row.path===base.path)!;
              if(old&&stableHash(old)===stableHash(base)){settlePendingForBase(current,base);continue;}
              need(!current.bases.some(row=>row.path===base.path&&row.entityId!==base.entityId),'mapping_changed');
              need(captured.base?old&&stableHash(old)===stableHash(captured.base):!old,'base_changed');
              current.bases=current.bases.filter(row=>row.entityId!==base.entityId);current.bases.push(base);settlePendingForBase(current,base);
            }
            return current;
          });
          await live();await queue.renew(token);await queue.transition(token,job.id,'local-pending',{state:'acknowledged'});acknowledged.push(job.id);
        }
        return acknowledged;
      }finally{try{await queue.release(token);}catch{/* do not release a newer worker's lease */}}
    },
  };
}
