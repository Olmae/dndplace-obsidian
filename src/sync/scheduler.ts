export type ScheduleBinding={id:string;campaign:string;enabled:boolean;version:string};
type Clock={now:()=>number;set:(fn:()=>void,ms:number)=>unknown;clear:(id:unknown)=>void};
type Entry={binding:ScheduleBinding;due:number;dirty:number|null;failures:number;status:'waiting'|'running'|'attention';abort:AbortController|null};
const retry=[5000,15000,30000,60000,300000];
/** Per-root serialization, at most two distinct campaigns, and no implicit opt-in. */
export function createSyncScheduler(options:{run:(id:string,signal:AbortSignal)=>Promise<'ok'|'review'>;clock?:Clock;random?:()=>number;changed?:()=>void}){
  const clock=options.clock??{now:Date.now,set:(fn,ms)=>setTimeout(fn,ms),clear:id=>clearTimeout(id as ReturnType<typeof setTimeout>)};
  const entries=new Map<string,Entry>(),running=new Set<Entry>();let timer:unknown=null,closed=false;
  const notify=()=>options.changed?.();
  function arm(){
    if(timer!==null){clock.clear(timer);timer=null;}if(closed)return;
    const campaigns=new Set([...running].map(row=>row.binding.campaign));
    const ready=[...entries.values()].filter(row=>row.status==='waiting'&&running.size<2&&!campaigns.has(row.binding.campaign));
    if(!ready.length)return;const due=Math.min(...ready.map(row=>row.due));
    timer=clock.set(()=>{timer=null;pump();},Math.max(0,due-clock.now()));
  }
  function pump(){
    if(closed)return;const campaigns=new Set([...running].map(row=>row.binding.campaign));
    for(const row of entries.values()){
      if(running.size>=2)break;if(row.status!=='waiting'||row.due>clock.now()||campaigns.has(row.binding.campaign))continue;
      row.status='running';row.dirty=null;row.abort=new AbortController();running.add(row);campaigns.add(row.binding.campaign);notify();
      void execute(row);
    }arm();
  }
  async function execute(row:Entry){
    try{
      const result=await options.run(row.binding.id,row.abort!.signal);
      if(closed||entries.get(row.binding.id)!==row||row.abort!.signal.aborted)return;
      row.failures=0;row.status=result==='review'?'attention':'waiting';row.due=row.dirty??clock.now()+30000;
    }catch(error){
      if(closed||entries.get(row.binding.id)!==row||row.abort!.signal.aborted)return;
      const failure=error as {status?:number;code?:string;retryAfterMs?:number};
      const stop=[401,403].includes(failure.status??0)||/protocol|context|capture|conflict|authorization|corrupt|changed|paused|unsafe|review|unresolved|identity|lease/.test(failure.code??'');
      row.status=stop?'attention':'waiting';
      const delay=retry[Math.min(row.failures++,retry.length-1)],jitter=Math.max(0,Math.min(1,options.random?.()??Math.random()))*delay*.2;
      row.due=clock.now()+Math.max(delay+jitter,Math.min(3600000,Math.max(0,failure.retryAfterMs??0)));row.dirty=null;
    }finally{running.delete(row);row.abort=null;notify();arm();}
  }
  return {
    configure(bindings:readonly ScheduleBinding[]){
      if(closed)return;const enabled=bindings.filter(row=>row.enabled),ids=new Set(enabled.map(row=>row.id));
      for(const [id,row]of entries)if(!ids.has(id)||!enabled.some(binding=>binding.id===id&&binding.version===row.binding.version&&binding.campaign===row.binding.campaign)){row.abort?.abort();entries.delete(id);}
      for(const binding of enabled)if(!entries.has(binding.id))entries.set(binding.id,{binding:{...binding},due:clock.now()+30000,dirty:null,failures:0,status:'waiting',abort:null});
      notify();arm();
    },
    localChanged(id:string){const row=entries.get(id);if(!row||row.status==='attention'||row.failures)return;row.dirty=clock.now()+1500;if(row.status!=='running')row.due=row.dirty;arm();},
    status:(id:string)=>entries.get(id)?.status??'off',
    dispose(){closed=true;if(timer!==null)clock.clear(timer);timer=null;for(const row of running)row.abort?.abort();entries.clear();notify();},
  };
}
