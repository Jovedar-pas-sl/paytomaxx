import type { ReservationPackageView } from '@nightpay/contracts';
import { LEGAL_LINKS_CSS, legalFooter } from '../legal/legal-links';
import { CLUB_BASE_CSS, brandBar, clientMoney, escapeHtml as h } from '../payments/club-ui';
import { canSaveReservation } from './reservation-calendar';
import type { BookingEntry, GroupView, GuestPageView } from './reservations.service';

/**
 * Las páginas del cliente de los reservados (HTML desde el API, móvil primero,
 * en español sencillo, con la marca de las páginas de pago):
 *  - /reservar/<código>  elegir paquete y noche, y dejar nombre y teléfono;
 *  - /reservas/<enlace>  la del que reservó: guardarla (pagada: calendario, WhatsApp,
 *    copiar), pagar (con el aviso de que la señal no se devuelve), los QR del
 *    grupo, lo que queda y lo que gasta cada uno, y, plegado en «Cambiar o
 *    anular», cambiar la fecha (una vez, con 48 h) o anular;
 *  - /reservas/q/<qr>    el QR de una persona del grupo.
 * Una sola acción principal en lima en cada estado; lo demás, en gris. Toques
 * de 44 px como poco y campos de 16 px (el iPhone no hace zoom). Todas llevan
 * el pie legal (Aviso legal · Privacidad · Cookies · Condiciones).
 */

const LOCALE = 'es-ES';
const eur = (c: number) => clientMoney(c, LOCALE);

