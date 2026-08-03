/* МОРСКОЙ БОЙ 3D — service worker.
   Стратегия: app shell и статика — cache-first, всё остальное — network-first.
   Сетевые запросы к LLM никогда не кэшируются. */
const VERSION = 'seabattle-v3-online';
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-64.png',
  './icons/favicon-32.png'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    // Не валим установку, если один файл недоступен.
    await Promise.all(CORE.map(u => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Навигация: сначала сеть, при офлайне — кэш
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const net = await fetch(req);
        const c = await caches.open(VERSION);
        c.put('./index.html', net.clone());
        return net;
      } catch (err) {
        return (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  const isCdn = /unpkg\.com|jsdelivr\.net|cdn\.skypack\.dev|esm\.sh/.test(url.hostname);

  // Статика своего оригина и библиотеки с CDN (three.js) — cache-first
  if (sameOrigin || isCdn) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const net = await fetch(req);
        if (net && (net.ok || net.type === 'opaque')) {
          const c = await caches.open(VERSION);
          c.put(req, net.clone());
        }
        return net;
      } catch (err) {
        return hit || Response.error();
      }
    })());
  }
});
