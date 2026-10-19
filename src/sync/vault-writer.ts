import type {SyncIdentity} from '../protocol/types.js';
import type {SyncState,VaultJournal,JournalEntry} from './state.js';
import type {VaultPlan} from './pull.js';
import {prepareVaultJournal,recordEntry,finishJournal} from './journal.js';
import {hashBytes} from '../documents/hashes.js';

export class WriteConflict extends Error{constructor(public reason:string){super(reason);this.name='WriteConflict';}}
export type VaultWriter={read:(path:string)=>Promise<Uint8Array|null>;create:(path:string,data:Uint8Array)=>Promise<void>;process:(path:string,transform:(current:string)=>string)=>Promise<void>};
export type EditorSnapshot={text:string;token:string};
export type EditorWriter={snapshot:(path:string)=>EditorSnapshot|null;replace:(path:string,input:{expectedHash:string;expectedToken:string;output:string})=>Promise<boolean>;waitForSaved:(path:string,hash:string)=>Promise<boolean>};
export type WriteAdapters={vault:VaultWriter;editor:EditorWriter;state:SyncState;assertContext?:()=>Promise<void>;signal?:AbortSignal};

async function resume(identity:SyncIdentity,root:string,journalId:string,adapters:WriteAdapters){
  const {state,vault,editor}=adapters;
  const context=async()=>{if(adapters.signal?.aborted)throw new Error('Обновление остановлено');await adapters.assertContext?.();};
  const journal=()=>state.load(identity,root).then(value=>{const row=value.journals.find(row=>row.id===journalId);if(!row)throw new Error('Журнал не найден');return row;});
  for(const initial of (await journal()).entries){
    await context();const entry=(await journal()).entries.find(row=>row.id===initial.id)!;
    if(entry.status==='acknowledged'||entry.status==='superseded'||entry.status==='pending'&&entry.reason!=='awaiting-save')continue;
    const pending=(reason:string)=>recordEntry(state,identity,root,journalId,entry.id,'pending',reason);
    const previous=(await state.load(identity,root)).bases.find(row=>row.entityId===entry.entityId),next=entry.nextBase;
    if(previous&&next&&(previous.serverRevision>next.serverRevision||previous.serverRevision===next.serverRevision&&(previous.serverSourceHash!==next.serverSourceHash||previous.projectionHash!==next.projectionHash||previous.remoteMetadataHash!==next.remoteMetadataHash))){await pending('stale-remote');continue;}
    const dependencies=(await journal()).entries.filter(row=>entry.dependencies.includes(row.path));
    if(dependencies.length!==entry.dependencies.length||dependencies.some(row=>row.status!=='acknowledged')){await pending('missing-asset');continue;}
    const assetsReady=async()=>{for(const dependency of dependencies){const bytes=await vault.read(dependency.path);if(!bytes||hashBytes(bytes)!==dependency.outputHash)return false;}return true;};
    const output=await state.storage.readBlob(entry.outputHash);if(hashBytes(output)!==entry.outputHash||output.byteLength!==entry.byteSize)throw new Error('Файл восстановления повреждён');
    for(const hash of [entry.preimageHash,entry.editorHash,entry.nextBase?.boardHash])if(hash){const bytes=await state.storage.readBlob(hash);if(hashBytes(bytes)!==hash)throw new Error('Резервный снимок повреждён');}
    const current=await vault.read(entry.path),actual=current===null?null:hashBytes(current),snapshot=editor.snapshot(entry.path);
    if(!await assetsReady()){await pending('missing-asset');continue;}
    if(actual===entry.outputHash){
      if(snapshot&&hashBytes(snapshot.text)!==entry.outputHash){await pending('active-editor');continue;}
      await context();await recordEntry(state,identity,root,journalId,entry.id,'acknowledged');continue;
    }
    if(entry.status==='pending')continue;
    if(actual!==entry.expectedHash){await pending(actual===null?'missing':entry.expectedHash===null?'collision':'local-changed');continue;}
    if(snapshot){
      if(!['manual','restore'].includes((await journal()).mode)||!entry.manualApproved||entry.editorHash===null||entry.editorToken===null){await pending('active-editor');continue;}
      if(hashBytes(snapshot.text)!==entry.editorHash||snapshot.token!==entry.editorToken){await pending('editor-changed');continue;}
    }
    await context();
    try{
      if(snapshot){
        if(!await editor.replace(entry.path,{expectedHash:entry.editorHash!,expectedToken:entry.editorToken!,output:Buffer.from(output).toString('utf8')})){await pending('editor-changed');continue;}
        await recordEntry(state,identity,root,journalId,entry.id,'written');
        if(!await editor.waitForSaved(entry.path,entry.outputHash)){await pending('awaiting-save');continue;}
      }else if(entry.expectedHash===null)await vault.create(entry.path,output);
      else{
        if(entry.kind!=='note')throw new WriteConflict('asset-collision');
        await vault.process(entry.path,text=>{
          if(editor.snapshot(entry.path))throw new WriteConflict('active-editor');
          if(hashBytes(text)!==entry.expectedHash)throw new WriteConflict('local-changed');
          return Buffer.from(output).toString('utf8');
        });
      }
    }catch(error){if(error instanceof WriteConflict){await pending(error.reason);continue;}throw error;}
    await recordEntry(state,identity,root,journalId,entry.id,'written');
    await context();const saved=await vault.read(entry.path),buffer=editor.snapshot(entry.path);
    if(!await assetsReady()){await pending('missing-asset');continue;}
    if(saved===null||hashBytes(saved)!==entry.outputHash||buffer&&hashBytes(buffer.text)!==entry.outputHash){await pending(buffer?'active-editor':'save-changed');continue;}
    await recordEntry(state,identity,root,journalId,entry.id,'acknowledged');
  }
  return finishJournal(state,identity,root,journalId);
}
export async function applyVaultPlan(plan:VaultPlan,adapters:WriteAdapters){
  if(adapters.signal?.aborted)throw new Error('Обновление остановлено');await adapters.assertContext?.();
  await prepareVaultJournal(plan,adapters.state);return resume(plan.identity,plan.root,plan.id,adapters);
}
export async function recoverVaultJournal(identity:SyncIdentity,adapters:WriteAdapters&{root:string}){
  const current=await adapters.state.load(identity,adapters.root);
  for(const journal of current.journals)if(journal.status!=='completed')await resume(identity,adapters.root,journal.id,adapters);
  return adapters.state.load(identity,adapters.root);
}
