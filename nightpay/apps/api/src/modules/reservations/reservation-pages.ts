import type { ReservationPackageView } from '@nightpay/contracts';
import { LEGAL_LINKS_CSS, legalFooter } from '../legal/legal-links';
import { CLUB_BASE_CSS, brandBar, clientMoney, escapeHtml as h } from '../payments/club-ui';
import type { BookingEntry, GroupView, GuestPageView } from './reservations.service';

/**
 * Las páginas del cliente de los reservados (HTML desde el API, móvil primero,
 * en español sencillo, con la marca de las páginas de pago):
 *  - /reservar/<código>  elegir paquete y noche, y dejar nombre y teléfono;
 *  - /reservas/<enlace>  la del que reservó: pagar (con el aviso de que la
 *    señal no se devuelve), los QR del grupo, lo que queda y lo que gasta cada
 *    uno, y cambiar la fecha (una vez, con 48 h);
 *  - /reservas/q/<qr>    el QR de una persona del grupo.
 * Todas llevan el pie legal (Aviso legal · Privacidad · Cookies · Condiciones).
 */

const LOCALE = 'es-ES';
const eur = (c: number) => clientMoney(c, LOCALE);

const CSS = `
.m{max-width:28rem;margin:0 auto;padding:4.5rem 1rem calc(2rem + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:1rem}
.m h1{font-size:1.75rem}
.card{border:1px solid var(--line);border-radius:var(--r);padding:1rem;display:flex;flex-direction:column;gap:.75rem;background:var(--surface)}
.card h2{font-size:1.125rem}
.warn{border-color:var(--warn)}
.warn p{color:var(--fg)}
.pk{display:block;border:1px solid var(--line);border-radius:var(--r-tile);padding:.875rem;cursor:pointer}
.pk:has(input:checked){border-color:var(--lime);background:var(--surface-2)}
.pk input{margin-right:.5rem;accent-color:var(--lime)}
.pk b{font-size:1.0625rem;color:var(--fg)}
.pk p,.small{font-size:.875rem}
.row{display:flex;justify-content:space-between;gap:.75rem;font-size:.9375rem}
.row span:first-child{color:var(--mute)}
.row b{font-family:var(--num);color:var(--fg)}
label.f{display:flex;flex-direction:column;gap:.375rem;font-size:.875rem;color:var(--label);font-weight:500}
input.i,textarea.i{min-height:3rem;padding:.625rem .75rem;border:1px solid var(--line-hi);border-radius:var(--r-field);background:var(--surface-2);color:var(--fg);font:inherit;font-size:1rem}
input.i:focus-visible,textarea.i:focus-visible{outline:3px solid var(--fg);outline-offset:2px}
.chk{display:flex;gap:.625rem;align-items:flex-start;font-size:.9375rem;color:var(--fg)}
.chk input{width:1.25rem;height:1.25rem;margin-top:.125rem;accent-color:var(--lime)}
.pill{display:inline-block;padding:.25rem .625rem;border-radius:999px;border:1px solid var(--line-hi);font-size:.875rem;font-weight:600;color:var(--fg)}
.pill.ok{border-color:var(--ok);color:var(--ok)}
.qrs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.5rem}
.qrs li{display:flex;justify-content:space-between;align-items:center;gap:.5rem;font-size:.9375rem}
.qrs a{color:var(--fg)}
.qrimg{display:block;width:min(18rem,80vw);height:auto;margin:0 auto;border-radius:var(--r-tile);background:#fff;padding:.5rem}
.big{font-family:var(--num);font-size:1.5rem;font-weight:700;color:var(--fg)}`;

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
      (p, i) => `<label class="pk"><input type="radio" name="pk" value="${h(p.id)}"${i === 0 ? ' checked' : ''}><b>${h(p.name)}</b> · <b class="num">${h(eur(p.priceCents))}</b>
<p>${h(packageLine(p))}</p>${p.description ? `<p>${h(p.description)}</p>` : ''}<p>Señal para reservar: <b class="num">${h(eur(p.depositCents))}</b> (30 %)</p></label>`,
    )
    .join('');
  const closed = entry.problem ?? (entry.packages.length === 0 ? 'Ahora no hay reservados a la venta' : null);
  const body = `<section><h1>Reserva en ${h(entry.venueName)}</h1><p>Elige tu reservado y la noche. Pagas la señal (30 %) o todo, y te damos un QR para cada persona del grupo.</p></section>
${
  closed
    ? `<section class="card warn"><p>${h(closed)}</p></section>`
    : `<form id="f" class="card" novalidate>
