import {renderHistoryPanel} from './history.js';
import {renderConflictPanel} from './conflicts.js';
import {renderOverwriteRows} from './overwrite-review.js';
import type {PanelModel,PanelController} from './controller.js';

export function renderCampaignPanel(host:HTMLElement,model:PanelModel,actions:PanelController,connect:()=>void){
  const doc=host.ownerDocument,active=doc.activeElement as HTMLInputElement|null,key=host.contains(active)?active?.dataset.focus:host.dataset.pendingFocus,selection=key&&active?.tagName==='INPUT'?[active.selectionStart,active.selectionEnd]:null;
  const hadHistory=!!host.querySelector('.dndplace-history'),scrollTop=host.scrollTop,listScrollTop=host.querySelector('.dndplace-note-list')?.scrollTop??Number(host.dataset.listScroll??0);host.dataset.listScroll=String(listScrollTop);
  const previousSetup=host.querySelector<HTMLDetailsElement>('.dndplace-setup')?.open,newName=host.querySelector<HTMLInputElement>('[data-focus="new-name"]')?.value??'';
  host.replaceChildren();host.classList.add('dndplace-panel');
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,cls?:string)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
  const sending=model.direction==='send';
  const busy=model.phase==='loading'||model.phase==='applying';
  function button(parent:HTMLElement,text:string,action:()=>unknown,disabled=false,primary=false){const node=el('button',text,primary?'mod-cta':'');node.type='button';node.disabled=disabled;node.addEventListener('click',()=>{void action();});parent.append(node);return node;}
  function select(parent:HTMLElement,label:string,value:string,items:{id:string;name:string}[],change:(value:string)=>unknown,disabled=false){
    const field=el('label',undefined,'dndplace-field'),name=el('span',label),node=el('select');node.dataset.focus=label;node.setAttribute('aria-label',label);node.disabled=disabled;
    const empty=el('option','Выберите…');empty.value='';node.append(empty);for(const item of items){const option=el('option',item.name);option.value=item.id;node.append(option);}node.value=value;node.addEventListener('change',()=>{void change(node.value);});field.append(name,node);parent.append(field);return node;
  }
  const header=el('header',undefined,'dndplace-panel-heading');header.append(el('span','DNDPlace','dndplace-wordmark'),el('h2','Архив кампании'));button(header,'Подключения',connect,busy);host.append(header);
  if(model.connections.length===0){const empty=el('section',undefined,'dndplace-empty');empty.append(el('h3','Подключите свой DNDPlace'));button(empty,'Добавить подключение',connect,false,true);host.append(empty);return;}
  if(model.roots.length)select(host,'Папка кампании',model.localId,model.roots.map(root=>({id:root.id,name:root.name})),id=>actions.chooseRoot(id),busy);
  if(model.sendAvailable&&model.localId&&!model.conflict){const modes=el('div',undefined,'dndplace-direction');modes.setAttribute('role','group');modes.setAttribute('aria-label','Направление обмена');for(const [id,label]of [['receive','С сайта'],['send','На сайт']]as const){const control=button(modes,label,()=>actions.chooseDirection(id),busy);control.setAttribute('aria-pressed',String(model.direction===id));control.dataset.focus='direction:'+id;}host.append(modes);}
  const setup=el('details',undefined,'dndplace-setup');setup.open=previousSetup??model.roots.length===0;setup.append(el('summary','Связать папку с кампанией'));
  const form=el('div',undefined,'dndplace-fields');select(form,'Подключение',model.connectionId,model.connections,id=>actions.chooseConnection(id),busy);
  select(form,'Кампания',model.campaignId,model.campaigns,id=>actions.chooseCampaign(id),busy||!model.connectionId);
  select(form,'Привязка архива',model.bindingId,model.bindings,id=>actions.chooseBinding(id),busy||!model.campaignId);
  if(model.campaignId){const create=el('div',undefined,'dndplace-new-binding'),input=el('input');input.type='text';input.maxLength=80;input.placeholder='Название новой привязки';input.setAttribute('aria-label','Название новой привязки');input.dataset.focus='new-name';input.value=newName;input.disabled=busy;create.append(input);button(create,'Создать привязку',()=>actions.createBinding(input.value),busy);form.append(create);}
  select(form,'Папка Obsidian',model.folder,model.folders.map(path=>({id:path,name:path})),path=>actions.chooseFolder(path),busy||!model.connectionId);
  button(form,'Связать папку',()=>actions.saveRoot(),busy||!model.connectionId||!model.campaignId||!model.bindingId||!model.folder,true);setup.append(form);host.append(setup);
  const status=el('div',undefined,'dndplace-panel-status');status.setAttribute('role',model.phase==='error'?'alert':'status');status.setAttribute('aria-live','polite');
  if(busy){status.append(el('span',model.phase==='applying'?(model.history?'Восстанавливаем текст…':model.conflict?'Применяем решение…':sending?'Отправляем выбранные записи…':'Получаем выбранные записи…'):'Загружаем…'));button(status,'Отменить',()=>actions.cancel());}
  else if(model.message)status.append(el('p',model.message));host.append(status);
  if(model.localId&&!model.history&&!model.conflict){
    const toolbar=el('div',undefined,'dndplace-panel-toolbar');button(toolbar,'Обновить список',()=>actions.chooseRoot(model.localId),busy);button(toolbar,sending?'Продолжить отправку':'Продолжить получение',()=>sending?actions.resumeSending():actions.recover(),busy);host.append(toolbar);
    if(model.notes.length){
      const search=el('label',undefined,'dndplace-field'),input=el('input');input.type='search';input.placeholder='Найти запись';input.setAttribute('aria-label','Поиск записей');input.dataset.focus='search';input.value=model.filter;input.addEventListener('input',()=>actions.filter(input.value));search.append(input);host.append(search);
      host.append(el('p',`Выбрано: ${model.selected.length} · Всего: ${model.notes.length}`,'dndplace-selection-count'));
      const list=el('div',undefined,'dndplace-note-list');list.setAttribute('role','group');list.setAttribute('aria-label',sending?'Записи Obsidian':'Записи на сайте');
      const query=model.filter.toLocaleLowerCase(),visible=model.notes.filter(note=>(note.title+' '+note.path).toLocaleLowerCase().includes(query));
      for(const note of visible){const label=el('label',undefined,'dndplace-note-row'),check=el('input'),copy=el('span',undefined,'dndplace-note-copy');check.type='checkbox';check.dataset.focus='note:'+note.id;check.checked=model.selected.includes(note.id);check.disabled=busy||!check.checked&&model.selected.length>=32;check.setAttribute('aria-label',note.title);check.addEventListener('change',()=>actions.toggleNote(note.id,check.checked));copy.append(el('strong',note.title),el('small',note.path));label.append(check,copy);list.append(label);}if(!visible.length)list.append(el('p','Ничего не найдено.'));host.append(list);
      if(model.historyAvailable){const history=button(host,'История записи',()=>actions.openHistory(model.selected[0]),busy||model.selected.length!==1);history.dataset.focus='history-open';if(model.selected.length!==1)history.title='Выберите одну запись';}
      if(model.conflictsAvailable){const compare=button(host,'Сравнить версии',()=>actions.openConflict(model.selected[0]),busy||model.selected.length!==1);compare.dataset.focus='conflict-open';if(model.selected.length!==1)compare.title='Выберите одну связанную запись';}
      button(host,sending?'Предпросмотр отправки':'Предпросмотр получения',()=>actions.preview(),busy||model.selected.length===0||model.selected.length>32,true);
    }else if(!busy)host.append(el('p',sending?'В выбранной папке нет Markdown-записей.':'В этой привязке пока нет записей.','dndplace-empty-caption'));
  }
  if(model.phase==='review'&&model.review){
    const review=el('section',undefined,'dndplace-transfer-review');review.setAttribute('aria-label',sending?'Подтверждение отправки':'Подтверждение получения');review.append(el('h3',sending?(model.review.stage==='capture'?'1. Состав пакета':'2. Подтверждение сайта'):'Проверьте изменения'));
    if(model.review.overwrite)renderOverwriteRows(review,model.review.rows);else for(const row of model.review.rows){const item=el('div',undefined,'dndplace-review-row');item.append(el('strong',row.title),el('span',row.status,'dndplace-review-status'),el('small',row.path));if(row.detail)item.append(el('small',row.detail));review.append(item);}
    const controls=el('div',undefined,'dndplace-review-controls');button(controls,sending?(model.review.stage==='capture'?'Подготовить отправку':model.review.overwrite?'Перезаписать на сайте':'Отправить на сайт'):'Получить выбранные записи',()=>actions.confirm(),model.review.canConfirm===false,true);button(controls,'Назад',()=>actions.cancel());review.append(controls);host.append(review);
  }
  if(model.result){const result=el('section',undefined,'dndplace-transfer-result');result.setAttribute('role','status');result.append(el('h3',model.result.pending?'Нужна проверка':'Готово'),el('p',`${sending?'Отправлено':'Получено'}: ${model.result.written} · Ожидает решения: ${model.result.pending}`));host.append(result);}
  if(model.history){renderHistoryPanel(host,model.history,actions,busy);if(!hadHistory){const region=host.querySelector<HTMLElement>('.dndplace-history');region?.setAttribute('tabindex','-1');region?.focus({preventScroll:true});}}
  if(model.conflict){renderConflictPanel(host,model.conflict,actions,busy);if(!hadHistory){const region=host.querySelector<HTMLElement>('.dndplace-conflict');region?.setAttribute('tabindex','-1');region?.focus({preventScroll:true});}}
  host.scrollTop=scrollTop;const currentList=host.querySelector('.dndplace-note-list');if(currentList)currentList.scrollTop=listScrollTop;
  if(key){let target=Array.from(host.querySelectorAll<HTMLElement>('[data-focus]')).find(node=>node.dataset.focus===key);if(!target&&key==='history-close')target=host.querySelector<HTMLElement>('[data-focus="history-open"]')??undefined;
    if(!target&&key.startsWith('history-restore-'))target=['history-restore-cancel','history-restore-preview','history-close'].map(value=>Array.from(host.querySelectorAll<HTMLElement>('[data-focus]')).find(node=>node.dataset.focus===value)).find(Boolean);
    if(!target&&key.startsWith('conflict-'))target=['conflict-cancel','conflict-remote','conflict-open'].map(value=>Array.from(host.querySelectorAll<HTMLElement>('[data-focus]')).find(node=>node.dataset.focus===value)).find(Boolean);
    if(target?.matches(':disabled'))host.dataset.pendingFocus=key;else{delete host.dataset.pendingFocus;target?.focus({preventScroll:true});if(selection&&target?.tagName==='INPUT')try{(target as HTMLInputElement).setSelectionRange(selection[0],selection[1]);}catch{/* native inputs may not support selection */}}
  }
}

export function mountCampaignPanel(host:HTMLElement,controller:PanelController,connect:()=>void){const render=()=>renderCampaignPanel(host,controller.get(),controller,connect),unsubscribe=controller.subscribe(render);render();return ()=>{unsubscribe();controller.dispose();host.replaceChildren();};}
