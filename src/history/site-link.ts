import {validateBaseUrl} from '../connection/transport.js';

/** Existing cookie-authenticated site route; never includes an integration credential. */
export function archiveNoteUrl(baseUrl:string,campaignId:string,entityId:string):string{
  if(![campaignId,entityId].every(id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(id)))throw new Error('Некорректная ссылка на запись');
  const url=new URL(validateBaseUrl(baseUrl)+'/dm/'+campaignId+'/prep');
  url.searchParams.set('open','note:'+entityId);return url.href;
}
