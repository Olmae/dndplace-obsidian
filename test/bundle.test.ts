import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vm from 'node:vm';
import {newConnection} from '../src/connection/settings.js';

test('CommonJS host bundle loads and initializes without vault access, startup network or plaintext settings writes',async()=>{
  const metadata=JSON.parse(readFileSync('package.json','utf8'));
  assert.notEqual(metadata.type,'module','Copying/symlinking the checkout must not turn main.js into ESM');
  const require=createRequire(resolve('package.json')),{build}=require('esbuild');
  const result=await build({entryPoints:['src/main.ts'],bundle:true,platform:'node',format:'cjs',target:'es2022',external:['obsidian'],write:false,logLevel:'silent'});
  const secretValues=new Map<string,string>(),commands:unknown[]=[],tabs:unknown[]=[],saved:unknown[]=[],ribbons:Array<{name:string;label:string}>=[],icons=new Map<string,string>(),views:string[]=[];
  let failSave=false;const viewFactories=new Map<string,(leaf:unknown)=>any>();
  class NativeView{contentEl={textContent:'',setAttribute:()=>{}};}
  const settingRows:Array<{name:string;description:string;button:any}>=[],notices:string[]=[];
  class HostSetting{
    row={name:'',description:'',button:null as any};
    constructor(_host:unknown){settingRows.push(this.row);}
    setName(value:string){this.row.name=value;return this;}
    setDesc(value:string){this.row.description=value;return this;}
    addButton(attach:(button:any)=>void){const button={label:'',disabled:false,click:null as any,setButtonText(value:string){this.label=value;return this;},setCta(){return this;},setDisabled(value:boolean){this.disabled=value;return this;},onClick(handler:()=>unknown){this.click=handler;return this;}};this.row.button??=button;attach(button);return this;}
  }
  class SettingsTab{containerEl={empty:()=>{settingRows.length=0;},addClass:()=>{},createEl:()=>({})};}
  class HostPlugin{
    app={secretStorage:{getSecret:(key:string)=>secretValues.get(key)??null,setSecret:(key:string,value:string)=>secretValues.set(key,value)},vault:new Proxy({},{get(){throw new Error('Vault access is forbidden during onboarding');}})};
    async loadData(){return null;}
    async saveData(value:unknown){if(failSave)throw Error('disk failure');saved.push(value);}
    addSettingTab(tab:unknown){tabs.push(tab);}
    registerView(type:string,factory:(leaf:unknown)=>any){views.push(type);viewFactories.set(type,factory);}
    addCommand(command:unknown){commands.push(command);}
    registerMarkdownCodeBlockProcessor(){return null;}
    addRibbonIcon(name:string,label:string){ribbons.push({name,label});}
  }
  const module={exports:{} as any};
  vm.runInNewContext(result.outputFiles[0].text,{module,exports:module.exports,require:(name:string)=>name==='obsidian'?{Plugin:HostPlugin,ItemView:NativeView,Modal:class{},PluginSettingTab:SettingsTab,Setting:HostSetting,Notice:class{constructor(value:string){notices.push(value);}},addIcon:(name:string,svg:string)=>icons.set(name,svg)}:require(name),structuredClone,Buffer,TextDecoder,URL,AbortController,setTimeout,clearTimeout});
  const plugin=new module.exports.default();await plugin.onload();
  assert.equal(commands.length,3);assert.deepEqual(views,['dndplace-sync-panel']);assert.equal(ribbons[0].name,'dndplace-d20');assert.equal((commands[1] as any).icon,'dndplace-d20');assert.ok(icons.has('dndplace-d20'));assert.match(icons.get('dndplace-d20')!,/M32 3 54 14/);assert.ok(!/script|foreignObject|<image|https?:|#[a-f0-9]{6}/i.test(icons.get('dndplace-d20')!));assert.equal(tabs.length,1);assert.equal(saved.length,0);assert.equal(secretValues.size,1);assert.equal(plugin.settings.connections.length,0);
  const manifest=JSON.parse(readFileSync('manifest.json','utf8'));assert.equal(manifest.id,'dndplace-sync');assert.equal(manifest.isDesktopOnly,true);assert.equal(manifest.minAppVersion,'1.11.4');
  const connection={...newConnection({name:'Fixture',baseUrl:'https://example.test'}),verified:{accountId:'dm',instanceId:'site',accountName:'DM'}};
  await plugin.addConnection(connection);secretValues.set(connection.secretName,'fixture-secret');
  await plugin.saveBinding({id:'local',root:'Game',identity:{connectionId:connection.id,accountId:'dm',instanceId:'site',campaignId:'camp',bindingId:'remote'}});
  const original=plugin.settings.bindings[0];
  failSave=true;await assert.rejects(plugin.setBindingPaused(original,true));assert.equal(plugin.settings.bindings[0].paused,undefined);
  failSave=false;await plugin.setBindingPaused(original,true);assert.equal(plugin.settings.bindings[0].paused,true);
  assert.equal(secretValues.get(connection.secretName),'fixture-secret');
  await assert.rejects(plugin.setBindingPaused(original,false));
  await plugin.setBindingPaused(plugin.settings.bindings[0],false);assert.equal(plugin.settings.bindings[0].paused,false);
  const tab=tabs[0] as any;tab.display();let row=settingRows.find(row=>row.name==='Game')!;
  assert.match(row.description,/Доступна для обмена/);assert.equal(row.button.label,'Поставить на паузу');
  failSave=true;await row.button.click();assert.equal(plugin.settings.bindings[0].paused,false);assert.equal(row.button.disabled,false);assert.equal(notices.length,1);
  failSave=false;await row.button.click();assert.equal(plugin.settings.bindings[0].paused,true);
  row=settingRows.find(row=>row.name==='Game')!;assert.match(row.description,/На паузе/);assert.equal(row.button.label,'Возобновить');
  await row.button.click();assert.equal(plugin.settings.bindings[0].paused,false);assert.equal(secretValues.get(connection.secretName),'fixture-secret');
  failSave=true;await assert.rejects(plugin.removeConnection(connection.id));
  assert.equal(secretValues.get(connection.secretName),'fixture-secret');assert.equal(plugin.settings.connections.length,1);assert.equal(plugin.settings.bindings.length,1);
  failSave=false;await plugin.removeConnection(connection.id);
  assert.equal(plugin.settings.connections.length,0);assert.equal(plugin.settings.bindings.length,0);assert.ok(!secretValues.get(connection.secretName));
  plugin.panelService=()=>{throw Error('private host path or secret');};
  const view=viewFactories.get('dndplace-sync-panel')!({});await view.onOpen();
  assert.match(view.contentEl.textContent,/Не удалось открыть архив/);assert.ok(!view.contentEl.textContent.includes('secret'));await view.onClose();
});
