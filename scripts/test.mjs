import {build} from 'esbuild';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const requested=process.argv.slice(2).filter(arg=>arg!=='--');
const files=requested.length?requested:(await readdir('test')).filter(name=>name.endsWith('.test.ts')).map(name=>'test/'+name);
if(!files.length)throw new Error('No tests selected');
for(const file of files)if(!/^test\/[A-Za-z0-9_-]+\.test\.ts$/.test(file))throw new Error('Invalid test path');
const directory=await mkdtemp(join(tmpdir(),'dndplace-plugin-test-'));
try{
  await build({entryPoints:files.map(file=>resolve(file)),outdir:directory,bundle:true,external:['obsidian'],platform:'node',target:'node22',format:'esm',banner:{js:'import {createRequire as __testCreateRequire} from "node:module"; const require=__testCreateRequire(import.meta.url);'},outExtension:{'.js':'.mjs'},logLevel:'silent'});
  const outputs=files.map(file=>join(directory,file.split('/').at(-1).replace(/\.ts$/,'.mjs')));
  const result=spawnSync(process.execPath,['--test',...outputs],{stdio:'inherit'});process.exitCode=result.status??1;
}finally{await rm(directory,{recursive:true,force:true});}
