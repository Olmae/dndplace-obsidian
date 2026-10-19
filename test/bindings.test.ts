import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRoots,normalizeVaultPath} from '../src/bindings/paths.js';
import {bindingForFile,identityKey} from '../src/bindings/registry.js';
import type {LocalBinding} from '../src/bindings/registry.js';

const identity={connectionId:'local',instanceId:'site',accountId:'dm',campaignId:'camp',bindingId:'binding'};
const binding=(root:string,id=root.replace(/[^A-Za-z0-9_-]/g,'_')||'root'):LocalBinding=>({id,root,identity:{...identity,bindingId:id}});
const adapter={vaultRealPath:'/vault',configDir:'.obsidian',inspect:async(path:string)=>({exists:true,directory:true,symlink:false,realPath:'/vault/'+path})};

test('roots use components, not string prefixes, and normalize Unicode',async()=>{
  const roots=await validateRoots([binding('Game'),binding('Games')],adapter);
  assert.equal(roots.length,2);assert.equal(bindingForFile('Game/Session.md',roots)?.root,'Game');assert.equal(bindingForFile('Games/Session.md',roots)?.root,'Games');
  assert.equal(bindingForFile('Gameplay/Session.md',roots),null);assert.equal(bindingForFile('Other/Session.md',roots),null);assert.equal(bindingForFile('Game',roots),null);
  assert.equal(normalizeVaultPath('Café/Room.md'),'Café/Room.md');
  await assert.rejects(validateRoots([binding('Café','one'),binding('Cafe\u0301','two')],adapter));
});
test('all overlapping/case-colliding roots are rejected across accounts and campaigns',async()=>{
  for(const [a,b] of [['Game','Game'],['Game','Game/Notes'],['game','Game'],['Game/Notes','game']]){
    await assert.rejects(validateRoots([binding(a,'one'),{...binding(b,'two'),identity:{...identity,accountId:'other',campaignId:'other'}}],adapter));
  }
  assert.throws(()=>bindingForFile('Game/Note.md',[binding('Game','one'),binding('Game/Notes','two')].map((row,i)=>i?{...row,root:'Game'}:row)));
});
test('vault root, absolute, traversal, hidden/config and nonportable paths are never roots',async()=>{
  for(const path of ['', '.', '..', '../Game', '/Game', 'C:/Game', '\\server\\Game', 'Game\\Notes', 'Game//Notes', 'Game/../Notes', 'Game/.obsidian', '.trash/Game', 'Game/.hidden', 'Game/Notes.', 'Game/CON', 'Game/Notes '])await assert.rejects(validateRoots([binding(path)],adapter),Error,path);
  await assert.rejects(validateRoots([binding('Settings/Notes')],{...adapter,configDir:'Settings'}));
});
test('every selected root component is inspected and symlinks/realpath escapes fail closed',async()=>{
  const seen:string[]=[];
  await validateRoots([binding('Game/Notes')],{...adapter,inspect:async path=>{seen.push(path);return adapter.inspect(path);}});assert.deepEqual(seen,['Game','Game/Notes']);
  for(const change of [{symlink:true},{directory:false},{exists:false},{realPath:'/outside/Game'},{realPath:'/vault-other/Game'}])await assert.rejects(validateRoots([binding('Game')],{...adapter,inspect:async()=>({...await adapter.inspect('Game'),...change})}));
  await assert.rejects(validateRoots([binding('Game/Notes')],{...adapter,inspect:async path=>({...await adapter.inspect(path),symlink:path==='Game'})}));
});
test('file routing never depends on a selected panel and identity keys include every scope',async()=>{
  const a=binding('Campaign A','a'),b=binding('Campaign B','b'),roots=await validateRoots([a,b],adapter);
  assert.equal(bindingForFile('Campaign A/Active.md',roots)?.id,'a');
  for(const key of Object.keys(identity) as (keyof typeof identity)[])assert.notEqual(identityKey(identity),identityKey({...identity,[key]:'other'}));
  const changed={...identity};const key=identityKey(changed);changed.accountId='changed';assert.equal(key,identityKey(identity));
});
test('different visible roots cannot alias the same physical directory or jump between parents',async()=>{
  await assert.rejects(validateRoots([binding('Game','one'),binding('Games','two')],{...adapter,inspect:async()=>({...await adapter.inspect('physical'),realPath:'/vault/physical'})}));
  await assert.rejects(validateRoots([binding('Game/Notes')],{...adapter,inspect:async path=>({...await adapter.inspect(path),realPath:path==='Game'?'/vault/Game':'/vault/Other'})}));
});
test('Windows roots use native component boundaries, not drive or string-prefix guesses',async()=>{
  const windows={...adapter,vaultRealPath:'C:\\Vault',inspect:async(path:string)=>({...await adapter.inspect(path),realPath:'c:\\VAULT\\'+path.replaceAll('/','\\')})};
  assert.equal((await validateRoots([binding('Game/Notes')],windows)).length,1);
  await assert.rejects(validateRoots([binding('Game')],{...windows,inspect:async()=>({exists:true,directory:true,symlink:false,realPath:'C:\\Vault-other\\Game'})}));
});
