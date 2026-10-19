import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile,readdir,symlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {App} from 'obsidian';
import {createNativePanelService} from '../src/host/panel-service.js';
import {newConnection} from '../src/connection/settings.js';
import type {Settings} from '../src/connection/settings.js';
import {createSecretStore} from '../src/connection/secrets.js';
import {createDesktopTransport} from '../src/connection/transport.js';
import {hashBytes} from '../src/documents/hashes.js';
import fixtures from '../contracts/v1/valid.json';
import {changeBindingPause} from '../src/connection/binding-settings.js';

test('automatic exchange requires an explicit same-device opt-in and a reviewed baseline',async t=>{
  const f=await fixture(t),signal=new AbortController().signal;
  assert.equal(await f.service.automatic!.eligible('local',signal),false);
  await assert.rejects(f.service.automatic!.cycle('local',signal));assert.deepEqual(f.calls,[]);
  const notes=await f.service.notes('local',signal);await f.service.apply('local',(await f.service.preview('local',['note'],signal)).id,signal);
  assert.equal(await f.service.automatic!.eligible('local',signal),true);
  f.setSettings({...f.settings,bindings:[{...f.root,automatic:{deviceId:f.options.deviceId}}]});
  const file=join(f.vaultRoot,notes[0].path),before=await readFile(file,'utf8');
  const service=createNativePanelService({...f.options,app:{...f.options.app,vault:{...f.options.app.vault,getAllLoadedFiles:()=>[{path:notes[0].path}]}} as unknown as App});
  assert.equal(await service.automatic!.cycle('local',signal),'ok');assert.equal(await readFile(file,'utf8'),before);service.dispose();
  assert.ok(!(f.calls as string[]).some(path=>path.includes('transfers')));f.service.dispose();
});

test('paused bindings are hidden and every selected-root action rejects before host or network IO',async t=>{
  const f=await fixture(t),signal=new AbortController().signal;
  f.setSettings(changeBindingPause(f.settings,f.root,true));
  assert.deepEqual(f.service.roots(),[]);
  for(const action of [()=>f.service.notes('local',signal),()=>f.service.recover('local',signal),()=>f.service.sending!.notes('local',signal),()=>f.service.sending!.resume('local',signal)])await assert.rejects(action);
  assert.deepEqual(f.calls,[]);assert.deepEqual(await readdir(join(f.vaultRoot,'Game')),[]);
  f.service.dispose();
});

test('a pull preview from before pause/resume cannot write and an explicit new preview can',async t=>{
  const f=await fixture(t),signal=new AbortController().signal;
  await f.service.notes('local',signal);const preview=await f.service.preview('local',['note'],signal);
  const paused=changeBindingPause(f.settings,f.root,true);f.setSettings(paused);
  f.setSettings(changeBindingPause(paused,paused.bindings![0],false));
  await assert.rejects(f.service.apply('local',preview.id,signal));
  assert.deepEqual(await readdir(join(f.vaultRoot,'Game')),[]);
  await f.service.notes('local',signal);const fresh=await f.service.preview('local',['note'],signal);
  await f.service.apply('local',fresh.id,signal);assert.equal((await readdir(join(f.vaultRoot,'Game'))).length,1);f.service.dispose();
});

test('pausing and resuming invalidates an in-flight catalog reply without another request',async t=>{
  const f=await fixture(t),wire=f.options.transportFactory();
  const service=createNativePanelService({...f.options,transportFactory:()=>({...wire,json:async(path,controls)=>{
    const result=await wire.json(path,controls);
    if(path.endsWith('/archive')){const current=f.settings,paused=changeBindingPause(current,current.bindings![0],true);f.setSettings(changeBindingPause(paused,paused.bindings![0],false));}
    return result;
  }})});
  await assert.rejects(service.notes('local',new AbortController().signal));assert.ok(!f.calls.some(path=>path.endsWith('/bindings')));service.dispose();
});

test('native conflict approval cannot cross a changed root or survive panel disposal',async t=>{const f=await fixture(t),signal=new AbortController().signal,notes=await f.service.notes('local',signal);await f.service.apply('local',(await f.service.preview('local',['note'],signal)).id,signal);const file=join(f.vaultRoot,notes[0].path),before=await readFile(file,'utf8'),comparison=await f.service.conflicts!.open('local',notes[0],signal);let review=await f.service.conflicts!.preview('local',comparison.id,'copy',signal);const settings=f.settings;f.setSettings({...settings,bindings:[{...f.root,root:'Other'}]});await assert.rejects(f.service.conflicts!.apply('local',review.id,signal));f.setSettings(settings);review=await f.service.conflicts!.preview('local',comparison.id,'copy',signal);f.service.dispose();await assert.rejects(f.service.conflicts!.apply('local',review.id,signal));assert.equal(await readFile(file,'utf8'),before);assert.equal((await readdir(join(f.vaultRoot,'Game'))).length,1);});

