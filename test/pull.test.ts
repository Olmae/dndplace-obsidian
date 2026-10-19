import test from 'node:test';
import assert from 'node:assert/strict';
import {planVaultWrites} from '../src/sync/pull.js';
import {hashBytes} from '../src/documents/hashes.js';
import {attachIdentity,stripIdentity} from '../src/documents/frontmatter.js';
import fixtures from '../contracts/v1/valid.json';

export const identity={connectionId:'connection',instanceId:'site',accountId:'dm',campaignId:'camp',bindingId:'binding'};
export function document(markdown='# Room\r\n',id='note'){
  const value=structuredClone(fixtures.find(row=>row.kind==='document')!.value) as any;
  return {...value,id,revision:2,title:'Room',markdown,sourceHash:hashBytes('original authoring source'),projectionHash:hashBytes(markdown),assets:[],board:null,metadata:{icon:'book',favorite:false}};
}
test('initial pull is source-exact except inert metadata and places images relative to nested notes',()=>{
  const data=Buffer.from([137,80,78,71,13,10,26,10]),sha256=hashBytes(data),asset={id:'image',mime:'image/png',sha256,byteSize:data.length,relativePath:`_assets/dndplace/${sha256}.png`};
  const remote={...document(`![Map](<_assets/dndplace/${sha256}.png>)\r\n`),assets:[asset]};
  const plan=planVaultWrites({identity,root:'Game',expectedCursor:null,cursor:'checkpoint',notes:[{path:'Game/Rooms/Room.md',document:remote}],assets:[{descriptor:asset,data}]},[],[]);
  assert.equal(plan.entries[0].kind,'asset');assert.equal(plan.entries[0].path,'Game/Rooms/'+asset.relativePath);
  const note=plan.entries.find(entry=>entry.kind==='note')!;assert.equal(stripIdentity(Buffer.from(note.output).toString()),remote.markdown);assert.equal(note.expectedHash,null);
  assert.equal(note.nextBase?.serverSourceHash,remote.sourceHash);assert.equal(note.nextBase?.projectionHash,remote.projectionHash);assert.notEqual(note.nextBase?.localFileHash,note.nextBase?.basePortableHash);
});
test('an unrelated same-named file or a changed local snapshot is never implicitly replaced',()=>{
  const batch={identity,root:'Game',expectedCursor:null,cursor:'next',notes:[{path:'Game/Room.md',document:document()}],assets:[]};
  const first=planVaultWrites(batch,[],[]),nextBase=first.entries[0].nextBase!;
  const collision=planVaultWrites(batch,[{path:'Game/Room.md',data:Buffer.from('Unrelated')}],[]);assert.equal(collision.entries[0].blockedReason,'collision');
  const changed=planVaultWrites(batch,[{path:'Game/Room.md',data:Buffer.from('User edit')}],[nextBase]);assert.equal(changed.entries[0].blockedReason,'local-changed');
  assert.throws(()=>planVaultWrites({...batch,notes:[{path:'Other/Room.md',document:document()}]},[],[]));
});
test('downloaded hashes, bytes, missing images and duplicate destinations are checked before any journal',()=>{
  const batch={identity,root:'Game',expectedCursor:null,cursor:null,notes:[{path:'Game/Room.md',document:document()}],assets:[]};
  assert.throws(()=>planVaultWrites({...batch,notes:[{path:'Game/Room.md',document:{...document(),projectionHash:'0'.repeat(64)}}]},[],[]));
  assert.throws(()=>planVaultWrites({...batch,notes:[...batch.notes,...batch.notes]},[],[]));
  const remote={...document(),assets:[{id:'image',mime:'image/png',sha256:'a'.repeat(64),byteSize:4,relativePath:'_assets/dndplace/'+('a'.repeat(64))+'.png'}]};
  assert.throws(()=>planVaultWrites({...batch,notes:[{path:'Game/Room.md',document:remote}],assets:[{descriptor:remote.assets[0],data:Buffer.from('bad')}]},[],[]));
  const missing=planVaultWrites({...batch,notes:[{path:'Game/Room.md',document:remote}]},[],[]);assert.equal(missing.entries.find(row=>row.kind==='note')?.blockedReason,'missing-asset');
});
