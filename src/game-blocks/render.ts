import {checkLabel,parseCheck,trialRoll} from './checks.js';
export function renderCheckBlock(source:string,host:HTMLElement){
  const doc=host.ownerDocument,section=doc.createElement('section');section.className='dndplace-check';
  try{const check=parseCheck(source),heading=doc.createElement('strong'),detail=doc.createElement('p'),button=doc.createElement('button'),result=doc.createElement('p');
    heading.textContent=checkLabel(check)+' · СЛ '+check.dc;detail.textContent='1d20 · '+({normal:'Обычный бросок',advantage:'С преимуществом',disadvantage:'С помехой'}[check.mode])+' · '+(check.visibility==='private'?'Приватная проверка':'Публичная проверка');
    button.type='button';button.textContent='Пробный бросок · только здесь';result.setAttribute('role','status');button.addEventListener('click',()=>{const rolled=trialRoll(check);result.textContent='Локально: '+rolled.dice.join(', ')+' → '+rolled.die+'. Без бонусов персонажа; в кампанию не отправлено.';});section.append(heading,detail,button,result);
  }catch{const warning=doc.createElement('p'),pre=doc.createElement('pre');warning.textContent='Проверка не распознана. Исходный текст сохранён.';pre.textContent=source;section.append(warning,pre);}host.append(section);return section;
}