const CSS = `
.m{max-width:28rem;margin:0 auto;padding:4.5rem 1rem calc(1.5rem + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:1.75rem}
.m h1{font-size:1.75rem;overflow-wrap:anywhere}
.m h2{font-size:1.125rem}
.m h3{margin:0;font-size:1rem;font-weight:600;line-height:1.25;color:var(--fg)}
.hd,.sec{display:flex;flex-direction:column;gap:.75rem;min-width:0}
.hd{gap:.625rem}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:.375rem .75rem;font-size:.9375rem}
.sub{font-size:.9375rem;font-weight:500;color:var(--label)}
.card{border:1px solid var(--line);border-radius:var(--r);padding:1rem;display:flex;flex-direction:column;gap:.75rem;background:var(--surface)}
.warn{border-color:var(--warn)}
.warn p{color:var(--fg)}
.small{font-size:.875rem}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:.75rem;font-size:.9375rem}
.row span:first-child{flex:none;color:var(--mute)}
.row b{min-width:0;font-family:var(--num);color:var(--fg);text-align:right;overflow-wrap:anywhere}
.pill{display:inline-flex;align-items:center;min-height:1.75rem;padding:.125rem .625rem;border-radius:999px;border:1px solid var(--line-hi);font-size:.875rem;font-weight:600;color:var(--fg)}
.pill.ok{border-color:var(--ok);color:var(--ok)}
.big{font-family:var(--num);font-size:2rem;font-weight:700;line-height:1.1;color:var(--fg)}
.save{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.5rem}
.tile{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.375rem;min-height:4.75rem;padding:.625rem .25rem;border:1px solid var(--line-hi);border-radius:var(--r-tile);background:var(--surface-2);color:var(--fg);font:inherit;font-size:.875rem;font-weight:500;line-height:1.2;text-align:center;text-decoration:none;overflow-wrap:anywhere;cursor:pointer;-webkit-tap-highlight-color:transparent}
.tile .ic{width:1.375rem;height:1.375rem}
.tile:active{background:var(--surface-3)}
.tile:focus-visible,.who:focus-visible{outline:3px solid var(--fg);outline-offset:2px}
.opt{display:flex;gap:.75rem;align-items:flex-start;min-height:3.5rem;padding:.875rem 1rem;border:1px solid var(--line-hi);border-radius:var(--r-tile);background:var(--surface);cursor:pointer;-webkit-tap-highlight-color:transparent}
.opt:has(input:checked){border-color:var(--fg);background:var(--surface-2)}
.opt input{flex:none;width:1.375rem;height:1.375rem;margin:.0625rem 0 0;accent-color:var(--lime)}
.opt input:focus-visible,.chk input:focus-visible{outline:3px solid var(--fg);outline-offset:2px}
.opt-b{flex:1;min-width:0;display:flex;flex-direction:column;gap:.25rem}
.opt-t{display:flex;justify-content:space-between;align-items:baseline;gap:.75rem;font-size:1.0625rem;font-weight:600;color:var(--fg)}
.opt-t .num{flex:none;white-space:nowrap}
.opt p{font-size:.875rem}
.one{min-height:0;padding:.25rem 0;border:0;background:none;cursor:default}
#f{gap:1.75rem}
.rules{margin:0;padding:0 0 0 1.125rem;display:flex;flex-direction:column;gap:.375rem;font-size:.9375rem;color:var(--mute)}
.rules b{color:var(--fg)}
.dis>summary{display:flex;align-items:center;gap:.625rem;min-height:2.75rem;color:var(--fg);font-weight:500;text-decoration:underline;text-underline-offset:.2em;list-style:none;cursor:pointer;-webkit-tap-highlight-color:transparent}
.dis>summary::-webkit-details-marker{display:none}
.dis>summary::after{content:'';flex:none;width:.5rem;height:.5rem;margin-top:-.25rem;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg)}
.dis[open]>summary::after{margin-top:.25rem;transform:rotate(-135deg)}
.dis>summary:focus-visible{outline:3px solid var(--fg);outline-offset:2px;border-radius:4px}
.dis-b{display:flex;flex-direction:column;gap:.5rem;padding:.25rem 0 .5rem;font-size:.9375rem}
.more{border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.more>summary{justify-content:space-between;min-height:3.5rem;font-size:1.0625rem;font-weight:600;text-decoration:none}
.more .dis-b{gap:1.5rem;padding:.25rem 0 1.25rem}
.more form+form{padding-top:1.5rem;border-top:1px solid var(--line)}
.more .dis-b>form:only-child>h3{display:none}
label.f{display:flex;flex-direction:column;gap:.375rem;min-width:0;font-size:.875rem;color:var(--label);font-weight:500}
input.i,textarea.i{display:block;width:100%;min-width:0;max-width:100%;min-height:3rem;padding:.625rem .75rem;border:1px solid var(--line-hi);border-radius:var(--r-field);background:var(--surface-2);color:var(--fg);font:inherit;font-size:1rem;-webkit-appearance:none;appearance:none}
input.i::-webkit-date-and-time-value{min-height:1.5rem;text-align:left}
input.i:focus-visible,textarea.i:focus-visible{outline:3px solid var(--fg);outline-offset:2px}
.chk{display:flex;gap:.75rem;align-items:center;min-height:3.5rem;padding:.75rem 1rem;border:1px solid var(--line-hi);border-radius:var(--r-tile);font-size:.9375rem;font-weight:500;line-height:1.35;color:var(--fg);cursor:pointer;-webkit-tap-highlight-color:transparent}
.chk:has(input:checked){border-color:var(--fg);background:var(--surface-2)}
.chk input{flex:none;width:1.5rem;height:1.5rem;margin:0;accent-color:var(--lime)}
.ppl{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.ppl li{display:flex;align-items:center;gap:.75rem;padding:.625rem 0;border-top:1px solid var(--line)}
.ppl li:last-child{border-bottom:1px solid var(--line)}
.who{flex:1;min-width:0;display:flex;align-items:center;gap:.75rem;min-height:3.5rem;color:var(--fg);text-decoration:none;border-radius:var(--r-chip)}
.who-t{display:flex;flex-direction:column;min-width:0}
.who-t span{font-size:.875rem;color:var(--mute)}
.qr{flex:none;display:block;width:3.5rem;height:3.5rem;padding:.125rem;border-radius:var(--r-chip);background:#fff}
.qr svg{display:block;width:100%;height:100%}
.btn.share{flex:none;width:auto;min-height:3rem;padding:.5rem 1rem;font-size:1rem}
.left{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.5rem}
.left li{display:flex;justify-content:space-between;align-items:center;gap:.5rem;font-size:.9375rem}
.qrimg{display:block;width:min(18rem,80vw);height:auto;margin:0 auto;border-radius:var(--r-tile);background:#fff;padding:.5rem}`;

