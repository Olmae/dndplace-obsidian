import {App,Modal,Notice,Plugin,PluginSettingTab,Setting,addIcon} from 'obsidian';
import {DNDPLACE_ICON_ID,DNDPLACE_ICON} from './ui/icon.js';
import {createSecretStore,installationId} from './connection/secrets.js';
import type {SecretStore} from './connection/secrets.js';
import {readSettings} from './connection/settings.js';
import type {Settings} from './connection/settings.js';
import type {Connection} from './connection/settings.js';
import {createSettingsWriter} from './connection/settings-writer.js';
import {changeBindingPause,changeBindingAutomatic} from './connection/binding-settings.js';
import {createSyncScheduler} from './sync/scheduler.js';
import {automaticBinding,automaticEventBinding} from './sync/event-guard.js';
import type {EventRef} from 'obsidian';
import type {PanelService} from './ui/controller.js';
import {registerGameBlocks} from './game-blocks/commands.js';
import {connectAndStore} from './connection/onboarding.js';
import {join} from 'node:path';
import type {LocalBinding} from './bindings/registry.js';
import {createNativePanelService} from './host/panel-service.js';
import {SyncPanelView,SYNC_VIEW_TYPE} from './ui/view.js';

export default class DndplaceSyncPlugin extends Plugin {
  private writer:ReturnType<typeof createSettingsWriter>|null=null;
  private deviceId='';
  private scheduler:ReturnType<typeof createSyncScheduler>|null=null;
  private automaticService:PanelService|null=null;
  private automaticEvents:EventRef[]=[];
  private automaticNotices=new Set<string>();
  get settings():Settings{return this.writer?.get()??{version:1,connections:[]};}
  secrets:SecretStore|null=null;
  initializationError='';
  async onload(){
    addIcon(DNDPLACE_ICON_ID,DNDPLACE_ICON);
    registerGameBlocks(this);
    try{this.writer=createSettingsWriter(readSettings(await this.loadData()),value=>this.saveData(value));this.secrets=createSecretStore(this.app.secretStorage);this.deviceId=installationId(this.secrets);}
    catch{this.initializationError='Не удалось открыть настройки или защищённое хранилище ключей';this.secrets=null;}
    this.addSettingTab(new DndplaceSettingsTab(this.app,this));
    this.registerView(SYNC_VIEW_TYPE,leaf=>new SyncPanelView(leaf,()=>this.panelService(),saved=>new ConnectionModal(this.app,this,saved).open()));
    this.addCommand({id:'connect',name:'Подключение к DNDPlace',icon:DNDPLACE_ICON_ID,callback:()=>new ConnectionModal(this.app,this).open()});
    this.addCommand({id:'open-panel',name:'Архив кампании',icon:DNDPLACE_ICON_ID,callback:()=>this.openPanel()});
    this.addRibbonIcon(DNDPLACE_ICON_ID,'DNDPlace',()=>this.openPanel());
    this.configureAutomatic();
  }
  async openPanel(){
    if(!this.secrets||this.initializationError){new Notice(this.initializationError||'Защищённое хранилище недоступно');return;}
    const leaf=this.app.workspace.getLeavesOfType(SYNC_VIEW_TYPE)[0]??this.app.workspace.getRightLeaf(false);if(!leaf)return;
    await leaf.setViewState({type:SYNC_VIEW_TYPE,active:true});await this.app.workspace.revealLeaf(leaf);
  }
  private panelService(){
    if(!this.secrets)throw new Error('Защищённое хранилище недоступно');const adapter=this.app.vault.adapter as unknown as {getBasePath?:()=>string};if(!adapter.getBasePath)throw new Error('Нужен Obsidian Desktop');
    return createNativePanelService({app:this.app,settings:()=>this.settings,saveBinding:binding=>this.saveBinding(binding),secrets:this.secrets,deviceId:this.deviceId,storageRoot:join(adapter.getBasePath(),this.app.vault.configDir,'plugins',this.manifest.id,'sync-state-v1')});
  }
  private configureAutomatic(){
    const bindings=this.settings.bindings??[],enabled=bindings.some(binding=>automaticBinding(binding,this.deviceId));
    if(!enabled){this.stopAutomatic();return;}
    if(!this.scheduler){
      this.automaticService=this.panelService();
      this.scheduler=createSyncScheduler({run:(id,signal)=>this.automaticService!.automatic!.cycle(id,signal),changed:()=>{
        for(const binding of this.settings.bindings??[])if(this.scheduler?.status(binding.id)==='attention'&&!this.automaticNotices.has(binding.id)){this.automaticNotices.add(binding.id);new Notice('DNDPlace · '+binding.root+': автообмен остановлен. Откройте архив и проверьте незавершённые операции или конфликт.');}
      }});
      const changed=(path:string)=>{const binding=automaticEventBinding(path,this.settings.bindings??[],this.deviceId);if(binding)this.scheduler?.localChanged(binding.id);};
      this.automaticEvents=[this.app.vault.on('modify',file=>changed(file.path)),this.app.vault.on('create',file=>changed(file.path)),this.app.vault.on('delete',file=>changed(file.path)),this.app.vault.on('rename',(file,oldPath)=>{changed(oldPath);changed(file.path);})];
    }
    this.scheduler.configure(bindings.map(binding=>({id:binding.id,campaign:JSON.stringify([binding.identity.connectionId,binding.identity.campaignId]),enabled:automaticBinding(binding,this.deviceId),version:JSON.stringify(binding)})));
  }
  private stopAutomatic(){this.scheduler?.dispose();this.scheduler=null;this.automaticService?.dispose();this.automaticService=null;for(const event of this.automaticEvents)this.app.vault.offref(event);this.automaticEvents=[];this.automaticNotices.clear();}
  async setAutomatic(binding:LocalBinding,enabled:boolean){
    if(!this.writer)throw new Error('Настройки недоступны');
    if(enabled){const service=this.panelService();try{if(!await service.automatic!.eligible(binding.id,new AbortController().signal))throw new Error('Сначала завершите ручной обмен хотя бы одной записи, без конфликтов и незавершённых операций.');}finally{service.dispose();}}
    await this.writer.update(current=>changeBindingAutomatic(current,binding,this.deviceId,enabled));this.automaticNotices.delete(binding.id);this.refreshPanels();this.configureAutomatic();
  }
  automaticEnabled(binding:LocalBinding){return binding.automatic?.deviceId===this.deviceId;}
  onunload(){this.stopAutomatic();this.app.workspace?.detachLeavesOfType(SYNC_VIEW_TYPE);}
  async saveBinding(binding:LocalBinding){if(!this.writer)throw new Error('Настройки недоступны');await this.writer.update(current=>({...current,bindings:[...(current.bindings??[]),binding]}));}
  async setBindingPaused(binding:LocalBinding,paused:boolean){if(!this.writer)throw new Error('Настройки недоступны');await this.writer.update(current=>changeBindingPause(current,binding,paused));this.refreshPanels();this.configureAutomatic();}
  private refreshPanels(){for(const leaf of this.app.workspace?.getLeavesOfType(SYNC_VIEW_TYPE)??[])if(leaf.view instanceof SyncPanelView)leaf.view.refresh();}
  async addConnection(value:Connection){if(!this.writer)throw new Error('Настройки недоступны');await this.writer.update(current=>({...current,connections:[...current.connections,value]}));this.refreshPanels();}
  async removeConnection(id:string){if(!this.writer)throw new Error('Настройки недоступны');const removed=this.settings.connections.find(connection=>connection.id===id);await this.writer.update(current=>({...current,connections:current.connections.filter(row=>row.id!==id),...(current.bindings?{bindings:current.bindings.filter(binding=>binding.identity.connectionId!==id)}:{})}));if(removed)this.secrets?.clear(removed.secretName);this.refreshPanels();this.configureAutomatic();}
}

