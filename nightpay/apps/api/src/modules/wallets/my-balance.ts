import { escapeHtml, jsConfig } from '../payments/club-ui';
import type { PayLanguage } from '../payments/customer-lang';
import { PASSKEY_BROWSER_JS } from './passkey-browser';
import { customerPage } from '../payments/customer-page';
import { PAY_TEXT } from '../payments/pay-i18n';

/**
 * «Ver mi saldo» en las pantallas del cliente que terminan sin saber de quién
 * es el saldo (un QR ya pagado, pagado con tarjeta o caducado, un enlace de
 * activación usado, una ficha bloqueada, la salida confirmada…): el cliente
 * desbloquea su móvil (Face ID o huella) y va a SU saldo (POST /w/mine, que
 * abre la sesión de consulta como /w/card/:token/view). Sin llave en este
 * navegador, el botón no sale. Va dentro de plantillas de TypeScript: sin
 * barras invertidas.
 */

export const MY_BALANCE_BASE = '/w/mine';

interface MyBalanceText {
  button: string;
  waiting: string;
  cancelled: string;
  /** Este móvil no tiene la llave de ningún saldo. */
  none: string;
  expired: string;
  rateLimited: string;
  error: string;
}

export const MY_BALANCE_TEXT: Readonly<Record<PayLanguage, MyBalanceText>> = {
  es: {
    button: 'Ver mi saldo',
    waiting: 'Abriendo tu saldo…',
    cancelled: 'No se ha abierto: vuelve a tocar «Ver mi saldo».',
    none: 'Este móvil no tiene un saldo con Face ID o huella. Ábrelo con el enlace de tu recarga o pregunta en recepción.',
    expired: 'Ha tardado demasiado: vuelve a tocar.',
    rateLimited: 'Demasiados intentos: espera un minuto.',
    error: 'No se ha podido abrir tu saldo. Inténtalo otra vez.',
  },
  en: {
    button: 'See my balance',
    waiting: 'Opening your balance…',
    cancelled: 'It didn’t open: tap “See my balance” again.',
    none: 'This phone has no balance with Face ID or fingerprint. Open it with the link from your top-up or ask at reception.',
    expired: 'It took too long: tap again.',
    rateLimited: 'Too many attempts: wait a minute.',
    error: 'Your balance couldn’t be opened. Try again.',
  },
  fr: {
    button: 'Voir mon solde',
    waiting: 'Ouverture de votre solde…',
    cancelled: 'Rien ne s’est ouvert : touchez à nouveau « Voir mon solde ».',
    none: 'Ce téléphone n’a pas de solde avec Face ID ou empreinte. Ouvrez-le avec le lien de votre recharge ou demandez à l’accueil.',
    expired: 'C’était trop long : touchez à nouveau.',
    rateLimited: 'Trop d’essais : attendez une minute.',
    error: 'Impossible d’ouvrir votre solde. Réessayez.',
  },
  pt: {
    button: 'Ver o meu saldo',
    waiting: 'A abrir o seu saldo…',
    cancelled: 'Não abriu: toque outra vez em «Ver o meu saldo».',
    none: 'Este telefone não tem saldo com Face ID ou impressão digital. Abra-o com o link da sua recarga ou pergunte na receção.',
    expired: 'Demorou demasiado: toque outra vez.',
    rateLimited: 'Demasiadas tentativas: espere um minuto.',
    error: 'Não foi possível abrir o seu saldo. Tente outra vez.',
  },
};

/** El botón (oculto hasta que el JS sabe que el móvil tiene llave) y su línea de error. */
export function myBalanceButton(lang: PayLanguage): string {
  return `<button class="btn alt" type="button" id="npMine" hidden>${escapeHtml(MY_BALANCE_TEXT[lang].button)}</button><p class="err" id="npMineErr" role="alert" hidden></p>`;
}

/**
 * Define npMineShow(on): enseña el botón (si el móvil tiene llave) y prepara
 * el reto, para que Face ID salga en el mismo toque (lo exige el iPhone).
 * `visible`: lo enseña ya al cargar; `showIf`: una expresión JS de la página
 * que dice si enseñarlo al cargar (la página del saldo, que pinta antes).
 * Necesita PASSKEY_BROWSER_JS en la página (`withPasskeyJs` lo trae, para
 * las que no lo llevan).
 */
