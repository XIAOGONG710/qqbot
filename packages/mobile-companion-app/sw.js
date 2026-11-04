const CACHE = 'qqbot-companion-static-v5';
const ASSETS = ['./', './index.html', './app.js', './action-links.js', './photo-review-view.js', './replay-window.js', './style.css', './manifest.webmanifest'];
const STATIC_URLS = new Set(ASSETS.map(asset => new URL(asset, self.location.href).href));
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))));
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  // 只缓存本伴侣页面的固定资源；动作轮询、Koishi API 和其他同源 GET 必须走网络。
  if (request.method !== 'GET' || url.origin !== self.location.origin || !STATIC_URLS.has(url.href)) return;
  event.respondWith(caches.match(request).then(cached => cached ?? fetch(request).then(response => {
    const copy = response.clone();
    void caches.open(CACHE).then(cache => cache.put(request, copy));
    return response;
  })));
});
