// Minimal service worker — required for PWA installability
// Chrome requires a fetch handler to consider the app installable
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));
