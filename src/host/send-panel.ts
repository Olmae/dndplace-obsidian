import {randomUUID} from 'node:crypto';
import type {LocalBinding} from '../bindings/registry.js';
import type {Connection} from '../connection/settings.js';
import {stableHash} from '../documents/hashes.js';
import {localNoteChoices,loadLocalDocuments} from './local-capture.js';
import type {createSyncCoordinator,PushPreview} from '../sync/coordinator.js';
import type {SyncQueue,QueueJob} from '../sync/queue.js';
import type {SyncState} from '../sync/state.js';
import type {WriteAdapters} from '../sync/vault-writer.js';
import type {ReviewPlanDTO} from '../protocol/transfers.js';
import {reviewCanApply} from '../sync/review.js';
import {PanelError} from '../ui/controller.js';
import type {SendPanelService,Review,TransferResult} from '../ui/controller.js';

type Session={root:LocalBinding;captured:Connection;live:()=>Promise<void>;queue:SyncQueue;coordinator:ReturnType<typeof createSyncCoordinator>;writer:Omit<WriteAdapters,'state'|'assertContext'>};
type Context={localId:string;root:LocalBinding;connection:Connection};
const same=(a:unknown,b:unknown)=>stableHash(a)===stableHash(b);
const active=(job:QueueJob)=>!['acknowledged','conflict'].includes(job.state);
const statuses={create:'Новая запись',push:'Обновление на сайте',unchanged:'Без изменений',pull:'На сайте есть новая версия — сначала получите её',conflict:'Изменено с обеих сторон — требуется решение',missing:'Исходная запись отсутствует — требуется проверка','copy-review':'Проверьте привязку и вложения'};

export function createSendPanelService(options:{session:(localId:string,signal:AbortSignal)=>Session;state:SyncState;paths:()=>string[]}):SendPanelService{
  const captures=new Map<string,Context&{plan:PushPreview;allowed:boolean}>(),reviews=new Map<string,Context&{jobId:string;plan:ReviewPlanDTO}>();
  const context=(localId:string,s:Session):Context=>({localId,root:structuredClone(s.root),connection:structuredClone(s.captured)});
  async function checked<T extends Context>(saved:T|undefined,localId:string,s:Session){await s.live();if(!saved||saved.localId!==localId||!same(saved.root,s.root)||!same(saved.connection,s.captured))throw new PanelError('preview_changed');return saved;}
  async function serverReview(localId:string,s:Session,jobId:string,plan:ReviewPlanDTO):Promise<Review>{
    const job=(await s.queue.snapshot()).jobs.find(job=>job.id===jobId);
    if(!job||job.planId!==plan.planId||job.planHash!==plan.planHash||plan.stale||!same(await s.queue.review(jobId),plan))throw new PanelError('preview_changed');
    const allowed=reviewCanApply(job,plan,s.root.root);
    const id=randomUUID();reviews.clear();reviews.set(id,{...context(localId,s),jobId,plan:structuredClone(plan)});
    return {id,stage:'server',overwrite:!!job.overwrite,canConfirm:allowed,rows:plan.rows.map(row=>({path:s.root.root+'/'+row.path,title:row.title,status:job.overwrite?'Перезаписать версию '+job.overwrite.revision+' на сайте':row.status==='new'?'Создать на сайте':row.status==='changed'?'Заменить проверенную версию':row.status==='unchanged'?'Без изменений':'Требуется решение конфликта',...(job.overwrite?{before:row.before?.content??null,after:row.after?.content??null,expectedRevision:row.expectedRevision}: {})}))};
  }
  async function result(s:Session,ids:string[]):Promise<TransferResult>{
    await s.coordinator.recoverPending();const jobs=(await s.queue.snapshot()).jobs.filter(job=>ids.includes(job.id));
    return {written:jobs.filter(job=>job.state==='acknowledged').reduce((sum,job)=>sum+job.notes.length,0),pending:jobs.filter(job=>job.state!=='acknowledged').reduce((sum,job)=>sum+job.notes.length,0)};
  }
  return {
    async notes(localId,signal){const s=options.session(localId,signal);await s.live();return localNoteChoices(options.paths(),s.root);},
    async preview(localId,paths,signal){
      const s=options.session(localId,signal);await s.live();if((await s.queue.snapshot()).jobs.some(active))throw new PanelError('send_pending');
      const snapshot=await options.state.load(s.root.identity,s.root.root),documents=await loadLocalDocuments({binding:s.root,bases:snapshot.bases,paths:options.paths(),selected:paths,read:s.writer.vault.read,snapshotEditor:s.writer.editor.snapshot,readBlob:options.state.storage.readBlob,assertContext:s.live});
      const plan=await s.coordinator.previewPush(documents);await s.live();const allowed=plan.packages.length===1&&plan.actions.every(action=>['create','push','unchanged'].includes(action.action));
      captures.clear();captures.set(plan.id,{...context(localId,s),plan,allowed});
      return {id:plan.id,stage:'capture',canConfirm:allowed,rows:plan.actions.map((action,index)=>({path:documents[index].path,title:documents[index].title,status:statuses[action.action],detail:documents[index].diagnostics.slice(0,3).map(row=>row.message).join(' · ')}))};
    },
    async stage(localId,id,signal){
      const s=options.session(localId,signal),saved=await checked(captures.get(id),localId,s);if(!saved.allowed)throw new PanelError('preview_changed');captures.delete(id);
      const jobs=await s.coordinator.applyPush(saved.plan);if(jobs.length!==1)throw new PanelError('preview_changed');
      const next=await s.coordinator.runPush();await s.live();if(next.state!=='review'||next.jobId!==jobs[0].id)throw new PanelError('preview_changed');return serverReview(localId,s,next.jobId,next.plan);
    },
    async apply(localId,id,signal){
      const s=options.session(localId,signal),saved=await checked(reviews.get(id),localId,s);reviews.delete(id);
      const latest=await serverReview(localId,s,saved.jobId,saved.plan);if(latest.canConfirm===false)throw new PanelError('preview_changed');reviews.clear();
      await s.queue.approve(saved.jobId,saved.plan.planId,saved.plan.planHash);await s.live();const next=await s.coordinator.runPush();if(next.state!=='local-pending'||next.jobId!==saved.jobId)throw new PanelError('preview_changed');return result(s,[saved.jobId]);
    },
    async resume(localId,signal){
      const s=options.session(localId,signal);await s.live();const ids=(await s.queue.snapshot()).jobs.filter(active).map(job=>job.id);if(!ids.length)return {kind:'done',result:{written:0,pending:0}};
      await s.queue.retry();await s.coordinator.recoverPending();const next=await s.coordinator.runPush();await s.live();
      if(next.state==='review')return {kind:'review',review:await serverReview(localId,s,next.jobId,next.plan)};
      return {kind:'done',result:await result(s,ids)};
    },
    dispose(){captures.clear();reviews.clear();},
  };
}
