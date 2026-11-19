/* Service worker mínimo: solo existe para que Chrome permita instalar la webapp.
 * No guarda nada en caché: el HUD necesita datos en vivo de la PC. */
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
  event.respondWith(fetch(event.request));
});
