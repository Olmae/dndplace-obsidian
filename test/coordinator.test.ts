import test from 'node:test';
import assert from 'node:assert/strict';
import {createSyncCoordinator} from '../src/sync/coordinator.js';
import {prepareLocalDocument} from '../src/documents/identity.js';
import {createSyncQueue} from '../src/sync/queue.js';
import {createSyncState} from '../src/sync/state.js';
import {hashBytes,presentationHash} from '../src/documents/hashes.js';
import type {SyncStorage} from '../src/sync/state.js';
import type {DownloadDocument} from '../src/sync/pull.js';
import type {ReviewPlanDTO,TransferDTO} from '../src/protocol/transfers.js';

const identity={connectionId:'local',instanceId:'site',accountId:'dm',campaignId:'camp',bindingId:'binding'},binding={id:'root',identity,root:'Game'};
function fixture(){
  const rows=new Map<string,string>(),blobs=new Map<string,Uint8Array>();const storage:SyncStorage={read:async key=>rows.get(key)??null,compareAndSwap:async(key,expected,next)=>{if((rows.get(key)??null)!==expected)return false;rows.set(key,next);return true;},putBlob:async bytes=>{const hash=hashBytes(bytes);blobs.set(hash,Uint8Array.from(bytes));return hash;},readBlob:async hash=>Uint8Array.from(blobs.get(hash)!)};
  const state=createSyncState({deviceId:'device',storage}),queue=createSyncQueue({identity,root:'Game',deviceId:'device',storage}),local=prepareLocalDocument({path:'Game/One.md',source:'# One\nVersion one\n'},binding,{entries:[],assets:[]});
  const remote:DownloadDocument={protocolVersion:1,id:'server-note',revision:1,title:'One',markdown:local.source,sourceHash:local.portableHash,projectionHash:local.portableHash,metadata:{icon:'',favorite:false},assets:[],board:null,diagnostics:[]};
  const plan:ReviewPlanDTO={planId:'plan',planHash:'c'.repeat(64),bindingId:'binding',archiveRevision:1,expiresAt:'2026-10-19T12:00:00.000Z',stale:false,rows:[{path:'One.md',title:'One',status:'new',action:'create',entityId:'server-note',expectedRevision:null,before:null,after:{title:'One',content:'Version one'},diagnostics:[]}],totals:{created:1,updated:0,skipped:0,folders:0},diagnostics:[]};
  let transfer:TransferDTO|null=null;const calls:string[]=[];
  const client={identity,index:async()=>{calls.push('index');return {protocolVersion:1,archiveRevision:1,highWater:1,rows:transfer?.state==='applied'?[{id:remote.id,title:remote.title,folderId:null,revision:remote.revision,hasBoard:false}]:[],folders:[],nextCursor:null};},document:async(id:string,revision:number)=>{calls.push('document');assert.equal(id,remote.id);assert.equal(revision,remote.revision);return structuredClone(remote);},
    reserveTransfer:async(input:any)=>{transfer={id:'transfer',bindingId:'binding',...input,state:'reserved',expiresAt:'2026-10-19T12:00:00.000Z',planId:null,planHash:null,operationId:null,receipt:null};return structuredClone(transfer!);},transferStatus:async()=>structuredClone(transfer!),uploadTransfer:async()=>{transfer!.state='ready';return structuredClone(transfer!);},prepareTransfer:async()=>{transfer!.state='review';transfer!.planId=plan.planId;transfer!.planHash=plan.planHash;return structuredClone(plan);},reviewTransfer:async()=>structuredClone(plan),applyTransfer:async(_ref:any,input:any)=>{calls.push('apply');transfer!.state='applied';transfer!.operationId=input.operationId;transfer!.receipt={operationId:input.operationId,archiveRevision:2};return structuredClone(transfer!);},
  };
  const coordinator=()=>createSyncCoordinator({binding,state,queue,client,assertContext:()=>{}});
  async function committed(){const preview=await coordinator().previewPush([local]);const [job]=await coordinator().applyPush(preview);await coordinator().runPush();await queue.approve(job.id,plan.planId,plan.planHash);await coordinator().runPush();return job;}
  return {state,queue,local,remote,plan,client,calls,coordinator,committed};
}
test('capture, review and receipt produce a durable captured local base without writing the vault',async()=>{
  const f=fixture(),job=await f.committed();assert.equal((await f.queue.snapshot()).jobs[0].state,'local-pending');
  await f.coordinator().recoverPending();const saved=await f.state.load(identity,'Game');assert.equal(saved.bases.length,1);assert.equal(saved.bases[0].entityId,'server-note');assert.equal(saved.bases[0].localFileHash,f.local.localFileHash);assert.equal(saved.bases[0].basePortableHash,f.local.portableHash);assert.equal(saved.cursor,null);
  assert.equal((await f.queue.snapshot()).jobs.find(row=>row.id===job.id)!.state,'acknowledged');assert.equal(saved.ownWrites.length,0);assert.equal(saved.journals.length,0);
});
test('acknowledging a created copy clears its pending-local marker without suppressing later edits',async()=>{const f=fixture();await f.committed();await f.state.update(identity,'Game',state=>{state.pending.push({id:'copy',path:f.local.path,entityId:null,reason:'local-copy',journalId:null,remote:null});return state;});await f.coordinator().recoverPending();assert.equal((await f.state.load(identity,'Game')).pending.length,0);assert.equal((await f.state.load(identity,'Game')).ownWrites.length,0);});
test('a later local edit remains a push after the captured earlier version is acknowledged',async()=>{
  const f=fixture();await f.committed();await f.coordinator().recoverPending();const base=(await f.state.load(identity,'Game')).bases[0];
  const edited=prepareLocalDocument({path:f.local.path,source:'# One\nEdited while sending\n'},binding,{entries:[{path:base.path,entityId:base.entityId,identity,serverTitle:base.serverTitle,titleInputHash:base.titleInputHash,metadata:base.metadata}],assets:[]});
  const next=await f.coordinator().previewPush([edited]);assert.equal(next.actions[0].action,'push');assert.equal(next.packages.length,1);assert.equal(base.localFileHash,f.local.localFileHash);assert.notEqual(base.localFileHash,edited.localFileHash);
});
test('unchanged captured version produces no package and no subsequent writes',async()=>{
  const f=fixture();await f.committed();await f.coordinator().recoverPending();const base=(await f.state.load(identity,'Game')).bases[0],bound=prepareLocalDocument({path:base.path,source:f.local.source},binding,{entries:[{path:base.path,entityId:base.entityId,identity,serverTitle:base.serverTitle,titleInputHash:base.titleInputHash,metadata:base.metadata}],assets:[]});
  const preview=await f.coordinator().previewPush([bound]);assert.equal(preview.actions[0].action,'unchanged');assert.deepEqual(preview.packages,[]);assert.deepEqual(await f.coordinator().applyPush(preview),[]);assert.equal(f.calls.filter(call=>call==='apply').length,1);
});
test('a newer server document cannot be acknowledged as the captured commit',async()=>{
  const f=fixture();await f.committed();f.remote.revision=2;await assert.rejects(f.coordinator().recoverPending());assert.equal((await f.state.load(identity,'Game')).bases.length,0);assert.equal((await f.queue.snapshot()).jobs[0].state,'local-pending');
});
test('same revision with a different source hash cannot acknowledge a different document',async()=>{
  const f=fixture();await f.committed();f.remote.sourceHash=hashBytes('different');await assert.rejects(f.coordinator().recoverPending());assert.equal((await f.state.load(identity,'Game')).bases.length,0);
});
test('a stale preview, modified package or different binding is rejected before enqueue',async()=>{
  const f=fixture(),preview=await f.coordinator().previewPush([f.local]);preview.packages[0].bytes[0]^=1;await assert.rejects(f.coordinator().applyPush(preview));assert.equal((await f.queue.snapshot()).jobs.length,0);
  const fresh=await f.coordinator().previewPush([f.local]);await f.state.update(identity,'Game',state=>({...state,cursor:'changed'}));await assert.rejects(f.coordinator().applyPush(fresh));
});
test('recovering an already acknowledged operation is idempotent',async()=>{
  const f=fixture();await f.committed();await f.coordinator().recoverPending();const generation=(await f.state.load(identity,'Game')).generation,requests=f.calls.length;
  await f.coordinator().recoverPending();assert.equal((await f.state.load(identity,'Game')).generation,generation);assert.equal(f.calls.length,requests);
});
test('double-confirming one preview reuses its job, while a competing preview cannot duplicate that note',async()=>{
  const f=fixture(),preview=await f.coordinator().previewPush([f.local]),first=await f.coordinator().applyPush(preview),second=await f.coordinator().applyPush(preview);assert.equal(first[0].id,second[0].id);assert.equal((await f.queue.snapshot()).jobs.length,1);
  const competing=await f.coordinator().previewPush([f.local]);await assert.rejects(f.coordinator().applyPush(competing));assert.equal((await f.queue.snapshot()).jobs.length,1);
});
test('preview captures caller snapshots before asynchronous context checks',async()=>{
  const f=fixture(),pending=f.coordinator().previewPush([f.local]);f.local.source='# One\nChanged after click\n';f.local.portableHash=hashBytes(f.local.source);
  const preview=await pending;assert.equal(preview.packages[0].capture.documents[0].source,'# One\nVersion one\n');
});
test('two-sided edits stay a conflict instead of producing an upload package',async()=>{
  const f=fixture();await f.committed();await f.coordinator().recoverPending();const base=(await f.state.load(identity,'Game')).bases[0];
  f.remote.revision=2;f.remote.markdown='# One\nServer edit\n';f.remote.sourceHash=hashBytes(f.remote.markdown);f.remote.projectionHash=f.remote.sourceHash;
  const edited=prepareLocalDocument({path:base.path,source:'# One\nLocal edit\n'},binding,{entries:[{path:base.path,entityId:base.entityId,identity,serverTitle:base.serverTitle,titleInputHash:base.titleInputHash,metadata:base.metadata}],assets:[]}),preview=await f.coordinator().previewPush([edited]);
  assert.equal(preview.actions[0].action,'conflict');assert.deepEqual(preview.packages,[]);
});
test('receipt acknowledgement cannot downgrade a base advanced by another operation',async()=>{
  const f=fixture();await f.committed();const newer={identity,entityId:f.remote.id,path:f.local.path,localFileHash:f.local.localFileHash,basePortableHash:f.local.portableHash,localMetadataHash:f.local.metadataHash,assetHash:f.local.assetHash,serverSourceHash:hashBytes('newer'),projectionHash:hashBytes('newer'),serverRevision:2,remoteMetadataHash:presentationHash({title:'One',metadata:f.remote.metadata,board:null}),serverTitle:'One',titleInputHash:f.local.titleInputHash,metadata:f.remote.metadata,boardHash:null};
  await f.state.update(identity,'Game',state=>({...state,bases:[newer]}));await assert.rejects(f.coordinator().recoverPending());assert.equal((await f.state.load(identity,'Game')).bases[0].serverRevision,2);assert.equal((await f.queue.snapshot()).jobs[0].state,'local-pending');
});
test('failure after base commit but before queue acknowledgement safely recovers the same base',async()=>{
  const f=fixture();await f.committed();
  const broken={...f.queue,transition:async(...args:Parameters<typeof f.queue.transition>)=>{if(args[2]==='local-pending')throw Error('disk full after base commit');return f.queue.transition(...args);}};
  await assert.rejects(createSyncCoordinator({binding,state:f.state,queue:broken,client:f.client,assertContext:()=>{}}).recoverPending());assert.equal((await f.state.load(identity,'Game')).bases.length,1);assert.equal((await f.queue.snapshot()).jobs[0].state,'local-pending');
  await f.coordinator().recoverPending();assert.equal((await f.state.load(identity,'Game')).bases.length,1);assert.equal((await f.queue.snapshot()).jobs[0].state,'acknowledged');assert.equal(f.calls.filter(call=>call==='apply').length,1);
});
