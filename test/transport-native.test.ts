import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createDesktopTransport} from '../src/connection/transport.js';

test('native desktop HTTP: bounded JSON, no redirect follow, cancellation and timeout',async t=>{
  const secret=`dpobs_${Buffer.alloc(16,1).toString('base64url')}.${Buffer.alloc(32,2).toString('base64url')}`;
  let redirects=0;
  const server=createServer((request,response)=>{
    assert.equal(request.headers.authorization,`Bearer ${secret}`);
    if(request.url?.endsWith('/redirect')){redirects++;response.writeHead(302,{Location:'/outside'});response.end();return;}
    if(request.url?.endsWith('/slow'))return;
    if(request.url?.endsWith('/large')){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({value:'x'.repeat(1000)}));return;}
    response.writeHead(200,{'Content-Type':'application/json'});response.end('{"ok":true}');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const transport=createDesktopTransport({baseUrl:`http://127.0.0.1:${address.port}`,getSecret:async()=>secret});
  assert.deepEqual(await transport.json('connection'),{ok:true});
  await assert.rejects(transport.json('redirect'));assert.equal(redirects,1);
  await assert.rejects(transport.json('large',{maxBytes:20}));
  await assert.rejects(transport.json('slow',{timeoutMs:20}));
  const controller=new AbortController(),pending=transport.json('slow',{signal:controller.signal});controller.abort();await assert.rejects(pending);
});