<h2>Tu reservado</h2>${pkgs}
<label class="f">Noche<input class="i" type="date" name="night" required min="${minDay}" max="${maxDay}" value="${minDay}"></label>
<label class="f">Tu nombre<input class="i" name="name" required maxlength="60" autocomplete="name"></label>
<label class="f">Tu teléfono<input class="i" name="phone" required maxlength="32" inputmode="tel" autocomplete="tel"></label>
<label class="f">Algo que debamos saber (opcional)<textarea class="i" name="notes" maxlength="200" rows="2"></textarea></label>
<p class="err" id="err" role="alert" hidden></p>
<button class="btn" id="go" type="submit">Reservar</button>
<p class="small">Antes de pagar te decimos cuánto es la señal y que no se devuelve.</p>
</form>`
}<script type="application/json" id="cfg">${JSON.stringify({ post: `/reservar/${code}` })}</script>`;
  return page(`Reservar · ${entry.venueName}`, body, closed ? '' : BOOK_JS);
}

// ─── La página del grupo ───────────────────────────────────────────────

const GROUP_JS = `(function(){
var C=JSON.parse(document.getElementById('cfg').textContent),busy=false;
function err(id,t){var e=document.getElementById(id);if(e){e.textContent=t;e.hidden=!t;}}
function post(url,body,eid,btn){if(busy)return;busy=true;btn.classList.add('busy');btn.disabled=true;err(eid,'');
fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
.then(function(r){return r.json().catch(function(){return{};}).then(function(j){return{ok:r.ok,j:j};});})
.then(function(x){if(x.ok){if(x.j.payUrl){location.href=x.j.payUrl;}else{location.reload();}return;}throw new Error((x.j&&x.j.message)||'No se ha podido');})
.catch(function(e){err(eid,String(e.message||e));busy=false;btn.classList.remove('busy');btn.disabled=false;});}
var pf=document.getElementById('payf');
if(pf){var ok=document.getElementById('ack'),pb=document.getElementById('payb');
function sync(){var k=pf.querySelector('input[name=kind]:checked');pb.disabled=!ok.checked||!k;if(k)pb.textContent='Pagar '+k.getAttribute('data-eur');}
pf.addEventListener('change',sync);sync();
pf.addEventListener('submit',function(ev){ev.preventDefault();var k=pf.querySelector('input[name=kind]:checked');if(!k||!ok.checked)return;post(C.pay,{kind:k.value,acceptedNoRefund:true},'payerr',pb);});}
var cf=document.getElementById('cancelf');
if(cf){var ck=document.getElementById('cack'),cb=document.getElementById('cancelb');ck.addEventListener('change',function(){cb.disabled=!ck.checked;});
cf.addEventListener('submit',function(ev){ev.preventDefault();if(!ck.checked)return;post(C.cancel,{},'cancelerr',cb);});}
var df=document.getElementById('datef');
if(df){df.addEventListener('submit',function(ev){ev.preventDefault();var v=df.querySelector('input[name=night]').value;post(C.date,{nightDate:v},'dateerr',document.getElementById('dateb'));});}
document.querySelectorAll('[data-share]').forEach(function(b){b.addEventListener('click',function(){var u=b.getAttribute('data-share');
if(navigator.share){navigator.share({title:'Tu QR del reservado',url:u}).catch(function(){});}else if(navigator.clipboard){navigator.clipboard.writeText(u).then(function(){b.textContent='Copiado';});}});});
})();`;

