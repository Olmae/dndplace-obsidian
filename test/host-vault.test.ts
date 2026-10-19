import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createObsidianVaultAdapter} from '../src/host/vault.js';
import {createFileSyncStorage} from '../src/sync/file-storage.js';
import {createSyncState} from '../src/sync/state.js';
import {planVaultWrites} from '../src/sync/pull.js';
import {applyVaultPlan,recoverVaultJournal} from '../src/sync/vault-writer.js';
import {hashBytes} from '../src/documents/hashes.js';
import {createLocalRestoreCoordinator} from '../src/sync/local-restore.js';
import {createSyncQueue} from '../src/sync/queue.js';
import fixtures from '../contracts/v1/valid.json';

const identity={connectionId:'connection',instanceId:'site',accountId:'dm',campaignId:'camp',bindingId:'binding'};
test('native local restore writes a physical temporary note and keeps the server baseline',async t=>{
 const f=await setup(t);await applyVaultPlan(planVaultWrites(f.batch,[],[]),{...f.host,state:f.state});
 const before=await f.state.load(identity,'Game'),queue=createSyncQueue({identity,root:'Game',deviceId:f.state.deviceId,storage:f.state.storage}),coordinator=createLocalRestoreCoordinator({binding:{id:'local',root:'Game',identity},state:f.state,queue,writer:f.host,assertContext:()=>{}});
 const source='\uFEFF---\r\n# annotation\r\ntitle: Restored\r\n---\r\nA clue\r\n',plan=await coordinator.previewRestore({path:'Game/Room.md',entityId:'note',text:source});
 await coordinator.applyRestore(plan);const bytes=await readFile(join(f.root,'Game/Room.md')),after=await f.state.load(identity,'Game');
 assert.ok(bytes.toString().startsWith('\uFEFF---\r\n'));assert.match(bytes.toString(),/# annotation\r\n/);assert.match(bytes.toString(),/A clue\r\n$/);assert.deepEqual(after.bases,before.bases);assert.equal(after.cursor,before.cursor);assert.ok(after.pending.some(row=>row.reason==='local-restore'));
});
function remote(markdown='# Room\n',revision=2){return {...structuredClone(fixtures.find(row=>row.kind==='document')!.value) as any,id:'note',revision,title:'Room',markdown,sourceHash:hashBytes(markdown),projectionHash:hashBytes(markdown),assets:[],board:null,metadata:{icon:'',favorite:false}};}
async function setup(t:any){
  const directory=await mkdtemp(join(tmpdir(),'dnd-native-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const root=join(directory,'vault');await mkdir(join(root,'Game'),{recursive:true});
  const files=new Map<string,any>(),calls:string[]=[],leaves:any[]=[];
  const vault:any={adapter:{getBasePath:()=>root},getFileByPath:(path:string)=>files.get(path)??null,createFolder:async(path:string)=>mkdir(join(root,path)),
    create:async(path:string,text:string)=>{calls.push('create');await writeFile(join(root,path),text,{flag:'wx'});files.set(path,{path});},createBinary:async(path:string,data:ArrayBuffer)=>{await writeFile(join(root,path),Buffer.from(data),{flag:'wx'});files.set(path,{path});},
    readBinary:async(file:{path:string})=>Uint8Array.from(await readFile(join(root,file.path))).buffer,
    process:async(file:{path:string},transform:(text:string)=>string)=>{calls.push('process');const next=transform(await readFile(join(root,file.path),'utf8'));await writeFile(join(root,file.path),next);},
  };
  const workspace:any={getLeavesOfType:()=>leaves},binding={id:'local',root:'Game',identity},host=createObsidianVaultAdapter({vault,workspace,binding,saveTimeoutMs:30});
  const state=createSyncState({deviceId:'device',storage:createFileSyncStorage({root:join(directory,'state')})});
  const batch={identity,root:'Game',expectedCursor:null,cursor:'first',notes:[{path:'Game/Room.md',document:remote()}],assets:[]};
  return {directory,root,vault,workspace,binding,host,state,batch,files,calls,leaves};
}
function editor(text:string){
  const history:string[]=[],transactions:any[]=[];
  const current:any={getValue:()=>text,listSelections:()=>[{anchor:{line:0,ch:1},head:{line:0,ch:3}}],posToOffset:(position:any)=>position.ch,offsetToPos:(offset:number)=>({line:0,ch:offset}),transaction:(value:any,origin:string)=>{history.push(text);transactions.push({value,origin});text=value.changes[0].text;},set:(next:string)=>{text=next;}};
  return {current,history,transactions};
}
test('closed notes use the real temporary filesystem through the guarded Vault.process boundary',async t=>{
  const f=await setup(t);await applyVaultPlan(planVaultWrites(f.batch,[],[]),{...f.host,state:f.state});
  const before=await readFile(join(f.root,'Game/Room.md')),base=(await f.state.load(identity,'Game')).bases;
  const next=planVaultWrites({...f.batch,expectedCursor:'first',cursor:'second',notes:[{path:'Game/Room.md',document:remote('# Next\n',3)}]},[{path:'Game/Room.md',data:before}],base);
  await applyVaultPlan(next,{...f.host,state:f.state});assert.ok(f.calls.includes('process'));assert.equal((await f.state.load(identity,'Game')).bases[0].serverRevision,3);
});
test('manual active replacement is an undoable editor transaction; an unsaved buffer is journaled and not acknowledged prematurely',async t=>{
  const f=await setup(t);await applyVaultPlan(planVaultWrites(f.batch,[],[]),{...f.host,state:f.state});
  const before=await readFile(join(f.root,'Game/Room.md')),oldBase=(await f.state.load(identity,'Game')).bases,e=editor('Unsaved local buffer');f.leaves.push({view:{file:{path:'Game/Room.md'},editor:e.current}});
  const snapshot=f.host.editor.snapshot('Game/Room.md')!;
  const plan=planVaultWrites({...f.batch,expectedCursor:'first',cursor:'second',notes:[{path:'Game/Room.md',document:remote('# Site\n',3)}]},[{path:'Game/Room.md',data:before,editor:snapshot}],oldBase,{mode:'manual',manual:[{path:'Game/Room.md',diskHash:hashBytes(before),editorHash:hashBytes(snapshot.text),editorToken:snapshot.token}]});
  await applyVaultPlan(plan,{...f.host,state:f.state});
  assert.equal(e.transactions.length,1);assert.equal(e.transactions[0].origin,'dndplace-pull');assert.ok(e.transactions[0].value.selections[0].from);assert.equal(e.history[0],'Unsaved local buffer');
  assert.equal(Buffer.from(await f.state.storage.readBlob(hashBytes(snapshot.text))).toString(),snapshot.text);
  const pending=await f.state.load(identity,'Game');assert.deepEqual(pending.bases,oldBase);assert.ok(pending.pending.some(row=>row.reason==='awaiting-save'));
  await writeFile(join(f.root,'Game/Room.md'),e.current.getValue());await recoverVaultJournal(identity,{...f.host,state:f.state,root:'Game'});
  assert.equal((await f.state.load(identity,'Game')).bases[0].serverRevision,3);
});
test('a changed editor buffer after manual review is not erased',async t=>{
  const f=await setup(t);await applyVaultPlan(planVaultWrites(f.batch,[],[]),{...f.host,state:f.state});
  const data=await readFile(join(f.root,'Game/Room.md')),base=(await f.state.load(identity,'Game')).bases,e=editor(Buffer.from(data).toString());f.leaves.push({view:{file:{path:'Game/Room.md'},editor:e.current}});
  const snapshot=f.host.editor.snapshot('Game/Room.md')!,plan=planVaultWrites({...f.batch,expectedCursor:'first',notes:[{path:'Game/Room.md',document:remote('# Site\n',3)}]},[{path:'Game/Room.md',data,editor:snapshot}],base,{mode:'manual',manual:[{path:'Game/Room.md',diskHash:hashBytes(data),editorHash:hashBytes(snapshot.text),editorToken:snapshot.token}]});
  e.current.set('Typed after review');await applyVaultPlan(plan,{...f.host,state:f.state});assert.equal(e.current.getValue(),'Typed after review');assert.equal(e.history.length,0);assert.deepEqual(await readFile(join(f.root,'Game/Room.md')),data);
});
test('symlinked files and parent directories never authorize an out-of-root host read or create',async t=>{
  const f=await setup(t),outside=join(f.directory,'outside');await mkdir(outside);await writeFile(join(outside,'Secret.md'),'Keep');
  await symlink(join(outside,'Secret.md'),join(f.root,'Game/Link.md'));await symlink(outside,join(f.root,'Game/Shortcut'));
  await assert.rejects(f.host.vault.read('Game/Link.md'));await assert.rejects(f.host.vault.create('Game/Shortcut/New.md',Buffer.from('Bad')));
  assert.equal(await readFile(join(outside,'Secret.md'),'utf8'),'Keep');await assert.rejects(readFile(join(outside,'New.md')));
});
test('an editor appearing inside the closed-file processing boundary defers the write',async t=>{
  const f=await setup(t);await applyVaultPlan(planVaultWrites(f.batch,[],[]),{...f.host,state:f.state});
  const data=await readFile(join(f.root,'Game/Room.md')),base=(await f.state.load(identity,'Game')).bases,process=f.vault.process;
  f.vault.process=async(file:any,transform:any)=>{f.leaves.push({view:{file:{path:'Game/Room.md'},editor:editor('New unsaved text').current}});await process(file,transform);};
  const plan=planVaultWrites({...f.batch,expectedCursor:'first',notes:[{path:'Game/Room.md',document:remote('# Site\n',3)}]},[{path:'Game/Room.md',data}],base);await applyVaultPlan(plan,{...f.host,state:f.state});
  assert.deepEqual(await readFile(join(f.root,'Game/Room.md')),data);assert.deepEqual((await f.state.load(identity,'Game')).bases,base);
});