export function myBalanceScript(
  lang: PayLanguage,
  opts: { visible?: boolean; showIf?: string; withPasskeyJs?: boolean } = {},
): string {
  const config = jsConfig({ base: MY_BALANCE_BASE, lang, t: MY_BALANCE_TEXT[lang] });
  return `<script>
${opts.withPasskeyJs ? PASSKEY_BROWSER_JS : ''}
var npMineShow=(function(){'use strict';var C=JSON.parse(${config}),b=document.getElementById('npMine'),e=document.getElementById('npMineErr'),prep=null,busy=false;
if(!b)return function(){};
function msg(text){if(e){e.textContent=text;e.hidden=!text;}}
function arm(){prep=pkPrepare(C.base+'/challenge');}
function go(url){var d=new URL(url,window.location.origin),p=d.pathname.split('/');
 if(d.origin!==window.location.origin||p.length!==3||p[1]!=='w'||!/^[A-Za-z0-9_-]+$/.test(p[2]))throw new Error('invalid destination');
 window.location.assign(d.pathname+'?lang='+encodeURIComponent(C.lang));}
b.addEventListener('click',function(){if(busy)return;if(!prep)arm();var run=prep;prep=null;busy=true;b.disabled=true;b.textContent=C.t.waiting;msg('');
 run().then(function(r){return pkPost(C.base,{response:r});}).then(function(res){go(res&&res.url);})
 .catch(function(err){msg(pkCancelled(err)?C.t.cancelled:err.code==='FACE_ID_UNKNOWN'||err.status===404?C.t.none:err.code==='FACE_ID_TIMEOUT'||err.code==='FACE_ID_USED'?C.t.expired:err.status===429?C.t.rateLimited:C.t.error);
  busy=false;b.disabled=false;b.textContent=C.t.button;arm();});});
return function(on){var show=Boolean(on)&&pkSupported();b.hidden=!show;if(!show)msg('');if(show&&!prep)arm();};})();
${opts.visible ? 'npMineShow(true);' : opts.showIf ? `npMineShow(${opts.showIf});` : ''}
</script>`;
}

/** Botón y su script juntos, para una pantalla que termina (se ve al cargar). */
export function myBalanceBlock(lang: PayLanguage, opts: { withPasskeyJs?: boolean } = {}): string {
  return `${myBalanceButton(lang)}${myBalanceScript(lang, { visible: true, ...opts })}`;
}

/** GET /w/mine (idea 73): la puerta «Ver mi saldo» de la portada. */
interface MyBalancePageText {
  title: string;
  lead: string;
  /** Sin la llave en este móvil (o sin JavaScript): los otros caminos. */
  help: string;
}

export const MY_BALANCE_PAGE_TEXT: Readonly<Record<PayLanguage, MyBalancePageText>> = {
  es: {
    title: 'Tu saldo',
    lead: 'Desbloquea tu móvil para ver tu saldo.',
    help: '¿No se abre? Acerca tu ficha al móvil o abre el enlace de tu recarga.',
  },
  en: {
    title: 'Your balance',
    lead: 'Unlock your phone to see your balance.',
    help: 'Not opening? Hold your NFC tag to your phone or open the link from your top-up.',
  },
  fr: {
    title: 'Votre solde',
    lead: 'Déverrouillez votre téléphone pour voir votre solde.',
    help: 'Rien ne s’ouvre ? Approchez votre badge NFC du téléphone ou ouvrez le lien de votre recharge.',
  },
  pt: {
    title: 'O seu saldo',
    lead: 'Desbloqueie o telefone para ver o seu saldo.',
    help: 'Não abre? Aproxime a sua tag NFC do telefone ou abra o link da sua recarga.',
  },
};

/**
 * La página de «Ver mi saldo» que abre la portada: sin datos de nadie (no
 * sabe de quién es el saldo hasta que la llave lo dice, POST /w/mine). Sin
 * JavaScript o sin llave en este móvil, el botón no sale y queda la ayuda.
 */
export function renderMyBalancePage(lang: PayLanguage): string {
  const t = MY_BALANCE_PAGE_TEXT[lang];
  const body = `<h1>${escapeHtml(t.title)}</h1>
<p>${escapeHtml(t.lead)}</p>
${myBalanceBlock(lang, { withPasskeyJs: true })}
<p class="small">${escapeHtml(t.help)}</p>`;
  return customerPage(PAY_TEXT[lang], t.title, body);
}
