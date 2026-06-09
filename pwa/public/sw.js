const CACHE_NAME = "rss-triage-v38";
const ASSETS = ["/", "/index.html", "/styles.css", "/app.js", "/manifest.json"];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Network-first: always try fresh files, fall back to cache only when offline
self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET and external API calls
    if (event.request.method !== "GET") return;
    if (url.hostname.includes("github") || url.hostname.includes("firebase") || url.hostname.includes("googleapis")) return;

    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Cache the fresh response for offline use
                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                return response;
            })
            .catch(() => {
                // Offline — serve from cache
                return caches.match(event.request);
            })
    );
});
