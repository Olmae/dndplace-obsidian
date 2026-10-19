import {bindingForFile} from '../bindings/registry.js';
import type {LocalBinding} from '../bindings/registry.js';
export const automaticBinding=(binding:LocalBinding,deviceId:string)=>!binding.paused&&binding.automatic?.deviceId===deviceId;
export function automaticEventBinding(path:string,bindings:readonly LocalBinding[],deviceId:string):LocalBinding|null{
  try{const binding=bindingForFile(path,bindings);return binding&&automaticBinding(binding,deviceId)?binding:null;}catch{return null;}
}
