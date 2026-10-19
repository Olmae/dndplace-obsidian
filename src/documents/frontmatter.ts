import {parseDocument,isMap,isScalar,isAlias} from 'yaml';
import type {Pair} from 'yaml';

export type PortableIdentity={version:1;instanceId:string;accountId:string;campaignId:string;bindingId:string;entityId:string;generatedFrontmatter?:true};
export class DocumentError extends Error{constructor(public code:string,message:string){super(message);this.name='DocumentError';}}
const keys=['version','instanceId','accountId','campaignId','bindingId','entityId','generatedFrontmatter'];
type ReservedRange={start:number;end:number;indent:string;valueStart:number;valueEnd:number;flow:boolean};
function checkedIdentity(value:unknown):PortableIdentity{
  const row=value as Record<string,unknown>;
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(key=>!keys.includes(key))||row.version!==1||['instanceId','accountId','campaignId','bindingId','entityId'].some(key=>typeof row[key]!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(row[key] as string))||row.generatedFrontmatter!==undefined&&row.generatedFrontmatter!==true)throw new DocumentError('identity_collision','Служебная отметка DNDPlace требует проверки');
  return structuredClone(row) as PortableIdentity;
}
export function readFrontmatter(source:string){
  if(typeof source!=='string'||Buffer.byteLength(source)>1048576+4096||Buffer.from(source).toString()!==source)throw new DocumentError('note_size','Запись должна быть корректным UTF-8 размером до 1 МБ');
  const opening=source.match(/^\uFEFF?---(?:\r\n|\n)/),eol=source.includes('\r\n')?'\r\n':'\n';
  if(!opening)return {source,body:source.replace(/^\uFEFF/,''),yaml:'',opening:'',closing:'',eol,identity:null as PortableIdentity|null,title:null as string|null,reserved:null as ReservedRange|null,flow:false,flowInsert:0,flowItems:0};
  const offset=opening[0].length,remaining=source.slice(offset),close=/^(?:---|\.\.\.)(?:\r?\n|$)/m.exec(remaining);
  if(!close)throw new DocumentError('invalid_yaml','Не закрыт блок свойств записи');
  const yaml=remaining.slice(0,close.index),closing=close[0],body=remaining.slice(close.index+closing.length);
  if(Buffer.byteLength(yaml)>65536)throw new DocumentError('yaml_size','Блок свойств слишком большой');
  const document=parseDocument(yaml,{version:'1.2',schema:'core',uniqueKeys:true,merge:false,keepSourceTokens:true});
  if(document.errors.length||document.contents!==null&&!isMap(document.contents))throw new DocumentError('invalid_yaml','Проверьте свойства записи');
  const flow=!!document.contents?.flow,items=(document.contents?.items??[]) as Pair[];
  let identity:PortableIdentity|null=null,title:string|null=null,reserved:ReservedRange|null=null;
  for(const pair of (document.contents?.items??[]) as Pair[]){
    if(!isScalar(pair.key)||typeof pair.key.value!=='string')throw new DocumentError('invalid_yaml','Ключи свойств должны быть обычными названиями');
    if(pair.key.value==='title'){
      if(isScalar(pair.value)&&typeof pair.value.value==='string'&&pair.value.value.trim()&&pair.value.value.length<=500)title=pair.value.value.trim();
      else throw new DocumentError('invalid_title','Название в свойствах должно быть строкой до 500 символов');
    }
    if(pair.key.value!=='dndplace')continue;
    if(!isMap(pair.value)||isAlias(pair.value))throw new DocumentError('identity_collision','Свойство dndplace уже занято');
    const values:Record<string,unknown>=Object.create(null);
    for(const item of pair.value.items){
      if(!isScalar(item.key)||typeof item.key.value!=='string'||!keys.includes(item.key.value)||!isScalar(item.value))throw new DocumentError('identity_collision','Служебная отметка требует проверки');
      values[item.key.value]=item.value.value;
    }
    identity=checkedIdentity(values);
    const keyStart=pair.key.range?.[0],valueEnd=pair.value.range?.[2];
    if(keyStart===undefined||valueEnd===undefined)throw new DocumentError('identity_collision','Не удалось определить границы отметки');
    const lineStart=yaml.lastIndexOf('\n',keyStart-1)+1;
    if(flow){
      const position=items.indexOf(pair),next=items[position+1],previous=items[position-1];
      let start=keyStart,end=pair.value.range![1];
      if(next&&isScalar(next.key))end=next.key.range![0];
      else if(previous&&previous.value&&typeof previous.value==='object'&&'range' in previous.value)start=(previous.value.range as [number,number,number])[1];
      reserved={start,end,indent:'',valueStart:pair.value.range![0],valueEnd:pair.value.range![1],flow:true};
    }else reserved={start:lineStart,end:valueEnd,indent:yaml.slice(lineStart,keyStart),valueStart:pair.value.range![0],valueEnd:pair.value.range![1],flow:false};
  }
  const first=items[0]?.key;
  return {source,body,yaml,opening:opening[0],closing,eol,identity,title,reserved,flow,flowInsert:flow?(first&&isScalar(first)?first.range![0]:document.contents!.range![1]-1):0,flowItems:items.length};
}
export function attachIdentity(source:string,value:PortableIdentity,{allowRebind=false}={}):string{
  const input=checkedIdentity(value),parsed=readFrontmatter(source);
  if(parsed.identity&&!allowRebind&&['instanceId','accountId','campaignId','bindingId','entityId'].some(key=>parsed.identity![key as keyof PortableIdentity]!==input[key as keyof PortableIdentity]))throw new DocumentError('identity_rebind_required','Смена привязки требует подтверждения');
  if(parsed.identity?.generatedFrontmatter)input.generatedFrontmatter=true;
  if(!parsed.opening){
    input.generatedFrontmatter=true;const bom=source.startsWith('\uFEFF')?'\uFEFF':'';
    return bom+'---'+parsed.eol+'dndplace: '+JSON.stringify(input)+parsed.eol+'---'+parsed.eol+source.slice(bom.length);
  }
  if(parsed.flow){
    const yaml=parsed.reserved?parsed.yaml.slice(0,parsed.reserved.valueStart)+JSON.stringify(input)+parsed.yaml.slice(parsed.reserved.valueEnd):parsed.yaml.slice(0,parsed.flowInsert)+'dndplace: '+JSON.stringify(input)+(parsed.flowItems?', ':'')+parsed.yaml.slice(parsed.flowInsert);
    return parsed.opening+yaml+parsed.closing+parsed.body;
  }
  const row=(parsed.reserved?.indent??'')+'dndplace: '+JSON.stringify(input)+parsed.eol;
  const yaml=parsed.reserved?parsed.yaml.slice(0,parsed.reserved.start)+row+parsed.yaml.slice(parsed.reserved.end):parsed.yaml+row;
  return parsed.opening+yaml+parsed.closing+parsed.body;
}
export function stripIdentity(source:string):string{
  const parsed=readFrontmatter(source);if(!parsed.reserved)return source;
  const yaml=parsed.yaml.slice(0,parsed.reserved.start)+parsed.yaml.slice(parsed.reserved.end);
  if(parsed.identity?.generatedFrontmatter&&!yaml.trim())return (source.startsWith('\uFEFF')?'\uFEFF':'')+parsed.body;
  return parsed.opening+yaml+parsed.closing+parsed.body;
}
