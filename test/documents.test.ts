import test from 'node:test';
import assert from 'node:assert/strict';
import {readFrontmatter,attachIdentity,stripIdentity} from '../src/documents/frontmatter.js';
import {prepareLocalDocument} from '../src/documents/identity.js';
import {scanReferences,resolveNoteLink} from '../src/documents/links.js';
import {hashBytes,presentationHash} from '../src/documents/hashes.js';
import {collectLocalAssets} from '../src/documents/assets.js';

const identity={connectionId:'local',instanceId:'site',accountId:'dm',campaignId:'camp',bindingId:'binding'},binding={id:'local-root',root:'Game',identity};
const portable={version:1 as const,instanceId:'site',accountId:'dm',campaignId:'camp',bindingId:'binding',entityId:'note'};
test('wiki images resolve from binding root and unique basename, while Markdown stays note-relative',()=>{
  const data=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'),assets=[{path:'Game/Pictures/map.png',data}];
  for(const source of ['![[Pictures/map.png]]','![[map.png]]']){const note=prepareLocalDocument({path:'Game/Rooms/One.md',source},binding,{entries:[],assets});assert.equal(note.assets.length,1);assert.equal(note.diagnostics.some(d=>d.severity==='error'),false);}
  const markdown=prepareLocalDocument({path:'Game/Rooms/One.md',source:'![Map](Pictures/map.png)'},binding,{entries:[],assets});assert.equal(markdown.assets.length,0);assert.ok(markdown.diagnostics.some(d=>d.code==='missing_asset'));
  const ambiguous=prepareLocalDocument({path:'Game/Rooms/One.md',source:'![[map.png]]'},binding,{entries:[],assets:[...assets,{path:'Game/Other/map.png',data}]});assert.equal(ambiguous.assets.length,0);assert.ok(ambiguous.diagnostics.some(d=>d.code==='ambiguous_asset'));
});
const original='---\r\n# Author comment\r\ntitle: "The room" # keep this\r\ntags: [one, two]\r\nforeign:\r\n  multiline: |\r\n    Never flatten this.\r\n---\r\n# Room\r\n\r\n- [ ] Key  \r\n```dndplace-check\r\n{ "dc": 12 }\r\n```\r\n';

