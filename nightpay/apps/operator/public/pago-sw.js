'use strict';
// «Te han pagado» (Web Push): enseña el aviso del pago aunque la app esté
// cerrada. Sin caché ni fetch: no cambia cómo carga la app.
self.addEventListener('install', function () {
  self.skipWaiting();
});
self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim());
});
self.addEventListener('push', function (e) {
  var d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch (x) {
    d = {};
  }
  e.waitUntil(
    self.registration.showNotification(String(d.title || 'OxioPay'), {
      body: String(d.body || ''),
      tag: d.tag ? String(d.tag) : undefined,
      icon: '/icons/icon-192.png',
      data: { url: d.url },
    }),
  );
});
// Lo que no puede ir detrás de la primera barra: otra barra o la barra invertida (el navegador
// las lee como «//otro.sitio»).
var NOT_SECOND = '/' + String.fromCharCode(92);
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = e.notification.data && e.notification.data.url;
  // Solo una página de esta app, nunca otro sitio.
  var ok = typeof url === 'string' && url.length > 1 && url.charAt(0) === '/' && NOT_SECOND.indexOf(url.charAt(1)) < 0;
  e.waitUntil(self.clients.openWindow(ok ? url : '/'));
});
