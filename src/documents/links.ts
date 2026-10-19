import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import {readFrontmatter} from './frontmatter.js';
import {insideRoot,normalizeVaultPath,pathKey} from '../bindings/paths.js';
import type {LocalBinding} from '../bindings/registry.js';

export type Diagnostic={code:string;message:string;severity:'info'|'warning'|'error'};
export type Reference={target:string;kind?:'wiki'|'markdown';label?:string};
export function scanReferences(source:string){
  const parser=new MarkdownIt({html:false,linkify:false,typographer:false}),assets:Reference[]=[],links:Reference[]=[],diagnostics:Diagnostic[]=[];
  parser.inline.ruler.before('link','dndplace_wiki',(state,silent)=>{
    const start=state.pos,embed=state.src.startsWith('![[',start),offset=embed?3:2;
    if(!embed&&!state.src.startsWith('[[',start))return false;
    const end=state.src.indexOf(']]',start+offset);if(end<0||end-start>2048)return false;
    const inside=state.src.slice(start+offset,end);if(!inside||/[\r\n]/.test(inside))return false;
    const [target,...label]=inside.split('|');if(!target)return false;
    if(!silent){const token=state.push('dndplace_wiki','',0);token.meta={target,embed,label:label.join('|')};}
    state.pos=end+2;return true;
  });
  const tokens=parser.parse(readFrontmatter(source).body,{});
  function visit(tokens:Token[]){for(const token of tokens){
    if(token.type==='dndplace_wiki'){
      const {target,embed,label}=token.meta,reference={target,kind:'wiki' as const,label};
      if(embed){if(/\.(?:png|jpe?g|webp)(?:#.*)?$/i.test(target))assets.push(reference);else diagnostics.push({code:'unsupported_embed',severity:'warning',message:'Встраивание сохранено как текст: '+target});}
      else links.push(reference);
    }
    if(token.type==='image')assets.push({target:token.attrGet('src')??'',kind:'markdown',label:token.content});
    if(token.type==='link_open')links.push({target:token.attrGet('href')??'',kind:'markdown'});
    if(token.children)visit(token.children);
  }}visit(tokens);
  let h1:string|null=null;for(let i=0;i<tokens.length;i++)if(tokens[i].type==='heading_open'&&tokens[i].tag==='h1'){h1=tokens[i+1]?.content?.trim()||null;break;}
  return {assets,links,diagnostics,h1};
}
function decodeTarget(value:string):string{try{return decodeURIComponent(value);}catch{return value;}}
export function resolveLocalTarget(target:string,from:string,binding:LocalBinding,{decode=true}={}):{status:'local';path:string}|{status:'external'|'outside'}{
  try{if(!insideRoot(from,binding.root))return {status:'outside'};}catch{return {status:'outside'};}
  if(typeof target!=='string'||!target||target.length>2048)return {status:'outside'};
  // Decode exactly once; never fetch a URL, even one masquerading as a filename.
  target=target.split('#')[0];if(decode)target=decodeTarget(target);
  if(/^[A-Za-z][A-Za-z0-9+.-]*:|^\/\//.test(target))return {status:'external'};
  if(!target)return {status:'local',path:normalizeVaultPath(from)};
  if(target.startsWith('/')||target.includes('\\')||/[\x00-\x1f\x7f]/.test(target))return {status:'outside'};
  const root=normalizeVaultPath(binding.root),rootParts=root.split('/');
  try{
    const explicit=normalizeVaultPath(target);if(insideRoot(explicit,root))return {status:'local',path:explicit};
  }catch{}
  const parts=normalizeVaultPath(from).split('/').slice(0,-1);
  for(const part of target.split('/')){
    if(part==='.')continue;
    if(part==='..'){if(parts.length<=rootParts.length)return {status:'outside'};parts.pop();}
    else parts.push(part);
  }
  try{const path=normalizeVaultPath(parts.join('/'));return insideRoot(path,root)?{status:'local',path}:{status:'outside'};}catch{return {status:'outside'};}
}
export type NoteLinkEntry={path:string;entityId:string;aliases?:string[]};
export function resolveNoteLink(target:string,from:string,binding:LocalBinding,entries:readonly NoteLinkEntry[],kind:Reference['kind']='markdown'){
  const options={decode:kind!=='wiki'},resolved=resolveLocalTarget(target,from,binding,options);if(resolved.status!=='local')return {status:resolved.status,entityId:null};
  const visible=entries.filter(entry=>insideRoot(entry.path,binding.root));
  const exact=(path:string)=>visible.filter(entry=>pathKey(entry.path)===pathKey(/\.md$/i.test(path)?path:path+'.md'));
  let matches=exact(resolved.path);
  if(!matches.length){const rootTarget=resolveLocalTarget(target,binding.root+'/_root.md',binding,options);if(rootTarget.status==='local')matches=exact(rootTarget.path);}
  if(!matches.length&&!target.split('#')[0].includes('/')){
    const alias=pathKey(decodeTarget(target.split('#')[0]).replace(/\.md$/i,''));
    matches=visible.filter(entry=>pathKey(entry.path.split('/').at(-1)!.replace(/\.md$/i,''))===alias||(entry.aliases??[]).some(value=>pathKey(value)===alias));
  }
  return matches.length===1?{status:'resolved' as const,entityId:matches[0].entityId,path:matches[0].path}:{status:matches.length?'ambiguous' as const:'missing' as const,entityId:null};
}
