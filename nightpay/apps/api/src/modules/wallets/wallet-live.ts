/**
 * La página del saldo «al momento» (H-1, M-7): JS del navegador (va dentro
 * de una plantilla de TypeScript: sin barras invertidas). Lo usa
 * wallet-page.ts:
 *
 *   var L=npLive({base, busy:()=>busy, state:render, bar:(on)=>…, unauth, gone});
 *   L.start();   // y L.refresh() para pedir el estado ya
 *
 *  - Escucha los avisos de su saldo (EventSource a <base>/events, SSE) y solo
 *    entonces pide <base>/state. Antes preguntaba cada 3 s.
 *  - De respaldo, una consulta cada 30 s con el aviso funcionando y cada
 *    20 s sin él (navegador sin EventSource, red que lo corta, 429…). Tras un
 *    fallo vuelve a probar pronto (5 s, 10 s… hasta 20 s).
 *  - Nunca dos /state a la vez: los avisos que llegan mientras tanto dejan
 *    una consulta más para cuando acabe (se ve el último cambio).
 *  - El aviso se cae: lo cierra, pide /state ya y reconecta con espera
 *    creciente (1 s, 2 s, 4 s… hasta 30 s, con algo de azar); al volver a
 *    entrar (o al entrar por fin tras fallos), pide /state otra vez (un aviso
 *    pudo perderse en el hueco). Solo el primer «hola» limpio, recién cargada
 *    la página (su estado viene del servidor), no pregunta. «bye» del
 *    servidor: renew = vuelve ya (su sesión o su tope de vida), restart = la
 *    réplica se apaga (vuelve en 1–5 s), cap = hay más pestañas de este saldo
 *    (no vuelve: sigue con el sondeo).
 *  - Pestaña oculta: cierra el aviso y no pregunta; al volver (o al salir de
 *    la caché del «atrás»), pregunta ya y vuelve a escuchar.
 *  - Tras 2 fallos seguidos o un 429, bar(true): «Reconectando…» (antes, un
 *    429 se ignoraba en silencio); la siguiente consulta buena lo quita.
 *  - 401 (la sesión del Face ID caducó): unauth() y para. 404 (el enlace ya
 *    no vale): gone() y para.
 *  - Con algo a medias (busy(): activando Face ID, eligiendo PIN…) no pinta
 *    encima: lo intenta en la siguiente vuelta.
 * `fetch`, `EventSource`, `doc` y `win` se pueden pasar (pruebas); si no, los del navegador.
 */
export const WALLET_LIVE_JS = `
function npLive(o){
 var W=o.win||window,D=o.doc||document,F=o.fetch||function(u,x){return W.fetch(u,x);},ES=o.EventSource===undefined?W.EventSource:o.EventSource;
 var es=null,up=false,fails=0,retry=0,poll=0,stFails=0,slow=false,gone=false,capped=false,inflight=false,again=false,opened=0;
 function hidden(){return D.visibilityState==='hidden';}
 function bar(){o.bar(!gone&&(stFails>=2||slow));}
 function next(){return slow?20000:stFails>0?Math.min(20000,5000*stFails):up?30000:20000;}
 function later(ms){W.clearTimeout(poll);poll=0;if(gone||hidden())return;poll=W.setTimeout(refresh,ms);}
 function close(){if(es){es.close();es=null;}up=false;}
 function stop(){gone=true;close();W.clearTimeout(poll);W.clearTimeout(retry);}
 function refresh(){if(gone)return;if(inflight){again=true;return;}if(o.busy()){later(next());return;}
  inflight=true;
  F(o.base+'/state',{cache:'no-store',credentials:'same-origin'}).then(function(r){
   if(r.status===401){stop();o.unauth();return null;}
   if(r.status===404){stop();o.gone();return null;}
   if(r.status===429){slow=true;stFails++;return null;}
   if(!r.ok){stFails++;return null;}
   slow=false;stFails=0;return r.json();})
  .then(function(s){if(s&&!o.busy())o.state(s);},function(){stFails++;})
  .then(function(){inflight=false;bar();if(gone)return;if(again){again=false;refresh();}else later(next());});}
 function reopen(ms){W.clearTimeout(retry);retry=0;if(gone||capped)return;retry=W.setTimeout(open,ms);}
 function open(){if(es||gone||capped||hidden()||!ES)return;
  var s=new ES(o.base+'/events');es=s;
  s.addEventListener('hello',function(){if(es!==s)return;var catchUp=opened++>0||fails>0||stFails>0||slow;up=true;fails=0;if(catchUp)refresh();else later(next());});
  s.addEventListener('change',function(){if(es===s)refresh();});
  s.addEventListener('resync',function(){if(es===s)W.setTimeout(refresh,Math.random()*5000);});
  s.addEventListener('bye',function(e){if(es!==s)return;var r='';try{r=JSON.parse(e.data).r;}catch(x){r='';}close();
   if(r==='cap'){capped=true;return;}reopen(r==='restart'?1000+Math.random()*4000:0);});
  s.onerror=function(){if(es!==s)return;close();fails++;reopen(Math.min(30000,1000*Math.pow(2,fails-1))*(0.5+Math.random()/2));refresh();};}
 D.addEventListener('visibilitychange',function(){if(hidden()){close();W.clearTimeout(poll);W.clearTimeout(retry);}else if(!gone){refresh();open();}});
 W.addEventListener('pageshow',function(e){if(e.persisted&&!gone){close();refresh();open();}});
 return {refresh:refresh,start:function(){later(next());open();},stop:stop};
}`;
