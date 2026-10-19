import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {createSyncQueue} from '../src/sync/queue.js';
import {createFileSyncStorage} from '../src/sync/file-storage.js';
import {hashBytes} from '../src/documents/hashes.js';
import type {SyncStorage} from '../src/sync/state.js';

const identity={connectionId:'connection',instanceId:'site',accountId:'dm',campaignId:'camp',bindingId:'binding'};
const h=hashBytes('version-one');
function memory():SyncStorage{
  const rows=new Map<string,string>(),blobs=new Map<string,Uint8Array>();
  return {read:async key=>rows.get(key)??null,compareAndSwap:async(key,expected,next)=>{if((rows.get(key)??null)!==expected)return false;rows.set(key,next);return true;},putBlob:async data=>{const hash=hashBytes(data);blobs.set(hash,Uint8Array.from(data));return hash;},readBlob:async hash=>{const data=blobs.get(hash);if(!data)throw Error('missing blob');return Uint8Array.from(data);}};
}
const capture=(path='Game/One.md')=>({packageBytes:Buffer.from('synthetic-package'),notes:[{path,entityId:null,localFileHash:h,baseVersion:null}]});
const queue=(storage:SyncStorage,extra:Record<string,unknown>={})=>createSyncQueue({identity,deviceId:'device',root:'Game',storage,...extra});
test('overwrite intent is durable and bound to one existing note and its captured facts',async()=>{const storage=memory(),q=queue(storage),base={entityId:'note',revision:1,sourceHash:h},overwrite={entityId:'note',revision:2,sourceHash:hashBytes('remote')},input={...capture(),notes:[{...capture().notes[0],entityId:'note',baseVersion:base}],overwrite,capture:Buffer.from(JSON.stringify({overwrite}))};const job=await q.enqueue(input);overwrite.revision=99;const saved=(await queue(storage).snapshot()).jobs[0];assert.equal(saved.overwrite!.revision,2);assert.deepEqual(saved,job);});
test('malformed or unbacked overwrite intent is rejected before writing package blobs',async()=>{const storage=memory();let writes=0;storage.putBlob=async()=>{writes++;return h;};const q=queue(storage);for(const overwrite of [{entityId:'other',revision:2,sourceHash:h},{entityId:'note',revision:0,sourceHash:h},{entityId:'note',revision:2,sourceHash:'bad'}])await assert.rejects(q.enqueue({...capture(),notes:[{...capture().notes[0],entityId:'note',baseVersion:{entityId:'note',revision:1,sourceHash:h}}],overwrite,capture:Buffer.from('{}')}));assert.equal(writes,0);});

