'use strict';
// Rental phone screen inside the common app. Scope '/', so an item page opened from a QR label or FeliCa
// card (/i/<code>) loads without a connection; every other page of the common app is left to the network.
const CACHE = 'iyakusai-rental-shell-20261026-v21-contacts-tab';
const ASSETS = ['/rental', '/rental/app.js', '/rental/styles.css', '/rental/manifest.webmanifest', '/rental/icon.svg', '/rental/vendor/jsQR.js'];
const isRentalPage = (path) => path === '/rental' || path === '/rental/' || /^\/i\/IY-[A-Z0-9-]+$/.test(path);
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('iyakusai-rental-shell-') && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    if (isRentalPage(url.pathname)) event.respondWith(fetch(event.request).catch(() => caches.match('/rental')));
    return;
  }
  if (!ASSETS.includes(url.pathname)) return;
  event.respondWith(caches.match(url.pathname).then((cached) => cached || fetch(event.request).then(async (response) => { if (response.ok) (await caches.open(CACHE)).put(url.pathname, response.clone()); return response; })));
});
