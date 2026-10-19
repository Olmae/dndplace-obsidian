import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';

export class TransportError extends Error {
  readonly code:string;
  readonly status?:number;
  readonly retryAfterMs?:number;
  constructor(code:string,message:string,status?:number,retryAfterMs?:number){super(message);this.name='TransportError';this.code=code;this.status=status;this.retryAfterMs=retryAfterMs;}
}
export type RequestOptions={method:string;headers:Record<string,string>;body?:Uint8Array;signal:AbortSignal;maxBytes:number};
export type WireResponse={status:number;headers:Record<string,string|undefined>;body:Uint8Array};
export type RequestImpl=(url:URL,options:RequestOptions)=>Promise<WireResponse>;
export type TransportOptions={method?:'GET'|'POST'|'PUT'|'DELETE';body?:unknown;signal?:AbortSignal;timeoutMs?:number;maxBytes?:number;expectedAccountId?:string;expectedInstanceId?:string;query?:Record<string,string|number|undefined>};
const fail=(code:string,message:string):never=>{throw new TransportError(code,message);};
export function validateBaseUrl(value:string):string{
  let url:URL;try{url=new URL(value);}catch{return fail('invalid_url','Укажите адрес сайта');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)return fail('invalid_url','Нужен адрес сайта без ключа и параметров');
  if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))return fail('insecure_url','Для удалённого сайта нужен HTTPS');
  return url.href.replace(/\/+$/,'');
}
function validSecret(value:unknown):value is string{
  if(typeof value!=='string'||!/^dpobs_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.test(value))return false;
  const [id,secret]=value.slice(6).split('.');return [id,secret].every(part=>Buffer.from(part,'base64url').toString('base64url')===part);
}

