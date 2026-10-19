import {lstat,realpath,readdir} from 'node:fs/promises';
import {join,relative,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Vault,Workspace,Editor,MarkdownView} from 'obsidian';
import type {LocalBinding} from '../bindings/registry.js';
import {validateRoots,insideRoot,normalizeVaultPath,pathKey} from '../bindings/paths.js';
import {hashBytes} from '../documents/hashes.js';
import {WriteConflict} from '../sync/vault-writer.js';
import type {VaultWriter,EditorWriter} from '../sync/vault-writer.js';

export function createObsidianVaultAdapter({vault,workspace,binding:providedBinding,signal,saveTimeoutMs=5000}:{vault:Vault;workspace:Workspace;binding:LocalBinding;signal?:AbortSignal;saveTimeoutMs?:number}):{vault:VaultWriter;editor:EditorWriter}{
  const binding=structuredClone(providedBinding);
  const versions=new WeakMap<Editor,{token:string;text:string;version:number}>();
  function running(){if(signal?.aborted)throw new Error('Обновление остановлено');}
  async function basePath(){
    running();const adapter=vault.adapter as unknown as {getBasePath?:()=>string};if(typeof adapter.getBasePath!=='function')throw new Error('Нужен файловый адаптер Obsidian Desktop');return realpath(adapter.getBasePath());
  }
  async function verify(path:string,createParents=false){
    running();path=normalizeVaultPath(path);if(!insideRoot(path,binding.root))throw new WriteConflict('outside-root');
    const base=await basePath();
    await validateRoots([binding],{vaultRealPath:base,configDir:vault.configDir,inspect:async relativePath=>{
      const entry=await lstat(join(base,...relativePath.split('/')));return {exists:true,directory:entry.isDirectory(),symlink:entry.isSymbolicLink(),realPath:await realpath(join(base,...relativePath.split('/')))};
    }});
    const parts=path.split('/');let exists=true;
    for(let i=0;i<parts.length;i++){
      const parent=join(base,...parts.slice(0,i)),names=await readdir(parent),matches=names.filter(name=>pathKey(name)===pathKey(parts[i]));
      if(matches.length>1||matches.length===1&&matches[0]!==parts[i])throw new WriteConflict('case-collision');
      if(!matches.length){
        if(i===parts.length-1){exists=false;break;}
        if(!createParents)return false;
        running();await vault.createFolder(parts.slice(0,i+1).join('/'));
      }
      const target=join(base,...parts.slice(0,i+1)),entry=await lstat(target);
      if(entry.isSymbolicLink()||i<parts.length-1&&!entry.isDirectory()||i===parts.length-1&&!entry.isFile())throw new WriteConflict('unsafe-file');
      if(i===parts.length-1&&entry.size>(/\.md$/i.test(path)?1048576+4096:10485760))throw new WriteConflict('file-too-large');
      if(pathKey(relative(base,await realpath(target)).split(sep).join('/'))!==pathKey(parts.slice(0,i+1).join('/')))throw new WriteConflict('unsafe-file');
    }running();return exists;
  }
  function views(path:string){return workspace.getLeavesOfType('markdown').map(leaf=>leaf.view as MarkdownView).filter(view=>view.file?.path===path&&view.editor);}
  function snapshot(path:string){
    if(!insideRoot(normalizeVaultPath(path),binding.root))throw new WriteConflict('outside-root');
    const matches=views(path);if(!matches.length)return null;
    const editor=matches[0].editor,text=editor.getValue();let entry=versions.get(editor);
    if(!entry){entry={token:randomUUID(),text,version:0};versions.set(editor,entry);}else if(entry.text!==text){entry.text=text;entry.version++;}
    return {text,token:matches.length===1?entry.token+'-'+entry.version:'multiple-editors'};
  }
  const host:VaultWriter={
    async read(path){if(!await verify(path))return null;const file=vault.getFileByPath(path);if(!file)throw new WriteConflict('index-pending');return new Uint8Array(await vault.readBinary(file));},
    async create(path,data){
      if(data.byteLength>(/\.md$/i.test(path)?1048576+4096:10485760))throw new WriteConflict('file-too-large');
      if(await verify(path,true))throw new WriteConflict('collision');running();
      try{if(/\.md$/i.test(path)){const text=Buffer.from(data).toString('utf8');if(hashBytes(text)!==hashBytes(data))throw new Error('Некорректная кодировка записи');await vault.create(path,text);}else await vault.createBinary(path,Uint8Array.from(data).buffer);}
      catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST'||/already exists|file.*exists/i.test((error as Error).message))throw new WriteConflict('collision');throw error;}
    },
    async process(path,transform){if(!await verify(path))throw new WriteConflict('missing');const file=vault.getFileByPath(path);if(!file)throw new WriteConflict('index-pending');running();await vault.process(file,transform);},
  };
  const editors:EditorWriter={
    snapshot,
    async replace(path,input){
      running();await verify(path);const matches=views(path),current=snapshot(path);if(matches.length!==1||!current||current.token!==input.expectedToken||hashBytes(current.text)!==input.expectedHash)return false;
      if(current.text===input.output)return true;
      const editor=matches[0].editor,selections=editor.listSelections().map(selection=>({anchor:editor.posToOffset(selection.anchor),head:editor.posToOffset(selection.head)}));
      const position=(offset:number)=>{const before=input.output.slice(0,Math.min(offset,input.output.length)),lines=before.split('\n');return {line:lines.length-1,ch:lines.at(-1)!.length};};
      editor.transaction({changes:[{from:{line:0,ch:0},to:editor.offsetToPos(current.text.length),text:input.output}],selections:selections.map(selection=>({from:position(selection.anchor),to:position(selection.head)}))},'dndplace-pull');return true;
    },
    async waitForSaved(path,hash){
      const deadline=Date.now()+saveTimeoutMs;
      while(Date.now()<=deadline){
        running();const current=snapshot(path);if(current&&hashBytes(current.text)!==hash)return false;
        const saved=await host.read(path);if(saved&&hashBytes(saved)===hash)return true;
        await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,25);signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();});
      }return false;
    },
  };
  return {vault:host,editor:editors};
}