/** Iconos de trazo (los de .ic de club-ui): calendario, mensaje, enlace y compartir. */
const ICONS = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  chat: '<path d="M20.5 11.5a8.5 8.5 0 0 1-12.4 7.6L3.5 20.5l1.4-4.4a8.5 8.5 0 1 1 15.6-4.6z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  share: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
} as const;
const icon = (name: keyof typeof ICONS) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

function page(title: string, body: string, script = ''): string {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#0b0d0e"><title>${h(title)}</title>
<style>${CLUB_BASE_CSS}${LEGAL_LINKS_CSS}${CSS}</style></head><body>
${brandBar()}
<main class="m">${body}</main>
${legalFooter('es')}
${script ? `<script>${script}</script>` : ''}
</body></html>`;
}

export function renderReservationGone(): string {
  return page('Reservados', `<section class="card warn"><h1>Este enlace no existe o ya no vale</h1><p>Pregunta en el local.</p></section>`);
}

function nightText(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

function packageLine(p: ReservationPackageView): string {
  const what = p.kind === 'CREDIT' ? `${eur(p.creditCents)} para consumir` : p.items.map((i) => `${i.qty} × ${i.name}`).join(', ');
  return `${p.entries} ${p.entries === 1 ? 'persona' : 'personas'} · ${what}`;
}

// ─── Reservar ──────────────────────────────────────────────────────────

const BOOK_JS = `(function(){
var C=JSON.parse(document.getElementById('cfg').textContent),f=document.getElementById('f'),e=document.getElementById('err'),b=document.getElementById('go'),busy=false;
function key(){try{var k=sessionStorage.getItem('resvKey');if(!k){k=Array.from(crypto.getRandomValues(new Uint8Array(18)),function(x){return('0'+x.toString(16)).slice(-2);}).join('');sessionStorage.setItem('resvKey',k);}return k;}catch(_){return Array.from(crypto.getRandomValues(new Uint8Array(18)),function(x){return('0'+x.toString(16)).slice(-2);}).join('');}}
f.addEventListener('submit',function(ev){ev.preventDefault();if(busy)return;var d=new FormData(f);var pk=d.get('pk');
if(!pk){e.textContent='Elige un paquete';e.hidden=false;return;}
busy=true;b.classList.add('busy');b.disabled=true;e.hidden=true;
fetch(C.post,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({packageId:pk,nightDate:d.get('night'),customerName:d.get('name'),customerPhone:d.get('phone'),notes:d.get('notes')||null,key:key()})})
.then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});})
.then(function(x){if(x.ok&&x.j.next){try{sessionStorage.removeItem('resvKey');}catch(_){}location.href=x.j.next;return;}throw new Error((x.j&&x.j.message)||'No se ha podido reservar');})
.catch(function(err){e.textContent=String(err.message||err);e.hidden=false;busy=false;b.classList.remove('busy');b.disabled=false;});});
})();`;

export function renderBookPage(code: string, entry: BookingEntry, minDay: string, maxDay: string): string {
  const pkgs = entry.packages
    .map(
      (p, i) => `<label class="opt"><input type="radio" name="pk" value="${h(p.id)}"${i === 0 ? ' checked' : ''}><span class="opt-b">
