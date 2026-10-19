import type {HistoryModel} from '../history/panel-types.js';
import type {PanelController} from './controller.js';
const format=(value:string)=>{try{return new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short'}).format(new Date(value));}catch{return value;}};
export function renderHistoryPanel(host:HTMLElement,model:HistoryModel,actions:PanelController,busy:boolean){
  const doc=host.ownerDocument,el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,cls?:string)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
  function button(parent:HTMLElement,label:string,key:string,action:()=>unknown){const node=el('button',label);node.type='button';node.disabled=busy;node.dataset.focus=key;node.addEventListener('click',()=>{void action();});parent.append(node);return node;}
  const region=el('section',undefined,'dndplace-history');region.setAttribute('role','region');region.setAttribute('aria-label','История записи');
  const header=el('div',undefined,'dndplace-history-heading');header.append(el('h2','История'));button(header,'Закрыть историю','history-close',()=>actions.closeHistory());region.append(header,el('h3',model.title),el('small',model.path,'dndplace-history-path'));
  const notice=model.remoteStatus==='cache'?'Сохранённая история'+(model.fetchedAt?' · '+format(model.fetchedAt):''):model.remoteStatus==='unavailable'?'История сайта сейчас недоступна.':model.remoteStatus==='forbidden'?'Нет доступа к истории сайта.':model.remoteStatus==='unlinked'?'Запись ещё не связана с сайтом.':null;
  if(notice){const status=el('p',notice,'dndplace-history-notice');status.setAttribute('role','status');region.append(status);}
  if(model.siteUrl&&model.remoteStatus==='server'){
    const site=el('p',undefined,'dndplace-history-site'),link=el('a','Открыть запись на сайте','external-link');
    link.href=model.siteUrl;link.target='_blank';link.rel='noopener noreferrer';link.dataset.focus='history-site';
    link.setAttribute('aria-disabled',String(busy));if(busy)link.tabIndex=-1;
    link.addEventListener('click',event=>{if(busy)event.preventDefault();});
    site.append(link,el('small','Для восстановления версии откройте «История изменений» на сайте. Вход — через браузер.'));region.append(site);
  }
  for(const [source,title]of [['server','На сайте'],['local','Локальные копии']]as const){
    const items=model.items.filter(item=>source==='local'?item.source==='Локальная копия':item.source!=='Локальная копия');if(!items.length)continue;
    region.append(el('h3',title));const list=el('div',undefined,'dndplace-history-list');list.setAttribute('role','group');list.setAttribute('aria-label',title);
    for(const item of items){
      const row=button(list,'','history-version:'+item.id,()=>actions.readHistory(item.id));row.className='dndplace-history-version';row.setAttribute('aria-label','Открыть версию: '+item.label);row.setAttribute('aria-pressed',String(model.active?.id===item.id));
      row.append(el('strong',item.label+(item.deleted?' · удалено':'')),el('span',item.source+' · '+item.actor));if(item.createdAt){const time=el('time',format(item.createdAt));time.dateTime=item.createdAt;row.append(time);}
    }region.append(list);
  }
  if(!model.items.some(item=>item.source==='Локальная копия'))region.append(el('p','Локальных копий пока нет.','dndplace-history-path'));
  if(model.remoteStatus==='server'&&!model.items.some(item=>item.source!=='Локальная копия'))region.append(el('p','На сайте пока нет версий этой записи.','dndplace-history-path'));
  if(model.nextCursor)button(region,'Ещё версии','history-more',()=>actions.moreHistory());
  if(model.active){
    const section=el('section',undefined,'dndplace-history-compare');section.setAttribute('aria-label','Сравнение текста');
    const field=el('label',undefined,'dndplace-field'),select=el('select');select.setAttribute('aria-label','Сравнить с');select.dataset.focus='history-compare';select.disabled=busy;
    const current=el('option','Текущий текст файла');current.value='';select.append(current);
    for(const item of model.items){if(item.id===model.active.id)continue;const option=el('option',item.label+' · '+item.source);option.value=item.id;select.append(option);}select.value=model.compare?.id??'';select.addEventListener('change',()=>{void actions.compareHistory(select.value);});field.append(el('span','Сравнить с'),select);section.append(field);
    const right=model.compare?.text??model.active.currentText,summary=el('p',right===null?'Текущий файл отсутствует.':right===model.active.text?'Текст совпадает':'Текст отличается','dndplace-history-difference');summary.setAttribute('role','status');section.append(summary);
    if(model.active.origin==='cache'||model.compare?.origin==='cache')section.append(el('p','Показан сохранённый текст версии.','dndplace-history-notice'));
    const columns=el('div',undefined,'dndplace-history-columns');
    for(const [label,source]of [[model.active.label,model.active.text],[model.compare?.label??'Текущий текст файла',right]]as const){const article=el('article'),pre=el('pre',source??'Файл отсутствует.');pre.tabIndex=0;pre.setAttribute('aria-label','Текст: '+label);pre.dataset.focus='history-text:'+label;article.append(el('h3',label),pre);columns.append(article);}section.append(columns);region.append(section);
  }
  if(model.active&&model.restoreAvailable&&model.active.currentText!==null&&model.remoteStatus!=='unlinked'){
    const restore=el('section',undefined,'dndplace-transfer-review');restore.setAttribute('aria-label','Восстановление текста');
    if(model.restore){
      restore.append(el('h3','Восстановление текста · '+model.restore.label),el('small',model.restore.path),el('p','Заменится только текст этого файла, включая несохранённые правки. Текущий текст останется в локальной истории. Изображения и доска не восстанавливаются. На сайт ничего не отправится.'));
      const columns=el('div',undefined,'dndplace-history-columns');for(const [label,source]of [['Сейчас',model.restore.currentText],['После восстановления',model.restore.text]]){const article=el('article'),pre=el('pre',source);pre.tabIndex=0;pre.setAttribute('aria-label','Текст: '+label);article.append(el('h3',label),pre);columns.append(article);}restore.append(columns);
      const controls=el('div',undefined,'dndplace-review-controls');button(controls,'Подтвердить восстановление текста','history-restore-confirm',()=>actions.confirmHistoryRestore());button(controls,'Отмена восстановления','history-restore-cancel',()=>actions.cancelHistoryRestore());restore.append(controls);
    }else{const control=button(restore,'Восстановить текст локально…','history-restore-preview',()=>actions.previewHistoryRestore());if(model.active.text===model.active.currentText){control.disabled=true;control.title='Текст уже совпадает';}}
    region.append(restore);
  }
  host.append(region);
}
