import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSyncPackages} from '../src/sync/packages.js';
import {prepareLocalDocument} from '../src/documents/identity.js';
import {hashBytes} from '../src/documents/hashes.js';
import type {StoredBase} from '../src/sync/state.js';

const identity={connectionId:'local',instanceId:'site',accountId:'dm',campaignId:'camp',bindingId:'binding'},binding={id:'root',root:'Game',identity};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const prepared=(name='One',source=`# ${name}\r\n\r\n- [ ] A clue\r\n`)=>prepareLocalDocument({path:`Game/${name}.md`,source},binding,{entries:[],assets:[]});
// Read central-directory records of the deliberately uncompressed, bounded test packages.
// The site's independent ZIP decoder supplies actual interoperability coverage.
function unzip(bytes:Uint8Array){
  const b=Buffer.from(bytes),eocd=b.length-22;assert.equal(b.readUInt32LE(eocd),0x06054b50);let offset=b.readUInt32LE(eocd+16);
  const result=new Map<string,Buffer>();
  for(let i=0;i<b.readUInt16LE(eocd+10);i++){
    assert.equal(b.readUInt32LE(offset),0x02014b50);assert.equal(b.readUInt16LE(offset+10),0);const size=b.readUInt32LE(offset+24),length=b.readUInt16LE(offset+28),extra=b.readUInt16LE(offset+30),comment=b.readUInt16LE(offset+32),local=b.readUInt32LE(offset+42);
    const path=b.toString('utf8',offset+46,offset+46+length),start=local+30+b.readUInt16LE(local+26)+b.readUInt16LE(local+28);result.set(path,b.subarray(start,start+size));offset+=46+length+extra+comment;
  }
  return result;
}
test('empty selection builds no ZIP and no fake synchronization operation',async()=>{
  assert.deepEqual(await buildSyncPackages({binding,documents:[],bases:[]}),[]);
});
test('ZIP preserves exact authoring Markdown, CRLF and unrelated YAML without local namespace',async()=>{
  const note=prepared('One','---\r\n# Keep\r\ntitle: One\r\ntags: [secret, clue]\r\n---\r\n# One\r\n[[Two]]\r\n'),[pack]=await buildSyncPackages({binding,documents:[note],bases:[]});
  const files=unzip(pack.bytes),manifest=JSON.parse(files.get('dndplace-manifest.json')!.toString());
  assert.equal(files.get('One.md')!.toString(),note.source);assert.equal(manifest.entries[0].title,'One');assert.equal(manifest.instanceId,'site');assert.equal(manifest.campaignId,'camp');
  assert.equal(manifest.entries[0].sourceHash,note.portableHash);assert.equal(pack.packageHash,hashBytes(pack.bytes));assert.equal(pack.notes[0].localFileHash,note.localFileHash);
  assert.ok(!JSON.stringify(manifest).includes('connectionId'));assert.equal(manifest.entries[0].revision,1);
});
test('rebuilding the same capture is deterministic, including ZIP bytes and new-note source IDs',async()=>{
  const documents=[prepared('One'),prepared('Two')],a=await buildSyncPackages({binding,documents,bases:[]}),b=await buildSyncPackages({binding,documents:[...documents].reverse(),bases:[]});
  assert.deepEqual(Buffer.from(a[0].bytes),Buffer.from(b[0].bytes));assert.deepEqual(a[0].capture,b[0].capture);
});
test('only selected referenced images are bundled once, with aliases independent of note directories',async()=>{
  const assets=[{path:'Game/Pictures/map.png',data:png},{path:'Game/Unused.png',data:png}],note=prepareLocalDocument({path:'Game/Rooms/One.md',source:'# Room\n![Map](../Pictures/map.png)\n![[Pictures/map.png]]\n'},binding,{entries:[],assets});
  const [pack]=await buildSyncPackages({binding,documents:[note],bases:[]}),files=unzip(pack.bytes),manifest=JSON.parse(files.get('dndplace-manifest.json')!.toString());
  assert.equal(manifest.assets.length,1);assert.deepEqual(files.get(manifest.assets[0].path),png);assert.equal(files.has('Unused.png'),false);
  const preserved=JSON.parse(files.get(manifest.entries[0].preservedPath)!.toString());assert.equal(preserved.source,note.source);
  assert.equal(preserved.sourceAssetMap.length,2);assert.equal(preserved.sourceAssetMap[0][1],manifest.assets[0].path);assert.equal(preserved.sourceAssetMap[1][1],manifest.assets[0].path);
});
test('note limit splits batches while each independent ZIP includes the images it references',async()=>{
  const documents=Array.from({length:33},(_,i)=>prepared('Note'+i)),packs=await buildSyncPackages({binding,documents,bases:[]});
  assert.deepEqual(packs.map(pack=>pack.notes.length),[32,1]);assert.ok(packs.every(pack=>pack.bytes.byteLength<=33554432));
});
test('byte budget includes manifests, source preservation, boards and ZIP overhead',async()=>{
  const documents=[prepared('One'),prepared('Two')],single=(await buildSyncPackages({binding,documents:[documents[0]],bases:[]}))[0];
  const packs=await buildSyncPackages({binding,documents,bases:[],limits:{bytes:single.bytes.byteLength+200}});assert.equal(packs.length,2);
  await assert.rejects(buildSyncPackages({binding,documents:[documents[0]],bases:[],limits:{bytes:200}}));
});
test('bound notes carry their own captured base versions and cannot borrow another scope or entity',async()=>{
  const local=prepared(),base:StoredBase={identity,entityId:'note',path:local.path,localFileHash:local.localFileHash,basePortableHash:local.portableHash,localMetadataHash:local.metadataHash,assetHash:local.assetHash,serverSourceHash:'a'.repeat(64),projectionHash:local.portableHash,serverRevision:7,remoteMetadataHash:local.metadataHash,serverTitle:'One',titleInputHash:local.titleInputHash,metadata:{icon:'',favorite:false},boardHash:null};
  const note=prepareLocalDocument({path:local.path,source:'# One\nEdited\n'},binding,{entries:[{path:local.path,entityId:'note',identity,serverTitle:'One',titleInputHash:local.titleInputHash}],assets:[]});
  const [pack]=await buildSyncPackages({binding,documents:[note],bases:[base]});assert.deepEqual(pack.notes[0].baseVersion,{entityId:'note',revision:7,sourceHash:base.serverSourceHash});
  assert.equal(pack.capture.documents[0].portableHash,note.portableHash);assert.equal(pack.capture.documents[0].base!.serverRevision,7);
  for(const bases of [[],[{...base,identity:{...identity,campaignId:'other'}}],[{...base,entityId:'different'}]])await assert.rejects(buildSyncPackages({binding,documents:[note],bases}));
});
test('unreviewed identities, diagnostics, duplicate paths, forged hashes and config paths fail closed',async()=>{
  const note=prepared();
  for(const documents of [[{...note,identityStatus:'review' as const}],[{...note,diagnostics:[{code:'missing',message:'missing',severity:'error' as const}]}],[note,note],[{...note,portableHash:'a'.repeat(64)}],[{...note,path:'Game/.obsidian/config.md'}],[{...note,identity:{...identity,accountId:'other'}}]])await assert.rejects(buildSyncPackages({binding,documents,bases:[]}));
});
test('captured output does not retain caller buffers or metadata objects',async()=>{
  const note=prepared(),[pack]=await buildSyncPackages({binding,documents:[note],bases:[]});note.source='changed';Object.assign(note.metadata,{favorite:true});
  assert.equal(pack.capture.documents[0].source,'# One\r\n\r\n- [ ] A clue\r\n');assert.equal(pack.capture.documents[0].metadata.favorite,false);
});
test('board data stays separate from prose; unresolved board images cannot silently disappear',async()=>{
  const note=prepared(),board={nodes:[],edges:[]},mapped={path:note.path,entityId:'note',identity,serverTitle:'One',titleInputHash:note.titleInputHash,board};
  const document=prepareLocalDocument({path:note.path,source:note.source},binding,{entries:[mapped],assets:[]});
  const base:StoredBase={identity,entityId:'note',path:note.path,localFileHash:note.localFileHash,basePortableHash:note.portableHash,localMetadataHash:document.metadataHash,assetHash:note.assetHash,serverSourceHash:'a'.repeat(64),projectionHash:note.portableHash,serverRevision:1,remoteMetadataHash:document.metadataHash,serverTitle:'One',titleInputHash:note.titleInputHash,metadata:{icon:'',favorite:false},boardHash:null};
  const [pack]=await buildSyncPackages({binding,documents:[document],bases:[base]}),files=unzip(pack.bytes),manifest=JSON.parse(files.get('dndplace-manifest.json')!.toString());assert.deepEqual(JSON.parse(files.get(manifest.entries[0].boardPath)!.toString()),board);
  const broken=prepareLocalDocument({path:note.path,source:note.source},binding,{entries:[{...mapped,board:{nodes:[{kind:'image',url:'missing.png'}],edges:[]}}],assets:[]});await assert.rejects(buildSyncPackages({binding,documents:[broken],bases:[base]}));
});
