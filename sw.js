/* sw.js — แคชไฟล์ทั้งหมดไว้ในเครื่อง เพื่อให้ใช้งานได้โดยไม่ต้องต่อเน็ต
   เมื่อแก้ไฟล์ใด ๆ ให้เพิ่มเลข VERSION เพื่อให้มือถือโหลดของใหม่ */
const VERSION = 'v1';
const CACHE = 'scanner-' + VERSION;
const FILES = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'scan.js',
  'pdf.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('scanner-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => {
      if (hit) return hit;
      return fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => req.mode === 'navigate' ? caches.match('index.html') : Response.error());
    })
  );
});