test('native conflict flow defers, reopens, copies and receives through physical temporary notes',async t=>{
 const f=await fixture(t),wire=f.options.transportFactory(),signal=new AbortController().signal;let changed=false;
 const options={...f.options,transportFactory:()=>({...wire,json:async(path:string,controls:any)=>{const result=await wire.json(path,controls) as any;if(!changed)return result;if(path.endsWith('/archive'))return {...result,archiveRevision:2,rows:result.rows.map((row:any)=>({...row,revision:2}))};if(path.includes('/documents/')){const markdown='# One\r\nRemote clue\r\n';return {...result,revision:2,markdown,sourceHash:hashBytes(markdown),projectionHash:hashBytes(markdown)};}return result;}})};
 let service=createNativePanelService(options);const notes=await service.notes('local',signal),note=notes[0];await service.apply('local',(await service.preview('local',[note.id],signal)).id,signal);
 const file=join(f.vaultRoot,note.path),original=(await readFile(file,'utf8')).replace('A clue','Local clue');await writeFile(file,original);changed=true;
 let comparison=await service.conflicts!.open('local',note,signal);assert.match(comparison.localText,/Local clue/);assert.match(comparison.remoteText,/Remote clue/);
 let review=await service.conflicts!.preview('local',comparison.id,'later',signal);await service.conflicts!.apply('local',review.id,signal);assert.equal(await readFile(file,'utf8'),original);await assert.rejects(service.conflicts!.apply('local',review.id,signal));
 service.dispose();service=createNativePanelService(options);comparison=await service.conflicts!.open('local',note,signal);review=await service.conflicts!.preview('local',comparison.id,'copy',signal);assert.equal(await readFile(file,'utf8'),original);await service.conflicts!.apply('local',review.id,signal);const copied=await readFile(join(f.vaultRoot,review.targetPath),'utf8');assert.match(copied,/Local clue/);assert.ok(!copied.includes('dndplace:'));assert.equal(await readFile(file,'utf8'),original);
 comparison=await service.conflicts!.open('local',note,signal);review=await service.conflicts!.preview('local',comparison.id,'remote',signal);await service.conflicts!.apply('local',review.id,signal);assert.match(await readFile(file,'utf8'),/Remote clue/);assert.deepEqual(await readdir(join(f.vaultRoot,'Other')),[]);assert.ok(!f.calls.some(path=>path.includes('transfers')));service.dispose();
});

async function fixture(t:any){
  const directory=await mkdtemp(join(tmpdir(),'dnd-panel-host-'));t.after(()=>rm(directory,{recursive:true,force:true}));const vaultRoot=join(directory,'vault');await mkdir(vaultRoot);await mkdir(join(vaultRoot,'Game'));await mkdir(join(vaultRoot,'Other'));
  const connection={...newConnection({name:'Site',baseUrl:'https://example.test'}),verified:{accountId:'user',instanceId:'site',accountName:'DM'}},root={id:'local',root:'Game',identity:{connectionId:connection.id,accountId:'user',instanceId:'site',campaignId:'camp',bindingId:'remote'}};
  let settings:Settings={version:1,connections:[connection],bindings:[root]};const deviceId=randomUUID(),secret=`dpobs_${Buffer.alloc(16,1).toString('base64url')}.${Buffer.alloc(32,2).toString('base64url')}`,values=new Map([['dndplace-device-id',deviceId],[connection.secretName,secret]]),secrets=createSecretStore({getSecret:(key:string)=>values.get(key)??null,setSecret:(key:string,value:string)=>{values.set(key,value);}}),calls:string[]=[];
  const source='# One\r\nA clue\r\n',doc={protocolVersion:1,id:'note',revision:1,title:'One',markdown:source,sourceHash:hashBytes(source),projectionHash:hashBytes(source),metadata:{icon:'',favorite:false},assets:[],board:null,diagnostics:[]};
  const wire=createDesktopTransport({baseUrl:connection.baseUrl,getSecret:async()=>secret,requestImpl:async(url,options)=>{
    const path=url.pathname.split('/v1/')[1];calls.push(path);assert.equal(options.headers.Authorization,'Bearer '+secret);if(path!=='connection'){assert.equal(options.headers['X-Dndplace-Account'],'user');assert.equal(options.headers['X-Dndplace-Instance'],'site');}
    const body=path==='connection'?structuredClone(fixtures.find(row=>row.kind==='connection')!.value):path==='campaigns'?[{id:'camp',name:'Campaign',capabilities:['archive.read']}]:path.endsWith('/bindings')?[{id:'remote',campaignId:'camp',ownerId:'user',sourceBindingId:'source',destinationFolderId:null,name:'Archive',revision:1}]:path.endsWith('/archive')?{protocolVersion:1,archiveRevision:1,highWater:0,rows:[{id:'note',title:'One',folderId:null,revision:1,hasBoard:false}],folders:[],nextCursor:null}:path.includes('/documents/')?doc:null;
    return {status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(body))};
  }});
  const vault={configDir:'.obsidian',adapter:{getBasePath:()=>vaultRoot},getAllLoadedFiles:()=>[{path:'Game',children:[]},{path:'Other',children:[]},{path:'.obsidian',children:[]}],getFileByPath:(path:string)=>existsSync(join(vaultRoot,path))?{path}:null,readBinary:async(file:any)=>{const data=await readFile(join(vaultRoot,file.path));return Uint8Array.from(data).buffer;},createFolder:async(path:string)=>{await mkdir(join(vaultRoot,path));},create:async(path:string,text:string)=>{await writeFile(join(vaultRoot,path),text,{flag:'wx'});return {path};},createBinary:async(path:string,data:ArrayBuffer)=>{await writeFile(join(vaultRoot,path),new Uint8Array(data),{flag:'wx'});return {path};},process:async(file:any,change:(text:string)=>string)=>{await writeFile(join(vaultRoot,file.path),change(await readFile(join(vaultRoot,file.path),'utf8')));}};
  const app={vault,workspace:{getLeavesOfType:()=>[]}} as unknown as App,options={app,settings:()=>settings,saveBinding:async(binding:any)=>{settings={...settings,bindings:[...settings.bindings!,binding]};},secrets,deviceId,storageRoot:join(directory,'state'),transportFactory:()=>wire};
  return {service:createNativePanelService(options),options,calls,directory,vaultRoot,root,connection,setSettings:(next:Settings)=>{settings=next;},get settings(){return settings;}};
}
test('native service construction and root metadata have no network or vault access',async t=>{
  const f=await fixture(t),options={...f.options,app:new Proxy({},{get(){throw Error('startup vault access');}}) as App},service=createNativePanelService(options);assert.equal(service.roots().length,1);assert.equal(service.connections().length,1);assert.deepEqual(f.calls,[]);
});

