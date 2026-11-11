// Service Worker：只缓存 App 自己的静态文件，让它离线也能打开。
// `/api/*`（配对、媒体、历史）和 `/ws` 一律不碰、不缓存；聊天内容只在页面自己的 IndexedDB 里。
const CACHE = 'chat-app-static-v1';
const ASSETS = [
    './', './index.html', './style.css', './app.js', './manifest.webmanifest',
    './src/connection.js', './src/format.js', './src/outbox.js', './src/pairing.js', './src/protocol.js', './src/store.js', './src/timeline.js',
    './ui/db.js', './ui/dom.js', './ui/media.js', './ui/recorder.js', './ui/render.js',
    './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/badge-96.png',
];
const STATIC_URLS = new Set(ASSETS.map(asset => new URL(asset, self.location.href).href));
const INDEX_URL = new URL('./index.html', self.location.href).href;

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS.map(asset => new Request(asset, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil(caches.keys()
        .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
        .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
    const key = request.mode === 'navigate' ? INDEX_URL : url.href.split('?')[0];
    if (!STATIC_URLS.has(key)) return;
    // 先走网络拿最新的（中继就在自己家里，很快），3 秒没回音或离线就用缓存
    event.respondWith((async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(key);
        const fresh = fetch(request, { cache: 'no-cache' }).then(response => {
            if (response.ok && response.type === 'basic') void cache.put(key, response.clone());
            return response;
        });
        if (!cached) return fresh;
        fresh.catch(() => {});
        const timeout = new Promise(resolve => setTimeout(() => resolve(undefined), 3000));
        const winner = await Promise.race([fresh.catch(() => undefined), timeout]);
        return winner && winner.ok ? winner : cached;
    })());
});

// 点通知回到聊天
self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        const open = clients.find(client => 'focus' in client);
        return open ? open.focus() : self.clients.openWindow('./');
    }));
});
