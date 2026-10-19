import type {QueueJob} from './queue.js';
import type {ReviewPlanDTO} from '../protocol/transfers.js';

/** Same gate for rendering an approval and executing it. An explicit overwrite
 * may resolve a conflict only for its captured entity and fresh remote revision. */
export function reviewCanApply(job:QueueJob,plan:ReviewPlanDTO,root:string){
 if(plan.planId!==job.planId||plan.planHash!==job.planHash||plan.stale||plan.diagnostics.some(row=>row.severity==='error')||plan.rows.length!==job.notes.length)return false;
 const seen=new Set<string>();
 for(const row of plan.rows){
  const note=job.notes.find(note=>note.path.slice(root.length+1)===row.path);if(!note||seen.has(row.path)||row.diagnostics.some(row=>row.severity==='error'))return false;seen.add(row.path);
  const conflict=job.overwrite&&row.status==='conflict'&&row.action==='replace'&&row.entityId===job.overwrite.entityId&&row.expectedRevision===job.overwrite.revision;
  if(!['new','changed','unchanged'].includes(row.status)&&!conflict)return false;
  if(row.action!==(note.entityId===null?'create':'replace')&&!(row.status==='unchanged'&&row.action==='skip'))return false;
  if(note.entityId!==null&&(row.entityId!==note.entityId||row.expectedRevision!==(job.overwrite?.revision??note.baseVersion!.revision)))return false;
 }
 return true;
}
