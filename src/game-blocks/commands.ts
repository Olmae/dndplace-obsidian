import {Modal,Setting} from 'obsidian';
import type {App,Editor,Plugin} from 'obsidian';
import {ABILITIES,SKILLS,checkSource,validateCheck} from './checks.js';
import {renderCheckBlock} from './render.js';
class CheckModal extends Modal{
  constructor(app:App,private editor:Editor){super(app);}
  onOpen(){
    let kind='skill',key='perception',dc='15',mode='normal',visibility='private';const host=this.contentEl;host.createEl('h2',{text:'Добавить проверку'});
    new Setting(host).setName('Навык или характеристика').addDropdown(input=>{for(const [id,label]of Object.entries(SKILLS))input.addOption('skill:'+id,label);for(const [id,label]of Object.entries(ABILITIES)){input.addOption('ability:'+id,label);input.addOption('save:'+id,'Спасбросок · '+label);}input.setValue('skill:perception').onChange(value=>{[kind,key]=value.split(':');});});
    new Setting(host).setName('Сложность · 1–40').addText(input=>{input.inputEl.type='number';input.inputEl.min='1';input.inputEl.max='40';input.setValue(dc).onChange(value=>{dc=value;});});
    new Setting(host).setName('Режим').addDropdown(input=>input.addOptions({normal:'Обычный',advantage:'Преимущество',disadvantage:'Помеха'}).onChange(value=>{mode=value;}));
    new Setting(host).setName('Видимость на сайте').addDropdown(input=>input.addOptions({private:'Приватная',public:'Публичная'}).onChange(value=>{visibility=value;}));
    const issue=host.createEl('p',{attr:{role:'alert'}});
    new Setting(host).addButton(button=>button.setButtonText('Вставить проверку').setCta().onClick(()=>{try{const source=checkSource(validateCheck({version:1,kind,...(kind==='skill'?{skill:key}:{ability:key}),dc:Number(dc),mode,visibility})),range=this.editor.listSelections()[0];if(!range)throw Error('Редактор недоступен');const [from,to]=[range.anchor,range.head].sort((a,b)=>a.line-b.line||a.ch-b.ch);this.editor.transaction({changes:[{from,to,text:'\n'+source+'\n'}]},'dndplace-check');this.close();}catch(error){issue.setText(error instanceof Error?error.message:'Проверьте параметры');}}));
  }
  onClose(){this.contentEl.empty();}
}
export function registerGameBlocks(plugin:Plugin){plugin.registerMarkdownCodeBlockProcessor('dndplace-check',(source,host)=>{renderCheckBlock(source,host);});plugin.addCommand({id:'insert-check',name:'Добавить проверку',editorCallback:editor=>new CheckModal(plugin.app,editor).open()});}