class ConnectionModal extends Modal {
  private abort=new AbortController();
  private secret='';
  constructor(app:App,private plugin:DndplaceSyncPlugin,private onSaved?:()=>void){super(app);}
  onOpen(){
    const {contentEl}=this;contentEl.addClass('dndplace-sync-connect');contentEl.createEl('h2',{text:'Подключение к DNDPlace'});
    if(!this.plugin.secrets){contentEl.createEl('p',{text:this.plugin.initializationError||'Защищённое хранилище ключей недоступно'});return;}
    let name='',baseUrl='';
    new Setting(contentEl).setName('Название').addText(input=>input.setPlaceholder('Например, основной сайт').onChange(value=>{name=value;}));
    new Setting(contentEl).setName('Адрес сайта').addText(input=>{input.setPlaceholder('https://…').onChange(value=>{baseUrl=value;});input.inputEl.type='url';input.inputEl.spellcheck=false;});
    new Setting(contentEl).setName('Ключ подключения').addText(input=>{input.inputEl.type='password';input.inputEl.autocomplete='off';input.inputEl.spellcheck=false;input.onChange(value=>{this.secret=value;});});
    const status=contentEl.createEl('p',{cls:'dndplace-sync-status',attr:{role:'status'}});
    new Setting(contentEl).addButton(button=>button.setButtonText('Проверить и сохранить').setCta().onClick(async()=>{
      if(!this.plugin.secrets)return;button.setDisabled(true);status.setText('Проверяем подключение…');
      if(!name.trim()){status.setText('Укажите название подключения');button.setDisabled(false);return;}
      try{
        const result=await connectAndStore({name,baseUrl,secret:this.secret,signal:this.abort.signal},{settings:this.plugin.settings,store:this.plugin.secrets,saveSettings:value=>this.plugin.addConnection(value.connections.at(-1)!)});
        new Notice(result.readiness.read?'Подключение сохранено':'Подключение сохранено. Архив на сайте ещё не готов');
        this.secret='';this.onSaved?.();this.close();
      }catch(error){if(!this.abort.signal.aborted)status.setText(error instanceof Error&&error.name==='TransportError'?error.message:'Не удалось сохранить подключение. Проверьте адрес и ключ');}
      finally{if(!this.abort.signal.aborted)button.setDisabled(false);}
    }));
    new Setting(contentEl).addButton(button=>button.setButtonText('Отмена').onClick(()=>this.close()));
  }
  onClose(){this.abort.abort();this.secret='';this.contentEl.querySelectorAll('input').forEach(input=>{input.value='';});this.contentEl.empty();}
}

