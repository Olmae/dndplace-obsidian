import type {LocalBinding} from '../bindings/registry.js';
import type {SyncState} from '../sync/state.js';
import type {SyncQueue} from '../sync/queue.js';
import type {createSyncCoordinator} from '../sync/coordinator.js';
import type {WriteAdapters} from '../sync/vault-writer.js';
import {automaticBinding} from '../sync/event-guard.js';
import {loadLocalDocuments} from './local-capture.js';
import {reviewCanApply} from '../sync/review.js';
import {hashBytes} from '../documents/hashes.js';
type Session={root:LocalBinding;live:()=>Promise<void>;queue:SyncQueue;coordinator:ReturnType<typeof createSyncCoordinator>;writer:Omit<WriteAdapters,'state'|'assertContext'>};
export function createAutomaticCycle(options:{session:(id:string,signal:AbortSignal)=>Session;state:SyncState;deviceId:string;paths:()=>string[]}){
  const offsets=new Map<string,number>();
  async function ready(s:Session){await s.live();const state=await options.state.load(s.root.identity,s.root.root),queue=await s.queue.snapshot();return state.bases.length>0&&!state.pending.length&&!state.journals.some(row=>row.status!=='completed')&&!queue.jobs.some(row=>row.state!=='acknowledged');}
  return {
    async eligible(id:string,signal:AbortSignal){return ready(options.session(id,signal));},
    async cycle(id:string,signal:AbortSignal):Promise<'ok'|'review'>{
      const s=options.session(id,signal);if(!automaticBinding(s.root,options.deviceId))throw Object.assign(Error('Автообмен выключен'),{code:'automation_disabled'});
      if(!await ready(s))return 'review';const snapshot=await options.state.load(s.root.identity,s.root.root),paths=options.paths();
      const start=(offsets.get(id)??0)%snapshot.bases.length,bases=[...snapshot.bases.slice(start),...snapshot.bases.slice(0,start)].slice(0,32);offsets.set(id,start+bases.length);
      // A baseline is not permission to recreate a removed note or publish an unsaved buffer.
      for(const base of bases){await s.live();if(!paths.includes(base.path))return 'review';const disk=await s.writer.vault.read(base.path),editor=s.writer.editor.snapshot(base.path);if(!disk||editor&&hashBytes(editor.text)!==hashBytes(disk))return 'review';}
      const documents=await loadLocalDocuments({binding:s.root,bases:snapshot.bases,paths,selected:bases.map(row=>row.path),read:s.writer.vault.read,snapshotEditor:s.writer.editor.snapshot,readBlob:options.state.storage.readBlob,assertContext:s.live});
      const preview=await s.coordinator.previewPush(documents);
      if(preview.actions.some(row=>!['unchanged','pull','push'].includes(row.action)||row.needsBaseRefresh))return 'review';
      const pulls=preview.actions.filter(row=>row.action==='pull');
      // Do not mix a generation-changing receive and a staged upload in one approval.
      if(pulls.length){
        const selections=pulls.map(row=>{const base=bases.find(base=>base.entityId===row.entityId)!;return {path:base.path,entityId:base.entityId,revision:base.serverRevision};});
        // previewPush does not expose current remote revisions; fetch them via a bounded index supplied by the coordinator.
        const versions=await s.coordinator.automaticPullVersions(selections.map(row=>row.entityId));
        if(versions.length!==selections.length)return 'review';
        const plan=await s.coordinator.previewPull(selections.map(row=>({...row,revision:versions.find(version=>version.entityId===row.entityId)!.revision})),{mode:'automatic'});
        if(plan.entries.some(row=>row.blockedReason))return 'review';
        await s.coordinator.applyPull(plan);await s.live();return 'ok';
      }
      if(!preview.packages.length)return 'ok';
      const jobs=await s.coordinator.applyPush(preview);
      for(const job of jobs){
        const stage=await s.coordinator.runPush();await s.live();const current=(await s.queue.snapshot()).jobs.find(row=>row.id===job.id);if(stage.state!=='review'||stage.jobId!==job.id||!current||stage.plan.rows.some(row=>row.action==='create'||row.status==='conflict')||!reviewCanApply(current,stage.plan,s.root.root))return 'review';
        await s.queue.approve(job.id,stage.plan.planId,stage.plan.planHash);await s.live();
        const applied=await s.coordinator.runPush();if(applied.state!=='local-pending'||applied.jobId!==job.id)return 'review';
        await s.coordinator.recoverPending();await s.live();
      }
      return await ready(s)?'ok':'review';
    },
  };
}
