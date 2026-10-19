import test from 'node:test';
import assert from 'node:assert/strict';
import {readSettings,newConnection} from '../src/connection/settings.js';
import {changeBindingPause} from '../src/connection/binding-settings.js';
import {bindingForFile} from '../src/bindings/registry.js';
import {createSettingsWriter} from '../src/connection/settings-writer.js';
import type {Settings} from '../src/connection/settings.js';

const connection={...newConnection({name:'Site',baseUrl:'https://example.test'}),verified:{accountId:'dm',instanceId:'site',accountName:'DM'}};
const root={id:'local-root',root:'Game',identity:{connectionId:connection.id,instanceId:'site',accountId:'dm',campaignId:'camp',bindingId:'remote'}};
test('connection-preview settings remain compatible while verified folder bindings are optional',()=>{
  assert.deepEqual(readSettings({version:1,connections:[connection]}),{version:1,connections:[connection]});
  const saved=readSettings({version:1,connections:[connection],bindings:[root]});assert.deepEqual(saved.bindings,[root]);
});
test('unknown connections, accounts, overlapping roots, config paths and unknown fields are rejected',()=>{
  for(const bindings of [[{...root,secret:'no'}],[{...root,root:'.obsidian'}],[{...root,identity:{...root.identity,connectionId:'unknown'}}],[{...root,identity:{...root.identity,accountId:'other'}}],[root,{...root,id:'second',root:'Game/Nested',identity:{...root.identity,bindingId:'second'}}]])assert.throws(()=>readSettings({version:1,connections:[connection],bindings}));
  assert.throws(()=>readSettings({version:1,connections:[{...connection,verified:undefined}],bindings:[root]}));
});

test('paused bindings round trip while old settings remain readable',()=>{
  const saved=readSettings({version:1,connections:[connection],bindings:[{...root,paused:true}]});
  assert.equal(saved.bindings![0].paused,true);
  assert.equal(readSettings({version:1,connections:[connection],bindings:[root]}).bindings![0].paused,undefined);
});
test('pause accepts only a boolean and no arbitrary settings fields',()=>{
  for(const paused of [null,1,'true',{}])assert.throws(()=>readSettings({version:1,connections:[connection],bindings:[{...root,paused}]}));
});
test('pause versions are bounded positive integers and cannot overflow',()=>{
  for(const pauseVersion of [null,0,-1,1.5,'1',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>readSettings({version:1,connections:[connection],bindings:[{...root,pauseVersion}]}));
  const exhausted={...root,pauseVersion:Number.MAX_SAFE_INTEGER};
  assert.throws(()=>changeBindingPause({version:1,connections:[connection],bindings:[exhausted]},exhausted,true));
});
test('old active snapshots are invalid even after a complete pause/resume cycle',()=>{
  const active={...root,paused:false},settings={version:1 as const,connections:[connection],bindings:[active]};
  const paused=changeBindingPause(settings,active,true),resumed=changeBindingPause(paused,paused.bindings![0],false);
  assert.throws(()=>changeBindingPause(resumed,active,true));assert.equal(resumed.bindings![0].pauseVersion,2);
});
test('one remote identity cannot be attached to two nonoverlapping local roots',()=>{
  assert.throws(()=>readSettings({version:1,connections:[connection],bindings:[root,{...root,id:'other',root:'Elsewhere',paused:true}]}));
});
test('paused roots remain reserved and cannot be overlapped',()=>{
  assert.throws(()=>readSettings({version:1,connections:[connection],bindings:[{...root,paused:true},{...root,id:'other',root:'Game/Nested',identity:{...root.identity,bindingId:'other'}}]}));
});
test('file lookup excludes paused roots but resumes the exact same identity',()=>{
  assert.equal(bindingForFile('Game/Note.md',[{...root,paused:true}]),null);
  assert.equal(bindingForFile('Game/Note.md',[{...root,paused:false}])!.id,root.id);
});
test('pausing changes only the selected local association without changing its identity or root',()=>{
  const settings:Settings={version:1,connections:[connection],bindings:[root,{...root,id:'other',root:'Other',identity:{...root.identity,bindingId:'other'}}]};
  const next=changeBindingPause(settings,root,true);
  assert.equal(next.bindings![0].paused,true);assert.deepEqual(next.bindings![0].identity,root.identity);
  assert.equal(next.bindings![0].root,root.root);assert.deepEqual(next.bindings![1],settings.bindings![1]);
  assert.deepEqual(next.connections,settings.connections);assert.equal(settings.bindings![0].paused,undefined);
  assert.deepEqual(changeBindingPause(next,next.bindings![0],false).bindings![0],{...root,paused:false,pauseVersion:2});
});
test('stale, removed or repointed binding snapshots cannot change pause state',()=>{
  const settings={version:1 as const,connections:[connection],bindings:[root]};
  for(const changed of [{...root,root:'Other'},{...root,identity:{...root.identity,bindingId:'other'}},{...root,paused:true}]){
    assert.throws(()=>changeBindingPause({...settings,bindings:[changed]},root,true));
  }
  assert.throws(()=>changeBindingPause({...settings,bindings:[]},root,true));
});
test('failed pause persistence leaves the binding active and later retry works',async()=>{
  let fail=true;const writer=createSettingsWriter({version:1,connections:[connection],bindings:[root]},async()=>{if(fail)throw Error('disk');});
  await assert.rejects(writer.update(current=>changeBindingPause(current,root,true)));
  assert.equal(writer.get().bindings![0].paused,undefined);fail=false;
  await writer.update(current=>changeBindingPause(current,root,true));assert.equal(writer.get().bindings![0].paused,true);
});
