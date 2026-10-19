import type {ConflictPanelService,ConflictModel,PanelConflictChoice} from './conflict-types.js';
import type {HistoryPanelService,HistoryModel} from '../history/panel-types.js';
export type Choice={id:string;name:string;detail?:string};
export type RootChoice=Choice&{root:string;connectionId:string;campaignId:string};
export type NoteChoice={id:string;title:string;path:string;revision:number};
export type Review={id:string;overwrite?:boolean;stage?:'capture'|'server';canConfirm?:boolean;rows:{path:string;title:string;status:string;detail?:string;before?:string|null;after?:string|null;expectedRevision?:number|null}[]};
export type SendOutcome={kind:'review';review:Review}|{kind:'done';result:TransferResult};
export type SendPanelService={notes:(localId:string,signal:AbortSignal)=>Promise<NoteChoice[]>;preview:(localId:string,paths:string[],signal:AbortSignal)=>Promise<Review>;stage:(localId:string,id:string,signal:AbortSignal)=>Promise<Review>;apply:(localId:string,id:string,signal:AbortSignal)=>Promise<TransferResult>;resume:(localId:string,signal:AbortSignal)=>Promise<SendOutcome>;dispose:()=>void};
export type TransferResult={written:number;pending:number};
export type PanelService={automatic?:{eligible:(id:string,signal:AbortSignal)=>Promise<boolean>;cycle:(id:string,signal:AbortSignal)=>Promise<'ok'|'review'>};conflicts?:ConflictPanelService;history?:HistoryPanelService;sending?:SendPanelService;connections:()=>Choice[];roots:()=>RootChoice[];folders:()=>Promise<string[]>;campaigns:(connection:string,signal:AbortSignal)=>Promise<Choice[]>;bindings:(connection:string,campaign:string,signal:AbortSignal)=>Promise<Choice[]>;createBinding:(connection:string,campaign:string,name:string,signal:AbortSignal)=>Promise<Choice>;saveBinding:(input:{connectionId:string;campaignId:string;bindingId:string;root:string},signal:AbortSignal)=>Promise<RootChoice>;notes:(localId:string,signal:AbortSignal)=>Promise<NoteChoice[]>;preview:(localId:string,noteIds:string[],signal:AbortSignal)=>Promise<Review>;apply:(localId:string,previewId:string,signal:AbortSignal)=>Promise<TransferResult>;recover:(localId:string,signal:AbortSignal)=>Promise<TransferResult>;dispose:()=>void};
export type PanelModel={conflict:ConflictModel|null;conflictsAvailable:boolean;history:HistoryModel|null;historyAvailable:boolean;direction:'receive'|'send';sendAvailable:boolean;connections:Choice[];roots:RootChoice[];campaigns:Choice[];bindings:Choice[];folders:string[];connectionId:string;campaignId:string;bindingId:string;folder:string;localId:string;notes:NoteChoice[];selected:string[];filter:string;phase:'idle'|'loading'|'review'|'applying'|'done'|'error';message:string;review:Review|null;result:TransferResult|null};
const messages={binding_paused:'Папка на паузе. Возобновите обмен в настройках DNDPlace.',overwrite_unchanged:'Локальная и серверная версии уже совпадают. Перезапись не нужна.',conflict_unavailable:'Выберите существующую запись, уже связанную с сайтом. Сначала её нужно получить или отправить.',history_unavailable:'История сейчас недоступна. Обновите её после восстановления связи или доступа.',send_pending:'Есть незавершённая отправка. Сначала продолжите её.',unsafe_root:'Выберите отдельную папку внутри хранилища Obsidian, без скрытых или вложенных привязок.',connection_changed:'Подключение изменилось. Выберите его заново.',preview_changed:'Предпросмотр устарел. Постройте его заново.',selection:'Выберите от одной до 32 записей.',unavailable:'Не удалось выполнить действие. Проверьте подключение и повторите.',folder_required:'Выберите кампанию, привязку и папку Obsidian.'};
export class PanelError extends Error{constructor(public code:keyof typeof messages){super(messages[code]);this.name='PanelError';}}
function message(error:unknown){return error instanceof PanelError?error.message:messages.unavailable;}