test('captured bytes, hashes and operation IDs survive reopening without retaining caller objects',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dnd-queue-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const storage=createFileSyncStorage({root}),q=queue(storage),input=capture(),job=await q.enqueue(input);
  input.packageBytes.fill(0);input.notes[0].localFileHash=hashBytes('later edit');input.notes[0].path='Game/Later.md';
  const reopened=queue(createFileSyncStorage({root})),saved=(await reopened.snapshot()).jobs[0];
  assert.deepEqual(saved,job);assert.equal(saved.notes[0].localFileHash,h);assert.equal(saved.notes[0].path,'Game/One.md');
  assert.equal(Buffer.from(await reopened.packageBytes(job.id)).toString(),'synthetic-package');
  assert.match(saved.operationId,/^[a-f0-9-]{36}$/);assert.notEqual(saved.operationId,saved.id);
});
test('two independent windows retain both enqueues using compare-and-swap',async()=>{
  const storage=memory(),a=queue(storage),b=queue(storage);
  await Promise.all([a.enqueue(capture('Game/A.md')),b.enqueue(capture('Game/B.md'))]);
  assert.equal((await a.snapshot()).jobs.length,2);
});
test('an explicit enqueue ID is idempotent but cannot be reused for another capture',async()=>{
  const q=queue(memory()),id='e221317d-3df2-4a69-8100-9a4a36d0a678';
  const first=await q.enqueue(capture(),id);assert.deepEqual(await q.enqueue(capture(),id),first);
  await assert.rejects(q.enqueue(capture('Game/Other.md'),id));assert.equal((await q.snapshot()).jobs.length,1);
});
test('two windows cannot enqueue overlapping unfinished captures with different job IDs',async()=>{
  const storage=memory(),a=queue(storage),b=queue(storage),outcomes=await Promise.allSettled([a.enqueue(capture()),b.enqueue(capture())]);assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);assert.equal((await a.snapshot()).jobs.length,1);
});
test('scopes and devices are independent while rebinding an existing queue root fails closed',async()=>{
  const storage=memory(),a=queue(storage);await a.enqueue(capture());
  for(const extra of [{deviceId:'other'},{identity:{...identity,accountId:'other'}},{identity:{...identity,instanceId:'other'}},{identity:{...identity,campaignId:'other'}}])assert.equal((await queue(storage,extra).snapshot()).jobs.length,0);
  await assert.rejects(queue(storage,{root:'Other'}).snapshot());
});
test('copied device state, unknown fields and malformed records fail closed',async()=>{
  const storage=memory(),q=queue(storage);await q.enqueue(capture());
  for(const mutate of [(s:any)=>{s.deviceId='copied';},(s:any)=>{s.secret='not-allowed';},(s:any)=>{s.bindings[0].jobs[0].operationId='not-a-uuid';}]){
    const bad={...storage,read:async(key:string)=>{const value=await storage.read(key);if(!value)return null;const state=JSON.parse(value);mutate(state);return JSON.stringify(state);}};
    await assert.rejects(queue(bad).snapshot());
  }
});
test('unsafe, out-of-root, duplicate notes and invalid base versions are rejected before storage',async()=>{
  let writes=0;const storage=memory(),original=storage.putBlob;storage.putBlob=async data=>{writes++;return original(data);};const q=queue(storage);
  for(const input of [capture('Elsewhere/A.md'),capture('Game/.obsidian/config.md'),{...capture(),notes:[...capture().notes,...capture().notes]}, {...capture(),notes:[{...capture().notes[0],entityId:'one',baseVersion:{entityId:'two',revision:1,sourceHash:h}}]}, {...capture(),notes:[{...capture().notes[0],secret:'not-allowed'}]}])await assert.rejects(q.enqueue(input as any));
  assert.equal(writes,0);assert.equal((await q.snapshot()).jobs.length,0);
});
test('batch bounds are enforced before storage',async()=>{
  const q=queue(memory());
  for(const input of [{...capture(),packageBytes:Buffer.alloc(0)},{...capture(),packageBytes:Buffer.alloc(33554433)},{...capture(),notes:[]},{...capture(),notes:Array.from({length:33},(_,i)=>({...capture().notes[0],path:`Game/${i}.md`}))}])await assert.rejects(q.enqueue(input));
});
test('missing or corrupt content-addressed package cannot be sent',async()=>{
  const storage=memory(),q=queue(storage),job=await q.enqueue(capture());
  await assert.rejects(queue({...storage,readBlob:async()=>Buffer.from('tampered')}).packageBytes(job.id));
  await assert.rejects(queue({...storage,readBlob:async()=>{throw Error('missing');}}).packageBytes(job.id));
});
test('one durable campaign lease serializes separate windows and separate binding roots',async()=>{
  const storage=memory(),a=queue(storage),b=queue(storage),other=queue(storage,{identity:{...identity,bindingId:'second'},root:'Other'});
  const token=await a.resume();await assert.rejects(b.resume());await assert.rejects(other.resume());
  await a.release(token);const second=await other.resume();await other.release(second);assert.ok(await b.resume());
});
test('identity property order cannot bypass the durable campaign lease',async()=>{
  const storage=memory(),a=queue(storage),reordered={bindingId:'binding',campaignId:'camp',accountId:'dm',instanceId:'site',connectionId:'connection'},b=queue(storage,{identity:reordered});
  await a.enqueue(capture());assert.equal((await b.snapshot()).jobs.length,1);
  const token=await a.resume();await assert.rejects(b.resume());await a.release(token);
});
test('separate OS processes cannot hold the same campaign lease concurrently',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'dnd-queue-process-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const {build}=createRequire(resolve('package.json'))('esbuild'),worker=join(directory,'worker.mjs'),root=join(directory,'state');
  await build({stdin:{contents:`import {createSyncQueue} from './src/sync/queue.ts';import {createFileSyncStorage} from './src/sync/file-storage.ts';const [root,mode]=process.argv.slice(2);const q=createSyncQueue({identity:${JSON.stringify(identity)},root:'Game',deviceId:'device',storage:createFileSyncStorage({root})});try{const token=await q.resume();process.stdout.write('acquired\\n');if(mode==='hold')await new Promise(resolve=>process.stdin.once('data',resolve));await q.release(token);process.exit(0);}catch(e){process.stdout.write(e.code+'\\n');process.exit(e.code==='queue_busy'?2:3);}`,resolveDir:process.cwd(),loader:'ts',sourcefile:'queue-worker.ts'},outfile:worker,bundle:true,platform:'node',target:'node22',format:'esm',logLevel:'silent'});
  const first=spawn(process.execPath,[worker,root,'hold']);t.after(()=>{if(first.exitCode===null)first.kill();});const firstExit=once(first,'exit');
  const [output]=await once(first.stdout,'data');assert.equal(String(output),'acquired\n');
  const second=spawn(process.execPath,[worker,root,'try']);const [code]=await once(second,'exit');assert.equal(code,2);
  first.stdin.end('release\n');assert.equal((await firstExit)[0],0);
  const third=spawn(process.execPath,[worker,root,'try']);assert.equal((await once(third,'exit'))[0],0);
});
test('lease expiration fences a stale worker without invalidating a new owner',async()=>{
  let now=1000;const storage=memory(),a=queue(storage,{clock:()=>now,leaseMs:1000}),b=queue(storage,{clock:()=>now,leaseMs:1000});
  const job=await a.enqueue(capture()),old=await a.resume();now+=1001;const fresh=await b.resume();
  await assert.rejects(a.renew(old));await assert.rejects(a.transition(old,job.id,'queued',{state:'staged',transferId:'transfer'}));await assert.rejects(a.release(old));
  await b.transition(fresh,job.id,'queued',{state:'staged',transferId:'transfer'});assert.equal((await b.snapshot()).jobs[0].state,'staged');
});
test('pause survives restart and fences the pausing owner; explicit retry preserves the operation',async()=>{
  const storage=memory(),a=queue(storage),job=await a.enqueue(capture()),token=await a.resume();
  await a.pause('network');await assert.rejects(a.transition(token,job.id,'queued',{state:'staged',transferId:'transfer'}));
  const reopened=queue(storage);await assert.rejects(reopened.resume());assert.equal((await reopened.snapshot()).pauseReason,'network');
  await reopened.retry();const lease=await reopened.resume();assert.equal((await reopened.snapshot()).jobs[0].operationId,job.operationId);await reopened.release(lease);
});
test('a second window can pause but cannot prematurely release an active worker lease',async()=>{
  const storage=memory(),a=queue(storage),b=queue(storage),job=await a.enqueue(capture()),token=await a.resume();
  await b.pause('manual');await assert.rejects(a.transition(token,job.id,'queued',{state:'staged',transferId:'transfer'}));
  await b.retry();await assert.rejects(b.resume());await a.release(token);assert.ok(await b.resume());
});
async function reviewed(q:ReturnType<typeof queue>){
  const job=await q.enqueue(capture()),token=await q.resume();
  await q.transition(token,job.id,'queued',{state:'staged',transferId:'transfer'});
  await q.transition(token,job.id,'staged',{state:'review',planId:'plan',planHash:h});return {job,token};
}
test('review requires explicit approval of the exact persisted plan before applying',async()=>{
  const q=queue(memory()),{job,token}=await reviewed(q);
  await assert.rejects(q.transition(token,job.id,'review',{state:'applying'}));
  await assert.rejects(q.approve(job.id,'other-plan',h));await assert.rejects(q.approve(job.id,'plan',hashBytes('changed')));
  await q.approve(job.id,'plan',h);await q.transition(token,job.id,'review',{state:'applying'});
  assert.equal((await q.snapshot()).jobs[0].state,'applying');
});
test('an uncertain commit recovers with the same IDs; acknowledgement requires its matching receipt',async()=>{
  const storage=memory(),q=queue(storage),{job,token}=await reviewed(q);await q.approve(job.id,'plan',h);
  await q.transition(token,job.id,'review',{state:'applying'});await q.transition(token,job.id,'applying',{state:'awaiting-receipt'});await q.release(token);
  const reopened=queue(storage),lease=await reopened.resume();
  await assert.rejects(reopened.transition(lease,job.id,'awaiting-receipt',{state:'acknowledged'}));
  await assert.rejects(reopened.transition(lease,job.id,'awaiting-receipt',{state:'acknowledged',receipt:{operationId:'c89b98bc-32b0-452e-9d34-ea2a3265173e',archiveRevision:2}}));
  await reopened.transition(lease,job.id,'awaiting-receipt',{state:'acknowledged',receipt:{operationId:job.operationId,archiveRevision:2}});
  const saved=(await reopened.snapshot()).jobs[0];assert.equal(saved.operationId,job.operationId);assert.equal(saved.transferId,'transfer');assert.equal(saved.notes[0].localFileHash,h);
  await assert.rejects(reopened.transition(lease,job.id,'acknowledged',{state:'queued'}));
});
test('stale transitions and attempts to change captured destination/content are rejected',async()=>{
  const q=queue(memory()),job=await q.enqueue(capture()),token=await q.resume();
  await assert.rejects(q.transition(token,job.id,'queued',{state:'staged',transferId:'transfer',notes:[]} as any));
  await assert.rejects(q.transition(token,job.id,'queued',{state:'acknowledged',receipt:{operationId:job.operationId,archiveRevision:1}}));
  await q.transition(token,job.id,'queued',{state:'staged',transferId:'transfer'});
  await assert.rejects(q.transition(token,job.id,'queued',{state:'review',planId:'plan',planHash:h}));
  await assert.rejects(q.transition(token,job.id,'staged',{state:'review',transferId:'different',planId:'plan',planHash:h}));
});
test('durable commit errors never expose an unpersisted job',async()=>{
  const storage=memory(),q=queue({...storage,compareAndSwap:async()=>{throw Error('disk full');}});
  await assert.rejects(q.enqueue(capture()),/disk full/);assert.equal((await queue(storage).snapshot()).jobs.length,0);
});
test('captured local facts and the reviewed entity map survive restart as verified blobs',async()=>{
  const storage=memory(),q=queue(storage),captureBytes=Buffer.from('{"captured":"version-one"}');
  const job=await q.enqueue({...capture(),capture:captureBytes});captureBytes.fill(0);const token=await q.resume();
  await q.transition(token,job.id,'queued',{state:'staged',transferId:'transfer'});
  const review={planId:'plan',planHash:h,bindingId:'binding',archiveRevision:1,expiresAt:'2026-10-19T12:00:00.000Z',stale:false,rows:[],totals:{created:0,updated:0,skipped:0,folders:0},diagnostics:[]};
  await q.saveReview(token,job.id,review);await q.release(token);
  const reopened=queue(storage);assert.equal(Buffer.from(await reopened.captureBytes(job.id)).toString(),'{"captured":"version-one"}');assert.deepEqual(await reopened.review(job.id),review);
  await assert.rejects(queue({...storage,readBlob:async()=>Buffer.from('bad')}).captureBytes(job.id));
});
