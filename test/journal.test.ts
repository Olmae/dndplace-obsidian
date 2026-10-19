import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFileSyncStorage} from '../src/sync/file-storage.js';
import {createSyncState} from '../src/sync/state.js';
import {hashBytes} from '../src/documents/hashes.js';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';

const identity={connectionId:'connection',instanceId:'site',accountId:'dm',campaignId:'camp',bindingId:'binding'};
test('device-scoped state survives reopening and concurrent independent storage writers',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dnd-journal-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const storage=createFileSyncStorage({root}),a=createSyncState({deviceId:'device',storage}),b=createSyncState({deviceId:'device',storage:createFileSyncStorage({root})});
  assert.equal((await a.load(identity,'Game')).cursor,null);
  await Promise.all([a.update(identity,'Game',state=>({...state,pending:[...state.pending,{id:'one',path:'Game/One.md',entityId:'one',reason:'missing',journalId:null,remote:null}]})),b.update(identity,'Game',state=>({...state,pending:[...state.pending,{id:'two',path:'Game/Two.md',entityId:'two',reason:'missing',journalId:null,remote:null}]}))]);
  assert.equal((await a.load(identity,'Game')).pending.length,2);
  assert.equal((await createSyncState({deviceId:'other',storage}).load(identity,'Game')).pending.length,0);
  assert.equal((await a.load({...identity,accountId:'other'},'Game')).pending.length,0);
  await assert.rejects(a.load(identity,'Different'));
});
test('immutable storage blobs and compare-and-swap never replace newer data',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dnd-storage-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const storage=createFileSyncStorage({root}),key='a'.repeat(64),bytes=Buffer.from('preimage');
  assert.equal(await storage.putBlob(bytes),hashBytes(bytes));assert.deepEqual(await storage.readBlob(hashBytes(bytes)),bytes);
  assert.equal(await storage.compareAndSwap(key,null,'first'),true);assert.equal(await storage.compareAndSwap(key,null,'stale'),false);
  assert.equal(await storage.read(key),'first');assert.equal(await storage.compareAndSwap(key,'first','second'),true);assert.equal(await storage.read(key),'second');
});
test('corrupt or copied device state fails closed rather than resetting journals',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dnd-corrupt-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const storage=createFileSyncStorage({root}),state=createSyncState({deviceId:'device',storage});
  await state.update(identity,'Game',value=>value);
  const folder=join(root,'states',(await readdir(join(root,'states')))[0]),file=join(folder,(await readdir(folder)).find(name=>name.endsWith('.json'))!);
  await writeFile(file,'broken');await assert.rejects(state.load(identity,'Game'));
  const fake={...storage,read:async()=>JSON.stringify({version:1,deviceId:'copied-device',identity,root:'Game',generation:1,cursor:null,bases:[],pending:[],journals:[],ownWrites:[]})};
  await assert.rejects(createSyncState({deviceId:'device',storage:fake}).load(identity,'Game'));
});
test('a failed durable state commit does not advance any in-memory baseline',async()=>{
  const storage={read:async()=>null,compareAndSwap:async()=>{throw new Error('disk full');},putBlob:async(data:Uint8Array)=>hashBytes(data),readBlob:async()=>Buffer.alloc(0)};
  const state=createSyncState({deviceId:'device',storage});
  await assert.rejects(state.update(identity,'Game',value=>({...value,cursor:'must-not-advance'})),/disk full/);assert.equal((await state.load(identity,'Game')).cursor,null);
});
test('independent operating-system processes preserve both concurrent journal updates',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dnd-process-state-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const {build}=createRequire(resolve('package.json'))('esbuild'),worker=join(root,'worker.mjs');
  await build({stdin:{contents:`import {createSyncState} from './src/sync/state.ts';import {createFileSyncStorage} from './src/sync/file-storage.ts';const [root,id]=process.argv.slice(2);const identity=${JSON.stringify(identity)};const state=createSyncState({deviceId:'device',storage:createFileSyncStorage({root})});await state.update(identity,'Game',value=>({...value,pending:[...value.pending,{id,path:'Game/'+id+'.md',entityId:id,reason:'missing',journalId:null,remote:null}]}));`,resolveDir:process.cwd(),sourcefile:'worker.ts',loader:'ts'},outfile:worker,bundle:true,platform:'node',target:'node22',format:'esm',logLevel:'silent'});
  const run=(id:string)=>new Promise<void>((resolve,reject)=>{const child=spawn(process.execPath,[worker,join(root,'state'),id]);let output='';child.stderr.on('data',data=>{output+=data;});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(output)));});
  await Promise.all([run('one'),run('two')]);
  const state=createSyncState({deviceId:'device',storage:createFileSyncStorage({root:join(root,'state')})});assert.deepEqual((await state.load(identity,'Game')).pending.map(row=>row.id).sort(),['one','two']);
});
