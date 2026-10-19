import {parseDocument} from 'yaml';
export const ABILITIES:Record<string,string>={str:'Сила',dex:'Ловкость',con:'Телосложение',int:'Интеллект',wis:'Мудрость',cha:'Харизма'};
export const SKILLS:Record<string,string>={acrobatics:'Акробатика',investigation:'Анализ',athletics:'Атлетика',perception:'Внимательность',survival:'Выживание',performance:'Выступление',intimidation:'Запугивание',history:'История',sleight_of_hand:'Ловкость рук',arcana:'Магия',medicine:'Медицина',deception:'Обман',nature:'Природа',insight:'Проницательность',religion:'Религия',stealth:'Скрытность',persuasion:'Убеждение',animal_handling:'Уход за животными'};
export type Check={version:1;kind:'skill'|'ability'|'save';skill?:string;ability?:string;dc:number;formula:'1d20';mode:'normal'|'advantage'|'disadvantage';visibility:'private'|'public'};
const need=(condition:unknown,message='Некорректная проверка'):void=>{if(!condition)throw new Error(message);};
export function validateCheck(value:unknown):Check{
  need(value&&typeof value==='object'&&!Array.isArray(value));const raw=value as Record<string,unknown>;
  need(Object.keys(raw).every(key=>['version','kind','skill','ability','dc','formula','visibility','mode'].includes(key)));
  need(raw.version===1&&['skill','ability','save'].includes(String(raw.kind)));need(Number.isSafeInteger(raw.dc)&&Number(raw.dc)>=1&&Number(raw.dc)<=40,'Сложность должна быть от 1 до 40');
  need(raw.formula===undefined||raw.formula==='1d20');const mode=raw.mode??'normal',visibility=raw.visibility??'private';
  need(['normal','advantage','disadvantage'].includes(String(mode))&&['private','public'].includes(String(visibility)));
  if(raw.kind==='skill')need(typeof raw.skill==='string'&&Object.hasOwn(SKILLS,raw.skill)&&raw.ability===undefined);else need(typeof raw.ability==='string'&&Object.hasOwn(ABILITIES,raw.ability)&&raw.skill===undefined);
  return {version:1,kind:raw.kind,...(raw.kind==='skill'?{skill:raw.skill}:{ability:raw.ability}),dc:raw.dc,formula:'1d20',mode,visibility} as Check;
}
export function parseCheck(source:string):Check{
  need(typeof source==='string'&&Buffer.byteLength(source)<=4096,'Проверка слишком велика');const doc=parseDocument(source,{version:'1.2',schema:'core',uniqueKeys:true,merge:false});need(!doc.errors.length&&!doc.warnings.length);return validateCheck(doc.toJS({maxAliasCount:0}));
}
export const checkLabel=(check:Check)=>check.kind==='skill'?SKILLS[check.skill!]:`${check.kind==='save'?'Спасбросок · ':''}${ABILITIES[check.ability!]}`;
export const checkSource=(check:Check)=>'```dndplace-check\n'+JSON.stringify(validateCheck(check),null,2)+'\n```\n';
export function trialRoll(check:Check,random=Math.random){check=validateCheck(check);const dice=Array.from({length:check.mode==='normal'?1:2},()=>{const value=random();need(Number.isFinite(value)&&value>=0&&value<1);return Math.floor(value*20)+1;});return {local:true as const,dice,die:check.mode==='advantage'?Math.max(...dice):Math.min(...dice)};}
