import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {ZipFile} from 'yazl';
const require=createRequire(import.meta.url),manifest=JSON.parse(await readFile('manifest.json','utf8'));
if(manifest.id!=='dndplace-sync'||manifest.version!=='0.1.0')throw Error('Review release identity/version first');
const files=['main.js','manifest.json','styles.css'],hashes={};await mkdir('dist',{recursive:true});
const notices=[];
for(const name of ['markdown-it','yaml','yazl','argparse','entities','linkify-it','mdurl','punycode.js','uc.micro','buffer-crc32']){
  const root=new URL('../node_modules/'+name+'/',import.meta.url);let license='';for(const file of ['LICENSE','LICENSE.md','LICENSE.txt','LICENSE-MIT.txt','LICENSE-MIT'])try{license=await readFile(new URL(file,root),'utf8');break;}catch{}
  const metadata=JSON.parse(await readFile(new URL('package.json',root),'utf8'));if(!license)throw Error('Missing dependency license: '+name);notices.push(name+' '+metadata.version+' · '+metadata.license+'\n'+license);
}
const notice=notices.join('\n\n---\n\n');await writeFile('dist/THIRD-PARTY-NOTICES.txt',notice);
const zip=new ZipFile();
for(const file of files){const bytes=await readFile(file);if(file==='main.js'&&/\/Users\/|\/var\/folders\/|sourceMappingURL=/.test(bytes.toString()))throw Error('Private path/source map in bundle');hashes[file]=createHash('sha256').update(bytes).digest('hex');zip.addBuffer(bytes,manifest.id+'/'+file,{mtime:new Date('2026-10-19T00:00:00Z')});await writeFile('dist/'+file,bytes);}
zip.addBuffer(Buffer.from(notice),manifest.id+'/THIRD-PARTY-NOTICES.txt');zip.end();const chunks=[];for await(const chunk of zip.outputStream)chunks.push(chunk);
const bytes=Buffer.concat(chunks),name=manifest.id+'-'+manifest.version+'.zip';await writeFile('dist/'+name,bytes);hashes[name]=createHash('sha256').update(bytes).digest('hex');
await writeFile('dist/SHA256SUMS',Object.entries(hashes).map(([file,hash])=>hash+'  '+file).join('\n')+'\n');console.log('Release package: dist/'+name);
