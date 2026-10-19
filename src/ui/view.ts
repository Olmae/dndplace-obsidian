import {ItemView} from 'obsidian';
import type {WorkspaceLeaf} from 'obsidian';
import {createPanelController} from './controller.js';
import type {PanelService,PanelController} from './controller.js';
import {mountCampaignPanel} from './panel.js';
import {DNDPLACE_ICON_ID} from './icon.js';

export const SYNC_VIEW_TYPE='dndplace-sync-panel';
export class SyncPanelView extends ItemView{
  private closePanel:(()=>void)|null=null;
  private controller:PanelController|null=null;
  constructor(leaf:WorkspaceLeaf,private service:()=>PanelService,private connect:(saved:()=>void)=>void){super(leaf);}
  getViewType(){return SYNC_VIEW_TYPE;}
  getDisplayText(){return 'DNDPlace';}
  getIcon(){return DNDPLACE_ICON_ID;}
  refresh(){this.controller?.refresh();}
  async onOpen(){
    this.closePanel?.();this.closePanel=null;
    try{this.controller=createPanelController(this.service());this.closePanel=mountCampaignPanel(this.contentEl,this.controller,()=>this.connect(()=>this.refresh()));}
    catch{this.controller?.dispose();this.controller=null;this.contentEl.textContent='Не удалось открыть архив. Закройте панель и откройте её снова.';this.contentEl.setAttribute('role','alert');}
  }
  async onClose(){this.closePanel?.();this.closePanel=null;this.controller=null;}
}
