import {randomUUID} from 'node:crypto';
import {posix} from 'node:path';
import type {LocalBinding} from '../bindings/registry.js';
import {sameIdentity} from '../bindings/registry.js';
import {insideRoot,normalizeVaultPath} from '../bindings/paths.js';
import {readFrontmatter,stripIdentity} from '../documents/frontmatter.js';
import {hashBytes,stableHash} from '../documents/hashes.js';
import type {StoredBase,SyncState} from './state.js';
import type {SyncQueue} from './queue.js';
import type {createPullCoordinator,PullSelection} from './pull-coordinator.js';
import type {VaultPlan} from './pull.js';
import {planFingerprint} from './pull.js';
import {applyVaultPlan} from './vault-writer.js';
import type {WriteAdapters} from './vault-writer.js';

export type ConflictChoice='remote'|'copy'|'later';
export type ConflictSnapshot={id:string;path:string;title:string;localText:string;remoteText:string;base:StoredBase;pull:VaultPlan;hash:string};
export type ConflictDecision={choice:ConflictChoice;snapshot:ConflictSnapshot;plan:VaultPlan;hash:string};
const decode=(bytes:Uint8Array)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
const fingerprint=(row:ConflictSnapshot)=>stableHash({id:row.id,path:row.path,title:row.title,localText:row.localText,remoteText:row.remoteText,base:row.base,pull:row.pull.hash});
const decisionHash=(row:ConflictDecision)=>stableHash([row.choice,row.snapshot.hash,row.plan.hash]);
export class ConflictError extends Error{constructor(public code:string){super('Решение конфликта требует проверки: '+code);this.name='ConflictError';}}
function need(value:unknown,code:string):asserts value{if(!value)throw new ConflictError(code);}

/** Explicit local decisions. Uses the same captured pull and journal writer, with no
 * unreviewed server mutation, fabricated baseline or transfer approval. */
