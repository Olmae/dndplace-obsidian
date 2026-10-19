import test from 'node:test';
import assert from 'node:assert/strict';
import {createSecretStore,installationId} from '../src/connection/secrets.js';
import {readSettings,newConnection} from '../src/connection/settings.js';
import {verifyConnection,createProtocolClient} from '../src/protocol/client.js';
import fixtures from '../contracts/v1/valid.json';

const host=()=>{const values=new Map<string,string>();return {values,getSecret:(key:string)=>values.get(key)??null,setSecret:(key:string,value:string)=>{values.set(key,value);}};};
const secret=`dpobs_${Buffer.alloc(16,1).toString('base64url')}.${Buffer.alloc(32,2).toString('base64url')}`;
const connection=()=>structuredClone(fixtures.find(row=>row.kind==='connection')!.value) as any;
test('native secret storage has no plaintext fallback and keeps device markers out of settings',()=>{
  assert.throws(()=>createSecretStore(undefined));assert.throws(()=>createSecretStore({}));
  const first=host(),second=host(),store=createSecretStore(first);
  const a=installationId(store),b=installationId(createSecretStore(first));assert.equal(a,b);assert.notEqual(a,installationId(createSecretStore(second)));
  const record=newConnection({name:'Laptop',baseUrl:'https://example.test'});
  store.set(record.secretName,secret);assert.equal(store.get(record.secretName),secret);
  assert.ok(!JSON.stringify(record).includes(secret));assert.ok(!JSON.stringify(record).includes(a));
  store.clear(record.secretName);assert.equal(store.get(record.secretName),undefined);
  assert.throws(()=>store.get('other-plugin-secret'));
});
test('settings are versioned, explicit, disabled by default and reject embedded secrets',()=>{
  assert.deepEqual(readSettings(null),{version:1,connections:[]});
  const record=newConnection({name:'Laptop',baseUrl:'https://example.test/table'});
  const settings=readSettings({version:1,connections:[record]});assert.equal(settings.connections[0].enabled,false);
  for(const invalid of [{version:2,connections:[]},{version:1,connections:[{...record,secret}]},{version:1,connections:[{...record,baseUrl:'http://evil.test'}]},{version:1,connections:[record,record]}])assert.throws(()=>readSettings(invalid));
});
test('connection verification rejects malformed/version-mismatched server responses',async()=>{
  const valid=connection();assert.equal((await verifyConnection({json:async()=>valid})).instanceId,valid.instanceId);
  for(const response of [{...valid,protocolVersion:2},{...valid,account:{id:'x'}},{...valid,secretHash:secret}])await assert.rejects(verifyConnection({json:async()=>response}));
});
test('protocol client captures identity and fails closed on account or instance change',async()=>{
  const valid=connection(),identity={connectionId:'local',instanceId:valid.instanceId,accountId:valid.account.id,campaignId:'camp',bindingId:'bind'};
  const calls:Array<{path:string,options:any}>=[];
  const transport={json:async(path:string,options?:any)=>{calls.push({path,options});return path==='connection'?valid:[];}};
  const client=createProtocolClient(transport,identity);identity.accountId='mutated';
  await client.campaigns();assert.equal(calls.at(-1)?.options.expectedAccountId,valid.account.id);
  valid.account.id='other';await assert.rejects(client.campaigns());
  valid.account.id='user';valid.instanceId='other-instance';await assert.rejects(client.campaigns());
  assert.equal(calls.filter(call=>call.path==='campaigns').length,1);
});
test('campaign lists are validated, not trusted because the connection handshake passed',async()=>{
  const valid=connection(),identity={connectionId:'local',instanceId:valid.instanceId,accountId:valid.account.id,campaignId:'camp',bindingId:'bind'};
  const client=createProtocolClient({json:async path=>path==='connection'?valid:[{id:'camp',name:'Campaign',capabilities:['characters.write']}]},identity);
  await assert.rejects(client.campaigns());
});
