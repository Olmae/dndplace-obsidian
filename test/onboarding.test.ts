import test from 'node:test';
import assert from 'node:assert/strict';
import {connectAndStore} from '../src/connection/onboarding.js';
import {createSecretStore} from '../src/connection/secrets.js';
import valid from '../contracts/v1/valid.json';

const response=()=>structuredClone(valid.find(row=>row.kind==='connection')!.value) as any;
test('onboarding verifies the server before persisting and never serializes the credential',async()=>{
  const values=new Map<string,string>(),store=createSecretStore({getSecret:(name:string)=>values.get(name)??null,setSecret:(name:string,value:string)=>values.set(name,value)});let saved:any;
  const result=await connectAndStore({name:'Laptop',baseUrl:'https://example.test',secret:'private-input'},{settings:{version:1,connections:[]},store,transportFactory:()=>({json:async()=>response()}),saveSettings:async value=>{saved=value;}});
  assert.equal(saved.connections.length,1);assert.equal(result.connection.verified?.accountId,'user');assert.equal(result.connection.enabled,false);
  assert.ok(!JSON.stringify(saved).includes('private-input'));assert.equal(store.get(result.connection.secretName),'private-input');
});
test('failed verification or settings save never leaves a usable orphan credential',async()=>{
  for(const failAt of ['verify','save']){
    const values=new Map<string,string>(),store=createSecretStore({getSecret:(name:string)=>values.get(name)??null,setSecret:(name:string,value:string)=>values.set(name,value)});
    await assert.rejects(connectAndStore({name:'Laptop',baseUrl:'https://example.test',secret:'private-input'},{settings:{version:1,connections:[]},store,transportFactory:()=>({json:async()=>failAt==='verify'?{}:response()}),saveSettings:async()=>{if(failAt==='save')throw new Error('disk failed');}}));
    assert.ok([...values.values()].every(value=>value===''));
  }
});
