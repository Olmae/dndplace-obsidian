import test from 'node:test';
import assert from 'node:assert/strict';
import {createPanelController,PanelError} from '../src/ui/controller.js';
import type {PanelService} from '../src/ui/controller.js';

function fixture(){
  const calls:string[]=[],roots=[{id:'local',name:'One shot',root:'Game',connectionId:'connection',campaignId:'camp'}];
  const service:PanelService={connections:()=>[{id:'connection',name:'My site',detail:'Synthetic DM'}],roots:()=>roots,folders:async()=>['Game'],campaigns:async()=>[{id:'camp',name:'Campaign'}],bindings:async()=>[{id:'remote',name:'Archive'}],createBinding:async()=>({id:'new-remote',name:'New archive'}),saveBinding:async input=>{calls.push('save:'+input.root);return roots[0];},notes:async()=>[{id:'note',title:'One',path:'Game/One.md',revision:1}],preview:async(root,ids)=>{calls.push('preview:'+root+':'+ids.join(','));return {id:'preview',rows:[{path:'Game/One.md',title:'One',status:'Новая запись'}]};},apply:async(root,id)=>{calls.push('apply:'+root+':'+id);return {written:1,pending:0};},recover:async()=>({written:1,pending:0}),dispose:()=>{calls.push('dispose');}};
  return {service,calls,controller:createPanelController(service)};
}
test('opening a panel does not access the network, vault or synchronization service',()=>{
  const f=fixture();assert.equal(f.controller.get().phase,'idle');assert.deepEqual(f.calls,[]);assert.equal(f.controller.get().roots.length,1);
});
test('saving a folder immediately loads its remote note list without applying anything',async()=>{
  const f=fixture();await f.controller.chooseConnection('connection');await f.controller.chooseCampaign('camp');f.controller.chooseBinding('remote');f.controller.chooseFolder('Game');await f.controller.saveRoot();
  assert.equal(f.controller.get().notes.length,1);assert.deepEqual(f.calls,['save:Game']);assert.equal(f.controller.get().phase,'idle');
});
test('metadata refresh cancels old replies and reloads newly added connections without a transfer',async()=>{
  const f=fixture();let release!:(value:any)=>void,signal!:AbortSignal;
  f.service.notes=async(_id,current)=>{signal=current;return new Promise(resolve=>{release=resolve;});};const pending=f.controller.chooseRoot('local');
  f.service.connections=()=>[{id:'new',name:'New server'}];f.controller.refresh();assert.equal(signal.aborted,true);release([{id:'late',title:'Late',path:'Game/Late.md',revision:1}]);await pending;
  assert.equal(f.controller.get().connections[0].id,'new');assert.equal(f.controller.get().localId,'');assert.deepEqual(f.controller.get().notes,[]);assert.deepEqual(f.calls,[]);
});
test('campaign and remote binding choices reset downstream selection and require an explicit local folder',async()=>{
  const f=fixture();await f.controller.chooseConnection('connection');await f.controller.chooseCampaign('camp');assert.equal(f.controller.get().bindings[0].id,'remote');f.controller.chooseBinding('remote');await f.controller.saveRoot();assert.equal(f.calls.length,0);
  f.controller.chooseFolder('Game');await f.controller.saveRoot();assert.deepEqual(f.calls,['save:Game']);assert.equal(f.controller.get().localId,'local');
});
test('old connection responses cannot populate a newly selected connection',async()=>{
  const f=fixture();let release!:(value:any)=>void;f.service.connections=()=>[{id:'connection',name:'First'},{id:'second',name:'Second'}];f.service.campaigns=async id=>id==='connection'?new Promise(resolve=>{release=resolve;}):[{id:'second-camp',name:'Second campaign'}];
  const controller=createPanelController(f.service),first=controller.chooseConnection('connection');await controller.chooseConnection('second');release([{id:'old',name:'Old'}]);await first;assert.equal(controller.get().campaigns[0].id,'second-camp');
});
test('notes are explicitly selected and preview never applies changes',async()=>{
  const f=fixture();await f.controller.chooseRoot('local');await f.controller.preview();assert.equal(f.calls.length,0);f.controller.toggleNote('note',true);await f.controller.preview();assert.equal(f.controller.get().phase,'review');assert.deepEqual(f.calls,['preview:local:note']);
});
test('confirmation uses the exact saved preview; duplicate clicks never apply twice',async()=>{
  const f=fixture();await f.controller.chooseRoot('local');f.controller.toggleNote('note',true);await f.controller.preview();await Promise.all([f.controller.confirm(),f.controller.confirm()]);assert.deepEqual(f.calls,['preview:local:note','apply:local:preview']);assert.equal(f.controller.get().phase,'done');assert.equal(f.controller.get().result!.written,1);
});
test('changing selection invalidates an earlier preview before any write',async()=>{
  const f=fixture();await f.controller.chooseRoot('local');f.controller.toggleNote('note',true);await f.controller.preview();f.controller.toggleNote('note',false);await f.controller.confirm();assert.equal(f.calls.filter(call=>call.startsWith('apply:')).length,0);
});
test('unknown roots and note IDs never reach a transfer operation',async()=>{
  const f=fixture();await f.controller.chooseRoot('foreign');assert.equal(f.controller.get().localId,'');await f.controller.chooseRoot('local');f.controller.toggleNote('foreign',true);await f.controller.preview();assert.deepEqual(f.calls,[]);
});
test('closing cancels in-flight work and suppresses late updates',async()=>{
  const f=fixture();let signal:AbortSignal|undefined,release!:(notes:any)=>void;f.service.notes=async(_id,value)=>{signal=value;return new Promise(resolve=>{release=resolve;});};
  const pending=f.controller.chooseRoot('local');f.controller.dispose();assert.equal(signal!.aborted,true);release([{id:'note',title:'Late',path:'Game/Late.md',revision:1}]);await pending;assert.equal(f.controller.get().notes.length,0);assert.deepEqual(f.calls,['dispose']);
});
test('untrusted errors are not displayed verbatim, while known user errors stay readable',async()=>{
  const f=fixture();f.service.notes=async()=>{throw Error('dpobs_secret_should_not_render');};await f.controller.chooseRoot('local');assert.ok(!f.controller.get().message.includes('dpobs_'));
  f.service.notes=async()=>{throw new PanelError('unsafe_root');};await f.controller.chooseRoot('local');assert.ok(f.controller.get().message.includes('папк'));
});
test('a captured confirmation keeps its original destination when another root is selected',async()=>{
  const f=fixture();f.service.roots=()=>[{id:'local',name:'First',root:'Game',connectionId:'connection',campaignId:'camp'},{id:'other',name:'Other',root:'Other',connectionId:'connection',campaignId:'other-camp'}];
  const controller=createPanelController(f.service);await controller.chooseRoot('local');controller.toggleNote('note',true);await controller.preview();let release!:()=>void;f.service.apply=async(root,id,signal)=>{f.calls.push('apply:'+root+':'+id);await new Promise<void>(resolve=>{release=resolve;});if(signal.aborted)throw Error('cancelled');return {written:1,pending:0};};
  const applying=controller.confirm();await controller.chooseRoot('other');release();await applying;assert.deepEqual(f.calls,['preview:local:note','apply:local:preview']);assert.equal(controller.get().localId,'other');assert.equal(controller.get().result,null);
});
