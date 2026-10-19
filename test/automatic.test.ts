import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticBinding,automaticEventBinding} from '../src/sync/event-guard.js';
import {readSettings,newConnection} from '../src/connection/settings.js';
import {changeBindingAutomatic} from '../src/connection/binding-settings.js';
const device='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',connection={...newConnection({name:'Site',baseUrl:'https://example.test'}),verified:{accountId:'dm',instanceId:'site',accountName:'DM'}},root={id:'local',root:'Game',identity:{connectionId:connection.id,instanceId:'site',accountId:'dm',campaignId:'camp',bindingId:'remote'}};
test('automation is per device, off by default and paused roots never dispatch events',()=>{
  assert.equal(automaticBinding(root,device),false);const enabled={...root,automatic:{deviceId:device}};
  assert.equal(automaticBinding(enabled,device),true);assert.equal(automaticBinding(enabled,other),false);assert.equal(automaticBinding({...enabled,paused:true},device),false);
  assert.equal(automaticEventBinding('Other/File.md',[enabled],device),null);assert.equal(automaticEventBinding('Game/File.md',[enabled],device)?.id,'local');
  assert.equal(automaticEventBinding('.obsidian/data.json',[enabled],device),null);
});
test('automation settings preserve legacy data and reject malformed/copied device opt-in',()=>{
  assert.equal(readSettings({version:1,connections:[connection],bindings:[root]}).bindings![0].automatic,undefined);
  for(const automatic of [true,{},null,{deviceId:'x'},{deviceId:device,secret:'no'}])assert.throws(()=>readSettings({version:1,connections:[connection],bindings:[{...root,automatic}]}));
  const settings={version:1 as const,connections:[connection],bindings:[root]},next=changeBindingAutomatic(settings,root,device,true);
  assert.equal(next.bindings![0].automatic?.deviceId,device);assert.equal(next.bindings![0].pauseVersion,1);
  assert.throws(()=>changeBindingAutomatic(next,root,device,false));
  assert.equal(changeBindingAutomatic(next,next.bindings![0],device,false).bindings![0].automatic,undefined);
});