export function createConflictCoordinator(options:{binding:LocalBinding;state:SyncState;queue:SyncQueue;writer?:Omit<WriteAdapters,'state'|'assertContext'>;pull:ReturnType<typeof createPullCoordinator>;assertContext:()=>void|Promise<void>}){
 const binding=structuredClone(options.binding),{identity,root}=binding,{state,queue,writer,pull}=options;
 async function live(){await options.assertContext();need(!writer?.signal?.aborted,'cancelled');const current=await queue.snapshot();need(sameIdentity(current.identity,identity)&&current.root===root&&state.deviceId===queue.deviceId,'context_changed');}
 function checked(snapshot:ConflictSnapshot){need(snapshot.hash===fingerprint(snapshot)&&snapshot.pull.hash===planFingerprint(snapshot.pull)&&sameIdentity(snapshot.pull.identity,identity)&&snapshot.pull.root===root&&snapshot.pull.entries.filter(row=>row.kind==='note').length===1,'review_changed');}
 function own(source:string,entityId:string,required:boolean){const portable=readFrontmatter(source).identity;need(!required&&!portable||portable&&portable.entityId===entityId&&(['instanceId','accountId','campaignId','bindingId']as const).every(key=>portable[key]===identity[key]),'identity_changed');}
 return {
  async previewConflict(selection:PullSelection[number]):Promise<ConflictSnapshot>{
   need(writer,'writer_unavailable');await live();const plan=await pull.previewPull([selection]),entry=plan.entries.find(row=>row.kind==='note')!;
   const snapshot=await state.load(identity,root),base=snapshot.bases.find(row=>row.entityId===selection.entityId&&row.path===selection.path);need(base&&entry.preimage&&entry.nextBase,'missing_or_unlinked');
   own(decode(entry.preimage),base.entityId,true);if(entry.editorPreimage)own(decode(entry.editorPreimage),base.entityId,false);need(entry.editorToken!=='multiple-editors','multiple_editors');
   const value:ConflictSnapshot={id:randomUUID(),path:entry.path,title:entry.nextBase.serverTitle,localText:stripIdentity(decode(entry.editorPreimage??entry.preimage)),remoteText:stripIdentity(decode(entry.output)),base:structuredClone(base),pull:plan,hash:''};value.hash=fingerprint(value);await live();return value;
  },
  async previewDecision(input:ConflictSnapshot,choice:ConflictChoice):Promise<ConflictDecision>{
   const snapshot=structuredClone(input);checked(snapshot);need(['remote','copy','later'].includes(choice),'choice');await live();
   const current=await state.load(identity,root);need(stableHash(current.bases.find(row=>row.entityId===snapshot.base.entityId))===stableHash(snapshot.base),'base_changed');
   let plan=structuredClone(snapshot.pull);plan.id=randomUUID();for(const entry of plan.entries)entry.id=randomUUID();
   if(choice==='remote'){
    plan.mode='manual';const entry=plan.entries.find(row=>row.kind==='note')!;
    need(entry.blockedReason===null||entry.blockedReason==='local-changed','blocked');entry.manualApproved=true;entry.blockedReason=null;
    need(!plan.entries.some(row=>row.blockedReason),'blocked_asset');
   }else if(choice==='later'){
    for(const entry of plan.entries)entry.blockedReason='user-deferred';
   }else{
    const source=snapshot.pull.entries.find(row=>row.kind==='note')!,path=normalizeVaultPath(posix.join(posix.dirname(snapshot.path),posix.basename(snapshot.path,'.md').slice(0,70)+' — копия '+randomUUID().slice(0,8)+'.md'));
    need(insideRoot(path,root)&&path!==snapshot.path,'copy_path');const output=Buffer.from(snapshot.localText);
    plan={...plan,mode:'copy',blobs:[source.preimage!,...(source.editorPreimage?[source.editorPreimage]:[])],entries:[{id:randomUUID(),kind:'note',path,expectedHash:null,preimageHash:null,outputHash:hashBytes(output),byteSize:output.byteLength,status:'prepared',reason:null,entityId:null,nextBase:null,dependencies:[],editorHash:null,editorToken:null,manualApproved:true,output,preimage:null,editorPreimage:null,blockedReason:null}]};
   }
   plan.hash=planFingerprint(plan);const result:ConflictDecision={choice,snapshot,plan,hash:''};result.hash=decisionHash(result);return result;
  },
  async applyDecision(input:ConflictDecision){
   const decision=structuredClone(input);checked(decision.snapshot);need(decision.hash===decisionHash(decision)&&decision.plan.hash===planFingerprint(decision.plan)&&sameIdentity(decision.plan.identity,identity)&&decision.plan.root===root,'decision_changed');need(writer,'writer_unavailable');await live();
   const original=decision.snapshot.pull.entries.find(row=>row.kind==='note')!;
   if(decision.choice==='remote'){
    // Re-read the exact current remote revision before using the approved local preimages.
    const fresh=await pull.previewPull([{path:decision.snapshot.path,entityId:original.entityId!,revision:original.nextBase!.serverRevision}]);
    need(stableHash(fresh.entries.find(row=>row.kind==='note')!.nextBase)===stableHash(original.nextBase),'remote_changed');return pull.applyPull(decision.plan);
   }
   if(decision.choice==='later')return pull.applyPull(decision.plan);
   need(decision.choice==='copy'&&decision.plan.mode==='copy','choice');const token=await queue.resume('pull');
   try{
    const guard=async()=>{await live();await queue.renew(token);};await guard();const current=await state.load(identity,root);
    need(stableHash(current.bases.find(row=>row.entityId===decision.snapshot.base.entityId))===stableHash(decision.snapshot.base),'base_changed');
    // A completed journal is already authoritative; replay never recreates a removed copy.
    if(!current.journals.some(row=>row.id===decision.plan.id)){
     const disk=await writer.vault.read(original.path),editor=writer.editor.snapshot(original.path);need(disk&&hashBytes(disk)===original.expectedHash,'local_changed');need((editor?.token??null)===original.editorToken&&(editor?hashBytes(editor.text):null)===original.editorHash,'editor_changed');
    }
    return await applyVaultPlan(decision.plan,{...writer,state,assertContext:guard});
   }finally{try{await queue.release(token);}catch{/* preserve a newer lease */}}
  },
 };
}