<span class="opt-t"><span>${h(p.name)}</span><b class="num">${h(eur(p.priceCents))}</b></span>
<p>${h(packageLine(p))}</p>${p.description ? `<p>${h(p.description)}</p>` : ''}<p>Señal para reservar: <b class="num">${h(eur(p.depositCents))}</b> (30&nbsp;%)</p></span></label>`,
    )
    .join('');
  const closed = entry.problem ?? (entry.packages.length === 0 ? 'Ahora no hay reservados a la venta' : null);
  const body = `<section class="hd"><h1>Reserva en ${h(entry.venueName)}</h1><p>Elige tu reservado y la noche. Pagas la señal (30&nbsp;%) o todo, y te damos un QR para cada persona del grupo.</p></section>
${
  closed
    ? `<section class="card warn"><p>${h(closed)}</p></section>`
    : `<form id="f" class="sec" novalidate>
<div class="sec" role="radiogroup" aria-labelledby="pk-h"><h2 id="pk-h">Tu reservado</h2>${pkgs}</div>
<div class="sec"><h2>La noche y tus datos</h2>
<label class="f">Noche<input class="i" type="date" name="night" required min="${minDay}" max="${maxDay}" value="${minDay}"></label>
<label class="f">Tu nombre<input class="i" name="name" required maxlength="60" autocomplete="name"></label>
<label class="f">Tu teléfono<input class="i" name="phone" required maxlength="32" inputmode="tel" autocomplete="tel"></label>
<label class="f">Algo que debamos saber (opcional)<textarea class="i" name="notes" maxlength="200" rows="2"></textarea></label></div>
<p class="err" id="err" role="alert" hidden></p>
<button class="btn" id="go" type="submit">Reservar</button>
<p class="small">Antes de pagar te decimos cuánto es la señal y que no se devuelve.</p>
</form>`
}<script type="application/json" id="cfg">${JSON.stringify({ post: `/reservar/${code}` })}</script>`;
  return page(`Reservar · ${entry.venueName}`, body, closed ? '' : BOOK_JS);
}

// ─── La página del grupo ───────────────────────────────────────────────

const GROUP_JS = `(function(){
var C=JSON.parse(document.getElementById('cfg').textContent),busy=false,live=document.getElementById('live');
function err(id,t){var e=document.getElementById(id);if(e){e.textContent=t;e.hidden=!t;}}
function post(url,body,eid,btn){if(busy)return;busy=true;btn.classList.add('busy');btn.disabled=true;err(eid,'');
fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
.then(function(r){return r.json().catch(function(){return{};}).then(function(j){return{ok:r.ok,j:j};});})
.then(function(x){if(x.ok){if(x.j.payUrl){location.href=x.j.payUrl;}else{location.reload();}return;}throw new Error((x.j&&x.j.message)||'No se ha podido');})
.catch(function(e){err(eid,String(e.message||e));busy=false;btn.classList.remove('busy');btn.disabled=false;});}
var pf=document.getElementById('payf');
if(pf){var ok=document.getElementById('ack'),pb=document.getElementById('payb');
function kind(){return pf.querySelector('input[name=kind]:checked')||pf.querySelector('input[name=kind][type=hidden]');}
function sync(){var k=kind();pb.disabled=!ok.checked||!k;if(k)pb.textContent='Pagar '+k.getAttribute('data-eur');}
pf.addEventListener('change',sync);sync();
pf.addEventListener('submit',function(ev){ev.preventDefault();var k=kind();if(!k||!ok.checked)return;post(C.pay,{kind:k.value,acceptedNoRefund:true},'payerr',pb);});}
var cf=document.getElementById('cancelf');
if(cf){var ck=document.getElementById('cack'),cb=document.getElementById('cancelb');ck.addEventListener('change',function(){cb.disabled=!ck.checked;});
cf.addEventListener('submit',function(ev){ev.preventDefault();if(!ck.checked)return;post(C.cancel,{},'cancelerr',cb);});}
var df=document.getElementById('datef');
if(df){df.addEventListener('submit',function(ev){ev.preventDefault();var v=df.querySelector('input[name=night]').value;post(C.date,{nightDate:v},'dateerr',document.getElementById('dateb'));});}
function oldCopy(u){var t=document.createElement('textarea'),r=false;t.value=u;t.setAttribute('readonly','');t.style.position='fixed';t.style.opacity='0';document.body.appendChild(t);t.select();try{r=document.execCommand('copy');}catch(_){}document.body.removeChild(t);return r;}
function copy(u,b){var l=b.querySelector('span')||b,was=l.textContent;function done(){l.textContent='Copiado';live.textContent='Enlace copiado';setTimeout(function(){l.textContent=was;live.textContent='';},2500);}
if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(u).then(done,function(){if(oldCopy(u))done();});}else if(oldCopy(u)){done();}}
document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){copy(b.getAttribute('data-copy'),b);});});
document.querySelectorAll('[data-share]').forEach(function(b){b.addEventListener('click',function(){var u=b.getAttribute('data-share');
if(navigator.share){navigator.share({title:b.getAttribute('data-title')||document.title,url:u}).catch(function(e){if(!e||e.name!=='AbortError')copy(u,b);});}else{copy(u,b);}});});
})();`;

/** Los QR del grupo: con la señal, pagada o ya en el local. */
export function showsGroupQrs(status: string): boolean {
  return status === 'DEPOSIT_PAID' || status === 'PAID' || status === 'ARRIVED';
}

/** «Guarda tu reservado»: al calendario, a su WhatsApp o copiar el enlace (sin datos del cliente). */
function saveCard(token: string, v: GroupView, origin: string): string {
  const r = v.reservation;
  if (!canSaveReservation(r.status)) return '';
  const url = `${origin}/reservas/${token}`;
  const wa = `https://wa.me/?text=${encodeURIComponent(`Mi reservado en ${v.venueName}, ${nightText(r.nightDate)}: ${url}`)}`;
  return `<section class="sec" aria-labelledby="save-h"><h2 id="save-h" class="sub">Guarda tu reservado</h2><div class="save">
<a class="tile" href="/reservas/${h(token)}/calendario">${icon('calendar')}<span>Añadir a mi calendario</span></a>
<a class="tile" href="${h(wa)}" target="_blank" rel="noopener">${icon('chat')}<span>Enviármelo por WhatsApp</span></a>
<button class="tile" type="button" data-copy="${h(url)}">${icon('link')}<span>Copiar enlace</span></button>
</div></section>`;
}

