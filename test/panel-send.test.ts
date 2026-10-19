import test from 'node:test';
import assert from 'node:assert/strict';
import {createPanelController} from '../src/ui/controller.js';
import type {PanelService,Review} from '../src/ui/controller.js';
function fixture(){
  const calls:string[]=[],root={id:'local',name:'Game',root:'Game',connectionId:'connection',campaignId:'camp'},local:Review={id:'capture',stage:'capture',canConfirm:true,rows:[{path:'Game/One.md',title:'One',status:'Новая запись'}]},remote:Review={...local,id:'server',stage:'server'};
  const service:PanelService={connections:()=>[{id:'connection',name:'Site'}],roots:()=>[root],folders:async()=>[],campaigns:async()=>[],bindings:async()=>[],createBinding:async()=>({id:'x',name:'x'}),saveBinding:async()=>root,notes:async()=>[{id:'remote-note',path:'Game/Remote.md',title:'Remote',revision:1}],preview:async()=>local,apply:async()=>({written:1,pending:0}),recover:async()=>({written:0,pending:0}),dispose:()=>{},sending:{notes:async()=>[{id:'Game/One.md',path:'Game/One.md',title:'One',revision:0}],preview:async()=>{calls.push('preview');return local;},stage:async(_id,preview)=>{calls.push('stage:'+preview);return remote;},apply:async(_id,review)=>{calls.push('apply:'+review);return {written:1,pending:0};},resume:async()=>({kind:'review',review:remote}),dispose:()=>{}}};
  return {service,calls,local,remote,controller:createPanelController(service)};
}
test('sending has a read-only capture, staging review and separate final confirmation',async()=>{
  const f=fixture();await f.controller.chooseRoot('local');await f.controller.chooseDirection('send');assert.equal(f.controller.get().notes[0].id,'Game/One.md');f.controller.toggleNote('Game/One.md',true);await f.controller.preview();assert.deepEqual(f.calls,['preview']);
  await Promise.all([f.controller.confirm(),f.controller.confirm()]);assert.deepEqual(f.calls,['preview','stage:capture']);assert.equal(f.controller.get().review!.stage,'server');
  await Promise.all([f.controller.confirm(),f.controller.confirm()]);assert.deepEqual(f.calls,['preview','stage:capture','apply:server']);assert.equal(f.controller.get().result!.written,1);
});
test('blocked or unchanged-only plans cannot be confirmed programmatically',async()=>{
  const f=fixture();f.local.canConfirm=false;await f.controller.chooseRoot('local');await f.controller.chooseDirection('send');f.controller.toggleNote('Game/One.md',true);await f.controller.preview();await f.controller.confirm();assert.deepEqual(f.calls,['preview']);
});
test('changing direction discards approval and resets local selection',async()=>{
  const f=fixture();await f.controller.chooseRoot('local');await f.controller.chooseDirection('send');f.controller.toggleNote('Game/One.md',true);await f.controller.preview();await f.controller.chooseDirection('receive');await f.controller.confirm();assert.deepEqual(f.calls,['preview']);assert.deepEqual(f.controller.get().selected,[]);assert.equal(f.controller.get().notes[0].id,'remote-note');
});
test('resume of an unconfirmed staging review never triggers its apply',async()=>{
  const f=fixture();await f.controller.chooseRoot('local');await f.controller.chooseDirection('send');await f.controller.resumeSending();assert.equal(f.controller.get().review!.id,'server');assert.deepEqual(f.calls,[]);
});
test('cancelled staging cannot restore stale server approval into another direction',async()=>{
  const f=fixture();let release!:(review:Review)=>void;f.service.sending!.stage=async()=>new Promise(resolve=>{release=resolve;});await f.controller.chooseRoot('local');await f.controller.chooseDirection('send');f.controller.toggleNote('Game/One.md',true);await f.controller.preview();const pending=f.controller.confirm();await f.controller.chooseDirection('receive');release(f.remote);await pending;assert.equal(f.controller.get().review,null);assert.equal(f.controller.get().direction,'receive');
});
test('a receive-only service never enters an unsupported sending state',async()=>{
  const f=fixture();delete f.service.sending;const controller=createPanelController(f.service);await controller.chooseDirection('send');assert.equal(controller.get().direction,'receive');assert.equal(controller.get().sendAvailable,false);
});