/** Owns only panel interaction state. Selection changes cancel stale reads and invalidate approval. */
export function createPanelController(service:PanelService){
  let model:PanelModel={conflict:null,conflictsAvailable:!!service.conflicts,history:null,historyAvailable:!!service.history,direction:'receive',sendAvailable:!!service.sending,connections:structuredClone(service.connections()),roots:structuredClone(service.roots()),campaigns:[],bindings:[],folders:[],connectionId:'',campaignId:'',bindingId:'',folder:'',localId:'',notes:[],selected:[],filter:'',phase:'idle',message:'',review:null,result:null},serial=0,closed=false,abort:AbortController|null=null;
  let historyNote:NoteChoice|null=null;const historyCursors=new Set<string>();
  const listeners=new Set<()=>void>(),emit=()=>{if(!closed)for(const listener of listeners)listener();};
  function reset(){model.conflict=null;historyCursors.clear();model.history=null;historyNote=null;abort?.abort();serial++;model.review=null;model.result=null;model.message='';model.phase='idle';}
  async function run<T>(phase:PanelModel['phase'],action:(signal:AbortSignal)=>Promise<T>,done:(value:T)=>void){
    if(closed)return;abort?.abort();const request=new AbortController(),version=++serial;abort=request;model.phase=phase;model.message='';emit();
    try{const value=await action(request.signal);if(closed||request.signal.aborted||version!==serial)return;done(value);emit();}
    catch(error){if(!closed&&!request.signal.aborted&&version===serial){model.phase='error';model.message=message(error);emit();}}
  }
  return {
    get:()=>structuredClone(model),
    subscribe(listener:()=>void){listeners.add(listener);return ()=>{listeners.delete(listener);};},
    refresh(){if(closed)return;reset();model.historyAvailable=!!service.history;model.sendAvailable=!!service.sending;model.connections=structuredClone(service.connections());model.roots=structuredClone(service.roots());model.connectionId='';model.campaignId='';model.bindingId='';model.localId='';model.folder='';model.campaigns=[];model.bindings=[];model.notes=[];model.selected=[];emit();},
    async chooseConnection(id:string){
      if(closed)return;reset();model.connectionId=model.connections.some(row=>row.id===id)?id:'';model.campaignId='';model.bindingId='';model.localId='';model.campaigns=[];model.bindings=[];model.notes=[];model.selected=[];model.folder='';model.folders=[];emit();if(!model.connectionId)return;
      await run('loading',async signal=>({campaigns:await service.campaigns(id,signal),folders:await service.folders()}),value=>{model.campaigns=value.campaigns;model.folders=value.folders;model.phase='idle';});
    },
    async chooseCampaign(id:string){
      if(closed)return;reset();model.campaignId=model.campaigns.some(row=>row.id===id)?id:'';model.bindingId='';model.bindings=[];model.localId='';model.notes=[];model.selected=[];emit();if(!model.campaignId)return;
      const connection=model.connectionId;await run('loading',signal=>service.bindings(connection,id,signal),value=>{model.bindings=value;model.phase='idle';});
    },
    chooseBinding(id:string){if(closed)return;reset();model.bindingId=model.bindings.some(row=>row.id===id)?id:'';emit();},
    chooseFolder(path:string){if(closed)return;reset();model.folder=model.folders.includes(path)?path:'';emit();},
    async createBinding(name:string){
      if(closed||!model.connectionId||!model.campaignId||!name.trim())return;const connection=model.connectionId,campaign=model.campaignId;
      await run('loading',signal=>service.createBinding(connection,campaign,name.trim(),signal),value=>{model.bindings=[...model.bindings.filter(row=>row.id!==value.id),value];model.bindingId=value.id;model.phase='idle';});
    },
    async saveRoot(){
      if(closed)return;if(!model.connectionId||!model.campaignId||!model.bindingId||!model.folder){model.message=messages.folder_required;emit();return;}
      const input={connectionId:model.connectionId,campaignId:model.campaignId,bindingId:model.bindingId,root:model.folder};
      let savedId='';const version=serial+1;
      await run('loading',signal=>service.saveBinding(input,signal),value=>{model.roots=structuredClone(service.roots());model.localId=value.id;savedId=value.id;model.notes=[];model.selected=[];model.review=null;model.phase='idle';model.message='Папка связана с кампанией.';});
      if(savedId&&!closed&&serial===version)await this.chooseRoot(savedId);
    },
    async chooseRoot(id:string){
      if(closed)return;reset();model.localId=model.roots.some(row=>row.id===id)?id:'';model.notes=[];model.selected=[];model.filter='';emit();if(!model.localId)return;
      await run('loading',signal=>model.direction==='send'?service.sending!.notes(id,signal):service.notes(id,signal),value=>{model.notes=value;model.phase='idle';});
    },
    toggleNote(id:string,selected:boolean){if(closed||!model.notes.some(row=>row.id===id))return;reset();model.selected=selected?[...new Set([...model.selected,id])]:model.selected.filter(value=>value!==id);emit();},
    filter(value:string){if(closed)return;model.filter=value.slice(0,200);emit();},
    async preview(){
      if(closed)return;if(!model.localId||model.selected.length<1||model.selected.length>32){model.message=messages.selection;emit();return;}
      const root=model.localId,selected=[...model.selected];model.review=null;model.result=null;
      await run('loading',signal=>model.direction==='send'?service.sending!.preview(root,selected,signal):service.preview(root,selected,signal),value=>{model.review=structuredClone(value);model.phase='review';});
    },
    async confirm(){
      if(closed||model.phase!=='review'||!model.review||!model.localId||model.review.canConfirm===false)return;const root=model.localId,id=model.review.id,stage=model.review.stage;model.review=null;
      if(model.direction==='send'){
        if(stage==='capture')await run('loading',signal=>service.sending!.stage(root,id,signal),review=>{model.review=review;model.phase='review';});
        else if(stage==='server')await run('applying',signal=>service.sending!.apply(root,id,signal),value=>{model.result=value;model.phase='done';});
        return;
      }
      await run('applying',signal=>service.apply(root,id,signal),value=>{model.result=value;model.phase='done';});
    },
    async openHistory(noteId:string){
      if(closed||!model.localId||!service.history)return;const note=model.notes.find(note=>note.id===noteId);if(!note)return;const root=model.localId;reset();historyNote=structuredClone(note);
      await run('loading',signal=>service.history!.list(root,note,undefined,signal),value=>{model.history={...value,active:null,compare:null,restoreAvailable:!!service.history?.restore,restore:null};model.phase='idle';});
    },
    async moreHistory(){
      if(closed||!model.localId||!service.history||!model.history?.nextCursor||!historyNote)return;const previous=structuredClone(model.history),root=model.localId,note=structuredClone(historyNote),cursor=previous.nextCursor!;if(historyCursors.has(cursor)){model.history.nextCursor=null;emit();return;}historyCursors.add(cursor);model.history.active=null;model.history.compare=null;model.history.restore=null;
      await run('loading',signal=>service.history!.list(root,note,cursor,signal),value=>{const keep=['server','cache'].includes(value.remoteStatus),items=new Map((keep?[...previous.items,...value.items]:value.items).map(item=>[item.id,item]));model.history={...value,restoreAvailable:!!service.history?.restore,restore:null,items:[...items.values()].slice(0,500),nextCursor:value.nextCursor!==null&&historyCursors.has(value.nextCursor)||items.size>=500?null:value.nextCursor,active:keep?previous.active:null,compare:keep?previous.compare:null};model.phase='idle';});
    },
    async readHistory(itemId:string){
      if(closed||!model.localId||!service.history||!model.history?.items.some(item=>item.id===itemId))return;const root=model.localId,listId=model.history.id;model.history.active=null;model.history.compare=null;model.history.restore=null;
      await run('loading',signal=>service.history!.read(root,listId,itemId,signal),value=>{if(value.id!==itemId)throw new PanelError('history_unavailable');model.history!.active=value;model.phase='idle';});
      if(model.phase==='error'){model.history=null;historyNote=null;emit();}
    },
    async compareHistory(itemId:string){
      if(closed||!model.localId||!service.history||!model.history?.active)return;if(!itemId){model.history.compare=null;emit();return;}if(!model.history.items.some(item=>item.id===itemId))return;const root=model.localId,listId=model.history.id;model.history.compare=null;
      await run('loading',signal=>service.history!.read(root,listId,itemId,signal),value=>{if(value.id!==itemId)throw new PanelError('history_unavailable');model.history!.compare=value;model.phase='idle';});
      if(model.phase==='error'){model.history=null;historyNote=null;emit();}
    },
    closeHistory(){if(closed)return;reset();emit();},
    async openConflict(noteId:string){
      if(closed||!model.localId||!service.conflicts)return;const note=model.notes.find(row=>row.id===noteId);if(!note)return;const root=model.localId;reset();
      await run('loading',signal=>service.conflicts!.open(root,note,signal),value=>{model.conflict=value;model.phase='idle';});
    },
    async previewConflictDecision(choice:PanelConflictChoice){
      if(closed||['loading','applying'].includes(model.phase)||!model.localId||!model.conflict||!service.conflicts)return;const root=model.localId,id=model.conflict.id;model.conflict.decision=null;
      await run('loading',signal=>service.conflicts!.preview(root,id,choice,signal),value=>{model.conflict!.decision=value;model.phase='idle';});
    },
    async confirmConflictDecision(){
      if(closed||['loading','applying'].includes(model.phase)||!model.localId||!model.conflict?.decision||model.conflict.decision.canConfirm===false||!service.conflicts)return;const root=model.localId,{id,choice,stage}=model.conflict.decision;model.conflict.decision=null;
      await run(choice==='local'&&stage!=='server'?'loading':'applying',signal=>service.conflicts!.apply(root,id,signal),value=>{if('kind'in value){model.conflict!.decision=value.review;model.phase='idle';return;}model.conflict=null;model.phase='idle';model.message=choice==='later'?'Конфликт отложен и сохранён. Обе версии оставлены без изменений.':value.pending?'Решение ещё не завершено. Есть записи, требующие проверки.':choice==='local'?'Локальная версия отправлена на сайт. Более поздние правки остались локально.':choice==='copy'?'Локальная копия создана. Привязка оригинала сохранена.':'Версия сайта получена. Прежний текст сохранён в локальной истории.';});
    },
    cancelConflictDecision(){if(closed||!model.conflict)return;const staged=model.conflict.decision?.choice==='local'&&model.conflict.decision.stage==='server';model.conflict.decision=null;if(staged){model.conflict=null;model.message='Отправка не подтверждена. План сохранён: «На сайт» → «Продолжить отправку».';}emit();},
    closeConflict(){if(closed)return;reset();emit();},
    async previewHistoryRestore(){
      if(closed||['loading','applying'].includes(model.phase)||!model.localId||!service.history?.restore||!model.history?.active)return;
      const root=model.localId,listId=model.history.id,itemId=model.history.active.id;model.history.restore=null;
      await run('loading',signal=>service.history!.restore!.preview(root,listId,itemId,signal),value=>{model.history!.restore=value;model.phase='idle';});
    },
    async confirmHistoryRestore(){
      if(closed||['loading','applying'].includes(model.phase)||!model.localId||!service.history?.restore||!model.history?.restore)return;
      const root=model.localId,id=model.history.restore.id;model.history.restore=null;
      await run('applying',signal=>service.history!.restore!.apply(root,id,signal),value=>{model.history!.active=null;model.history!.compare=null;model.phase='idle';model.message=value.pending?'Файл изменился. Восстановление отложено; свежий текст сохранён.':'Текст восстановлен как локальная правка. На сайт ничего не отправлено.';});
    },
    cancelHistoryRestore(){if(closed||!model.history)return;model.history.restore=null;emit();},
    async chooseDirection(direction:'receive'|'send'){
      if(closed||direction==='send'&&!service.sending)return;reset();model.direction=direction;model.notes=[];model.selected=[];model.filter='';emit();const id=model.localId;if(id)await this.chooseRoot(id);
    },
    async resumeSending(){if(closed||!model.localId||model.direction!=='send'||!service.sending)return;const root=model.localId;model.review=null;model.result=null;await run('applying',signal=>service.sending!.resume(root,signal),value=>{if(value.kind==='review'){model.review=value.review;model.phase='review';}else{model.result=value.result;model.phase='done';}});},
    async recover(){if(closed||!model.localId)return;const root=model.localId;await run('applying',signal=>service.recover(root,signal),value=>{model.result=value;model.review=null;model.phase='done';});},
    cancel(){if(closed)return;reset();model.message='Операция отменена.';emit();},
    dispose(){if(closed)return;closed=true;abort?.abort();serial++;listeners.clear();service.dispose();},
  };
}
export type PanelController=ReturnType<typeof createPanelController>;
