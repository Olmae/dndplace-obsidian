import test from 'node:test';
import assert from 'node:assert/strict';
import {createPushRunner} from '../src/sync/push.js';
import {createSyncQueue} from '../src/sync/queue.js';
import {hashBytes} from '../src/documents/hashes.js';
import type {SyncStorage} from '../src/sync/state.js';
import type {TransferDTO,ReviewPlanDTO} from '../src/protocol/transfers.js';

const identity={connectionId:'connection',instanceId:'site',accountId:'dm',campaignId:'camp',bindingId:'binding'},h=hashBytes('local-one'),planHash='b'.repeat(64);
function fixture(){
  const records=new Map<string,string>(),blobs=new Map<string,Uint8Array>();
  const storage:SyncStorage={read:async key=>records.get(key)??null,compareAndSwap:async(key,expected,next)=>{if((records.get(key)??null)!==expected)return false;records.set(key,next);return true;},putBlob:async bytes=>{const hash=hashBytes(bytes);blobs.set(hash,Uint8Array.from(bytes));return hash;},readBlob:async hash=>Uint8Array.from(blobs.get(hash)!)};
  const queue=createSyncQueue({identity,root:'Game',deviceId:'device',storage});
  const plan:ReviewPlanDTO={planId:'plan',planHash,bindingId:'binding',archiveRevision:1,expiresAt:'2026-10-19T12:00:00.000Z',stale:false,rows:[{path:'One.md',title:'One',status:'new',action:'create',entityId:null,expectedRevision:null,before:null,after:{title:'One',content:'One'},diagnostics:[]}],totals:{created:1,updated:0,skipped:0,folders:0},diagnostics:[]};
  let transfer:TransferDTO|null=null,loseCommitResponse=false,loseReserveResponse=false,loseUploadResponse=false;const calls:string[]=[],commands:any[]=[];
  const client={identity,
    reserveTransfer:async(input:any)=>{calls.push('reserve');transfer??={id:'transfer',bindingId:'binding',...input,state:'reserved',expiresAt:'2026-10-19T12:00:00.000Z',planId:null,planHash:null,operationId:null,receipt:null};if(loseReserveResponse){loseReserveResponse=false;throw Error('lost reserve response');}return structuredClone(transfer!);},
    transferStatus:async()=>{calls.push('status');assert.ok(transfer);return structuredClone(transfer);},
    uploadTransfer:async(_ref:any,bytes:Uint8Array)=>{calls.push('upload');assert.equal(hashBytes(bytes),transfer!.packageHash);transfer!.state='ready';if(loseUploadResponse){loseUploadResponse=false;throw Error('lost upload response');}return structuredClone(transfer!);},
    prepareTransfer:async(_ref:any,command:any)=>{calls.push('prepare');commands.push(structuredClone(command));transfer!.state='review';transfer!.planId=plan.planId;transfer!.planHash=plan.planHash;return structuredClone(plan);},
    reviewTransfer:async()=>{calls.push('review');return structuredClone(plan);},
    applyTransfer:async(_ref:any,command:any)=>{calls.push('apply');commands.push(structuredClone(command));transfer!.state='applied';transfer!.operationId=command.operationId;transfer!.receipt={operationId:command.operationId,archiveRevision:2};if(loseCommitResponse){loseCommitResponse=false;throw Error('lost commit response');}return structuredClone(transfer!);},
  };
  const capture=()=>({packageBytes:Buffer.from('zip'),notes:[{path:'Game/One.md',entityId:null,localFileHash:h,baseVersion:null}]});
  const runner=()=>createPushRunner({queue,client,assertContext:()=>{}});
  return {queue,client,plan,calls,commands,capture,runner,storage,get transfer(){return transfer!;},loseCommit:()=>{loseCommitResponse=true;},loseReserve:()=>{loseReserveResponse=true;},loseUpload:()=>{loseUploadResponse=true;}};
}
test('empty and paused queues cause no network requests',async()=>{
  const f=fixture();assert.equal((await f.runner().run()).state,'idle');await f.queue.pause('manual');await assert.rejects(f.runner().run());assert.deepEqual(f.calls,[]);
});
test('manual push stops at persisted review; only explicitly approved plan can apply',async()=>{
  const f=fixture(),job=await f.queue.enqueue(f.capture());assert.equal((await f.runner().run()).state,'review');
  assert.equal(f.calls.filter(call=>call==='apply').length,0);assert.equal((await f.queue.snapshot()).jobs[0].state,'review');
  await f.queue.approve(job.id,'plan',planHash);assert.equal((await f.runner().run()).state,'local-pending');
  const saved=(await f.queue.snapshot()).jobs[0];assert.equal(saved.receipt!.operationId,job.operationId);assert.equal(saved.state,'local-pending');assert.equal(saved.notes[0].localFileHash,h);
  assert.equal((await f.runner().run()).state,'idle');assert.equal(f.calls.filter(call=>call==='apply').length,1);
});
test('lost reserve reply recovers the same transfer instead of allocating a new operation',async()=>{
  const f=fixture(),job=await f.queue.enqueue(f.capture());f.loseReserve();await assert.rejects(f.runner().run(),/lost reserve/);
  assert.equal((await f.queue.snapshot()).jobs[0].state,'queued');await f.queue.retry();assert.equal((await f.runner().run()).state,'review');
  const saved=(await f.queue.snapshot()).jobs[0];assert.equal(saved.operationId,job.operationId);assert.equal(f.transfer.clientTransferId,job.id);assert.equal(f.calls.filter(call=>call==='upload').length,1);
});
test('lost upload reply checks status and never uploads the ready package again',async()=>{
  const f=fixture();await f.queue.enqueue(f.capture());f.loseUpload();await assert.rejects(f.runner().run(),/lost upload/);await f.queue.retry();
  assert.equal((await f.runner().run()).state,'review');assert.equal(f.calls.filter(call=>call==='upload').length,1);
});
test('lost commit response is durable awaiting-receipt and recovers after restart without another apply',async()=>{
  const f=fixture(),job=await f.queue.enqueue(f.capture());await f.runner().run();await f.queue.approve(job.id,'plan',planHash);f.loseCommit();
  await assert.rejects(f.runner().run(),/lost commit/);assert.equal((await f.queue.snapshot()).jobs[0].state,'awaiting-receipt');
  const reopened=createSyncQueue({identity,root:'Game',deviceId:'device',storage:f.storage});await reopened.retry();
  const runner=createPushRunner({queue:reopened,client:f.client,assertContext:()=>{}});assert.equal((await runner.run()).state,'local-pending');
  assert.equal(f.calls.filter(call=>call==='apply').length,1);assert.equal((await reopened.snapshot()).jobs[0].operationId,job.operationId);
});
test('expired staging cannot hide an already committed receipt',async()=>{
  const f=fixture(),job=await f.queue.enqueue(f.capture());await f.runner().run();await f.queue.approve(job.id,'plan',planHash);f.loseCommit();await assert.rejects(f.runner().run());
  f.transfer.expiresAt='2020-01-01T00:00:00.000Z';await f.queue.retry();assert.equal((await f.runner().run()).state,'local-pending');
});
test('expired unknown outcome stays unresolved and keeps the same operation ID',async()=>{
  const f=fixture(),job=await f.queue.enqueue(f.capture());await f.runner().run();await f.queue.approve(job.id,'plan',planHash);
  const token=await f.queue.resume();await f.queue.transition(token,job.id,'review',{state:'applying'});await f.queue.transition(token,job.id,'applying',{state:'awaiting-receipt'});await f.queue.release(token);
  f.transfer.state='expired';await assert.rejects(f.runner().run());const saved=(await f.queue.snapshot()).jobs[0];assert.equal(saved.state,'awaiting-receipt');assert.equal(saved.operationId,job.operationId);assert.equal(saved.receipt,null);assert.equal(f.calls.filter(call=>call==='apply').length,0);
});
test('a changed review or conflict pauses before apply, even with earlier user approval',async()=>{
  for(const change of [(f:ReturnType<typeof fixture>)=>{f.plan.planHash='d'.repeat(64);},(f:ReturnType<typeof fixture>)=>{f.plan.stale=true;},(f:ReturnType<typeof fixture>)=>{f.plan.rows[0].status='conflict';}]){
    const f=fixture(),job=await f.queue.enqueue(f.capture());await f.runner().run();await f.queue.approve(job.id,'plan',planHash);change(f);await assert.rejects(f.runner().run());
    assert.equal(f.calls.filter(call=>call==='apply').length,0);assert.equal((await f.queue.snapshot()).paused,true);
  }
});
test('captured version is retained when a caller changes its source after enqueue',async()=>{
  const f=fixture(),capture=f.capture(),job=await f.queue.enqueue(capture);capture.notes[0].localFileHash=hashBytes('edited while sending');
  await f.runner().run();await f.queue.approve(job.id,'plan',planHash);await f.runner().run();
  assert.equal((await f.queue.snapshot()).jobs[0].notes[0].localFileHash,h);assert.notEqual((await f.queue.snapshot()).jobs[0].notes[0].localFileHash,capture.notes[0].localFileHash);
});
test('a context change or mismatched protocol client prevents any outgoing request',async()=>{
  const f=fixture();await f.queue.enqueue(f.capture());
  await assert.rejects(createPushRunner({queue:f.queue,client:f.client,assertContext:()=>{throw Error('changed context');}}).run());assert.deepEqual(f.calls,[]);
  await f.queue.retry();await assert.rejects(createPushRunner({queue:f.queue,client:{...f.client,identity:{...identity,campaignId:'other'}},assertContext:()=>{}}).run());assert.deepEqual(f.calls,[]);
});
test('existing notes send the captured base revision, not a newer server mapping',async()=>{
  const f=fixture(),capture={...f.capture(),notes:[{path:'Game/One.md',entityId:'note',localFileHash:h,baseVersion:{entityId:'note',revision:7,sourceHash:'a'.repeat(64)}}]};
  Object.assign(f.plan.rows[0],{status:'changed',action:'replace',entityId:'note',expectedRevision:7});await f.queue.enqueue(capture);await f.runner().run();
  assert.deepEqual(f.commands[0],{baseVersions:[capture.notes[0].baseVersion],choices:[{path:'One.md',action:'replace',targetId:'note',expectedRevision:7}]});
});
test('missing or foreign receipts never turn an uncertain operation into success',async()=>{
  for(const receipt of [null,{operationId:'wrong-operation',archiveRevision:2}]){
    const f=fixture(),job=await f.queue.enqueue(f.capture());await f.runner().run();await f.queue.approve(job.id,'plan',planHash);f.loseCommit();await assert.rejects(f.runner().run());
    f.transfer.receipt=receipt;await f.queue.retry();await assert.rejects(f.runner().run());
    const saved=(await f.queue.snapshot()).jobs[0];assert.equal(saved.receipt,null);assert.equal(saved.state,'awaiting-receipt');assert.equal(saved.operationId,job.operationId);
  }
});
test('a context change after server commit retains uncertainty and makes no local acknowledgement',async()=>{
  const f=fixture(),job=await f.queue.enqueue(f.capture());await f.runner().run();await f.queue.approve(job.id,'plan',planHash);
  const runner=createPushRunner({queue:f.queue,client:f.client,assertContext:()=>{if(f.transfer.state==='applied')throw Error('account changed');}});
  await assert.rejects(runner.run(),/account changed/);const saved=(await f.queue.snapshot()).jobs[0];assert.equal(saved.state,'awaiting-receipt');assert.equal(saved.receipt,null);
});
test('one campaign losing connection does not pause a separate campaign on the same device',async()=>{
  const f=fixture(),otherIdentity={...identity,campaignId:'another-campaign'},other=createSyncQueue({identity:otherIdentity,root:'Other',deviceId:'device',storage:f.storage});
  await f.queue.enqueue(f.capture());await other.enqueue({...f.capture(),notes:[{...f.capture().notes[0],path:'Other/One.md'}]});
  f.loseReserve();await assert.rejects(f.runner().run());assert.equal((await other.snapshot()).paused,false);
  const token=await other.resume();await other.release(token);assert.equal((await f.queue.snapshot()).paused,true);
});
