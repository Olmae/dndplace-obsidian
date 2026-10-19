import test from 'node:test';
import assert from 'node:assert/strict';
import {loadLocalDocuments,localNoteChoices} from '../src/host/local-capture.js';
import {hashBytes,presentationHash,stableHash} from '../src/documents/hashes.js';
import {attachIdentity} from '../src/documents/frontmatter.js';
import type {StoredBase} from '../src/sync/state.js';
const identity={connectionId:'connection',instanceId:'site',accountId:'dm',campaignId:'camp',bindingId:'remote'},binding={id:'local',root:'Game',identity};
const board='{"nodes":[],"edges":[]}',portable='# One\r\nA clue\r\n',source=attachIdentity(portable,{version:1,instanceId:'site',accountId:'dm',campaignId:'camp',bindingId:'remote',entityId:'note'});
function fixture(){
  const files=new Map<string,Uint8Array>([['Game/One.md',Buffer.from(source)],['Other/Secret.md',Buffer.from('private')],['Game/Unselected.md',Buffer.from('unselected')]]),reads:string[]=[];
  const base:StoredBase={identity,entityId:'note',path:'Game/One.md',localFileHash:hashBytes(source),basePortableHash:hashBytes(portable),localMetadataHash:presentationHash({title:'One',metadata:{},board}),assetHash:stableHash([]),serverSourceHash:hashBytes(portable),projectionHash:hashBytes(portable),serverRevision:1,remoteMetadataHash:presentationHash({title:'One',metadata:{},board}),serverTitle:'One',titleInputHash:stableHash({kind:'h1',value:'One'}),metadata:{icon:'',favorite:false},boardHash:hashBytes(board)};
  const blobs=new Map([[base.boardHash!,Buffer.from(board)]]);
  const options={binding,bases:[base],paths:[...files.keys()],selected:['Game/One.md'],read:async(path:string)=>{reads.push(path);return files.get(path)??null;},snapshotEditor:(_path:string)=>null as {text:string;token:string}|null,readBlob:async(hash:string)=>{assert.ok(blobs.has(hash));return blobs.get(hash)!;},assertContext:async()=>{}};
  return {options,base,files,reads,blobs};
}
test('local inventory is scoped, sorted, metadata-only and rejects ambiguous case paths',()=>{
  assert.deepEqual(localNoteChoices(['Other/Hidden.md','Game/Z.md','Game/A.md','Game/map.png','Game/.private/X.md'],binding).map(row=>row.path),['Game/A.md','Game/Z.md']);
  assert.throws(()=>localNoteChoices(['Game/A.md','Game/a.md'],binding));
});
test('capture reads only selected notes and keeps raw board metadata hash unchanged after pull',async()=>{
  const f=fixture(),documents=await loadLocalDocuments(f.options);assert.deepEqual(f.reads,['Game/One.md']);assert.equal(documents[0].source,portable);assert.equal(documents[0].metadataHash,f.base.localMetadataHash);assert.equal(documents[0].board,board);
});
test('legacy push board encoding is recognized without inventing a local edit',async()=>{
  const f=fixture(),encoded=JSON.stringify(board);f.base.boardHash=hashBytes(encoded);f.blobs.set(f.base.boardHash,Buffer.from(encoded));
  assert.equal((await loadLocalDocuments(f.options))[0].metadataHash,f.base.localMetadataHash);
});
test('object-style stored board metadata retains its original representation',async()=>{
  const f=fixture();f.base.localMetadataHash=presentationHash({title:'One',metadata:{},board:JSON.parse(board)});
  assert.deepEqual((await loadLocalDocuments(f.options))[0].board,JSON.parse(board));
});
test('unsaved selected editor text is captured without writing the file',async()=>{
  const f=fixture();f.options.snapshotEditor=()=>({text:source+'Unsaved\n',token:'editor-v1'});
  assert.match((await loadLocalDocuments(f.options))[0].source,/Unsaved/);assert.equal(Buffer.from(f.files.get('Game/One.md')!).toString(),source);
});
test('outside, missing and duplicate selections fail before unrelated reads',async()=>{
  for(const selected of [['Other/Secret.md'],['Game/Missing.md'],['Game/One.md','Game/One.md']]){const f=fixture();await assert.rejects(loadLocalDocuments({...f.options,selected}));assert.deepEqual(f.reads,[]);}
});
test('corrupt board data fails closed instead of dropping the board',async()=>{
  const f=fixture();f.blobs.set(f.base.boardHash!,Buffer.from('{bad'));await assert.rejects(loadLocalDocuments(f.options));
});
test('invalid UTF-8 and cancelled reads never produce a sendable document',async()=>{
  const f=fixture();f.files.set('Game/One.md',Uint8Array.of(255));await assert.rejects(loadLocalDocuments(f.options));
  await assert.rejects(loadLocalDocuments({...f.options,assertContext:async()=>{throw Error('cancelled');}}));
});
test('capture preserves an explicit UTF-8 BOM and CRLF rather than silently changing source bytes',async()=>{
  const f=fixture(),text='\uFEFF# Exact\r\nText\r\n';f.files.set('Game/One.md',Buffer.from(text));
  const document=(await loadLocalDocuments({...f.options,bases:[]}))[0];assert.equal(document.source,text);assert.equal(document.localFileHash,hashBytes(text));
});
test('only referenced image bytes are read; code examples and unselected assets stay untouched',async()=>{
  const f=fixture(),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=','base64');
  f.files.set('Game/One.md',Buffer.from('# Map\n![Map](map.png)\n```\n![Secret](private.png)\n```\n'));f.files.set('Game/map.png',png);f.files.set('Game/private.png',png);
  const document=(await loadLocalDocuments({...f.options,bases:[],paths:[...f.files.keys()]}))[0];assert.deepEqual(f.reads,['Game/One.md','Game/map.png']);assert.equal(document.assets.length,1);
});
test('a proven local rename keeps its bound board rather than silently sending null',async()=>{
  const f=fixture();f.files.delete('Game/One.md');f.files.set('Game/Renamed.md',Buffer.from(source));
  const document=(await loadLocalDocuments({...f.options,paths:[...f.files.keys()],selected:['Game/Renamed.md']}))[0];
  assert.equal(document.entityId,'note');assert.equal(document.identityStatus,'bound');assert.equal(document.board,board);assert.equal(document.metadataHash,f.base.localMetadataHash);
});
