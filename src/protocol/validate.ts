import schema from '../../contracts/v1/protocol.schema.json';

type Rule={type?:string;const?:unknown;enum?:unknown[];anyOf?:Rule[];$ref?:string;minimum?:number;maximum?:number;minLength?:number;maxLength?:number;pattern?:string;maxItems?:number;items?:Rule;properties?:Record<string,Rule>;required?:string[]};
const definitions=schema.$defs as unknown as Record<string,Rule>;
function check(rule:Rule,value:unknown):boolean{
  if(rule.$ref)return check(definitions[rule.$ref.split('/').at(-1)!],value);
  if(rule.anyOf)return rule.anyOf.some(item=>check(item,value));
  if(Object.hasOwn(rule,'const'))return value===rule.const;
  if(rule.enum)return rule.enum.includes(value);
  if(rule.type==='null')return value===null;
  if(rule.type==='boolean')return typeof value==='boolean';
  if(rule.type==='integer')return typeof value==='number'&&Number.isSafeInteger(value)&&value>=(rule.minimum??0)&&value<=(rule.maximum??Number.MAX_SAFE_INTEGER);
  if(rule.type==='string')return typeof value==='string'&&value.length>=(rule.minLength??0)&&value.length<=(rule.maxLength??Infinity)&&(!rule.pattern||new RegExp(rule.pattern).test(value));
  if(rule.type==='array')return Array.isArray(value)&&value.length<=(rule.maxItems??Infinity)&&value.every(item=>check(rule.items!,item));
  if(rule.type==='object')return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>Object.hasOwn(rule.properties!,key))&&(rule.required??[]).every(key=>Object.hasOwn(value,key))&&Object.entries(value).every(([key,item])=>check(rule.properties![key],item));
  return false;
}
function invalid():never{throw new Error('Несовместимый формат ответа DNDPlace');}
export function validateDTO(kind:string,value:unknown):unknown{
  let bytes:number;try{bytes=Buffer.byteLength(JSON.stringify(value));}catch{return invalid();}
  if(!Object.hasOwn(definitions,kind)||bytes>16777216||!check(definitions[kind],value))return invalid();
  const data=value as Record<string,any>;
  if(kind==='document'){if(Buffer.byteLength(data.markdown)>1048576)return invalid();for(const asset of data.assets)validateDTO('asset',asset);}
  if(kind==='historyPage'||kind==='historyDetail'){
    for(const row of kind==='historyPage'?data.rows:[data.change])if(!Number.isFinite(Date.parse(row.createdAt))||new Date(row.createdAt).toISOString()!==row.createdAt)return invalid();
    if(kind==='historyDetail'&&data.document)validateDTO('document',data.document);
  }
  if(kind==='asset'&&data.relativePath!==`_assets/dndplace/${data.sha256}.${({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'} as Record<string,string>)[data.mime]}`)return invalid();
  if(kind==='connection'&&data.readiness.write&&!data.readiness.read)return invalid();
  if(kind==='transfer'&&((data.planId===null)!==(data.planHash===null)||data.state==='applied'&&(!data.receipt||data.operationId!==data.receipt.operationId)||!Number.isFinite(Date.parse(data.expiresAt))||new Date(data.expiresAt).toISOString()!==data.expiresAt))return invalid();
  return value;
}
