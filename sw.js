// Minimal Service Worker to satisfy PWA install requirements
self.addEventListener('install', (e) => {
    console.log('[Service Worker] Installed');
});

self.addEventListener('fetch', (e) => {
    // Pass-through fetch (no offline caching yet)
});