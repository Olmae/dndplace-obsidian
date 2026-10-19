import {mkdir,lstat,readFile,open,link,unlink,readdir} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {hashBytes,validHash} from '../documents/hashes.js';
import {SyncStateError} from './state.js';
import type {SyncStorage} from './state.js';

const fail=()=>new SyncStateError('state_corrupt','Файлы журнала повреждены или недоступны');
const maxState=4194304,maxBlob=33554432;
export function createFileSyncStorage({root}:{root:string}):SyncStorage{
  if(!isAbsolute(root))throw fail();
  async function directory(path:string){await mkdir(path,{recursive:true,mode:0o700});const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw fail();}
  async function initialize(){await directory(root);}
  async function syncDirectory(path:string){
    let handle;try{handle=await open(path,'r');await handle.sync();}catch(error){const code=(error as NodeJS.ErrnoException).code;if(!['EINVAL','ENOTSUP','EISDIR'].includes(code??'')&&!(process.platform==='win32'&&code==='EPERM'))throw error;}finally{await handle?.close();}
  }
  async function boundedRead(path:string,max:number){const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max)throw fail();return readFile(path);}
  async function atomicInstall(directoryPath:string,target:string,bytes:Uint8Array){
    const temporary=join(directoryPath,randomUUID()+'.tmp');const file=await open(temporary,'wx',0o600);
    try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
    try{await link(temporary,target);await syncDirectory(directoryPath);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return false;throw error;}finally{await unlink(temporary).catch(()=>{});}
  }
  async function snapshots(key:string){
    if(!validHash(key))throw fail();await initialize();const states=join(root,'states');await directory(states);const folder=join(states,key);await directory(folder);
    const names=(await readdir(folder)).filter(name=>name.endsWith('.json')).sort();if(names.length>10000||names.some(name=>!/^\d{16}\.json$/.test(name)))throw fail();
    let payload:string|null=null,generation=0,total=0;
    for(const name of names){
      if(name!==String(++generation).padStart(16,'0')+'.json')throw fail();
      const bytes=await boundedRead(join(folder,name),2*maxState+4096);total+=bytes.length;if(total>67108864)throw new SyncStateError('state_quota','Журнал достиг лимита; требуется обслуживание');
      let envelope:any;try{envelope=JSON.parse(bytes.toString());}catch{throw fail();}
      if(!envelope||Object.keys(envelope).sort().join(',')!=='generation,payload,previous,sha256,version'||envelope.version!==1||envelope.generation!==generation||typeof envelope.payload!=='string'||Buffer.byteLength(envelope.payload)>maxState||envelope.sha256!==hashBytes(envelope.payload)||envelope.previous!==(payload===null?null:hashBytes(payload)))throw fail();
      payload=envelope.payload;
    }return {folder,payload,generation,total};
  }
  return {
    read:async key=>(await snapshots(key)).payload,
    async compareAndSwap(key,expected,next){
      if(typeof next!=='string'||Buffer.byteLength(next)>maxState)throw fail();const current=await snapshots(key);if(current.payload!==expected)return false;
      const envelope={version:1,generation:current.generation+1,previous:expected===null?null:hashBytes(expected),payload:next,sha256:hashBytes(next)};
      const bytes=Buffer.from(JSON.stringify(envelope));if(current.total+bytes.length>67108864)throw new SyncStateError('state_quota','Журнал достиг лимита; требуется обслуживание');
      return atomicInstall(current.folder,join(current.folder,String(envelope.generation).padStart(16,'0')+'.json'),bytes);
    },
    async putBlob(data){
      if(!(data instanceof Uint8Array)||data.byteLength>maxBlob)throw fail();await initialize();const folder=join(root,'blobs');await directory(folder);const hash=hashBytes(data),target=join(folder,hash);
      if(!await atomicInstall(folder,target,data)){if(hashBytes(await boundedRead(target,maxBlob))!==hash)throw fail();}return hash;
    },
    async readBlob(hash){if(!validHash(hash))throw fail();await initialize();const bytes=await boundedRead(join(root,'blobs',hash),maxBlob);if(hashBytes(bytes)!==hash)throw fail();return bytes;},
  };
}
