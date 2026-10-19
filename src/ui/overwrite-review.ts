import type {Review} from './controller.js';

/** Server-supplied snippets stay literal text: never render imported HTML/embeds. */
export function renderOverwriteRows(host:HTMLElement,rows:Review['rows']){
 const doc=host.ownerDocument;
 for(const row of rows){
  const region=doc.createElement('section');region.className='dndplace-history-compare';const title=doc.createElement('h3');title.textContent=row.status;const path=doc.createElement('small');path.className='dndplace-history-path';path.textContent=row.path;region.append(title,path);
  const columns=doc.createElement('div');columns.className='dndplace-history-columns';
  for(const [label,text]of [['На сайте сейчас',row.before],['После перезаписи',row.after]]as const){const article=doc.createElement('article'),heading=doc.createElement('h3'),pre=doc.createElement('pre');heading.textContent=label;pre.textContent=text??'Нет предпросмотра';pre.tabIndex=0;pre.setAttribute('aria-label',label);pre.dataset.focus='overwrite-text:'+label;article.append(heading,pre);columns.append(article);}
  region.append(columns);host.append(region);
 }
}
