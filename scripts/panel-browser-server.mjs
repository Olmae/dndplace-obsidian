// Isolated renderer fixture: no Obsidian host, credentials, campaign data or vault access.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
const bundle=await build({entryPoints:['test/browser/panel-fixture.ts'],bundle:true,format:'iife',platform:'browser',write:false});
const css=await readFile(new URL('../styles.css',import.meta.url),'utf8');
const html=`<!doctype html><html lang="ru"><meta charset="utf-8"><title>DNDPlace panel fixture</title><style>
:root{--font-interface:system-ui;--font-ui-small:14px;--text-normal:#ddd7c9;--text-muted:#a39c91;--text-accent:#e8bb77;--text-error:#ff9999;--background-primary:#242321;--background-secondary:#2e2c29;--background-modifier-border:#4b463e;--interactive-accent:#bd8f51;color-scheme:dark}
@media(prefers-color-scheme:light){:root{--text-normal:#2e2923;--text-muted:#655d52;--text-accent:#82521e;--background-primary:#fbf8f1;--background-secondary:#f0ebe1;--background-modifier-border:#cfc4b4;color-scheme:light}}
body{margin:0;background:var(--background-secondary)}main{width:390px;max-width:100%;margin-left:auto;min-height:100vh}button{background:var(--background-secondary);color:var(--text-normal);border:1px solid var(--background-modifier-border);border-radius:5px}button.mod-cta{background:var(--interactive-accent);color:#1b1610}select,input{font:inherit}details summary{list-style-position:inside}
</style><link rel="stylesheet" href="/styles.css"><main></main><script src="/fixture.js"></script></html>`;
const server=createServer((request,response)=>{
  if(request.url==='/fixture.js'){response.setHeader('Content-Type','text/javascript');response.end(bundle.outputFiles[0].text);}
  else if(request.url==='/styles.css'){response.setHeader('Content-Type','text/css');response.end(css);}
  else if(request.url==='/'){response.setHeader('Content-Type','text/html; charset=utf-8');response.end(html);}
  else{response.statusCode=404;response.end();}
});
server.listen(Number(process.env.PANEL_TEST_PORT??31986),'127.0.0.1');
