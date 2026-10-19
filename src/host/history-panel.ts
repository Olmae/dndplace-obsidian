import {randomUUID} from 'node:crypto';
import type {LocalBinding} from '../bindings/registry.js';
import type {Connection} from '../connection/settings.js';
import type {SyncState} from '../sync/state.js';
import type {SyncQueue} from '../sync/queue.js';
import {createLocalRestoreCoordinator} from '../sync/local-restore.js';
import type {RestorePlan} from '../sync/local-restore.js';
import type {createProtocolClient} from '../protocol/client.js';
import type {WriteAdapters} from '../sync/vault-writer.js';
import {stableHash,hashBytes} from '../documents/hashes.js';
import {readFrontmatter,stripIdentity} from '../documents/frontmatter.js';
import {createHistoryReader} from '../history/client.js';
import {archiveNoteUrl} from '../history/site-link.js';
import type {HistoryItem,HistoryList,HistoryPanelService} from '../history/panel-types.js';
import {localNoteChoices} from './local-capture.js';
import {PanelError} from '../ui/controller.js';
import type {NoteChoice} from '../ui/controller.js';
type Session={root:LocalBinding;captured:Connection;live:()=>Promise<void>;queue:SyncQueue;client:ReturnType<typeof createProtocolClient>;writer:Omit<WriteAdapters,'state'|'assertContext'>};
type Context={id:string;localId:string;root:LocalBinding;connection:Connection;note:NoteChoice;entityId:string|null;reader:ReturnType<typeof createHistoryReader>;items:Map<string,HistoryItem&{blob?:string;changeId?:number}>};
const same=(a:unknown,b:unknown)=>stableHash(a)===stableHash(b),labels={site:'Сайт',obsidian:'Obsidian',import:'Импорт',ai:'ИИ',baseline:'Исходная версия'};
const text=(data:Uint8Array)=>{if(data.byteLength>1052672)throw new PanelError('history_unavailable');const source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);try{return stripIdentity(source);}catch{return source;}};

