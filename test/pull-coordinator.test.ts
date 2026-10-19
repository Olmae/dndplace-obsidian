import test from 'node:test';
import assert from 'node:assert/strict';
import {createPullCoordinator} from '../src/sync/pull-coordinator.js';
import {createSyncState} from '../src/sync/state.js';
import {createSyncQueue} from '../src/sync/queue.js';
import {hashBytes} from '../src/documents/hashes.js';
import {stripIdentity} from '../src/documents/frontmatter.js';
import type {SyncStorage} from '../src/sync/state.js';
import type {DownloadDocument} from '../src/sync/pull.js';

const identity={connectionId:'local',instanceId:'site',accountId:'dm',campaignId:'camp',bindingId:'binding'},binding={id:'root',identity,root:'Game'};
function fixture(){
  const rows=new Map<string,string>(),blobs=new Map<string,Uint8Array>(),files=new Map<string,Uint8Array>();
  const storage:SyncStorage={read:async key=>rows.get(key)??null,compareAndSwap:async(key,expected,next)=>{if((rows.get(key)??null)!==expected)return false;rows.set(key,next);return true;},putBlob:async bytes=>{const hash=hashBytes(bytes);blobs.set(hash,Uint8Array.from(bytes));return hash;},readBlob:async hash=>Uint8Array.from(blobs.get(hash)!)};
  const state=createSyncState({deviceId:'device',storage}),queue=createSyncQueue({identity,root:'Game',deviceId:'device',storage}),source='# One\r\nA clue\r\n',remote:DownloadDocument={protocolVersion:1,id:'note',revision:1,title:'One',markdown:source,sourceHash:hashBytes(source),projectionHash:hashBytes(source),metadata:{icon:'',favorite:false},board:null,assets:[],diagnostics:[]};
  const calls:string[]=[],client={identity,document:async(id:string,revision:number)=>{calls.push('document');assert.equal(id,remote.id);assert.equal(revision,remote.revision);return structuredClone(remote);},asset:async(descriptor:any)=>{calls.push('asset');return Buffer.alloc(descriptor.byteSize);}};
  const editor={snapshot:(_path:string)=>null as {text:string;token:string}|null,replace:async()=>false,waitForSaved:async()=>true};
  const vault={read:async(path:string)=>files.get(path)??null,create:async(path:string,data:Uint8Array)=>{assert.ok(!files.has(path));files.set(path,Uint8Array.from(data));},process:async(path:string,change:(text:string)=>string)=>{const current=files.get(path);assert.ok(current);files.set(path,Buffer.from(change(Buffer.from(current).toString())));}};
  const selection=[{path:'Game/One.md',entityId:'note',revision:1}],coordinator=()=>createPullCoordinator({binding,state,queue,client,writer:{vault,editor},assertContext:()=>{}});
  return {state,queue,files,remote,client,calls,vault,editor,selection,coordinator};
}
test('preview is read-only; apply writes captured Markdown and records its base without advancing a feed',async()=>{
  const f=fixture(),plan=await f.coordinator().previewPull(f.selection);assert.equal(f.files.size,0);assert.equal((await f.state.load(identity,'Game')).generation,0);
  await f.coordinator().applyPull(plan);assert.equal(stripIdentity(Buffer.from(f.files.get('Game/One.md')!).toString()),f.remote.markdown);const saved=await f.state.load(identity,'Game');assert.equal(saved.bases[0].serverRevision,1);assert.equal(saved.cursor,null);assert.equal(saved.journals[0].status,'completed');
});
test('selection is captured before asynchronous context checks and rejects unsafe or duplicate paths',async()=>{
  const f=fixture(),pending=f.coordinator().previewPull(f.selection);f.selection[0].path='Other/Unexpected.md';assert.equal((await pending).entries[0].path,'Game/One.md');
  for(const selection of [[{path:'Other/One.md',entityId:'note',revision:1}],[{path:'Game/.obsidian/config.md',entityId:'note',revision:1}],[...f.selection,...f.selection]])await assert.rejects(f.coordinator().previewPull(selection));
});
test('a file created or edited after preview is preserved as a durable pending conflict',async()=>{
  const f=fixture(),plan=await f.coordinator().previewPull(f.selection);f.files.set('Game/One.md',Buffer.from('My later note'));await f.coordinator().applyPull(plan);
  assert.equal(Buffer.from(f.files.get('Game/One.md')!).toString(),'My later note');const saved=await f.state.load(identity,'Game');assert.equal(saved.bases.length,0);assert.equal(saved.pending.length,1);
});
test('an unfinished push appearing after preview blocks the pull instead of overwriting its file',async()=>{
  const f=fixture(),plan=await f.coordinator().previewPull(f.selection);await f.queue.enqueue({packageBytes:Buffer.from('zip'),notes:[{path:'Game/One.md',entityId:null,localFileHash:hashBytes('local'),baseVersion:null}]});
  await f.coordinator().applyPull(plan);assert.equal(f.files.size,0);assert.equal((await f.state.load(identity,'Game')).pending[0].reason,'push-pending');
});
test('the durable pull lease blocks newly queued captures while the actual write runs',async()=>{
  const f=fixture(),plan=await f.coordinator().previewPull(f.selection),create=f.vault.create;
  f.vault.create=async(path,data)=>{await assert.rejects(f.queue.enqueue({packageBytes:Buffer.from('zip'),notes:[{path:'Game/One.md',entityId:null,localFileHash:hashBytes('local'),baseVersion:null}]}));await create(path,data);};
  await f.coordinator().applyPull(plan);assert.equal((await f.queue.snapshot()).jobs.length,0);assert.equal(f.files.size,1);
});
test('modified plans and changed account context are rejected before journal or file writes',async()=>{
  const f=fixture(),plan=await f.coordinator().previewPull(f.selection);plan.entries[0].path='Other/One.md';await assert.rejects(f.coordinator().applyPull(plan));assert.equal(f.files.size,0);assert.equal((await f.state.load(identity,'Game')).journals.length,0);
  const valid=await f.coordinator().previewPull(f.selection),other=createPullCoordinator({binding,state:f.state,queue:f.queue,client:f.client,writer:{vault:f.vault,editor:f.editor},assertContext:()=>{throw Error('changed account');}});await assert.rejects(other.applyPull(valid));assert.equal(f.files.size,0);
});
test('a partial save recovers its journal without rewriting an already saved output',async()=>{
  const f=fixture(),plan=await f.coordinator().previewPull(f.selection),create=f.vault.create;let writes=0;
  f.vault.create=async(path,data)=>{writes++;await create(path,data);throw Error('stopped after save');};await assert.rejects(f.coordinator().applyPull(plan));assert.equal((await f.state.load(identity,'Game')).bases.length,0);
  f.vault.create=create;await f.coordinator().recoverPull();assert.equal(writes,1);assert.equal((await f.state.load(identity,'Game')).bases.length,1);
});
test('automatic pull leaves an open unsaved editor untouched',async()=>{
  const f=fixture(),first=await f.coordinator().previewPull(f.selection);await f.coordinator().applyPull(first);f.remote.revision=2;f.remote.markdown='# One\nRemote edit\n';f.remote.projectionHash=hashBytes(f.remote.markdown);f.remote.sourceHash=f.remote.projectionHash;
  f.editor.snapshot=()=>({text:'An unsaved local thought',token:'edit'});const plan=await f.coordinator().previewPull([{...f.selection[0],revision:2}],{mode:'automatic'});await f.coordinator().applyPull(plan);
  assert.ok(!Buffer.from(f.files.get('Game/One.md')!).toString().includes('Remote edit'));assert.equal((await f.state.load(identity,'Game')).pending[0].reason,'active-editor');
});
test('wrong document identity or corrupt image bytes fail before any local journal is created',async()=>{
  const f=fixture();f.client.document=async()=>({...f.remote,id:'other'});await assert.rejects(f.coordinator().previewPull(f.selection));assert.equal(f.files.size,0);
  f.client.document=async()=>structuredClone(f.remote);const data=Buffer.from('expected'),sha256=hashBytes(data);f.remote.assets=[{id:'image',mime:'image/png',sha256,byteSize:data.length,relativePath:`_assets/dndplace/${sha256}.png`}];await assert.rejects(f.coordinator().previewPull(f.selection));assert.equal((await f.state.load(identity,'Game')).journals.length,0);
});
test('download and local preimage budgets include board payloads and unsaved editor buffers',async()=>{
  const large=fixture();large.remote.board='x'.repeat(4194304);large.client.document=async(id:string)=>({...large.remote,id});
  await assert.rejects(large.coordinator().previewPull(Array.from({length:9},(_,i)=>({path:`Game/${i}.md`,entityId:'note'+i,revision:1}))));assert.equal((await large.state.load(identity,'Game')).journals.length,0);
  const local=fixture(),bytes=Buffer.alloc(1048576,88),text='x'.repeat(1048576),selection=Array.from({length:17},(_,i)=>({path:`Game/${i}.md`,entityId:'note'+i,revision:1}));
  for(const note of selection)local.files.set(note.path,bytes);local.editor.snapshot=()=>({text,token:'editor'});local.client.document=async(id:string)=>({...local.remote,id});
  await assert.rejects(local.coordinator().previewPull(selection));assert.equal((await local.state.load(identity,'Game')).journals.length,0);
});
