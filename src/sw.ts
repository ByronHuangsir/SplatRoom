import { version as appVersion } from '../package.json';

// export default null
declare let self: ServiceWorkerGlobalScope;

const cacheName = `splatRoom-v${appVersion}`;

const cacheUrls = [
    './',
    './index.css',
    './index.html',
    './index.js',
    './index.js.map',
    './manifest.json',
    './static/icons/logo-192.png',
    './static/icons/logo-512.png',
    './static/images/screenshot-narrow.jpg',
    './static/images/screenshot-wide.jpg',
    './static/lib/webp/webp.mjs',
    './static/lib/webp/webp.wasm',
    './static/locales/de.json',
    './static/locales/en.json',
    './static/locales/fr.json',
    './static/locales/ja.json',
    './static/locales/ko.json',
    './static/locales/zh-CN.json'
];

// Check if we're running on localhost / 127.0.0.1 (dev or Electron)
const isLocal = () => {
    try {
        return self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1';
    } catch {
        return false;
    }
};

self.addEventListener('install', (event) => {
    console.log(`installing v${appVersion}`);

    // Force immediate activation (skip waiting state)
    self.skipWaiting();

    // On localhost: skip caching entirely and self-destruct
    if (isLocal()) {
        self.skipWaiting();
        event.waitUntil(
            caches.keys().then(names => Promise.all(names.map(n => caches.delete(n))))
        );
        return;
    }

    // create cache for current version
    event.waitUntil(
        caches.open(cacheName)
        .then((cache) => {
            cache.addAll(cacheUrls);
        })
    );
});

self.addEventListener('activate', (event) => {
    console.log(`activating v${appVersion}`);

    // Take control of all clients immediately
    self.clients.claim();

    // On localhost: unregister self and clear all caches
    if (isLocal()) {
        event.waitUntil(
            caches.keys().then(names => Promise.all(names.map(n => caches.delete(n))))
                .then(() => self.registration.unregister())
                .then(() => self.clients.matchAll())
                .then(clients => clients.forEach(c => c.navigate(c.url)))
        );
        return;
    }

    // delete the old caches once this one is activated
    event.waitUntil(
        caches.keys().then((names) => {
            return Promise.all(
                names.map((name) => {
                    if (name !== cacheName) {
                        return caches.delete(name);
                    }
                })
            );
        })
    );
});

self.addEventListener('fetch', (event) => {
    // On localhost: always fetch from network (bypass cache)
    if (isLocal()) {
        event.respondWith(fetch(event.request));
        return;
    }

    event.respondWith(
        caches.match(event.request)
        .then(response => response ?? fetch(event.request))
    );
});
