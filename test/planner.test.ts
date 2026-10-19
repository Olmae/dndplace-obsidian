import test from 'node:test';
import assert from 'node:assert/strict';
import {planSync} from '../src/sync/planner.js';
import type {LocalVersion,BaseVersion,RemoteVersion} from '../src/sync/planner.js';

const identity={connectionId:'local',instanceId:'site',accountId:'dm',campaignId:'camp',bindingId:'binding'},a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64);
const local:LocalVersion={identity,entityId:'note',path:'Game/Room.md',localFileHash:a,portableHash:a,metadataHash:a,assetHash:a,identityStatus:'bound',diagnostics:[]};
const base:BaseVersion={identity,entityId:'note',path:'Game/Room.md',localFileHash:a,basePortableHash:a,localMetadataHash:a,assetHash:a,serverSourceHash:b,projectionHash:a,serverRevision:1,remoteMetadataHash:a};
const remote:RemoteVersion={identity,entityId:'note',revision:1,sourceHash:b,projectionHash:a,metadataHash:a};

test('the complete local/base/remote truth table is conservative and has no I/O',()=>{
  const cases:Array<[LocalVersion|null,BaseVersion|null,RemoteVersion|null,string]>=[
    [local,base,remote,'unchanged'],[{...local,portableHash:c},base,remote,'push'],[local,base,{...remote,revision:2,sourceHash:c},'pull'],
    [{...local,portableHash:c},base,{...remote,revision:2,sourceHash:c},'conflict'],
    [{...local,entityId:null,identityStatus:'new'},null,null,'create'],[null,null,remote,'pull'],[local,null,remote,'copy-review'],
    [null,base,remote,'missing'],[local,base,null,'missing'],[null,base,null,'missing'],[null,null,null,'unchanged'],
  ];
  for(const [l,b,r,action] of cases)assert.equal(planSync({identity,local:l,base:b,remote:r}).action,action);
});
test('injected identity bytes alone do not push, while exact CRLF/source edits do',()=>{
  assert.equal(planSync({identity,local:{...local,localFileHash:c},base,remote}).action,'unchanged');
  assert.equal(planSync({identity,local:{...local,portableHash:c},base,remote}).action,'push');
  const result=planSync({identity,local:{...local,portableHash:c},base,remote});assert.deepEqual(result.baseVersion,{entityId:'note',revision:1,sourceHash:b});
});
test('metadata/assets participate independently and equivalent edits only refresh the base',()=>{
  for(const patch of [{metadataHash:c},{assetHash:c}])assert.equal(planSync({identity,local:{...local,...patch},base,remote}).action,'push');
  assert.equal(planSync({identity,local,base,remote:{...remote,metadataHash:c}}).action,'pull');
  const converged=planSync({identity,local:{...local,portableHash:c},base,remote:{...remote,revision:2,sourceHash:c,projectionHash:c}});
  assert.equal(converged.action,'unchanged');assert.equal(converged.needsBaseRefresh,true);
});
test('every changed scope or entity requires review rather than reuse of an old mapping',()=>{
  for(const key of Object.keys(identity) as (keyof typeof identity)[])for(const field of ['local','base','remote'] as const){
    const input={identity,local,base,remote,[field]:{...({local,base,remote}[field]),identity:{...identity,[key]:'other'}}};assert.equal(planSync(input).action,'copy-review');
  }
  assert.equal(planSync({identity,local:{...local,entityId:'copied'},base,remote}).action,'copy-review');
  assert.equal(planSync({identity,local:{...local,identityStatus:'review'},base,remote}).action,'copy-review');
});
test('renames preserve the entity; case-only/cross-binding moves require review',()=>{
  assert.equal(planSync({identity,local:{...local,path:'Game/Other.md'},base,remote}).action,'push');
  assert.equal(planSync({identity,local:{...local,path:'Game/room.md'},base,remote}).action,'copy-review');
  assert.equal(planSync({identity,local:{...local,path:'Other/Room.md',identity:{...identity,bindingId:'other'}},base,remote}).action,'copy-review');
});
test('invalid hashes, duplicate identity diagnostics and unsupported input cannot become a write candidate',()=>{
  assert.throws(()=>planSync({identity,local:{...local,portableHash:'bad'},base,remote}));
  const result=planSync({identity,local:{...local,diagnostics:[{code:'duplicate_identity',severity:'error',message:'Copy'}]},base,remote});assert.equal(result.action,'copy-review');
  const input={identity,local,base,remote},before=structuredClone(input);const first=planSync(input);assert.deepEqual(input,before);assert.deepEqual(planSync(input),first);
});