// Native Node transport: TLS verification stays enabled and redirects are not followed.
const nativeRequest:RequestImpl=(url,options)=>new Promise((resolve,reject)=>{
  const request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method:options.method,headers:options.headers,signal:options.signal},response=>{
    const status=response.statusCode??0,headers=Object.fromEntries(Object.entries(response.headers).map(([key,value])=>[key,Array.isArray(value)?value.join(', '):value]));
    if(status>=300&&status<400){response.destroy();resolve({status,headers,body:Buffer.alloc(0)});return;}
    const parts:Buffer[]=[];let size=0;
    response.on('data',(part:Buffer)=>{size+=part.length;if(size>options.maxBytes){response.destroy(new TransportError('response_size','Ответ сайта слишком велик'));return;}parts.push(part);});
    response.on('error',reject);response.on('end',()=>resolve({status,headers,body:Buffer.concat(parts)}));
  });
  request.on('error',reject);if(options.body)request.write(options.body);request.end();
});
export function createDesktopTransport({baseUrl,getSecret,requestImpl=nativeRequest}:{baseUrl:string;getSecret:()=>Promise<string|undefined>;requestImpl?:RequestImpl}){
  const root=new URL(validateBaseUrl(baseUrl)+'/api/integrations/obsidian/v1/');
  async function execute(path:string,options:TransportOptions={},binary=false,upload?:Uint8Array):Promise<Uint8Array>{
    if(upload!==undefined&&(!(upload instanceof Uint8Array)||upload.byteLength<1||upload.byteLength>33554432||options.body!==undefined||options.method!=='PUT'))return fail('request_size','Недопустимый ZIP-пакет');
    const capturedUpload=upload===undefined?undefined:Uint8Array.from(upload);
    if(options.signal?.aborted)return fail('cancelled','Запрос отменён');
    if(typeof path!=='string'||!path||path.startsWith('/')||/[\\?#]/.test(path)||/%(?:2e|2f|5c)/i.test(path)||path.split('/').some(part=>part==='.'||part==='..'))return fail('invalid_path','Недопустимый адрес запроса');
    const url=new URL(path,root);if(url.origin!==root.origin||!url.pathname.startsWith(root.pathname))return fail('invalid_path','Недопустимый адрес запроса');
    for(const [key,value] of Object.entries(options.query??{}))if(value!==undefined)url.searchParams.set(key,String(value));
    const maxBytes=options.maxBytes??(binary?10485760:16777216),timeoutMs=options.timeoutMs??15000;
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>(binary?10485760:16777216)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)return fail('invalid_limit','Недопустимый предел запроса');
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const onAbort=()=>controller.abort();options.signal?.addEventListener('abort',onAbort,{once:true});
    try{
      const deadline=new Promise<never>((_resolve,reject)=>{
        controller.signal.addEventListener('abort',()=>reject(new TransportError(options.signal?.aborted?'cancelled':'timeout',options.signal?.aborted?'Запрос отменён':'Сайт не ответил вовремя')),{once:true});
        timer=setTimeout(()=>controller.abort(),timeoutMs);
      });
      const response=await Promise.race([(async()=>{
        const secret=await getSecret();if(!validSecret(secret))return fail('missing_secret','Введите ключ подключения');
        if(controller.signal.aborted)return fail('cancelled','Запрос отменён');
        const headers:Record<string,string>={Authorization:`Bearer ${secret}`,Accept:binary?'image/png, image/jpeg, image/webp':'application/json','Accept-Encoding':'identity'};
        if(options.expectedAccountId)headers['X-Dndplace-Account']=options.expectedAccountId;
        if(options.expectedInstanceId)headers['X-Dndplace-Instance']=options.expectedInstanceId;
        let body:Uint8Array|undefined;
        if(capturedUpload!==undefined){body=capturedUpload;headers['Content-Type']='application/zip';headers['Content-Length']=String(body.byteLength);}
        else if(options.body!==undefined){body=Buffer.from(JSON.stringify(options.body));if(body.byteLength>33554432)return fail('request_size','Запрос слишком велик');headers['Content-Type']='application/json';headers['Content-Length']=String(body.byteLength);}
        return requestImpl(url,{method:options.method??'GET',headers,body,signal:controller.signal,maxBytes});
      })(),deadline]);
      if(response.status>=300&&response.status<400)return fail('redirect','Сайт перенаправляет запрос. Проверьте адрес');
      if(response.body.byteLength>maxBytes)return fail('response_size','Ответ сайта слишком велик');
      const declared=response.headers['content-length'];
      if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)!==response.body.byteLength))return fail('response_length','Ответ сайта получен не полностью');
      if(response.status<200||response.status>=300){
        let code=response.status===401?'integration_unauthenticated':response.status===403?'integration_forbidden':response.status===409?'archive_conflict':response.status===503?'archive_sync_not_ready':'server_error';
        const known=['integration_unauthenticated','integration_forbidden','archive_conflict','snapshot_changed','protocol_mismatch','archive_sync_not_ready','operation_reused','transfer_hash','binding_root_missing','actor_changed','instance_changed'];
        try{const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(response.body));if(typeof body?.code==='string'&&known.includes(body.code))code=body.code;}catch{/* Never display untrusted response text. */}
        const hint=response.headers['retry-after'];let retryAfterMs:number|undefined;
        if(hint&&hint.length<=100){const delay=/^\d+$/.test(hint)?Number(hint)*1000:Date.parse(hint)-Date.now();if(Number.isFinite(delay))retryAfterMs=Math.max(0,Math.min(300000,delay));}
        const message=response.status===401?'Ключ недействителен или истёк':response.status===403?'Нет доступа к кампании':response.status===409?'Данные изменились. Обновите подключение':response.status===503?'Архив сайта ещё не готов':'Не удалось выполнить запрос';
        throw new TransportError(code,message,response.status,retryAfterMs);
      }
      const type=response.headers['content-type']??'';
      if(binary?!/^(image\/png|image\/jpeg|image\/webp)(?:;|$)/i.test(type):!/^application\/json(?:;|$)/i.test(type))return fail('content_type','Неожиданный формат ответа сайта');
      return response.body;
    }catch(error){if(error instanceof TransportError)throw error;return fail('network_error','Не удалось связаться с сайтом');}
    finally{if(timer)clearTimeout(timer);options.signal?.removeEventListener('abort',onAbort);}
  }
  return {
    async json(path:string,options?:TransportOptions):Promise<unknown>{const bytes=await execute(path,options);try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return fail('invalid_json','Повреждённый ответ сайта');}},
    bytes:(path:string,options?:TransportOptions)=>execute(path,options,true),
    async uploadZip(path:string,bytes:Uint8Array,options:Omit<TransportOptions,'method'|'body'>={}):Promise<unknown>{
      if(!(bytes instanceof Uint8Array)||bytes.byteLength<1||bytes.byteLength>33554432)return fail('request_size','Недопустимый ZIP-пакет');
      const data=await execute(path,{...options,method:'PUT'},false,bytes);
      try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{return fail('invalid_json','Некорректный ответ сайта');}
    },
  };
}