test('only the reserved namespace changes; unrelated YAML, CRLF and Markdown stay byte-exact',()=>{
  const attached=attachIdentity(original,portable);assert.ok(attached.includes('# Author comment\r\ntitle: "The room" # keep this\r\n'));
  assert.equal(stripIdentity(attached),original);assert.equal(attachIdentity(attached,portable),attached);
  const next={...portable,entityId:'other'};assert.equal(stripIdentity(attachIdentity(attached,next,{allowRebind:true})),original);
  assert.equal(readFrontmatter(attached).identity?.entityId,'note');
  for(const source of ['# No YAML\n','\uFEFF# Unicode\r\n','---\ntags: [a]\n...\nBody\n'])assert.equal(stripIdentity(attachIdentity(source,portable)),source);
});
test('namespace collisions, duplicate keys, aliases, malformed and oversized YAML need review',()=>{
  for(const source of ['---\ndndplace: keep my value\n---\nBody','---\ndndplace: {}\n---\nBody','---\nx: 1\nx: 2\n---\nBody','---\na: &a [1]\ndndplace: *a\n---\nBody','---\ntitle: [broken\n---\nBody','---\n'+('x'.repeat(65537))+'\n---\nBody'])assert.throws(()=>attachIdentity(source,portable));
  assert.throws(()=>attachIdentity('---\ntitle: Room\nBody',portable));
});
test('file hash, portable hash and authoring-title inputs remain distinct',()=>{
  const source=attachIdentity(original,portable),prepared=prepareLocalDocument({path:'Game/Room.md',source},binding,{entries:[],assets:[]});
  assert.equal(prepared.localFileHash,hashBytes(source));assert.equal(prepared.portableHash,hashBytes(original));assert.equal(prepared.source,original);assert.notEqual(prepared.localFileHash,prepared.portableHash);
  assert.equal(prepared.identityStatus,'review');assert.equal(prepared.title,'The room');
  const plain=prepareLocalDocument({path:'Game/New.md',source:'# New\n'},binding,{entries:[],assets:[]});assert.equal(plain.identityStatus,'new');assert.equal(plain.title,'New');
  assert.throws(()=>prepareLocalDocument({path:'Other/Note.md',source:'# Outside'},binding,{entries:[],assets:[]}));
});
test('mapped title is retained until the effective local authoring title changes',()=>{
  const local=prepareLocalDocument({path:'Game/Room.md',source:original},binding,{entries:[],assets:[]});
  const entry={path:'Game/Room.md',entityId:'note',identity,serverTitle:'Renamed on site',titleInputHash:local.titleInputHash,metadata:{icon:'book',favorite:true},board:{nodes:[],edges:[]}};
  const index={entries:[entry],assets:[]};
  const attached=attachIdentity(original,portable),unchanged=prepareLocalDocument({path:'Game/Room.md',source:attached},binding,index);
  assert.equal(unchanged.identityStatus,'bound');assert.equal(unchanged.title,'Renamed on site');assert.deepEqual(unchanged.board,entry.board);
  const renamed=prepareLocalDocument({path:'Game/Renamed.md',source:attached},binding,index);assert.equal(renamed.title,'Renamed on site');assert.equal(renamed.entityId,'note');
  const changed=prepareLocalDocument({path:'Game/Room.md',source:attached.replace('"The room"','"Author title"')},binding,index);assert.equal(changed.title,'Author title');
});
test('foreign, copied and cross-binding identities never become replacement authority',()=>{
  const mapped={path:'Game/Original.md',entityId:'note',identity,serverTitle:'Room',titleInputHash:'a'.repeat(64)};
  for(const reserved of [{...portable,accountId:'other'},{...portable,campaignId:'other'},{...portable,bindingId:'other'}])assert.equal(prepareLocalDocument({path:'Game/Note.md',source:attachIdentity('# Room\n',reserved)},binding,{entries:[mapped],assets:[]}).identityStatus,'review');
  const duplicate=[mapped,{...mapped,path:'Game/Copy.md'}];assert.equal(prepareLocalDocument({path:'Game/Copy.md',source:attachIdentity('# Room\n',portable)},binding,{entries:duplicate,assets:[]}).identityStatus,'review');
});
test('real Markdown parsing ignores YAML/code images and resolves exact paths before unique aliases',()=>{
  const source='---\nimage: "![[private.png]]"\n---\n`![[inline.png]]`\n```md\n![code](code.png)\n```\n![Map](<maps/room map.png>)\n![[maps/other.png|240]]\n[[Rooms/Room#Clue|Door]]\n[Room](Rooms/Room.md#Clue)\n';
  const refs=scanReferences(source);assert.equal(refs.assets.length,2);assert.equal(refs.links.length,2);assert.equal(refs.assets[0].target,'maps/room%20map.png');
  const notes=[{path:'Game/Rooms/Room.md',entityId:'a',aliases:['Room']},{path:'Game/Other/Room.md',entityId:'b',aliases:['Room']}];
  assert.equal(resolveNoteLink('Rooms/Room','Game/Scene.md',binding,notes).entityId,'a');assert.equal(resolveNoteLink('Room','Game/Scene.md',binding,notes).status,'ambiguous');
  assert.equal(resolveNoteLink('../../Secret','Game/Scene.md',binding,notes).status,'outside');assert.equal(resolveNoteLink('https://example.test','Game/Scene.md',binding,notes).status,'external');
});
test('only referenced, in-root, actual static image bytes are collected; URLs are never fetched',()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHnQAAAAASUVORK5CYII=','base64'),assets=[{path:'Game/maps/map.png',data:png},{path:'Other/private.png',data:png}];
  const good=collectLocalAssets([{target:'maps/map.png'}],'Game/Scene.md',binding,assets);assert.equal(good.assets.length,1);assert.equal(good.assets[0].sha256,hashBytes(png));assert.equal(good.assets[0].relativePath,`_assets/dndplace/${hashBytes(png)}.png`);
  for(const target of ['../Other/private.png','https://example.test/a.png','file:///private.png','data:image/png;base64,abc','missing.png']){const result=collectLocalAssets([{target}],'Game/Scene.md',binding,assets);assert.equal(result.assets.length,0);assert.ok(result.diagnostics.length);}
  assert.equal(collectLocalAssets([{target:'maps/map.png'}],'Game/Scene.md',binding,[{path:'Game/maps/map.png',data:Buffer.from('<script>') }]).assets.length,0);
});
test('URI targets are decoded once; wiki literal percent signs and encoded hash filenames remain distinct',()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHnQAAAAASUVORK5CYII=','base64');
  const index=['map%20name.png','map name.png','map#name.png'].map(path=>({path:'Game/'+path,data:png}));
  for(const [target,kind,expected] of [['map%2520name.png','markdown','map%20name.png'],['map%20name.png','wiki','map%20name.png'],['map%23name.png','markdown','map#name.png']] as const){
    const result=collectLocalAssets([{target,kind}],'Game/Scene.md',binding,index);assert.equal(result.assets[0]?.path,'Game/'+expected);assert.equal(result.diagnostics.length,0);
  }
});
test('copied tagged files require review while a proven rename keeps its identity',()=>{
  const initial=prepareLocalDocument({path:'Game/Original.md',source:'# Room\n'},binding,{entries:[],assets:[]});
  const entry={path:'Game/Original.md',entityId:'note',identity,serverTitle:'Room',titleInputHash:initial.titleInputHash},source=attachIdentity('# Room\n',portable);
  const copied=prepareLocalDocument({path:'Game/Copy.md',source},binding,{entries:[entry],assets:[],existingPaths:['Game/Original.md','Game/Copy.md']});assert.equal(copied.identityStatus,'review');
  const moved=prepareLocalDocument({path:'Game/Moved.md',source},binding,{entries:[entry],assets:[],existingPaths:['Game/Moved.md']});assert.equal(moved.identityStatus,'bound');assert.equal(moved.entityId,'note');
});
test('reserved metadata can be added to block/flow YAML without flattening foreign aliases or comments',()=>{
  for(const source of ['---\nshared: &items [one, two]\nother: *items\n---\n# Body\n','---\n{title: Room, tags: [a, b]}\n---\n# Body\n','---\n---\n# Body\n']){
    const attached=attachIdentity(source,portable);assert.equal(stripIdentity(attached),source);assert.equal(readFrontmatter(attached).identity?.entityId,'note');
  }
});
test('a full-sized portable note still fits after adding inert local metadata',()=>{
  const source='a'.repeat(1048576),attached=attachIdentity(source,portable);assert.equal(stripIdentity(attached),source);
  assert.equal(prepareLocalDocument({path:'Game/Large.md',source:attached},binding,{entries:[],assets:[]}).portableHash,hashBytes(source));
});
test('fake JPEG signatures, animated PNG chunks and symlinked images are not upload candidates',()=>{
  const fake=collectLocalAssets([{target:'fake.jpg'}],'Game/Scene.md',binding,[{path:'Game/fake.jpg',data:Buffer.from([255,216,255,217])}]);assert.equal(fake.assets.length,0);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHnQAAAAASUVORK5CYII=','base64'),chunk=Buffer.alloc(20);chunk.writeUInt32BE(8);chunk.write('acTL',4,'ascii');
  assert.equal(collectLocalAssets([{target:'animated.png'}],'Game/Scene.md',binding,[{path:'Game/animated.png',data:Buffer.concat([png.subarray(0,33),chunk,png.subarray(33)])}]).assets.length,0);
  assert.equal(collectLocalAssets([{target:'map.png'}],'Game/Scene.md',binding,[{path:'Game/map.png',data:png,symlink:true}]).assets.length,0);
});
test('local and remote presentation hashes use the same explicit defaults',()=>{
  assert.equal(presentationHash({title:'Room'}),presentationHash({title:'Room',metadata:{icon:'',favorite:false},board:null}));
  assert.notEqual(presentationHash({title:'Room'}),presentationHash({title:'Renamed'}));
  assert.notEqual(presentationHash({title:'Room'}),presentationHash({title:'Room',metadata:{icon:'book'}}));
  const prepared=prepareLocalDocument({path:'Game/Room.md',source:'# Room\n'},binding,{entries:[],assets:[]});assert.equal(prepared.metadataHash,presentationHash({title:'Room'}));
});
test('attaching a different identity requires an explicit reviewed rebind',()=>{
  const source=attachIdentity(original,portable);
  for(const key of ['instanceId','accountId','campaignId','bindingId','entityId'] as const){const next={...portable,[key]:'other'};assert.throws(()=>attachIdentity(source,next));assert.equal(stripIdentity(attachIdentity(source,next,{allowRebind:true})),original);}
});
test('an explicit in-root target never authorizes reading links from an out-of-root source file',()=>{
  assert.equal(resolveNoteLink('Game/Room','Other/Private.md',binding,[{path:'Game/Room.md',entityId:'note'}]).status,'outside');
});