function payCard(v: GroupView): string {
  const r = v.reservation;
  if (v.openPayUrl) {
    return `<section class="card"><h2>Tienes un pago a medias</h2><a class="btn" href="${h(v.openPayUrl)}">Seguir pagando</a></section>`;
  }
  if (v.payable.length === 0) return '';
  const opts = v.payable
    .map((k, i) => {
      const cents = k === 'DEPOSIT' ? r.depositCents : k === 'FULL' ? r.priceCents : r.pendingCents;
      const label = k === 'DEPOSIT' ? 'Pagar la señal (30 %)' : k === 'FULL' ? 'Pagar todo ahora' : 'Pagar el resto';
      return `<label class="pk"><input type="radio" name="kind" value="${k}" data-eur="${h(eur(cents))}"${i === 0 ? ' checked' : ''}><b>${label}</b> · <b class="num">${h(eur(cents))}</b></label>`;
    })
    .join('');
  const rest = v.payable.includes('REST')
    ? `<p>Puedes pagar el resto ahora o al llegar al local.</p>`
    : `<p>Si pagas la señal, el resto (${h(eur(r.priceCents - r.depositCents))}) lo pagas antes de ir o al llegar.</p>`;
  return `<form id="payf" class="card warn">
<h2>Pagar</h2>${opts}${rest}
<p><b>La señal (${h(eur(r.depositCents))}) no se devuelve.</b> Si no vienes, la pierdes. Puedes cambiar la fecha una vez o anular la reserva (pierdes la señal), avisando con 48 horas antes de que abra el local.</p>
<p>Si pagas todo y no vienes sin avisar con 48 horas, pierdes la señal y el resto queda como saldo para otra noche (no se devuelve en dinero).</p>
<label class="chk"><input type="checkbox" id="ack"> Lo entiendo: la señal no se devuelve</label>
<p class="err" id="payerr" role="alert" hidden></p>
<button class="btn" id="payb" type="submit" disabled>Pagar</button>
</form>`;
}

function qrCard(v: GroupView, origin: string): string {
  const r = v.reservation;
  if (r.status === 'PENDING' || r.status === 'CANCELED' || r.status === 'CLIENT_CANCELED' || r.status === 'NO_SHOW') return '';
  const list = v.guestTokens
    .map((g) => {
      const url = `${origin}/reservas/q/${g.token}`;
      const guest = r.guests.find((x) => x.seq === g.seq);
      const spent = guest && guest.spentCents > 0 ? ` · ha gastado ${eur(guest.spentCents)}` : '';
      const items = guest && guest.items.length > 0 ? ` · ${guest.items.map((i) => `${i.qty} × ${i.name}`).join(', ')}` : '';
      return `<li><a href="${h(url)}">Persona ${g.seq}${h(spent)}${h(items)}</a><button class="link" type="button" data-share="${h(url)}">Compartir</button></li>`;
    })
    .join('');
  return `<section class="card"><h2>Los QR de tu grupo</h2><p>Comparte un QR con cada persona. Con cualquiera de ellos se gasta del reservado.</p><ul class="qrs">${list}</ul></section>`;
}

function leftCard(v: GroupView): string {
  const r = v.reservation;
  if (r.status !== 'ARRIVED') return '';
  const what =
    r.kind === 'CREDIT'
      ? `<p class="big">${h(eur(r.balanceCents ?? 0))}</p><p>Lo que queda para consumir. Lo que sobre queda como saldo para otra noche.</p>`
      : `<ul class="qrs">${r.itemsLeft.map((i) => `<li><span>${h(i.name)}</span><b class="num">${i.left} de ${i.qty}</b></li>`).join('')}</ul>`;
  return `<section class="card"><h2>Lo que queda</h2>${what}</section>`;
}

/** El cliente anula: sin pagar, «Cancelar»; pagada, con 48 h (pierde la señal; lo demás le queda de saldo). */
function cancelCard(v: GroupView): string {
  const r = v.reservation;
  if (!v.cancel) {
    return v.cancelBlocked ? `<p class="small">${h(v.cancelBlocked)}</p>` : '';
  }
  const paid = v.cancel === 'Anular';
  const left = r.paidCents - Math.min(r.depositCents, r.paidCents);
  const what = paid
    ? `<p><b>Pierdes la señal (${h(eur(Math.min(r.depositCents, r.paidCents)))}).</b>${left > 0 ? ` Lo demás (${h(eur(left))}) te queda como saldo para otra noche: no se devuelve en dinero.` : ''}</p>`
    : '<p>No has pagado nada: se cancela sin más.</p>';
  return `<form id="cancelf" class="card warn"><h2>${paid ? 'Anular mi reserva' : 'Cancelar la reserva'}</h2>${what}
<label class="chk"><input type="checkbox" id="cack"> ${paid ? 'Lo entiendo: pierdo la señal' : 'Sí, quiero cancelarla'}</label>
<p class="err" id="cancelerr" role="alert" hidden></p><button class="btn alt" id="cancelb" type="submit" disabled>${paid ? 'Anular mi reserva' : 'Cancelar la reserva'}</button></form>`;
}

