import test from 'node:test';
import assert from 'node:assert/strict';
import {createSettingsWriter} from '../src/connection/settings-writer.js';
import {newConnection} from '../src/connection/settings.js';

test('concurrent local settings changes are serialized without losing connections',async()=>{
  const saved:unknown[]=[],writer=createSettingsWriter({version:1,connections:[]},async value=>{await new Promise(resolve=>setTimeout(resolve,5));saved.push(value);});
  const first=newConnection({name:'First',baseUrl:'https://example.test'}),second=newConnection({name:'Second',baseUrl:'https://example.test'});
  await Promise.all([writer.update(current=>({...current,connections:[...current.connections,first]})),writer.update(current=>({...current,connections:[...current.connections,second]}))]);
  assert.equal(writer.get().connections.length,2);assert.equal(saved.length,2);
  const snapshot=writer.get();snapshot.connections.length=0;assert.equal(writer.get().connections.length,2);
});
test('failed settings save does not advance memory or poison subsequent updates',async()=>{
  let fail=true;const writer=createSettingsWriter({version:1,connections:[]},async()=>{if(fail)throw new Error('disk');});
  const record=newConnection({name:'First',baseUrl:'https://example.test'});
  await assert.rejects(writer.update(current=>({...current,connections:[record]})));assert.equal(writer.get().connections.length,0);
  fail=false;await writer.update(current=>({...current,connections:[record]}));assert.equal(writer.get().connections.length,1);
});
