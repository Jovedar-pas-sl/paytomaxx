/**
 * JS del navegador para la llave del cliente (passkey: Face ID, huella o el
 * PIN de su teléfono), compartido por las páginas del saldo, del cobro con QR
 * y de "Pagado". El navegador habla en bytes y el API en base64url.
 *
 * Va dentro de plantillas de TypeScript: sin barras invertidas (se perderían).
 * Define en la página: pkSupported(), pkCreate(base), pkGet(base) y
 * pkPost(url, body), donde `base` es la ruta a la que se añaden
 * /options (crear) o /challenge (pagar) y el POST final.
 */
export const PASSKEY_BROWSER_JS = `
function pkB64u(buf){var s='',b=new Uint8Array(buf);for(var i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);return btoa(s).split('+').join('-').split('/').join('_').split('=').join('');}
function pkBytes(s){s=s.split('-').join('+').split('_').join('/');while(s.length%4)s+='=';var b=atob(s),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u.buffer;}
function pkSupported(){return !!(window.PublicKeyCredential&&navigator.credentials);}
function pkCancelled(e){return e&&(e.name==='NotAllowedError'||e.name==='AbortError');}
function pkPost(url,body){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})})
  .then(function(r){return r.json().catch(function(){return {};}).then(function(j){if(!r.ok)throw new Error(j.detail||j.message||'Error');return j;});});}
function pkCreate(optionsUrl){return pkPost(optionsUrl).then(function(o){
  o.challenge=pkBytes(o.challenge);o.user.id=pkBytes(o.user.id);(o.excludeCredentials||[]).forEach(function(c){c.id=pkBytes(c.id);});
  return navigator.credentials.create({publicKey:o});
 }).then(function(c){var r=c.response;return {id:c.id,rawId:pkB64u(c.rawId),type:c.type,
  response:{clientDataJSON:pkB64u(r.clientDataJSON),attestationObject:pkB64u(r.attestationObject),transports:r.getTransports?r.getTransports():[]},
  authenticatorAttachment:c.authenticatorAttachment||undefined,clientExtensionResults:c.getClientExtensionResults()};});}
function pkGet(challengeUrl){return pkPost(challengeUrl).then(function(o){
  o.challenge=pkBytes(o.challenge);(o.allowCredentials||[]).forEach(function(c){c.id=pkBytes(c.id);});
  return navigator.credentials.get({publicKey:o});
 }).then(function(c){var r=c.response;return {id:c.id,rawId:pkB64u(c.rawId),type:c.type,
  response:{clientDataJSON:pkB64u(r.clientDataJSON),authenticatorData:pkB64u(r.authenticatorData),signature:pkB64u(r.signature),userHandle:r.userHandle?pkB64u(r.userHandle):undefined},
  authenticatorAttachment:c.authenticatorAttachment||undefined,clientExtensionResults:c.getClientExtensionResults()};});}
`;