/** Sin pagar solo ocupa sitio un rato: ni calendario ni WhatsApp; «Copiar enlace» en gris, debajo de «Pagar». */
function linkCard(token: string, v: GroupView, origin: string): string {
  if (v.reservation.status !== 'PENDING') return '';
  return `<section class="sec"><p class="small">Guarda el enlace para volver a esta página.</p><button class="btn alt" type="button" data-copy="${h(`${origin}/reservas/${token}`)}">${icon('link')}<span>Copiar enlace</span></button></section>`;
}

function payCard(v: GroupView): string {
  const r = v.reservation;
  if (v.openPayUrl) {
    return `<section class="card"><h2>Tienes un pago a medias</h2><a class="btn" href="${h(v.openPayUrl)}">Seguir pagando</a></section>`;
  }
  if (v.payable.length === 0) return '';
  const cents = (k: string) => (k === 'DEPOSIT' ? r.depositCents : k === 'FULL' ? r.priceCents : r.pendingCents);
  const label = (k: string) => (k === 'DEPOSIT' ? 'Pagar la señal (30&nbsp;%)' : k === 'FULL' ? 'Pagar todo ahora' : 'Pagar el resto');
  const opts =
    v.payable.length === 1
      ? // Una sola forma de pagar: sin botón de opción (no hay nada que elegir).
        `<div class="opt one"><span class="opt-b"><span class="opt-t"><span>${label(v.payable[0]!)}</span><b class="num">${h(eur(cents(v.payable[0]!)))}</b></span></span><input type="hidden" name="kind" value="${v.payable[0]}" data-eur="${h(eur(cents(v.payable[0]!)))}"></div>`
      : v.payable
          .map(
            (k, i) =>
              `<label class="opt"><input type="radio" name="kind" value="${k}" data-eur="${h(eur(cents(k)))}"${i === 0 ? ' checked' : ''}><span class="opt-b"><span class="opt-t"><span>${label(k)}</span><b class="num">${h(eur(cents(k)))}</b></span></span></label>`,
          )
          .join('');
  const rest = v.payable.includes('REST')
    ? `<p>Puedes pagar el resto ahora o al llegar al local.</p>`
    : `<p>Si pagas la señal, el resto (${h(eur(r.priceCents - r.depositCents))}) lo pagas antes de ir o al llegar.</p>`;
  return `<form id="payf" class="sec">
<h2>Pagar</h2>${opts}${rest}
<ul class="rules"><li><b>La señal (${h(eur(r.depositCents))}) no se devuelve.</b> Si no vienes, la pierdes.</li><li>Puedes cambiar la fecha una vez o anular, avisando con 48 horas.</li></ul>
<details class="dis"><summary>Ver condiciones</summary><div class="dis-b">
<p>Las 48 horas cuentan hasta la hora de apertura del local esa noche. La fecha se cambia una sola vez.</p>
<p>Si anulas, pierdes la señal; lo demás que hayas pagado te queda como saldo para otra noche (no se devuelve en dinero).</p>
<p>Si pagas todo y no vienes sin avisar con 48 horas, pierdes la señal y el resto queda como saldo para otra noche (no se devuelve en dinero).</p>
<p>Si el local anula la reserva, lo pagado te queda como saldo para otra noche.</p>
</div></details>
<label class="chk"><input type="checkbox" id="ack"><span>Lo entiendo: la señal no se devuelve</span></label>
<p class="err" id="payerr" role="alert" hidden></p>
<button class="btn" id="payb" type="submit" disabled>Pagar</button>
</form>`;
}

