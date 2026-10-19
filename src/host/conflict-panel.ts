import {randomUUID} from 'node:crypto';
import type {LocalBinding} from '../bindings/registry.js';
import type {Connection} from '../connection/settings.js';
import type {SyncState} from '../sync/state.js';
import type {SyncQueue} from '../sync/queue.js';
import type {WriteAdapters} from '../sync/vault-writer.js';
import type {createSyncCoordinator} from '../sync/coordinator.js';
import {SyncCoordinatorError,type KeepLocalPreview} from '../sync/coordinator.js';
import {createConflictCoordinator,ConflictError} from '../sync/conflicts.js';
import type {ConflictSnapshot,ConflictDecision} from '../sync/conflicts.js';
import type {ConflictPanelService} from '../ui/conflict-types.js';
import type {NoteChoice,Review,SendPanelService} from '../ui/controller.js';
import {PanelError} from '../ui/controller.js';
import {stableHash,hashBytes} from '../documents/hashes.js';
import {loadLocalDocuments} from './local-capture.js';
type Session={root:LocalBinding;captured:Connection;queue:SyncQueue;coordinator:ReturnType<typeof createSyncCoordinator>;writer:Omit<WriteAdapters,'state'|'assertContext'>;live:()=>Promise<void>};
type Context={localId:string;root:LocalBinding;connection:Connection;snapshot:ConflictSnapshot};
type Decision={context:Context}&({kind:'vault';decision:ConflictDecision}|{kind:'local';plan:KeepLocalPreview}|{kind:'server';review:Review});
const same=(a:unknown,b:unknown)=>stableHash(a)===stableHash(b);
export function createConflictPanelService(options:{state:SyncState;session:(localId:string,signal:AbortSignal)=>Session;remoteNotes:(localId:string,signal:AbortSignal)=>Promise<NoteChoice[]>;paths:()=>string[];sending:SendPanelService}):ConflictPanelService{
 const contexts=new Map<string,Context>(),decisions=new Map<string,Decision>();let closed=false;
 async function checked(localId:string,signal:AbortSignal,context?:Context){if(closed||signal.aborted)throw new PanelError('preview_changed');const s=options.session(localId,signal);await s.live();if(context&&(context.localId!==localId||!same(context.root,s.root)||!same(context.connection,s.captured)))throw new PanelError('connection_changed');return s;}
 const resolver=(s:Session)=>createConflictCoordinator({binding:s.root,state:options.state,queue:s.queue,writer:s.writer,pull:s.coordinator,assertContext:s.live});
 async function action<T>(operation:()=>Promise<T>){try{return await operation();}catch(error){if(error instanceof SyncCoordinatorError&&error.code==='overwrite_unchanged')throw new PanelError('overwrite_unchanged');if(error instanceof SyncCoordinatorError&&['overwrite_changed','preview_changed','overwrite_selection'].includes(error.code))throw new PanelError('preview_changed');if(error instanceof ConflictError)throw new PanelError(['missing_or_unlinked','identity_changed'].includes(error.code)?'conflict_unavailable':'preview_changed');throw error;}}
 return {
  async open(localId,note,signal){
   const s=await checked(localId,signal),state=await options.state.load(s.root.identity,s.root.root),base=state.bases.find(row=>row.path===note.path);if(!base||note.id!==base.entityId&&note.id!==note.path)throw new PanelError('conflict_unavailable');
   const rows=await options.remoteNotes(localId,signal),remote=rows.find(row=>row.id===base.entityId&&row.path===base.path);if(!remote)throw new PanelError('preview_changed');
   const snapshot=await action(()=>resolver(s).previewConflict({path:base.path,entityId:base.entityId,revision:remote.revision}));await s.live();contexts.clear();decisions.clear();const id=randomUUID();contexts.set(id,{localId,root:structuredClone(s.root),connection:structuredClone(s.captured),snapshot});
   return {id,title:snapshot.title,path:snapshot.path,localText:snapshot.localText,remoteText:snapshot.remoteText,revision:remote.revision,decision:null};
  },
  async preview(localId,id,choice,signal){
   const context=contexts.get(id);if(!context)throw new PanelError('preview_changed');const s=await checked(localId,signal,context);decisions.clear();const reviewId=randomUUID();
   if(choice==='local'){
    if((await s.queue.snapshot()).jobs.some(job=>!['acknowledged','conflict'].includes(job.state)))throw new PanelError('send_pending');
    const snapshot=await options.state.load(s.root.identity,s.root.root);if(!same(snapshot.bases.find(row=>row.entityId===context.snapshot.base.entityId),context.snapshot.base))throw new PanelError('preview_changed');
    const [document]=await loadLocalDocuments({binding:s.root,bases:snapshot.bases,paths:options.paths(),selected:[context.snapshot.path],read:s.writer.vault.read,snapshotEditor:s.writer.editor.snapshot,readBlob:options.state.storage.readBlob,assertContext:s.live});
    const original=context.snapshot.pull.entries.find(row=>row.kind==='note')!,remote=original.nextBase!;
    if(document.localFileHash!==(original.editorHash??original.expectedHash)||document.portableHash!==hashBytes(context.snapshot.localText))throw new PanelError('preview_changed');
    const plan=await action(()=>s.coordinator.previewKeepLocal(document,{entityId:remote.entityId,revision:remote.serverRevision,sourceHash:remote.serverSourceHash}));await checked(localId,signal,context);
    decisions.set(reviewId,{kind:'local',context,plan});return {id:reviewId,choice,stage:'capture',canConfirm:true,path:context.snapshot.path,targetPath:context.snapshot.path};
   }
   const decision=await action(()=>resolver(s).previewDecision(context.snapshot,choice));await checked(localId,signal,context);decisions.set(reviewId,{kind:'vault',context,decision});return {id:reviewId,choice,path:context.snapshot.path,targetPath:decision.plan.entries.find(row=>row.kind==='note')!.path};
  },
  async apply(localId,id,signal){
   const row=decisions.get(id);if(!row)throw new PanelError('preview_changed');decisions.delete(id);const s=await checked(localId,signal,row.context);if(![...contexts.values()].includes(row.context))throw new PanelError('preview_changed');
   if(row.kind==='local'){
    const jobs=await action(()=>s.coordinator.applyKeepLocal(row.plan));if(jobs.length!==1)throw new PanelError('preview_changed');const next=await s.coordinator.runPush();if(next.state!=='review'||next.jobId!==jobs[0].id)throw new PanelError('preview_changed');
    const resumed=await options.sending.resume(localId,signal);await checked(localId,signal,row.context);if(resumed.kind!=='review'||!resumed.review.overwrite)throw new PanelError('preview_changed');
    const reviewId=randomUUID();decisions.set(reviewId,{kind:'server',context:row.context,review:resumed.review});return {kind:'review',review:{id:reviewId,choice:'local',stage:'server',server:resumed.review,canConfirm:resumed.review.canConfirm,path:row.context.snapshot.path,targetPath:row.context.snapshot.path}};
   }
   if(row.kind==='server')return options.sending.apply(localId,row.review.id,signal);
   const state=await action(()=>resolver(s).applyDecision(row.decision)),entries=state.journals.find(journal=>journal.id===row.decision.plan.id)!.entries.filter(row=>row.kind==='note');return {written:entries.filter(row=>row.status==='acknowledged').length,pending:entries.filter(row=>row.status!=='acknowledged').length};
  },
  dispose(){closed=true;contexts.clear();decisions.clear();},
 };
}