class DndplaceSettingsTab extends PluginSettingTab {
  constructor(app:App,private plugin:DndplaceSyncPlugin){super(app,plugin);}
  display(){
    const {containerEl}=this;containerEl.empty();containerEl.addClass('dndplace-sync-settings');containerEl.createEl('h2',{text:'DNDPlace'});
    if(this.plugin.initializationError){containerEl.createEl('p',{text:this.plugin.initializationError});return;}
    new Setting(containerEl).setName('Архив кампании').addButton(button=>button.setButtonText('Открыть панель').setCta().onClick(()=>this.plugin.openPanel()));
    new Setting(containerEl).setName('Новое подключение').addButton(button=>button.setButtonText('Подключить сайт').setCta().onClick(()=>new ConnectionModal(this.app,this.plugin,()=>this.display()).open()));
    for(const connection of this.plugin.settings.connections){
      new Setting(containerEl).setName(connection.name).setDesc([connection.baseUrl,connection.verified?.accountName].filter(Boolean).join(' · ')).addButton(button=>button.setButtonText('Убрать с устройства').onClick(async()=>{
        button.setDisabled(true);
        try{await this.plugin.removeConnection(connection.id);this.display();}
        catch{new Notice('Не удалось удалить подключение');button.setDisabled(false);}
      }));
    }
    const bindings=this.plugin.settings.bindings??[];
    if(bindings.length){
      containerEl.createEl('h3',{text:'Папки кампаний'});
      containerEl.createEl('p',{text:'Пауза останавливает обмен. Заметки, резервные копии и незавершённые отправки сохраняются. После возобновления продолжите отправку вручную.'});
      for(const binding of bindings){
        const connection=this.plugin.settings.connections.find(row=>row.id===binding.identity.connectionId);
        new Setting(containerEl).setName(binding.root).setDesc([connection?.name,'Кампания: '+binding.identity.campaignId,binding.paused?'На паузе':'Доступна для обмена'].filter(Boolean).join(' · ')).addButton(button=>button.setButtonText(binding.paused?'Возобновить':'Поставить на паузу').onClick(async()=>{
          button.setDisabled(true);
          try{await this.plugin.setBindingPaused(binding,!binding.paused);this.display();}
          catch{new Notice('Не удалось изменить привязку. Откройте настройки заново и повторите.');button.setDisabled(false);}
        })).addButton(button=>button.setButtonText(this.plugin.automaticEnabled(binding)?'Выключить автообмен':'Включить автообмен').setDisabled(!!binding.paused).onClick(async()=>{
          button.setDisabled(true);
          try{await this.plugin.setAutomatic(binding,!this.plugin.automaticEnabled(binding));this.display();}
          catch(error){new Notice(error instanceof Error?error.message:'Не удалось изменить автообмен');button.setDisabled(false);}
        }));
      }
    }
  }
}
