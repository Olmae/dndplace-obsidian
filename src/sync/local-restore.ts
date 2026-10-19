import {randomUUID} from 'node:crypto';
import type {LocalBinding} from '../bindings/registry.js';
import {sameIdentity} from '../bindings/registry.js';
import {insideRoot,normalizeVaultPath,pathKey} from '../bindings/paths.js';
import {attachIdentity,stripIdentity,readFrontmatter} from '../documents/frontmatter.js';
import {hashBytes,stableHash} from '../documents/hashes.js';
import type {SyncState} from './state.js';
import type {SyncQueue} from './queue.js';
import type {VaultPlan} from './pull.js';
import {planFingerprint} from './pull.js';
import {applyVaultPlan} from './vault-writer.js';
import type {WriteAdapters} from './vault-writer.js';

export type RestorePlan=VaultPlan&{baseHash:string};
function need(value:unknown,reason:string):asserts value{if(!value)throw new Error('Восстановление требует проверки: '+reason);}
const decode=(bytes:Uint8Array)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);

/** Local text restoration uses the guarded writer and its durable preimages, but never
 * replaces a server baseline, board, attachment or receipt. It has no network client. */
export function createLocalRestoreCoordinator(input:{binding:LocalBinding;state:SyncState;queue:SyncQueue;writer?:Omit<WriteAdapters,'state'|'assertContext'>;assertContext:()=>void|Promise<void>}){
 const binding=structuredClone(input.binding),{identity}=binding,root=normalizeVaultPath(binding.root),{state,queue,writer}=input;
 async function live(){await input.assertContext();need(!writer?.signal?.aborted,'cancelled');const current=await queue.snapshot();need(sameIdentity(identity,current.identity)&&current.root===root&&queue.deviceId===state.deviceId,'context_changed');}
 async function noPush(path:string,entityId:string){const current=await queue.snapshot();need(!current.jobs.some(job=>!['acknowledged','conflict'].includes(job.state)&&job.notes.some(note=>pathKey(note.path)===pathKey(path)||note.entityId===entityId)),'push_pending');}
 return {
  async previewRestore(selection:{path:string;entityId:string;text:string}):Promise<RestorePlan>{
   const {path,entityId,text}=structuredClone(selection);need(writer,'writer_unavailable');
   need(normalizeVaultPath(path)===path&&insideRoot(path,root)&&/\.md$/i.test(path)&&typeof text==='string'&&Buffer.byteLength(text)<=1048576,'selection');
   await live();await noPush(path,entityId);const snapshot=await state.load(identity,root),base=snapshot.bases.find(row=>row.entityId===entityId&&row.path===path);need(base,'unlinked');
   const disk=await writer.vault.read(path);need(disk&&disk.byteLength<=1052672,'missing');const parsed=readFrontmatter(decode(disk)),portable=parsed.identity;
   need(portable&&(['instanceId','accountId','campaignId','bindingId']as const).every(key=>portable[key]===identity[key])&&portable.entityId===entityId,'identity_changed');
   const editor=writer.editor.snapshot(path);need(!editor||editor.token!=='multiple-editors'&&Buffer.byteLength(editor.text)<=1052672,'editor_unavailable');
   // Never inherit replacement authority from an historical reserved identity.
   const output=Buffer.from(attachIdentity(stripIdentity(text),{version:1,instanceId:identity.instanceId,accountId:identity.accountId,campaignId:identity.campaignId,bindingId:identity.bindingId,entityId}));
   need(output.byteLength<=1052672,'size');need(hashBytes(output)!==hashBytes(disk)||editor&&editor.text!==output.toString(),'unchanged');await live();
   const plan:RestorePlan={id:randomUUID(),identity:structuredClone(identity),root,mode:'restore',expectedCursor:snapshot.cursor,cursor:snapshot.cursor,baseHash:stableHash(base),blobs:[],entries:[{id:randomUUID(),kind:'note',path,entityId,expectedHash:hashBytes(disk),preimageHash:hashBytes(disk),outputHash:hashBytes(output),byteSize:output.byteLength,status:'prepared',reason:null,nextBase:null,dependencies:[],editorHash:editor?hashBytes(editor.text):null,editorToken:editor?.token??null,manualApproved:true,output,preimage:Uint8Array.from(disk),editorPreimage:editor?Buffer.from(editor.text):null,blockedReason:null}],hash:''};
   plan.hash=planFingerprint(plan);return plan;
  },
  async applyRestore(inputPlan:RestorePlan){
   const plan=structuredClone(inputPlan);need(writer,'writer_unavailable');need(plan.mode==='restore'&&plan.hash===planFingerprint(plan)&&sameIdentity(plan.identity,identity)&&plan.root===root&&plan.entries.length===1,'plan_changed');await live();
   const token=await queue.resume('pull');
   try{
    const guard=async()=>{await live();await queue.renew(token);};await guard();const entry=plan.entries[0];await noPush(entry.path,entry.entityId!);
    const snapshot=await state.load(identity,root);need(stableHash(snapshot.bases.find(row=>row.entityId===entry.entityId&&row.path===entry.path))===plan.baseHash,'base_changed');
    return await applyVaultPlan(plan,{...writer,state,assertContext:guard});
   }finally{try{await queue.release(token);}catch{/* never release a newer worker's lease */}}
  },
 };
}
