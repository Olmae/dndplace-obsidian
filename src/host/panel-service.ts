import type {App} from 'obsidian';
import {randomUUID} from 'node:crypto';
import {lstat,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import type {Settings,Connection} from '../connection/settings.js';
import type {SecretStore} from '../connection/secrets.js';
import {createDesktopTransport} from '../connection/transport.js';
import type {TransportOptions} from '../connection/transport.js';
import {createProtocolClient,verifyConnection} from '../protocol/client.js';
import {validateDTO} from '../protocol/validate.js';
import type {LocalBinding} from '../bindings/registry.js';
import {normalizeVaultPath,insideRoot,pathKey,validateRoots} from '../bindings/paths.js';
import {stableHash} from '../documents/hashes.js';
import {createFileSyncStorage} from '../sync/file-storage.js';
import {createSyncState} from '../sync/state.js';
import {createSyncQueue} from '../sync/queue.js';
import {createSyncCoordinator} from '../sync/coordinator.js';
import type {VaultPlan} from '../sync/pull.js';
import {createObsidianVaultAdapter} from './vault.js';
import {createSendPanelService} from './send-panel.js';
import {createConflictPanelService} from './conflict-panel.js';
import {createHistoryPanelService} from './history-panel.js';
import {createAutomaticCycle} from './automatic-cycle.js';
import {PanelError} from '../ui/controller.js';
import type {PanelService,NoteChoice,RootChoice,TransferResult} from '../ui/controller.js';

type Options={app:Pick<App,'vault'|'workspace'>;settings:()=>Settings;saveBinding:(binding:LocalBinding)=>Promise<void>;secrets:SecretStore;deviceId:string;storageRoot:string;transportFactory?:typeof createDesktopTransport};
const same=(a:unknown,b:unknown)=>stableHash(a)===stableHash(b);
const segment=(name:string)=>{let value=name.normalize('NFC').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g,'-').replace(/^[. ]+|[. ]+$/g,'').slice(0,80).replace(/[. ]+$/g,'')||'Запись';if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value))value='_'+value;return value;};

