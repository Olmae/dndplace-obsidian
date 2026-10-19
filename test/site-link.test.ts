import test from 'node:test';
import assert from 'node:assert/strict';
import {archiveNoteUrl} from '../src/history/site-link.js';

test('history links use the existing authenticated note route without plugin secrets',()=>{
  const url=new URL(archiveNoteUrl('https://example.test','campaign_1','note-2'));
  assert.equal(url.origin,'https://example.test');assert.equal(url.pathname,'/dm/campaign_1/prep');
  assert.deepEqual([...url.searchParams],[['open','note:note-2']]);assert.equal(url.hash,'');
});
test('site subpaths and literal loopback are preserved',()=>{
  assert.equal(archiveNoteUrl('https://example.test/dnd','camp','note'),'https://example.test/dnd/dm/camp/prep?open=note%3Anote');
  assert.equal(new URL(archiveNoteUrl('http://127.0.0.1:3100','camp','note')).port,'3100');
});
test('unsafe origins and path/query injection cannot become external history links',()=>{
  for(const base of ['javascript:alert(1)','file:///tmp/test','http://example.test','https://user:secret@example.test','https://example.test?key=secret'])assert.throws(()=>archiveNoteUrl(base,'camp','note'));
  for(const id of ['../other','//evil.test','note?key=secret','note#x','a:b','','x'.repeat(201)]){
    assert.throws(()=>archiveNoteUrl('https://example.test',id,'note'));assert.throws(()=>archiveNoteUrl('https://example.test','camp',id));
  }
});
