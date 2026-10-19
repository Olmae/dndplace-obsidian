import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopTransport,validateBaseUrl} from '../src/connection/transport.js';

const secret=`dpobs_${Buffer.alloc(16,1).toString('base64url')}.${Buffer.alloc(32,2).toString('base64url')}`;
const jsonResponse=(body:unknown,status=200)=>({status,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(body))});
test('only HTTPS or literal loopback HTTP bases; no credentials/query/fragment',()=>{
  for(const value of ['https://example.test','https://example.test/table/','http://localhost:3100','http://127.0.0.1:3100','http://[::1]:3100'])assert.ok(validateBaseUrl(value));
  for(const value of ['http://example.test','http://localhost.evil.test','http://127.0.0.1.evil.test','https://u:p@example.test','https://example.test?token=a','https://example.test/#x','file:///tmp/notes','javascript:alert(1)'])assert.throws(()=>validateBaseUrl(value));
});
test('base path is retained and only integration namespace is reachable',async()=>{
  const urls:string[]=[];
  const transport=createDesktopTransport({baseUrl:'https://example.test/table',getSecret:async()=>secret,requestImpl:async(url,options)=>{
    urls.push(url.href);assert.equal(options.headers.Authorization,`Bearer ${secret}`);return jsonResponse({ok:true});
  }});
  assert.deepEqual(await transport.json('connection'),{ok:true});assert.equal(urls[0],'https://example.test/table/api/integrations/obsidian/v1/connection');
  for(const path of ['../profile','/api/profile','https://evil.test','//evil.test','campaigns/../../../../profile','%2e%2e/profile','a\\b'])await assert.rejects(transport.json(path));
  assert.equal(urls.length,1);
});
test('redirects are rejected and never followed, without echoing credentials',async()=>{
  let count=0;
  const transport=createDesktopTransport({baseUrl:'https://example.test',getSecret:async()=>secret,requestImpl:async()=>{count++;return {status:302,headers:{location:'https://evil.test/'+secret},body:Buffer.alloc(0)};}});
  await assert.rejects(transport.json('connection'),error=>error instanceof Error&&!error.message.includes(secret));assert.equal(count,1);
});
test('HTTP errors, content type, byte limits and malformed JSON are bounded',async()=>{
  for(const response of [jsonResponse({error:secret,code:'arbitrary-secret'},500),{status:200,headers:{'content-type':'text/html'},body:Buffer.from(secret)},{status:200,headers:{'content-type':'application/json'},body:Buffer.from('{bad')},{status:200,headers:{'content-type':'application/json','content-length':'999'},body:Buffer.from('{}')}]){
    const transport=createDesktopTransport({baseUrl:'https://example.test',getSecret:async()=>secret,requestImpl:async()=>response});
    await assert.rejects(transport.json('connection'),error=>error instanceof Error&&!error.message.includes(secret));
  }
  const large=createDesktopTransport({baseUrl:'https://example.test',getSecret:async()=>secret,requestImpl:async()=>jsonResponse({value:'x'.repeat(100)})});
  await assert.rejects(large.json('connection',{maxBytes:20}));
});
test('missing secrets and pre-cancelled work never touch the network',async()=>{
  let calls=0;
  const transport=createDesktopTransport({baseUrl:'https://example.test',getSecret:async()=>undefined,requestImpl:async()=>{calls++;return jsonResponse({});}});
  await assert.rejects(transport.json('connection'));assert.equal(calls,0);
  const controller=new AbortController();controller.abort();await assert.rejects(transport.json('connection',{signal:controller.signal}));assert.equal(calls,0);
  const bad=createDesktopTransport({baseUrl:'https://example.test',getSecret:async()=>secret.split('.')[0]+'.'+'A'.repeat(42)+'B',requestImpl:async()=>{calls++;return jsonResponse({});}});
  await assert.rejects(bad.json('connection'));assert.equal(calls,0);
});
test('transport times out even if an injected adapter ignores abort',async()=>{
  const transport=createDesktopTransport({baseUrl:'https://example.test',getSecret:async()=>secret,requestImpl:async()=>new Promise(()=>{})});
  await assert.rejects(transport.json('connection',{timeoutMs:20}));
});
test('known conflict codes and bounded retry hints survive without exposing server messages',async()=>{
  const transport=createDesktopTransport({baseUrl:'https://example.test',getSecret:async()=>secret,requestImpl:async()=>({...jsonResponse({code:'snapshot_changed',error:secret},409),headers:{'content-type':'application/json','retry-after':'999999'}})});
  await assert.rejects(transport.json('connection'),(error:unknown)=>error instanceof Error&&(error as any).code==='snapshot_changed'&&(error as any).retryAfterMs===300000&&!error.message.includes(secret));
});