function qrCard(v: GroupView, origin: string, qrs: Record<number, string>): string {
  const r = v.reservation;
  if (!showsGroupQrs(r.status)) return '';
  const list = v.guestTokens
    .map((g) => {
      const url = `${origin}/reservas/q/${g.token}`;
      const guest = r.guests.find((x) => x.seq === g.seq);
      const notes = [
        guest && guest.spentCents > 0 ? `ha gastado ${eur(guest.spentCents)}` : '',
        guest && guest.items.length > 0 ? guest.items.map((i) => `${i.qty} × ${i.name}`).join(', ') : '',
      ].filter(Boolean);
      // El SVG del QR lo hace el propio API (qrcode) con su enlace: no lleva nada del cliente.
      const thumb = qrs[g.seq] ? `<span class="qr" aria-hidden="true">${qrs[g.seq]}</span>` : '';
      return `<li><a class="who" href="${h(url)}">${thumb}<span class="who-t"><b>Persona ${g.seq}</b>${notes.length ? `<span>${h(notes.join(' · '))}</span>` : ''}</span></a><button class="btn alt share" type="button" data-share="${h(url)}" data-title="${h(`Tu QR · ${v.venueName}`)}">${icon('share')}<span>Compartir</span></button></li>`;
    })
    .join('');
  return `<section class="sec" aria-labelledby="qr-h"><h2 id="qr-h">Los QR de tu grupo</h2><p>Comparte un QR con cada persona. Con cualquiera de ellos se gasta del reservado.</p><ul class="ppl">${list}</ul></section>`;
}

