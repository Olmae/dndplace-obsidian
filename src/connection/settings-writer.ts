import {readSettings} from './settings.js';
import type {Settings} from './settings.js';

export function createSettingsWriter(initial:Settings,save:(settings:Settings)=>Promise<void>){
  let current=readSettings(initial),tail=Promise.resolve();
  return {
    get:()=>structuredClone(current),
    update(change:(current:Settings)=>Settings):Promise<Settings>{
      const result=tail.then(async()=>{const next=readSettings(change(structuredClone(current)));await save(next);current=next;return structuredClone(current);});
      tail=result.then(()=>undefined,()=>undefined);return result;
    },
  };
}
