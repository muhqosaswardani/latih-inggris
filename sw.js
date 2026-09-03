// LATIH. - Service Worker
// Tugas: bikin app bisa di-install & tetap kebuka (shell-nya) walau offline.
// Data/API request (POST ke Worker Gemini) SENGAJA tidak di-cache di sini.

const CACHE_NAME = 'latih-shell-v1.5.5';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_NAME; })
          .map(function (k) { return caches.delete(k); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;

  // Jangan sentuh request non-GET (mis. POST ke Cloudflare Worker/Gemini)
  if (req.method !== 'GET') return;

  // Jangan cache request lintas-origin (API, fonts eksternal) - biarkan network normal
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // App shell: network-first, fallback ke cache kalau offline
  event.respondWith(
    fetch(req).then(function (res) {
      const resClone = res.clone();
      caches.open(CACHE_NAME).then(function (cache) {
        cache.put(req, resClone);
      });
      return res;
    }).catch(function () {
      return caches.match(req).then(function (cached) {
        return cached || caches.match('./index.html');
      });
    })
  );
});
