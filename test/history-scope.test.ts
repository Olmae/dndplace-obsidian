import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryPanelService} from '../src/host/history-panel.js';
import {TransportError} from '../src/connection/transport.js';
import {hashBytes} from '../src/documents/hashes.js';

test('authenticated-site entry is offered only after a fresh authorized history read',async()=>{
  const f=fixture(),fresh=await f.service.list('local',f.notes[0],undefined,f.signal);
  assert.equal(fresh.siteUrl,'https://example.test/dm/camp/prep?open=note%3Aone');
  f.setFailure(new TransportError('network_error','offline'));
  const cached=await f.service.list('local',f.notes[0],undefined,f.signal);
  assert.equal(cached.remoteStatus,'cache');assert.equal(cached.siteUrl,undefined);
  f.setFailure(new TransportError('integration_forbidden','revoked',403));
  const denied=await f.service.list('local',f.notes[0],undefined,f.signal);
  assert.equal(denied.remoteStatus,'forbidden');assert.equal(denied.siteUrl,undefined);
});
function fixture(){
 const identity={connectionId:'connection',instanceId:'site',accountId:'dm',campaignId:'camp',bindingId:'binding'},root={id:'local',root:'Game',identity},captured={id:'connection',name:'Site',baseUrl:'https://example.test',secretName:'key',enabled:false,verified:{accountId:'dm',instanceId:'site',accountName:'DM'}},notes=[{id:'one',path:'Game/One.md',title:'One',revision:1},{id:'two',path:'Game/Two.md',title:'Two',revision:1}];
 let fail:Error|null=null;const header=(id:string)=>({id:1,entityType:'note',entityId:id,revision:1,deleted:false,source:'site',actor:{id:'dm',name:'DM'},createdAt:'2026-10-18T12:00:00.000Z'}),client={identity,history:async(id:string)=>{if(fail)throw fail;return {protocolVersion:1,rows:[header(id)],nextCursor:null};},historyChange:async(id:string)=>{if(fail)throw fail;return {protocolVersion:1,change:header(id),document:{protocolVersion:1,id,revision:1,title:id,markdown:'# '+id,sourceHash:hashBytes('# '+id),projectionHash:hashBytes('# '+id),metadata:{icon:'',favorite:false},assets:[],board:null,diagnostics:[]},folder:null};}};
 const service=createHistoryPanelService({session:()=>({root,captured,live:async()=>{},client,writer:{vault:{read:async()=>null},editor:{snapshot:()=>null}}}) as any,state:{load:async()=>({bases:[],journals:[]})} as any,paths:()=>[],remoteNotes:()=>notes});
 return {service,notes,signal:new AbortController().signal,setFailure:(error:Error)=>{fail=error;}};
}
test('a denied history list invalidates cached server content for every note on that connection',async()=>{const f=fixture();await f.service.list('local',f.notes[0],undefined,f.signal);await f.service.list('local',f.notes[1],undefined,f.signal);f.setFailure(new TransportError('integration_forbidden','revoked',403));assert.equal((await f.service.list('local',f.notes[0],undefined,f.signal)).remoteStatus,'forbidden');f.setFailure(new TransportError('network_error','offline'));assert.equal((await f.service.list('local',f.notes[1],undefined,f.signal)).remoteStatus,'unavailable');});
test('a denied version read also invalidates other notes on the connection',async()=>{const f=fixture(),first=await f.service.list('local',f.notes[0],undefined,f.signal);await f.service.list('local',f.notes[1],undefined,f.signal);f.setFailure(new TransportError('integration_unauthenticated','expired',401));await assert.rejects(f.service.read('local',first.id,'server-1',f.signal));f.setFailure(new TransportError('network_error','offline'));assert.equal((await f.service.list('local',f.notes[1],undefined,f.signal)).remoteStatus,'unavailable');});
