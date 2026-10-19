import type {SyncState,JournalEntry,StoredBase,StateDocument} from './state.js';
import type {SyncIdentity} from '../protocol/types.js';
import type {VaultPlan} from './pull.js';
import {planFingerprint} from './pull.js';
import {hashBytes} from '../documents/hashes.js';
import {sameIdentity} from '../bindings/registry.js';

/** Retire only pending versions proven covered by this acknowledgement. Historical
 * blobs stay available; superseded means resolved, not that old output was written. */
export function settlePendingForBase(current:StateDocument,next:StoredBase){
  const covered=(remote:StoredBase)=>remote.entityId===next.entityId&&(remote.serverRevision<next.serverRevision||remote.serverRevision===next.serverRevision&&remote.serverSourceHash===next.serverSourceHash&&remote.projectionHash===next.projectionHash&&remote.remoteMetadataHash===next.remoteMetadataHash);
  const retired=new Set<string>();
  for(const journal of current.journals){
    for(const entry of journal.entries)if(entry.status==='pending'&&entry.nextBase&&covered(entry.nextBase)){entry.status='superseded';entry.reason='resolved';retired.add(entry.id);}
    for(const entry of journal.entries)if(entry.kind==='asset'&&entry.status==='pending'){
      const owners=journal.entries.filter(note=>note.dependencies.includes(entry.path));if(owners.length&&owners.every(note=>['acknowledged','superseded'].includes(note.status))){entry.status='superseded';entry.reason='resolved';retired.add(entry.id);}
    }
    // An applying journal still owes finishJournal its cursor/checkpoint commit.
    if(journal.status==='pending'&&journal.entries.every(entry=>['acknowledged','superseded'].includes(entry.status)))journal.status='completed';
  }
  current.pending=current.pending.filter(row=>!retired.has(row.id)&&!(row.remote?covered(row.remote):(row.entityId===next.entityId||row.path===next.path)));
}

export async function prepareVaultJournal(plan:VaultPlan,state:SyncState){
  if(plan.hash!==planFingerprint(plan))throw new Error('План файлов изменился');
  for(const bytes of plan.blobs)await state.storage.putBlob(bytes);
  for(const entry of plan.entries){
    if(hashBytes(entry.output)!==entry.outputHash||entry.byteSize!==entry.output.byteLength||(entry.preimage===null?entry.expectedHash!==null:hashBytes(entry.preimage)!==entry.expectedHash))throw new Error('Снимок файла изменился');
    await state.storage.putBlob(entry.output);if(entry.preimage)await state.storage.putBlob(entry.preimage);
    if(entry.editorPreimage){if(hashBytes(entry.editorPreimage)!==entry.editorHash)throw new Error('Снимок редактора изменился');await state.storage.putBlob(entry.editorPreimage);}
  }
  return state.update(plan.identity,plan.root,current=>{
    const existing=current.journals.find(row=>row.id===plan.id);if(existing){if(existing.planHash!==plan.hash)throw new Error('Идентификатор журнала уже использован');return current;}
    if(current.journals.some(row=>['prepared','applying'].includes(row.status)))throw new Error('Сначала восстановите незавершённое обновление');
    if(current.cursor!==plan.expectedCursor)throw new Error('Позиция истории изменилась; обновите предпросмотр');
    const entries:JournalEntry[]=plan.entries.map(({output,preimage,editorPreimage,blockedReason,...entry})=>({...entry,status:blockedReason?'pending':'prepared',reason:blockedReason}));
    current.journals.push({id:plan.id,planHash:plan.hash,mode:plan.mode,status:'prepared',cursor:plan.cursor,entries});return current;
  });
}
export async function recordEntry(state:SyncState,identity:SyncIdentity,root:string,journalId:string,entryId:string,status:JournalEntry['status'],reason:string|null=null){
  return state.update(identity,root,current=>{
    const journal=current.journals.find(row=>row.id===journalId),entry=journal?.entries.find(row=>row.id===entryId);if(!journal||!entry)throw new Error('Журнал не найден');
    if(entry.status==='acknowledged')return current;
    entry.status=status;entry.reason=reason;journal.status='applying';
    if(status==='pending'){
      const pending={id:entry.id,path:entry.path,entityId:entry.entityId,reason:reason??'conflict',journalId:journal.id,remote:entry.nextBase};
      current.pending=current.pending.filter(row=>row.id!==entry.id);current.pending.push(pending);
    }
    if(status==='acknowledged'){
      if(entry.nextBase){
        const previous=current.bases.find(row=>row.entityId===entry.entityId),next=entry.nextBase;
        if(previous&&(previous.serverRevision>next.serverRevision||previous.serverRevision===next.serverRevision&&(previous.serverSourceHash!==next.serverSourceHash||previous.projectionHash!==next.projectionHash||previous.remoteMetadataHash!==next.remoteMetadataHash))){entry.status='pending';entry.reason='stale-remote';current.pending=current.pending.filter(row=>row.id!==entry.id);current.pending.push({id:entry.id,path:entry.path,entityId:entry.entityId,reason:'stale-remote',journalId,remote:next});return current;}
        if(!sameIdentity(entry.nextBase.identity,identity))throw new Error('Привязка изменилась');
        current.bases=current.bases.filter(row=>row.entityId!==entry.nextBase!.entityId);current.bases.push(structuredClone(entry.nextBase));
        settlePendingForBase(current,next);
      }
      current.ownWrites=current.ownWrites.filter(row=>row.path!==entry.path);
      if(journal.mode==='restore'||journal.mode==='copy'){
        current.pending=current.pending.filter(row=>row.id!==entry.id);current.pending.push({id:entry.id,path:entry.path,entityId:entry.entityId,reason:journal.mode==='copy'?'local-copy':'local-restore',journalId,remote:null});
      }else current.ownWrites.push({path:entry.path,hash:entry.outputHash,generation:current.generation+1});
      current.ownWrites=current.ownWrites.slice(-2000);
    }return current;
  });
}
export async function finishJournal(state:SyncState,identity:SyncIdentity,root:string,journalId:string){
  return state.update(identity,root,current=>{
    const journal=current.journals.find(row=>row.id===journalId);if(!journal)throw new Error('Журнал не найден');
    if(journal.entries.some(entry=>!['acknowledged','pending','superseded'].includes(entry.status)))return current;
    for(const entry of journal.entries.filter(entry=>entry.status==='pending'))if(!current.pending.some(row=>row.id===entry.id))current.pending.push({id:entry.id,path:entry.path,entityId:entry.entityId,reason:entry.reason??'conflict',journalId,remote:entry.nextBase});
    journal.status=journal.entries.some(entry=>entry.status==='pending')?'pending':'completed';
    // Older unfinished journals must be completed or durably pending first.
    while(current.checkpoint<current.journals.length&&['completed','pending'].includes(current.journals[current.checkpoint].status)){if(!['restore','copy'].includes(current.journals[current.checkpoint].mode))current.cursor=current.journals[current.checkpoint].cursor;current.checkpoint++;}
    return current;
  });
}
export function matchesOwnWrite(state:{ownWrites:{path:string;hash:string;generation:number}[]},path:string,hash:string,generation:number){return state.ownWrites.some(row=>row.path===path&&row.hash===hash&&row.generation===generation);}