test('native history reads server versions and guarded local snapshots without changing either side',async t=>{
  const f=await fixture(t),wire=f.options.transportFactory(),row={id:1,entityType:'note',entityId:'note',revision:1,deleted:false,source:'site',actor:{id:'user',name:'Master'},createdAt:'2026-10-18T12:00:00.000Z'},source='# Historical\n',document={protocolVersion:1,id:'note',revision:1,title:'One',markdown:source,sourceHash:hashBytes(source),projectionHash:hashBytes(source),metadata:{icon:'',favorite:false},assets:[],board:null,diagnostics:[]};
  const service=createNativePanelService({...f.options,transportFactory:()=>({...wire,json:async(path,options)=>path.endsWith('/history')?{protocolVersion:1,rows:[row],nextCursor:null}:path.endsWith('/history/1')?{protocolVersion:1,change:row,document,folder:null}:wire.json(path,options)})}),signal=new AbortController().signal;
  const notes=await service.notes('local',signal);await service.apply('local',(await service.preview('local',['note'],signal)).id,signal);
  const file=join(f.vaultRoot,notes[0].path),before=await readFile(file,'utf8');await writeFile(file,before+'New local text\n');
  assert.ok(service.history);const list=await service.history.list('local',notes[0],undefined,signal);assert.equal(list.remoteStatus,'server');assert.ok(list.items.some(item=>item.source==='Локальная копия'));assert.equal(list.items.find(item=>item.id==='server-1')!.actor,'Master');assert.equal(list.siteUrl,'https://example.test/dm/camp/prep?open=note%3Anote');
  const preview=await service.history.read('local',list.id,'server-1',signal);assert.equal(preview.text,source);assert.match(preview.currentText!,/New local text/);
  const local=list.items.find(item=>item.source==='Локальная копия')!;assert.match((await service.history.read('local',list.id,local.id,signal)).text,/A clue/);
  f.options.app.workspace.getLeavesOfType=(()=>[{view:{file:{path:notes[0].path},editor:{getValue:()=>'# Unsaved editor text'}}}]) as any;
  assert.match((await service.history.read('local',list.id,'server-1',signal)).currentText!,/Unsaved editor text/);
  assert.equal(await readFile(file,'utf8'),before+'New local text\n');await assert.rejects(service.history.read('local',list.id,'unknown-version',signal));assert.deepEqual(await readdir(join(f.vaultRoot,'Other')),[]);
});