/** Host IO is lazy and root-scoped. Constructing the service never reads a vault or sends a request. */
export function createNativePanelService(options:Options):PanelService{
  const {app,settings,secrets,deviceId}=options,transportFactory=options.transportFactory??createDesktopTransport;
  const storage=createFileSyncStorage({root:options.storageRoot}),state=createSyncState({deviceId,storage});let disposed=false;
  const catalogs=new Map<string,NoteChoice[]>(),previews=new Map<string,{localId:string;root:LocalBinding;connection:Connection;plan:VaultPlan}>();
  const roots=():RootChoice[]=>(settings().bindings??[]).filter(binding=>!binding.paused).map(binding=>({id:binding.id,name:binding.root,root:binding.root,connectionId:binding.identity.connectionId,campaignId:binding.identity.campaignId}));
  function connection(id:string){const value=settings().connections.find(row=>row.id===id);if(!value?.verified)throw new PanelError('connection_changed');return structuredClone(value);}
  function check(connection:Connection,signal:AbortSignal){
    if(disposed||signal.aborted||!same(settings().connections.find(row=>row.id===connection.id),connection)||secrets.get('dndplace-device-id')!==deviceId)throw new PanelError('connection_changed');
  }
  function transport(captured:Connection,signal:AbortSignal){
    const wire=transportFactory({baseUrl:captured.baseUrl,getSecret:async()=>{check(captured,signal);return secrets.get(captured.secretName);}});
    return {...wire,json:(path:string,options:TransportOptions={})=>wire.json(path,{...options,signal}),bytes:(path:string,options:TransportOptions={})=>wire.bytes(path,{...options,signal}),uploadZip:(path:string,bytes:Uint8Array,options:Omit<TransportOptions,'method'|'body'>={})=>wire.uploadZip(path,bytes,{...options,signal})};
  }
  async function request(captured:Connection,signal:AbortSignal,path:string,extra:TransportOptions={}){
    check(captured,signal);const wire=transport(captured,signal),checked=await verifyConnection(wire,{signal});
    if(checked.account.id!==captured.verified!.accountId||checked.instanceId!==captured.verified!.instanceId)throw new PanelError('connection_changed');
    const value=await wire.json(path,{...extra,signal,expectedAccountId:captured.verified!.accountId,expectedInstanceId:captured.verified!.instanceId});check(captured,signal);return value;
  }
  function session(localId:string,signal:AbortSignal){
    const found=settings().bindings?.find(row=>row.id===localId);if(!found)throw new PanelError('unsafe_root');if(found.paused)throw new PanelError('binding_paused');const root=structuredClone(found),captured=connection(root.identity.connectionId);
    const live=async()=>{check(captured,signal);if(!same(settings().bindings?.find(row=>row.id===localId),root))throw new PanelError('unsafe_root');};
    const client=createProtocolClient(transport(captured,signal),root.identity),queue=createSyncQueue({identity:root.identity,root:root.root,deviceId,storage}),writer=createObsidianVaultAdapter({vault:app.vault,workspace:app.workspace,binding:root,signal});
    return {root,captured,live,client,queue,writer,coordinator:createSyncCoordinator({binding:root,state,queue,client,writer,assertContext:live})};
  }
  const sending=createSendPanelService({session,state,paths:()=>app.vault.getAllLoadedFiles().filter(file=>!('children'in file)).map(file=>file.path)});
  const conflicts=createConflictPanelService({session,state,remoteNotes:listNotes,sending,paths:()=>app.vault.getAllLoadedFiles().filter(file=>!('children'in file)).map(file=>file.path)});
  const history=createHistoryPanelService({session,state,paths:()=>app.vault.getAllLoadedFiles().filter(file=>!('children'in file)).map(file=>file.path),remoteNotes:localId=>catalogs.get(localId)});
  async function listNotes(localId:string,signal:AbortSignal){
    const s=session(localId,signal),rows:any[]=[],folders=new Map<string,any>();let cursor:string|undefined,revision:number|undefined;const cursors=new Set<string>();
    do{
      await s.live();const page=validateDTO('indexPage',await s.client.index(cursor)) as any;await s.live();if(revision!==undefined&&revision!==page.archiveRevision)throw new PanelError('preview_changed');revision=page.archiveRevision;
      rows.push(...page.rows);for(const folder of page.folders)folders.set(folder.id,folder);if(rows.length>2000)throw new PanelError('selection');
      cursor=page.nextCursor??undefined;if(cursor){if(cursors.has(cursor)||cursors.size>=40)throw new PanelError('preview_changed');cursors.add(cursor);}
    }while(cursor);
    const bindings=validateDTO('bindings',await request(s.captured,signal,`campaigns/${s.root.identity.campaignId}/bindings`)) as any[],remote=bindings.find(binding=>binding.id===s.root.identity.bindingId);if(!remote)throw new PanelError('unsafe_root');
    const current=await state.load(s.root.identity,s.root.root),seen=new Set<string>();
    function folderPath(id:string|null,visiting=new Set<string>()):string{
      if(!id||id===remote.destinationFolderId)return '';if(visiting.has(id)||visiting.size>=20)throw new PanelError('unsafe_root');visiting.add(id);const folder=folders.get(id);if(!folder)throw new PanelError('unsafe_root');const parent=folderPath(folder.parentId,visiting);return (parent?parent+'/':'')+segment(folder.name);
    }
    const notes:NoteChoice[]=rows.map(row=>{
      const base=current.bases.find(base=>base.entityId===row.id),parent=folderPath(row.folderId),title=segment(row.title),suffix=stableHash(row.id).slice(0,12),path=base?.path??`${s.root.root}/${parent?parent+'/':''}${title} — ${suffix}.md`;
      if(!insideRoot(path,s.root.root)||normalizeVaultPath(path)!==path||seen.has(pathKey(path)))throw new PanelError('unsafe_root');seen.add(pathKey(path));return {id:row.id,title:row.title,path,revision:row.revision};
    });
    notes.sort((a,b)=>a.path.localeCompare(b.path));await s.live();catalogs.set(localId,notes);return structuredClone(notes);
  }
  function result(current:Awaited<ReturnType<typeof state.load>>,journalIds?:Set<string>):TransferResult{
    const entries=current.journals.filter(journal=>!journalIds||journalIds.has(journal.id)).flatMap(journal=>journal.entries).filter(entry=>entry.kind==='note');
    return {written:entries.filter(entry=>entry.status==='acknowledged').length,pending:entries.filter(entry=>entry.status!=='acknowledged').length};
  }
  return {
    automatic:createAutomaticCycle({session,state,deviceId,paths:()=>app.vault.getAllLoadedFiles().filter(file=>!('children'in file)).map(file=>file.path)}),
    sending,history,conflicts,
    connections:()=>settings().connections.filter(row=>row.verified).map(row=>({id:row.id,name:row.name,detail:row.verified!.accountName})),roots,
    async folders(){
      if(disposed)return [];const paths=app.vault.getAllLoadedFiles().filter(file=>'children'in file&&file.path).flatMap(file=>{try{return [normalizeVaultPath(file.path)];}catch{return [];}});return paths.sort((a,b)=>a.localeCompare(b));
    },
    async campaigns(id,signal){const captured=connection(id),rows=validateDTO('campaigns',await request(captured,signal,'campaigns')) as any[];return rows.map(row=>({id:row.id,name:row.name,detail:row.capabilities.includes('archive.write')?'Чтение и запись':'Только чтение'}));},
    async bindings(id,campaign,signal){if(!/^[A-Za-z0-9_-]{1,200}$/.test(campaign))throw new PanelError('folder_required');const captured=connection(id),rows=validateDTO('bindings',await request(captured,signal,`campaigns/${campaign}/bindings`)) as any[];return rows.map(row=>({id:row.id,name:row.name,detail:row.destinationFolderId?'Папка архива':'Весь архив кампании'}));},
    async createBinding(id,campaign,name,signal){
      if(!/^[A-Za-z0-9_-]{1,200}$/.test(campaign)||!name.trim()||name.length>80)throw new PanelError('folder_required');
      const captured=connection(id),row=validateDTO('binding',await request(captured,signal,`campaigns/${campaign}/bindings`,{method:'POST',body:{name:name.trim(),destinationFolderId:null}})) as any;if(row.campaignId!==campaign||row.ownerId!==captured.verified!.accountId)throw new PanelError('connection_changed');return {id:row.id,name:row.name,detail:'Весь архив кампании'};
    },
    async saveBinding(input,signal){
      if(!/^[A-Za-z0-9_-]{1,200}$/.test(input.campaignId)||!/^[A-Za-z0-9_-]{1,200}$/.test(input.bindingId))throw new PanelError('folder_required');
      const captured=connection(input.connectionId),all=validateDTO('bindings',await request(captured,signal,`campaigns/${input.campaignId}/bindings`)) as any[];
      if(!all.some(row=>row.id===input.bindingId&&row.campaignId===input.campaignId))throw new PanelError('unsafe_root');
      const existing=settings().bindings??[],sameBinding=existing.find(row=>row.identity.connectionId===input.connectionId&&row.identity.campaignId===input.campaignId&&row.identity.bindingId===input.bindingId);
      if(sameBinding&&sameBinding.root!==input.root)throw new PanelError('unsafe_root');
      const root:LocalBinding={id:randomUUID(),root:input.root,identity:{connectionId:captured.id,instanceId:captured.verified!.instanceId,accountId:captured.verified!.accountId,campaignId:input.campaignId,bindingId:input.bindingId}};
      const adapter=app.vault.adapter as unknown as {getBasePath?:()=>string};if(!adapter.getBasePath)throw new PanelError('unsafe_root');
      try{const base=await realpath(adapter.getBasePath());await validateRoots(sameBinding?existing:[...existing,root],{vaultRealPath:base,configDir:app.vault.configDir,inspect:async path=>{const target=join(base,...path.split('/')),entry=await lstat(target);return {exists:true,directory:entry.isDirectory(),symlink:entry.isSymbolicLink(),realPath:await realpath(target)};}});}catch{throw new PanelError('unsafe_root');}
      if(sameBinding){if(sameBinding.paused)throw new PanelError('binding_paused');return roots().find(value=>value.id===sameBinding.id)!;}
      check(captured,signal);await options.saveBinding(root);return roots().find(row=>row.id===root.id)!;
    },
    notes:listNotes,
    async preview(localId,ids,signal){
      const notes=catalogs.get(localId);if(!notes||ids.length<1||ids.length>32||new Set(ids).size!==ids.length||ids.some(id=>!notes.some(note=>note.id===id)))throw new PanelError('selection');
      const s=session(localId,signal),selected=ids.map(id=>notes.find(note=>note.id===id)!);await s.live();const plan=await s.coordinator.previewPull(selected.map(note=>({path:note.path,entityId:note.id,revision:note.revision})));await s.live();
      previews.set(plan.id,{localId,root:s.root,connection:s.captured,plan});if(previews.size>10)previews.delete(previews.keys().next().value!);
      return {id:plan.id,rows:plan.entries.filter(entry=>entry.kind==='note').map(entry=>({path:entry.path,title:entry.nextBase!.serverTitle,status:entry.blockedReason?'Нужна проверка':entry.expectedHash===null?'Новая запись':entry.expectedHash===entry.outputHash?'Без изменений':'Обновление'}))};
    },
    async apply(localId,previewId,signal){
      const saved=previews.get(previewId),s=session(localId,signal);if(!saved||saved.localId!==localId||!same(saved.root,s.root)||!same(saved.connection,s.captured))throw new PanelError('preview_changed');
      previews.delete(previewId);await s.live();const current=await s.coordinator.applyPull(saved.plan);return result(current,new Set([saved.plan.id]));
    },
    async recover(localId,signal){const s=session(localId,signal);await s.live();const before=await state.load(s.root.identity,s.root.root),ids=new Set(before.journals.filter(journal=>journal.status!=='completed').map(journal=>journal.id));return result(await s.coordinator.recoverPull(),ids);},
    dispose(){disposed=true;catalogs.clear();previews.clear();sending.dispose();history.dispose();conflicts.dispose();},
  };
}