/** Scoped history bridge. Local text restores never upload or acknowledge a server baseline. */
export function createHistoryPanelService(options:{session:(localId:string,signal:AbortSignal)=>Session;state:SyncState;paths:()=>string[];remoteNotes:(localId:string)=>NoteChoice[]|undefined}):HistoryPanelService{
  const contexts=new Map<string,Context>();let closed=false;
  const restores=new Map<string,{context:Context;plan:RestorePlan}>();
  const denied=(error:unknown)=>[401,403].includes((error as {status?:number})?.status??0);
  function invalidate(connectionId:string){for(const context of contexts.values())if(context.connection.id===connectionId){context.reader.invalidate();for(const [id,item]of context.items)if(item.changeId)context.items.delete(id);}for(const [id,row]of restores)if(row.context.connection.id===connectionId)restores.delete(id);}
  async function session(localId:string,signal:AbortSignal,context?:Context){
    if(closed||signal.aborted)throw new PanelError('history_unavailable');const s=options.session(localId,signal);await s.live();if(context&&(context.localId!==localId||!same(context.root,s.root)||!same(context.connection,s.captured)))throw new PanelError('connection_changed');return s;
  }
  const service:HistoryPanelService={
    restore:{
      async preview(localId,listId,itemId,signal){
        const context=[...contexts.values()].find(row=>row.id===listId);if(!context?.entityId)throw new PanelError('history_unavailable');
        const selected=await service.read(localId,listId,itemId,signal),s=await session(localId,signal,context);
        const coordinator=createLocalRestoreCoordinator({binding:s.root,state:options.state,queue:s.queue,writer:s.writer,assertContext:s.live});
        const plan=await coordinator.previewRestore({path:context.note.path,entityId:context.entityId,text:selected.text}),entry=plan.entries[0];
        await s.live();for(const [id,row]of restores)if(row.context===context)restores.delete(id);
        const id=randomUUID();restores.set(id,{context,plan});if(restores.size>20)restores.delete(restores.keys().next().value!);
        return {id,path:entry.path,label:selected.label,text:text(entry.output),currentText:text(entry.editorPreimage??entry.preimage!)};
      },
      async apply(localId,id,signal){
        const captured=restores.get(id);if(!captured)throw new PanelError('preview_changed');restores.delete(id);
        const s=await session(localId,signal,captured.context);if(![...contexts.values()].includes(captured.context))throw new PanelError('preview_changed');
        const coordinator=createLocalRestoreCoordinator({binding:s.root,state:options.state,queue:s.queue,writer:s.writer,assertContext:s.live});
        const saved=await coordinator.applyRestore(captured.plan),entries=saved.journals.find(row=>row.id===captured.plan.id)!.entries;
        return {written:entries.filter(row=>row.status==='acknowledged').length,pending:entries.filter(row=>row.status!=='acknowledged').length};
      },
    },
    async list(localId,note,cursor,signal){
      const s=await session(localId,signal),snapshot=await options.state.load(s.root.identity,s.root.root),local=localNoteChoices(options.paths(),s.root).some(row=>row.id===note.id&&row.path===note.path),remote=options.remoteNotes(localId)?.some(row=>row.id===note.id&&row.path===note.path);
      if(!local&&!remote)throw new PanelError('selection');let entityId=remote?note.id:snapshot.bases.find(base=>base.path===note.path)?.entityId??null;
      if(local&&!entityId){const bytes=await s.writer.vault.read(note.path);if(bytes)try{const portable=readFrontmatter(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)).identity;if(portable&&(['instanceId','accountId','campaignId','bindingId']as const).every(key=>portable[key]===s.root.identity[key])&&snapshot.bases.some(base=>base.entityId===portable.entityId))entityId=portable.entityId;}catch{/* unlinked files do not acquire guessed server history */}}
      const key=stableHash([s.root,s.captured,note.path,entityId]);let context=contexts.get(key);
      if(!context){
        const capturedRoot=structuredClone(s.root),capturedConnection=structuredClone(s.captured);
        const reader=createHistoryReader({identity:s.root.identity,root:s.root.root,open:async signal=>{const next=await session(localId,signal);if(!same(next.root,capturedRoot)||!same(next.captured,capturedConnection))throw new PanelError('connection_changed');return next.client;}});
        context={id:randomUUID(),localId,root:capturedRoot,connection:capturedConnection,note:structuredClone(note),entityId,reader,items:new Map()};contexts.set(key,context);
        if(contexts.size>20){const first=contexts.keys().next().value!;contexts.get(first)!.reader.dispose();contexts.delete(first);}
      }
      if(!cursor)context.items.clear();
      const localItems:HistoryItem[]=[];
      for(const journal of [...snapshot.journals].reverse())for(const entry of journal.entries){
        if(entry.kind!=='note'||entry.path!==note.path&&(!entityId||entry.entityId!==entityId))continue;
        for(const [kind,blob,label]of [['editor',entry.editorHash,journal.mode==='restore'?'Несохранённый текст до восстановления':'Несохранённый текст до получения'],['disk',entry.preimageHash,journal.mode==='restore'?'Файл до восстановления':'Файл до получения'],['output',entry.outputHash,journal.mode==='restore'?'Восстановленный текст':journal.mode==='copy'?'Созданная копия':['pending','superseded'].includes(entry.status)?'Сохранённая версия сайта':'Полученная версия']]as const){
          if(!blob||localItems.length>=50)continue;const id='local-'+stableHash([journal.id,entry.id,kind]).slice(0,32),item={id,label,revision:null,source:'Локальная копия',actor:'Это устройство',createdAt:null,deleted:false,blob};context.items.set(id,item);localItems.push(item);
        }
      }
      let remoteStatus:HistoryList['remoteStatus']=entityId?'unavailable':'unlinked',nextCursor:string|null=null,fetchedAt:string|null=null;
      if(entityId)try{
        const page=await context.reader.page(entityId,cursor,signal);remoteStatus=page.origin;nextCursor=page.value.nextCursor;fetchedAt=page.fetchedAt;
        for(const row of page.value.rows){const id='server-'+row.id;context.items.set(id,{id,label:'Версия '+row.revision,revision:row.revision,source:labels[row.source],actor:row.actor?.name||'Участник',createdAt:row.createdAt,deleted:row.deleted,changeId:row.id});}
      }catch(error){if(signal.aborted)throw error;await s.live();if(denied(error))invalidate(s.captured.id);remoteStatus=(error as {status?:number})?.status===401||(error as {status?:number})?.status===403?'forbidden':'unavailable';for(const [id,item]of context.items)if(item.changeId)context.items.delete(id);}
      await s.live();const serverItems=[...context.items.values()].filter(item=>item.changeId).sort((a,b)=>b.changeId!-a.changeId!).slice(0,450);
      return {id:context.id,title:note.title,path:note.path,items:[...serverItems,...localItems].map(({id,label,revision,source,actor,createdAt,deleted})=>({id,label,revision,source,actor,createdAt,deleted})),nextCursor,remoteStatus,fetchedAt,...(entityId&&remoteStatus==='server'?{siteUrl:archiveNoteUrl(s.captured.baseUrl,s.root.identity.campaignId,entityId)}:{})};
    },
    async read(localId,listId,itemId,signal){
      const context=[...contexts.values()].find(row=>row.id===listId);if(!context)throw new PanelError('history_unavailable');const s=await session(localId,signal,context),item=context.items.get(itemId);if(!item)throw new PanelError('history_unavailable');
      let source:string,origin:'local'|'server'|'cache'='local',fetchedAt:string|null=null;
      if(item.blob){const data=await options.state.storage.readBlob(item.blob);if(hashBytes(data)!==item.blob)throw new PanelError('history_unavailable');source=text(data);}
      else if(item.changeId&&context.entityId){
        const detail=await context.reader.detail(context.entityId,item.changeId,signal).catch(error=>{if(denied(error))invalidate(s.captured.id);throw error;});if(detail.value.change.revision!==item.revision)throw new PanelError('history_unavailable');source=detail.value.document!.markdown;origin=detail.origin;fetchedAt=detail.fetchedAt;
      }else throw new PanelError('history_unavailable');
      const current=await s.writer.vault.read(context.note.path),editor=s.writer.editor.snapshot(context.note.path);if(editor?.token==='multiple-editors')throw new PanelError('history_unavailable');
      await s.live();return {id:item.id,label:item.label,text:source,currentText:editor?text(Buffer.from(editor.text)):current?text(current):null,origin,fetchedAt};
    },
    dispose(){closed=true;for(const context of contexts.values())context.reader.dispose();contexts.clear();restores.clear();},
  };
  return service;
}