function dateCard(v: GroupView, minDay: string, maxDay: string): string {
  if (!v.canChangeDate) return '';
  return `<form id="datef" class="card"><h2>Cambiar la fecha</h2><p>Solo una vez y avisando con 48 horas.</p>
<label class="f">Nueva noche<input class="i" type="date" name="night" required min="${minDay}" max="${maxDay}"></label>
<p class="err" id="dateerr" role="alert" hidden></p><button class="btn alt" id="dateb" type="submit">Cambiar la fecha</button></form>`;
}

export function renderGroupPage(token: string, v: GroupView, origin: string, minDay: string, maxDay: string): string {
  const r = v.reservation;
  const ok = r.status === 'PAID' || r.status === 'ARRIVED';
  const saldo = v.saldoHref
    ? `<section class="card"><h2>Tu saldo para otra noche</h2><p>Te queda saldo en ${h(v.venueName)}. No caduca y no se devuelve en dinero.</p><a class="btn alt" href="${h(v.saldoHref)}">Ver mi saldo</a></section>`
    : '';
  const canceled =
    r.status === 'CANCELED' && r.paidCents > 0
      ? `<p>El local ha anulado la reserva: te devolverán ${h(eur(r.paidCents))}.</p>`
      : r.status === 'CLIENT_CANCELED'
        ? '<p>Has anulado la reserva: la señal no se devuelve.</p>'
        : '';
  const body = `<section><h1>Tu reservado en ${h(v.venueName)}</h1><p><span class="pill${ok ? ' ok' : ''}">${h(r.statusText)}</span> · Referencia <b class="num">${h(r.ref)}</b></p></section>
<section class="card">
<div class="row"><span>Noche</span><b>${h(nightText(r.nightDate))}</b></div>
<div class="row"><span>Reservado</span><b>${h(r.packageName)}</b></div>
<div class="row"><span>Personas</span><b>${r.entries}</b></div>
${r.tableLabel ? `<div class="row"><span>Mesa</span><b>${h(r.tableLabel)}</b></div>` : ''}
<div class="row"><span>Total</span><b>${h(eur(r.priceCents))}</b></div>
<div class="row"><span>Pagado</span><b>${h(eur(r.paidCents))}</b></div>
${r.pendingCents > 0 && (r.status === 'PENDING' || r.status === 'DEPOSIT_PAID') ? `<div class="row"><span>Falta</span><b>${h(eur(r.pendingCents))}</b></div>` : ''}
${canceled}</section>
${payCard(v)}${leftCard(v)}${qrCard(v, origin)}${saldo}${dateCard(v, minDay, maxDay)}${cancelCard(v)}
<p class="small">Guarda este enlace: es tu reservado.</p>
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
        : `<ul class="qrs">${v.itemsLeft.map((i) => `<li><span>${h(i.name)}</span><b class="num">${i.left} de ${i.qty}</b></li>`).join('')}</ul>`;
  const body = `<section><h1>${h(v.venueName)}</h1><p>${h(v.packageName)} · ${h(nightText(v.nightDate))}</p></section>
<section class="card"><p class="small">Persona ${v.seq} de ${v.entries} · <span class="pill">${h(v.statusText)}</span></p>
<img class="qrimg" src="${qrPngDataUrl}" width="288" height="288" alt="QR de la persona ${v.seq} del reservado">
${left}${v.mySpentCents > 0 ? `<p>Has gastado ${h(eur(v.mySpentCents))}.</p>` : ''}</section>`;
  return page(`Tu QR · ${v.venueName}`, body);
}
