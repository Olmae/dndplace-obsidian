import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDTO} from '../src/protocol/validate.js';
import {createProtocolClient} from '../src/protocol/client.js';
import fixtures from '../contracts/v1/valid.json';
const row={id:1,entityType:'note',entityId:'note',revision:1,deleted:false,source:'obsidian',actor:{id:'dm',name:'Мастер'},createdAt:'2026-10-18T12:00:00.000Z'},page={protocolVersion:1,rows:[row],nextCursor:null};
test('history uses strict bounded actor/source/time contracts',()=>{assert.deepEqual(validateDTO('historyPage',page),page);});
test('history rejects extra authority fields, malformed timestamps and wrong versions',()=>{
  for(const value of [{...page,restoreUrl:'https://bad.test'}, {...page,rows:[{...row,createdAt:'yesterday'}]}, {...page,rows:[{...row,createdAt:'2026-02-30T12:00:00.000Z'}]}, {...page,rows:[{...row,revision:0}]}])assert.throws(()=>validateDTO('historyPage',value));
});
test('history requests verify account identity and encode only scoped note/cursor queries',async()=>{
  const calls:any[]=[],connection=structuredClone(fixtures.find(f=>f.kind==='connection')!.value) as any;connection.account.id='dm';connection.instanceId='site';
  const client=createProtocolClient({json:async(path,options)=>{calls.push({path,options});return path==='connection'?connection:page;}},{connectionId:'connection',instanceId:'site',accountId:'dm',campaignId:'camp',bindingId:'binding'}) as any;
  assert.deepEqual(await client.history('note','cursor'),page);assert.equal(calls[1].path,'campaigns/camp/bindings/binding/history');assert.deepEqual(calls[1].options.query,{entityType:'note',entityId:'note',cursor:'cursor',limit:50});
  await assert.rejects(client.history('../other'));assert.equal(calls.length,2);
});
