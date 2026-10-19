import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFileSyncStorage} from '../src/sync/file-storage.js';
import {createSyncState} from '../src/sync/state.js';
import {planVaultWrites} from '../src/sync/pull.js';
import {applyVaultPlan,recoverVaultJournal} from '../src/sync/vault-writer.js';
import {hashBytes} from '../src/documents/hashes.js';
import fixtures from '../contracts/v1/valid.json';
import {matchesOwnWrite,prepareVaultJournal} from '../src/sync/journal.js';

const identity={connectionId:'connection',instanceId:'site',accountId:'dm',campaignId:'camp',bindingId:'binding'};
function document(markdown='# Room\n',id='note'){const value=structuredClone(fixtures.find(row=>row.kind==='document')!.value) as any;return {...value,id,revision:2,title:'Room',markdown,sourceHash:hashBytes(markdown),projectionHash:hashBytes(markdown),assets:[],board:null,metadata:{icon:'',favorite:false}};}
async function setup(t:any){
  const root=await mkdtemp(join(tmpdir(),'dnd-writer-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const state=createSyncState({deviceId:'device',storage:createFileSyncStorage({root})}),files=new Map<string,Uint8Array>(),events:string[]=[];
  const vault={read:async(path:string)=>files.get(path)??null,create:async(path:string,bytes:Uint8Array)=>{if(files.has(path))throw new Error('exists');events.push('create:'+path);files.set(path,Buffer.from(bytes));},process:async(path:string,transform:(data:string)=>string)=>{const data=files.get(path);if(!data)throw new Error('missing');events.push('process:'+path);files.set(path,Buffer.from(transform(Buffer.from(data).toString())));}};
  const editor={snapshot:(_path:string)=>null as {text:string;token:string}|null,replace:async()=>false,waitForSaved:async()=>true};
  const batch={identity,root:'Game',expectedCursor:null,cursor:'cursor',notes:[{path:'Game/Room.md',document:document()}],assets:[]};
  return {state,files,events,vault,editor,batch,storageRoot:root};
}
test('journal is durable before writes; bases and cursor advance only after confirmed output',async t=>{
  const f=await setup(t),plan=planVaultWrites(f.batch,[],[]);
  const create=f.vault.create;f.vault.create=async(path,data)=>{assert.equal((await f.state.load(identity,'Game')).journals.length,1);assert.equal((await f.state.load(identity,'Game')).bases.length,0);await create(path,data);};
  await applyVaultPlan(plan,f);
  const stored=await f.state.load(identity,'Game');assert.equal(stored.bases.length,1);assert.equal(stored.cursor,'cursor');assert.equal(stored.journals[0].entries[0].status,'acknowledged');assert.equal(stored.ownWrites[0].hash,hashBytes(f.files.get('Game/Room.md')!));
});
test('recovery finishes the checkpoint after a crash between note acknowledgement and journal finish',async t=>{const f=await setup(t),plan=planVaultWrites(f.batch,[],[]),update=f.state.update;f.state.update=async(identity,root,reduce)=>{const before=await f.state.load(identity,root),next=reduce(structuredClone(before));if(next.checkpoint>before.checkpoint)throw Error('crash before checkpoint');return update(identity,root,reduce);};await assert.rejects(applyVaultPlan(plan,f),/crash before checkpoint/);f.state.update=update;await recoverVaultJournal(identity,{...f,root:'Game'});assert.equal((await f.state.load(identity,'Game')).cursor,'cursor');});
test('a collision appearing after download becomes durable pending, never an overwrite',async t=>{
  const f=await setup(t),plan=planVaultWrites(f.batch,[],[]);f.files.set('Game/Room.md',Buffer.from('User created this'));
  await applyVaultPlan(plan,f);assert.equal(Buffer.from(f.files.get('Game/Room.md')!).toString(),'User created this');
  const stored=await f.state.load(identity,'Game');assert.equal(stored.bases.length,0);assert.equal(stored.pending[0].reason,'collision');assert.equal(stored.cursor,'cursor');
});
test('automatic pulls defer any open editor buffer and retain the old base',async t=>{
  const f=await setup(t),initial=planVaultWrites(f.batch,[],[]);await applyVaultPlan(initial,f);const base=(await f.state.load(identity,'Game')).bases;
  const next=planVaultWrites({...f.batch,expectedCursor:'cursor',notes:[{path:'Game/Room.md',document:{...document('# New\n'),revision:3}}]},[{path:'Game/Room.md',data:f.files.get('Game/Room.md')!}],base);
  f.editor.snapshot=()=>({text:'Unsaved local buffer',token:'editor'});
  const before=f.files.get('Game/Room.md');await applyVaultPlan(next,f);assert.deepEqual(f.files.get('Game/Room.md'),before);assert.deepEqual((await f.state.load(identity,'Game')).bases,base);assert.ok((await f.state.load(identity,'Game')).pending.some(row=>row.reason==='active-editor'));
});
test('recovery after a write but before acknowledgement recognizes the exact output without writing again',async t=>{
  const f=await setup(t),plan=planVaultWrites(f.batch,[],[]),create=f.vault.create;
  f.vault.create=async(path,data)=>{await create(path,data);throw new Error('crash after write');};
  await assert.rejects(applyVaultPlan(plan,f),/crash after write/);assert.equal((await f.state.load(identity,'Game')).bases.length,0);
  f.vault.create=create;const count=f.events.length;await recoverVaultJournal(identity,{...f,root:'Game'});assert.equal(f.events.length,count);assert.equal((await f.state.load(identity,'Game')).bases.length,1);
});
test('recovery never rolls back over a user edit following a partial crash',async t=>{
  const f=await setup(t),plan=planVaultWrites(f.batch,[],[]),create=f.vault.create;
  f.vault.create=async(path,data)=>{await create(path,data);throw new Error('crash');};await assert.rejects(applyVaultPlan(plan,f));
  f.files.set('Game/Room.md',Buffer.from('Later user edit'));f.vault.create=create;
  await recoverVaultJournal(identity,{...f,root:'Game'});assert.equal(Buffer.from(f.files.get('Game/Room.md')!).toString(),'Later user edit');assert.equal((await f.state.load(identity,'Game')).bases.length,0);assert.ok((await f.state.load(identity,'Game')).pending.length);
});
test('recovering an older pending journal never regresses a later checkpoint',async t=>{
  const f=await setup(t),old=planVaultWrites(f.batch,[],[]);f.files.set('Game/Room.md',Buffer.from('Collision'));await applyVaultPlan(old,f);
  const later=planVaultWrites({...f.batch,expectedCursor:'cursor',cursor:'later',notes:[{path:'Game/Other.md',document:document('# Other\n','other')}]},[],[]);await applyVaultPlan(later,f);
  assert.equal((await f.state.load(identity,'Game')).cursor,'later');await recoverVaultJournal(identity,{...f,root:'Game'});assert.equal((await f.state.load(identity,'Game')).cursor,'later');
});
test('a stale older revision cannot replace a newer base even when note bytes are identical',async t=>{
  const f=await setup(t),old=planVaultWrites(f.batch,[],[]),newer=planVaultWrites({...f.batch,cursor:'newer',notes:[{path:'Game/Room.md',document:{...document(),revision:3}}]},[],[]);
  await applyVaultPlan(newer,f);await assert.rejects(applyVaultPlan(old,f),/Позиция истории/);assert.equal((await f.state.load(identity,'Game')).bases[0].serverRevision,3);
});
test('a user edit to a downloaded asset before the note write blocks the referring note',async t=>{
  const f=await setup(t),data=Buffer.from('verified server bytes'),sha256=hashBytes(data),descriptor={id:'asset',mime:'image/png',sha256,byteSize:data.length,relativePath:`_assets/dndplace/${sha256}.png`};
  const plan=planVaultWrites({...f.batch,notes:[{path:'Game/Room.md',document:{...document(),assets:[descriptor]}}],assets:[{descriptor,data}]},[],[]),read=f.vault.read;
  f.vault.read=async path=>{if(path==='Game/Room.md')f.files.set('Game/'+descriptor.relativePath,Buffer.from('user changed asset'));return read(path);};
  await applyVaultPlan(plan,f);assert.equal(f.files.has('Game/Room.md'),false);assert.equal((await f.state.load(identity,'Game')).bases.length,0);
});
test('own-write suppression matches path, exact bytes and generation rather than a time window',async t=>{
  const f=await setup(t);await applyVaultPlan(planVaultWrites(f.batch,[],[]),f);const state=await f.state.load(identity,'Game'),own=state.ownWrites[0];
  assert.equal(matchesOwnWrite(state,own.path,own.hash,own.generation),true);assert.equal(matchesOwnWrite(state,own.path,hashBytes('typed immediately'),own.generation),false);assert.equal(matchesOwnWrite(state,own.path,own.hash,own.generation+1),false);
});
test('an unfinished journal blocks a fresh competing plan until recovery',async t=>{
  const f=await setup(t),first=planVaultWrites(f.batch,[],[]),other=planVaultWrites(f.batch,[],[]);await prepareVaultJournal(first,f.state);
  await assert.rejects(applyVaultPlan(other,f),/восстанов/);assert.equal(f.files.size,0);await recoverVaultJournal(identity,{...f,root:'Game'});assert.equal((await f.state.load(identity,'Game')).bases.length,1);
});
test('recovery checks the current base before any write, not only when acknowledging it',async t=>{
  const f=await setup(t);await applyVaultPlan(planVaultWrites(f.batch,[],[]),f);const before=f.files.get('Game/Room.md')!,base=(await f.state.load(identity,'Game')).bases;
  const old=planVaultWrites({...f.batch,expectedCursor:'cursor',notes:[{path:'Game/Room.md',document:{...document('# Older remote\n'),revision:3}}]},[{path:'Game/Room.md',data:before}],base);await prepareVaultJournal(old,f.state);
  await f.state.update(identity,'Game',state=>({...state,bases:state.bases.map(row=>({...row,serverRevision:4}))}));
  await recoverVaultJournal(identity,{...f,root:'Game'});assert.deepEqual(f.files.get('Game/Room.md'),before);assert.equal((await f.state.load(identity,'Game')).bases[0].serverRevision,4);
});
test('a partially written multi-note batch retains progress but not its checkpoint until recovery',async t=>{
  const f=await setup(t),plan=planVaultWrites({...f.batch,notes:[...f.batch.notes,{path:'Game/Other.md',document:document('# Other\n','other')}]},[],[]),create=f.vault.create;let count=0;
  f.vault.create=async(path,data)=>{await create(path,data);if(++count===2)throw new Error('partial crash');};
  await assert.rejects(applyVaultPlan(plan,f),/partial crash/);const partial=await f.state.load(identity,'Game');assert.equal(partial.bases.length,1);assert.equal(partial.cursor,null);
  f.vault.create=create;const writes=f.events.length;await recoverVaultJournal(identity,{...f,root:'Game'});assert.equal(f.events.length,writes);assert.equal((await f.state.load(identity,'Game')).bases.length,2);assert.equal((await f.state.load(identity,'Game')).cursor,'cursor');
});
test('a corrupt recovery blob stops before any file write or checkpoint advance',async t=>{
  const f=await setup(t),plan=planVaultWrites(f.batch,[],[]);await prepareVaultJournal(plan,f.state);
  await writeFile(join(f.storageRoot,'blobs',plan.entries[0].outputHash),'corrupt');
  await assert.rejects(recoverVaultJournal(identity,{...f,root:'Game'}));assert.equal(f.files.size,0);assert.equal((await f.state.load(identity,'Game')).cursor,null);
});
test('note boards remain separate durable auxiliary data, never inserted into note prose',async t=>{
  const f=await setup(t),board='{"nodes":[{"id":"one","text":"Board-only detail"}],"edges":[]}',plan=planVaultWrites({...f.batch,notes:[{path:'Game/Room.md',document:{...document(),board}}]},[],[]);
  await applyVaultPlan(plan,f);const base=(await f.state.load(identity,'Game')).bases[0];assert.equal(base.boardHash,hashBytes(board));assert.equal(Buffer.from(await f.state.storage.readBlob(base.boardHash!)).toString(),board);assert.ok(!Buffer.from(f.files.get('Game/Room.md')!).toString().includes('Board-only detail'));
});
