// Explicit publication command, never called by build or test.
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
const manifest=JSON.parse(await readFile('manifest.json','utf8'));
if(process.argv[2]!=='--publish-test-release'||manifest.version!=='0.1.0')throw Error('Explicit reviewed test release required');
const values=Object.fromEntries(execFileSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
if(!values.password)throw Error('GitHub credential unavailable');
const base='https://api.github.com/repos/Olmae/dndplace-obsidian',headers={Authorization:'Bearer '+values.password,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
async function request(url,options={}){const response=await fetch(url,{...options,headers:{...headers,...options.headers}});const body=await response.json();if(!response.ok)throw Error('GitHub '+response.status+': '+body.message);return body;}
let release;try{release=await request(base+'/releases/tags/'+manifest.version);}catch(error){if(!error.message.startsWith('GitHub 404:'))throw error;release=await request(base+'/releases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tag_name:manifest.version,target_commitish:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),name:'DNDPlace Sync '+manifest.version+' · тестовый релиз',body:await readFile('docs/release-0.1.0.md','utf8'),prerelease:true,draft:false})});}
for(const name of ['main.js','manifest.json','styles.css','dndplace-sync-0.1.0.zip','THIRD-PARTY-NOTICES.txt','SHA256SUMS']){
  if(release.assets.some(asset=>asset.name===name))throw Error('Asset already exists; do not replace silently: '+name);
  const bytes=await readFile('dist/'+name);await request(release.upload_url.replace(/\{.*$/,'')+'?name='+encodeURIComponent(name),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:bytes});
}
console.log(release.html_url);