test('every sending protocol request carries the operation abort signal',async t=>{
  const f=await fixture(t);await writeFile(join(f.vaultRoot,'Game/Send.md'),'# Send\n');const signals:Array<AbortSignal|undefined>=[],wire=f.options.transportFactory();
  const app={...f.options.app,vault:{...f.options.app.vault,getAllLoadedFiles:()=>[{path:'Game/Send.md'}]}} as unknown as App;
  const service=createNativePanelService({...f.options,app,transportFactory:()=>({...wire,json:async(path,options)=>{signals.push(options?.signal);return wire.json(path,options);}})}),signal=new AbortController().signal;
  await service.sending!.preview('local',['Game/Send.md'],signal);assert.ok(signals.length>0);assert.ok(signals.every(value=>value===signal));
});

test('native sending inventory only lists in-root Markdown metadata and preview never mutates notes',async t=>{
  const f=await fixture(t);await writeFile(join(f.vaultRoot,'Game/Send.md'),'# Send\n');
  const app={...f.options.app,vault:{...f.options.app.vault,getAllLoadedFiles:()=>[{path:'Game/Send.md'},{path:'Other/Secret.md'},{path:'Game/map.png'}]}} as unknown as App;
  const service=createNativePanelService({...f.options,app}),signal=new AbortController().signal;
  assert.ok(service.sending);assert.equal((await service.sending.notes('local',signal)).length,1);assert.deepEqual(f.calls,[]);
  const review=await service.sending.preview('local',['Game/Send.md'],signal);assert.equal(review.stage,'capture');assert.equal(review.canConfirm,true);
  assert.ok(!f.calls.some((path:string)=>path.includes('transfers')));assert.equal(await readFile(join(f.vaultRoot,'Game/Send.md'),'utf8'),'# Send\n');
  await assert.rejects(service.sending.stage('local','unknown-preview',signal));assert.deepEqual(await readdir(join(f.vaultRoot,'Other')),[]);
});

test('invalid campaign paths are rejected before any catalog request',async t=>{
  const f=await fixture(t),signal=new AbortController().signal;
  await assert.rejects(f.service.bindings(f.connection.id,'../campaigns',signal));
  await assert.rejects(f.service.saveBinding({connectionId:f.connection.id,campaignId:'../campaigns',bindingId:'remote',root:'Game'},signal));
  assert.deepEqual(f.calls,[]);
});
test('a binding creation reply from another campaign or owner is rejected',async t=>{
  const f=await fixture(t),original=f.options.transportFactory();
  const service=createNativePanelService({...f.options,transportFactory:()=>({...original,json:async(path,options)=>path.endsWith('/bindings')?{id:'foreign',campaignId:'other',ownerId:'other',sourceBindingId:'source',destinationFolderId:null,name:'Foreign',revision:1}:original.json(path,options)})});
  await assert.rejects(service.createBinding(f.connection.id,'camp','Archive',new AbortController().signal));
});
test('actual scoped adapters preview read-only, then apply only after the exact one-use confirmation',async t=>{
  const f=await fixture(t),signal=new AbortController().signal,notes=await f.service.notes('local',signal),preview=await f.service.preview('local',[notes[0].id],signal);assert.deepEqual(await readdir(join(f.vaultRoot,'Game')),[]);
  assert.equal(preview.rows[0].status,'Новая запись');const result=await f.service.apply('local',preview.id,signal);assert.deepEqual(result,{written:1,pending:0});assert.match(await readFile(join(f.vaultRoot,notes[0].path),'utf8'),/dndplace:/);
  await assert.rejects(f.service.apply('local',preview.id,signal));assert.equal((await readdir(join(f.vaultRoot,'Game'))).length,1);assert.deepEqual(await readdir(join(f.vaultRoot,'Other')),[]);
});
test('a changed connection or root cannot reuse a previously approved preview',async t=>{
  const f=await fixture(t),signal=new AbortController().signal,notes=await f.service.notes('local',signal),preview=await f.service.preview('local',[notes[0].id],signal);
  f.setSettings({...f.settings,connections:[{...f.connection,baseUrl:'https://other.test'}]});await assert.rejects(f.service.apply('local',preview.id,signal));assert.deepEqual(await readdir(join(f.vaultRoot,'Game')),[]);
});
test('unknown selections and cancelled work cannot write notes',async t=>{
  const f=await fixture(t),controller=new AbortController();await assert.rejects(f.service.preview('local',['foreign-note'],controller.signal));controller.abort();await assert.rejects(f.service.notes('local',controller.signal));assert.deepEqual(await readdir(join(f.vaultRoot,'Game')),[]);
});
test('existing roots must be physically revalidated, not accepted after being replaced by a symlink',async t=>{
  const f=await fixture(t);await rm(join(f.vaultRoot,'Game'),{recursive:true});await symlink(join(f.vaultRoot,'Other'),join(f.vaultRoot,'Game'));
  await assert.rejects(f.service.saveBinding({connectionId:f.connection.id,campaignId:'camp',bindingId:'remote',root:'Game'},new AbortController().signal));
});
