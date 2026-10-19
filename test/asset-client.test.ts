import test from 'node:test';
import assert from 'node:assert/strict';
import {createProtocolClient} from '../src/protocol/client.js';
import fixtures from '../contracts/v1/valid.json';
import {hashBytes} from '../src/documents/hashes.js';

const identity={connectionId:'local',instanceId:'site',accountId:'user',campaignId:'camp',bindingId:'bind'},data=Buffer.from('image-data'),sha256=hashBytes(data),descriptor={id:'image',mime:'image/png',byteSize:data.length,sha256,relativePath:`_assets/dndplace/${sha256}.png`};
const connection=()=>structuredClone(fixtures.find(row=>row.kind==='connection')!.value) as any;
test('private image reads stay in captured binding, include identity guards and verify exact bytes',async()=>{
  const dto=connection(),client=createProtocolClient({json:async()=>dto,bytes:async(path,options)=>{assert.equal(path,'campaigns/camp/bindings/bind/assets/image');assert.equal(options!.expectedAccountId,'user');assert.equal(options!.expectedInstanceId,'site');assert.equal(options!.maxBytes,data.length);return data;}},identity);
  assert.deepEqual(Buffer.from(await client.asset(descriptor)),data);
});
test('wrong size/hash, unsafe IDs and switched accounts fail closed',async()=>{
  const dto=connection();let reads=0;
  const client=createProtocolClient({json:async()=>dto,bytes:async()=>{reads++;return Buffer.from('corrupt');}},identity);
  await assert.rejects(client.asset(descriptor));assert.equal(reads,1);
  await assert.rejects(client.asset({...descriptor,id:'../outside'}));assert.equal(reads,1);
  dto.account.id='different';await assert.rejects(client.asset(descriptor));assert.equal(reads,1);
});
test('image descriptors are captured before the asynchronous handshake',async()=>{
  const dto=connection(),input={...descriptor},client=createProtocolClient({json:async()=>dto,bytes:async()=>data},identity),pending=client.asset(input);input.sha256='a'.repeat(64);assert.deepEqual(Buffer.from(await pending),data);
});
test('document reads forward cancellation through both handshake and scoped request',async()=>{
  const dto=connection(),document=structuredClone(fixtures.find(row=>row.kind==='document')!.value) as any,controller=new AbortController(),signals:unknown[]=[];
  const client=createProtocolClient({json:async(path,options)=>{signals.push(options?.signal);return path==='connection'?dto:document;}},identity);
  await client.document(document.id,document.revision,{signal:controller.signal});assert.deepEqual(signals,[controller.signal,controller.signal]);
});
