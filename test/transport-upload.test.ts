import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createDesktopTransport} from '../src/connection/transport.js';

const secret=`dpobs_${Buffer.alloc(16,1).toString('base64url')}.${Buffer.alloc(32,2).toString('base64url')}`;
const response=(value:unknown)=>({status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(value))});
test('ZIP upload sends exact captured bytes, not JSON, and retains identity headers',async()=>{
  let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});const original=Buffer.from([0x50,0x4b,3,4,0,255]);
  const transport=createDesktopTransport({baseUrl:'https://example.test',getSecret:async()=>{await wait;return secret;},requestImpl:async(url,options)=>{
    assert.equal(url.pathname,'/api/integrations/obsidian/v1/campaigns/camp/bindings/binding/transfers/transfer/upload');
    assert.equal(options.method,'PUT');assert.equal(options.headers['Content-Type'],'application/zip');assert.equal(options.headers['Content-Length'],'6');
    assert.equal(options.headers['X-Dndplace-Account'],'dm');assert.equal(options.headers['X-Dndplace-Instance'],'site');
    assert.deepEqual(Buffer.from(options.body!),Buffer.from([0x50,0x4b,3,4,0,255]));return response({state:'ready'});
  }});
  const pending=transport.uploadZip('campaigns/camp/bindings/binding/transfers/transfer/upload',original,{expectedAccountId:'dm',expectedInstanceId:'site'});original.fill(0);release();
  assert.deepEqual(await pending,{state:'ready'});
});
test('ZIP upload validates bytes, bounds, path and forbidden JSON body before network',async()=>{
  let calls=0;const transport=createDesktopTransport({baseUrl:'https://example.test',getSecret:async()=>secret,requestImpl:async()=>{calls++;return response({});}});
  for(const bytes of [Buffer.alloc(0),Buffer.alloc(33554433),'not bytes',undefined,null])await assert.rejects(transport.uploadZip('transfers/upload',bytes as any));
  for(const path of ['../profile','https://other.test/upload','/api/profile','a/%2f/b'])await assert.rejects(transport.uploadZip(path,Buffer.from('zip')));
  await assert.rejects(transport.uploadZip('transfers/upload',Buffer.from('zip'),{body:{secret}} as any));assert.equal(calls,0);
});
test('ZIP redirects never replay the body or credential to the next location',async()=>{
  let calls=0;const transport=createDesktopTransport({baseUrl:'https://example.test',getSecret:async()=>secret,requestImpl:async()=>{calls++;return {status:307,headers:{location:'https://evil.test/'+secret},body:Buffer.alloc(0)};}});
  await assert.rejects(transport.uploadZip('transfers/upload',Buffer.from('zip')),error=>error instanceof Error&&!error.message.includes(secret));assert.equal(calls,1);
});
test('ZIP upload cancellation and JSON response validation remain enforced',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  const transport=createDesktopTransport({baseUrl:'https://example.test',getSecret:async()=>secret,requestImpl:async()=>{calls++;return {status:200,headers:{'content-type':'text/html'},body:Buffer.from(secret)};}});
  await assert.rejects(transport.uploadZip('transfers/upload',Buffer.from('zip'),{signal:controller.signal}));assert.equal(calls,0);
  await assert.rejects(transport.uploadZip('transfers/upload',Buffer.from('zip')),error=>error instanceof Error&&!error.message.includes(secret));assert.equal(calls,1);
});
test('native HTTP transmits the exact ZIP and parses a bounded JSON response on loopback',async t=>{
  const expected=Buffer.from([0x50,0x4b,3,4,0,255]);let received=Buffer.alloc(0);
  const server=createServer((req,res)=>{
    const parts:Buffer[]=[];req.on('data',part=>parts.push(part));req.on('end',()=>{received=Buffer.concat(parts);assert.equal(req.method,'PUT');assert.equal(req.headers['content-type'],'application/zip');assert.equal(req.headers.authorization,'Bearer '+secret);res.writeHead(200,{'Content-Type':'application/json'});res.end('{"state":"ready"}');});
  });t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
  const transport=createDesktopTransport({baseUrl:`http://127.0.0.1:${address.port}`,getSecret:async()=>secret});
  assert.deepEqual(await transport.uploadZip('transfers/upload',expected),{state:'ready'});assert.deepEqual(received,expected);
});