function leftCard(v: GroupView): string {
  const r = v.reservation;
  if (r.status !== 'ARRIVED') return '';
  const what =
    r.kind === 'CREDIT'
      ? `<p class="big">${h(eur(r.balanceCents ?? 0))}</p><p>Lo que queda para consumir. Lo que sobre queda como saldo para otra noche.</p>`
      : `<ul class="left">${r.itemsLeft.map((i) => `<li><span>${h(i.name)}</span><b class="num">${i.left} de ${i.qty}</b></li>`).join('')}</ul>`;
  return `<section class="card"><h2>Lo que queda</h2>${what}</section>`;
}

/** El cliente anula: sin pagar, «Cancelar»; pagada, con 48 h (pierde la señal; lo demás le queda de saldo). */
function cancelForm(v: GroupView): string {
  const r = v.reservation;
  if (!v.cancel) return '';
  const paid = v.cancel === 'Anular';
  const left = r.paidCents - Math.min(r.depositCents, r.paidCents);
  const what = paid
    ? `<p><b>Pierdes la señal (${h(eur(Math.min(r.depositCents, r.paidCents)))}).</b>${left > 0 ? ` Lo demás (${h(eur(left))}) te queda como saldo para otra noche: no se devuelve en dinero.` : ''}</p>`
    : '<p>No has pagado nada: se cancela sin más.</p>';
  return `<form id="cancelf" class="sec"><h3>${paid ? 'Anular mi reserva' : 'Cancelar la reserva'}</h3>${what}
<label class="chk"><input type="checkbox" id="cack"><span>${paid ? 'Lo entiendo: pierdo la señal' : 'Sí, quiero cancelarla'}</span></label>
<p class="err" id="cancelerr" role="alert" hidden></p><button class="btn alt" id="cancelb" type="submit" disabled>${paid ? 'Anular mi reserva' : 'Cancelar la reserva'}</button></form>`;
}

function dateForm(v: GroupView, minDay: string, maxDay: string): string {
  if (!v.canChangeDate) return '';
  return `<form id="datef" class="sec"><h3>Cambiar la fecha</h3><p>Solo una vez y avisando con 48 horas.</p>
<label class="f">Nueva noche<input class="i" type="date" name="night" required min="${minDay}" max="${maxDay}"></label>
<p class="err" id="dateerr" role="alert" hidden></p><button class="btn alt" id="dateb" type="submit">Cambiar la fecha</button></form>`;
}

/** Cambiar la fecha y anular, plegados debajo de todo: nunca tan a la vista como «Pagar». */
function changeOrCancel(v: GroupView, minDay: string, maxDay: string): string {
  const date = dateForm(v, minDay, maxDay);
  const cancel = cancelForm(v);
  const blocked = v.cancelBlocked ? `<p class="small">${h(v.cancelBlocked)}</p>` : '';
  if (!date && !cancel) return blocked;
  const title = date && cancel ? 'Cambiar o anular' : date ? 'Cambiar la fecha' : v.cancel === 'Anular' ? 'Anular mi reserva' : 'Cancelar la reserva';
  return `<details class="dis more"><summary>${title}</summary><div class="dis-b">${date}${cancel}</div></details>${blocked}`;
}

/**
 * El local anuló una reserva pagada (decisión del dueño del 17-nov): nada se
 * devuelve; lo pagado, con tarjeta o con bitcoin, le queda como saldo del grupo
 * para otra noche. Solo con esa regla (venueCanceledToSaldo): las anuladas antes
 * se devolvían desde Saldos.
 */
export function venueCanceledText(r: Pick<GroupView['reservation'], 'paidCents'>): string {
  return `El local ha anulado la reserva. Lo pagado (${eur(r.paidCents)}) te queda como saldo para otra noche.`;
}

