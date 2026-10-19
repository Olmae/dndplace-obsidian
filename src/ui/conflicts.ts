import type {ConflictModel} from './conflict-types.js';
import type {PanelController} from './controller.js';
import {renderOverwriteRows} from './overwrite-review.js';
export function renderConflictPanel(host:HTMLElement,model:ConflictModel,actions:PanelController,busy:boolean){
 const doc=host.ownerDocument,el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,cls?:string)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
 function button(parent:HTMLElement,label:string,key:string,action:()=>unknown,blocked=false){const node=el('button',label);node.type='button';node.dataset.focus=key;node.disabled=busy||blocked;node.addEventListener('click',()=>{void action();});parent.append(node);}
 const region=el('section',undefined,'dndplace-history dndplace-conflict');region.setAttribute('role','region');region.setAttribute('aria-label','Сравнение версий');
 const header=el('div',undefined,'dndplace-history-heading');header.append(el('h2','Версии'));button(header,'Закрыть сравнение','conflict-close',()=>actions.closeConflict());region.append(header,el('h3',model.title),el('small',model.path,'dndplace-history-path'));
 const comparison=el('div',undefined,'dndplace-history-compare'),columns=el('div',undefined,'dndplace-history-columns');
 for(const [label,text]of [['В Obsidian',model.localText],['На сайте · версия '+model.revision,model.remoteText]]){const article=el('article'),pre=el('pre',text);pre.tabIndex=0;pre.setAttribute('aria-label','Текст: '+label);pre.dataset.focus='conflict-text:'+label;article.append(el('h3',label),pre);columns.append(article);}comparison.append(columns);region.append(comparison);
 if(model.decision){
  if(model.decision.choice==='local'){
   const server=model.decision.stage==='server',review=el('section',undefined,'dndplace-transfer-review');review.setAttribute('aria-label','Подтверждение перезаписи');review.append(el('h3',server?'2. Подтверждение сайта':'1. Локальная версия'),el('small',model.path,'dndplace-history-path'),el('p',server?'Заменится проверенная версия на сайте. Более поздние локальные правки не отправятся автоматически.':'Подготовим серверный план для показанного текста, вложений, локальных метаданных и сохранённой доски. Запись на сайте пока не изменится.'));
   if(server&&model.decision.server)renderOverwriteRows(review,model.decision.server.rows);
   if(model.decision.canConfirm===false)review.append(el('p','Серверный план нельзя применить. Обновите сравнение и проверьте доступ.','dndplace-history-notice'));
   const controls=el('div',undefined,'dndplace-review-controls');button(controls,server?'Перезаписать на сайте':'Подготовить перезапись',server?'conflict-overwrite':'conflict-prepare',()=>actions.confirmConflictDecision(),model.decision.canConfirm===false);button(controls,server?'Не отправлять сейчас':'Отмена решения','conflict-cancel',()=>actions.cancelConflictDecision());review.append(controls);region.append(review);
  }else{
  const {choice,targetPath}=model.decision,review=el('section',undefined,'dndplace-transfer-review');review.setAttribute('aria-label','Подтверждение решения');
  review.append(el('h3',choice==='remote'?'Заменить локальную версию?':choice==='copy'?'Создать отдельную копию?':'Отложить конфликт?'),el('small',targetPath,'dndplace-history-path'),el('p',choice==='remote'?'Текст, метаданные и доска будут взяты с сайта. Текущий файл и несохранённый текст останутся в локальной истории. Новые правки не будут затёрты.':choice==='copy'?'Сохранится показанный локальный текст без привязки к оригиналу. Ссылки на изображения останутся; отдельная доска не копируется. Оригинал и версия сайта не изменятся.':'Обе версии и старая точка синхронизации сохранятся. Отложенная версия будет доступна в локальной истории.'));
  const controls=el('div',undefined,'dndplace-review-controls');button(controls,choice==='remote'?'Подтвердить получение':choice==='copy'?'Создать локальную копию':'Отложить конфликт','conflict-confirm',()=>actions.confirmConflictDecision());button(controls,'Отмена решения','conflict-cancel',()=>actions.cancelConflictDecision());review.append(controls);region.append(review);
  }
 }else{const controls=el('div',undefined,'dndplace-review-controls');button(controls,'Оставить локальную','conflict-local',()=>actions.previewConflictDecision('local'));button(controls,'Взять с сайта','conflict-remote',()=>actions.previewConflictDecision('remote'));button(controls,'Создать копию','conflict-copy',()=>actions.previewConflictDecision('copy'));button(controls,'Позже','conflict-later',()=>actions.previewConflictDecision('later'));region.append(controls);}
 host.append(region);
}
