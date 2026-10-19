import test from 'node:test';
import assert from 'node:assert/strict';
import {createProtocolClient} from '../src/protocol/client.js';
import fixtures from '../contracts/v1/valid.json';
import {hashBytes} from '../src/documents/hashes.js';

const identity={connectionId:'local',instanceId:'site',accountId:'user',campaignId:'camp',bindingId:'bind'};
const fixture=(kind:string)=>structuredClone(fixtures.find(row=>row.kind===kind)!.value) as any;
const reserve={deviceId:'device',clientTransferId:'client',packageHash:hashBytes('zip')};
const ref={id:'t',...reserve},planHash='c'.repeat(64),operationId='01570542-af50-42bd-b04c-a09ddc7e3cb0';
const apply={planId:'plan',planHash,operationId,confirmed:true as const};
function setup(){
  const connection=fixture('connection'),transfer={...fixture('transfer'),...ref},plan={...fixture('reviewPlan'),bindingId:'bind'};
  const calls:Array<{path:string;options:any}>=[];let onApply:()=>unknown=()=>({untrusted:'ignored'});
  const transport={
    json:async(path:string,options?:any):Promise<unknown>=>{
      calls.push({path,options:structuredClone(options)});if(path==='connection')return connection;
      if(path.endsWith('/apply')){const body=options.body;transfer.state='applied';transfer.planId=body.planId;transfer.planHash=body.planHash;transfer.operationId=body.operationId;transfer.receipt={operationId:body.operationId,archiveRevision:3};return onApply();}
      if(path.endsWith('/plan')){if(options?.method==='POST'){transfer.state='review';transfer.planId=plan.planId;transfer.planHash=plan.planHash;}return plan;}
      if(options?.method==='DELETE')transfer.state='canceled';return structuredClone(transfer);
    },
    uploadZip:async(path:string,bytes:Uint8Array,options?:any)=>{calls.push({path,options:{...options,bytes:Buffer.from(bytes)}});transfer.state='ready';return structuredClone(transfer);},
  };
  return {client:createProtocolClient(transport,identity),connection,transfer,plan,calls,transport,setApply:(handler:()=>unknown)=>{onApply=handler;}};
}
test('reserve, status, exact ZIP upload, immutable prepare and cancel use only captured binding paths',async()=>{
  const s=setup(),request={...reserve};assert.equal((await s.client.reserveTransfer(request)).id,'t');
  const uploaded=await s.client.uploadTransfer(ref,Buffer.from('zip'));assert.equal(uploaded.state,'ready');
  const plan=await s.client.prepareTransfer(ref,{baseVersions:[],choices:[]});assert.equal(plan.planId,'plan');
  assert.equal((await s.client.reviewTransfer(ref)).planHash,planHash);assert.equal((await s.client.cancelTransfer(ref)).state,'canceled');
  for(const call of s.calls.filter(call=>call.path!=='connection')){
    assert.ok(call.path.startsWith('campaigns/camp/bindings/bind/transfers'));
    assert.equal(call.options.expectedAccountId,'user');assert.equal(call.options.expectedInstanceId,'site');
  }
  assert.deepEqual(s.calls.find(call=>call.path.endsWith('/upload'))!.options.bytes,Buffer.from('zip'));
});
test('reserve responses cannot silently switch package, device, client ID or binding',async()=>{
  for(const mutation of [{packageHash:'f'.repeat(64)},{deviceId:'other'},{clientTransferId:'other'},{bindingId:'other'}]){
    const s=setup();Object.assign(s.transfer,mutation);await assert.rejects(s.client.reserveTransfer(reserve));
  }
});
test('transfer identity is verified before uploading, preparing or canceling',async()=>{
  for(const action of ['upload','prepare','cancel']){
    const s=setup();s.transfer.deviceId='another-device';
    await assert.rejects(action==='upload'?s.client.uploadTransfer(ref,Buffer.from('zip')):action==='prepare'?s.client.prepareTransfer(ref,{baseVersions:[],choices:[]}):s.client.cancelTransfer(ref));
    assert.equal(s.calls.filter(call=>call.path.endsWith('/upload')||call.options?.method==='POST'||call.options?.method==='DELETE').length,0);
  }
});
test('invalid requests, IDs and package hashes do not touch transport',async()=>{
  const s=setup();
  await assert.rejects(s.client.reserveTransfer({...reserve,secret:'not allowed'} as any));
  await assert.rejects(s.client.transferStatus({...ref,id:'../other'}));
  await assert.rejects(s.client.uploadTransfer(ref,Buffer.from('changed bytes')));
  await assert.rejects(s.client.prepareTransfer(ref,{baseVersions:[],choices:[],token:'no'} as any));
  await assert.rejects(s.client.applyTransfer(ref,{...apply,confirmed:false} as any));assert.equal(s.calls.length,0);
});
test('changed account blocks transfer writes including ZIP transport',async()=>{
  const s=setup();s.connection.account.id='other';await assert.rejects(s.client.uploadTransfer(ref,Buffer.from('zip')));
  assert.equal(s.calls.filter(call=>call.path!=='connection').length,0);
});
test('apply acknowledges only the matching durable status receipt, not raw apply JSON',async()=>{
  const s=setup();await s.client.prepareTransfer(ref,{baseVersions:[],choices:[]});
  const result=await s.client.applyTransfer(ref,apply);assert.equal(result.receipt!.operationId,operationId);assert.equal(result.receipt!.archiveRevision,3);
  assert.ok(!Object.hasOwn(result,'untrusted'));
  const before=s.calls.filter(call=>call.path.endsWith('/apply')).length;assert.equal((await s.client.applyTransfer(ref,apply)).state,'applied');
  assert.equal(s.calls.filter(call=>call.path.endsWith('/apply')).length,before);
});
test('lost apply response recovers a known commit through status without a second write',async()=>{
  const s=setup();await s.client.prepareTransfer(ref,{baseVersions:[],choices:[]});s.setApply(()=>{throw Error('lost response');});
  await assert.rejects(s.client.applyTransfer(ref,apply),/lost response/);const saved=await s.client.transferStatus(ref);
  assert.equal(saved.receipt!.operationId,operationId);assert.equal((await s.client.applyTransfer(ref,apply)).receipt!.operationId,operationId);
  assert.equal(s.calls.filter(call=>call.path.endsWith('/apply')).length,1);
});
test('stale plans, foreign reviews, mismatched and missing receipts never acknowledge',async()=>{
  const s=setup();await s.client.prepareTransfer(ref,{baseVersions:[],choices:[]});
  await assert.rejects(s.client.applyTransfer(ref,{...apply,planHash:'d'.repeat(64)}));assert.equal(s.calls.filter(call=>call.path.endsWith('/apply')).length,0);
  s.plan.bindingId='other';await assert.rejects(s.client.reviewTransfer(ref));s.plan.bindingId='bind';
  for(const receipt of [null,{operationId:'different',archiveRevision:3},{operationId,archiveRevision:-1}]){
    s.transfer.state='applied';s.transfer.operationId=operationId;s.transfer.receipt=receipt;await assert.rejects(s.client.transferStatus(ref));
  }
});
test('request captures input before any asynchronous identity handshake',async()=>{
  const s=setup(),request={...reserve},pending=s.client.reserveTransfer(request);request.packageHash='d'.repeat(64);await pending;
  assert.equal(s.calls.find(call=>call.options?.method==='POST')!.options.body.packageHash,reserve.packageHash);
});