export function renderGroupPage(token: string, v: GroupView, origin: string, minDay: string, maxDay: string, qrs: Record<number, string> = {}): string {
  const r = v.reservation;
  const ok = r.status === 'PAID' || r.status === 'ARRIVED';
  const venueCanceled = r.status === 'CANCELED' && r.paidCents > 0;
  const saldo =
    v.saldoHref && !venueCanceled
      ? `<section class="card"><h2>Tu saldo para otra noche</h2><p>Te queda saldo en ${h(v.venueName)}. No caduca y no se devuelve en dinero.</p><a class="btn alt" href="${h(v.saldoHref)}">Ver mi saldo</a></section>`
      : '';
  const canceled = venueCanceled
    ? `<section class="card warn"><p>${h(v.venueCanceledToSaldo ? venueCanceledText(r) : 'El local ha anulado la reserva.')}</p>${v.saldoHref ? `<a class="btn" href="${h(v.saldoHref)}">Ver mi saldo</a>` : ''}</section>`
    : r.status === 'CLIENT_CANCELED'
      ? '<section class="card warn"><p>Has anulado la reserva: la señal no se devuelve.</p></section>'
      : '';
  const body = `<section class="hd"><h1>Tu reservado en ${h(v.venueName)}</h1><p class="meta"><span class="pill${ok ? ' ok' : ''}">${h(r.statusText)}</span><span>Referencia <b class="num">${h(r.ref)}</b></span></p></section>
${canceled}${saveCard(token, v, origin)}${leftCard(v)}
<section class="card" aria-label="Tu reservado">
<div class="row"><span>Noche</span><b>${h(nightText(r.nightDate))}</b></div>
<div class="row"><span>Reservado</span><b>${h(r.packageName)}</b></div>
<div class="row"><span>Personas</span><b>${r.entries}</b></div>
${r.tableLabel ? `<div class="row"><span>Mesa</span><b>${h(r.tableLabel)}</b></div>` : ''}
<div class="row"><span>Total</span><b>${h(eur(r.priceCents))}</b></div>
<div class="row"><span>Pagado</span><b>${h(eur(r.paidCents))}</b></div>
${r.pendingCents > 0 && (r.status === 'PENDING' || r.status === 'DEPOSIT_PAID') ? `<div class="row"><span>Falta</span><b>${h(eur(r.pendingCents))}</b></div>` : ''}
</section>
${payCard(v)}${linkCard(token, v, origin)}${qrCard(v, origin, qrs)}${saldo}${changeOrCancel(v, minDay, maxDay)}
<p class="sr" id="live" aria-live="polite"></p>
<script type="application/json" id="cfg">${JSON.stringify({ pay: `/reservas/${token}/pago`, date: `/reservas/${token}/fecha`, cancel: `/reservas/${token}/anular` })}</script>`;
  return page(`Tu reservado · ${v.venueName}`, body, GROUP_JS);
}

// ─── El QR de una persona ──────────────────────────────────────────────

export function renderGuestPage(v: GuestPageView, qrPngDataUrl: string): string {
  const left =
    v.status !== 'ARRIVED'
      ? `<p>Enséñalo en la puerta la noche del reservado.</p>`
      : v.kind === 'CREDIT'
        ? `<p>Queda para consumir: <b class="num">${h(eur(v.balanceCents ?? 0))}</b></p>`
        : `<ul class="left">${v.itemsLeft.map((i) => `<li><span>${h(i.name)}</span><b class="num">${i.left} de ${i.qty}</b></li>`).join('')}</ul>`;
  const body = `<section class="hd"><h1>${h(v.venueName)}</h1><p>${h(v.packageName)} · ${h(nightText(v.nightDate))}</p></section>
<section class="card"><p class="meta">Persona ${v.seq} de ${v.entries} <span class="pill">${h(v.statusText)}</span></p>
<img class="qrimg" src="${qrPngDataUrl}" width="288" height="288" alt="QR de la persona ${v.seq} del reservado">
${left}${v.mySpentCents > 0 ? `<p>Has gastado ${h(eur(v.mySpentCents))}.</p>` : ''}</section>`;
  return page(`Tu QR · ${v.venueName}`, body);
}
