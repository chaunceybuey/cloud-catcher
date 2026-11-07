const CACHE_NAME = "rss-triage-v46";
const ASSETS = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.json"];

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
        ).then(() => self.clients.claim())
    );
});

// Network-first: always try fresh files, fall back to cache only when offline
self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET and external API / auth calls
    if (event.request.method !== "GET") return;
    if (
        url.hostname.includes("github") ||
        url.hostname.includes("firebase") ||
        url.hostname.includes("googleapis") ||
        url.hostname.includes("script.google.com") ||
        url.pathname.startsWith("/__/")          // Firebase Hosting auth handler
    ) return;

    // (Navigation requests can't take fetch options — passing any throws.)
    const sameOrigin = url.origin === self.location.origin && event.request.mode !== "navigate";

    event.respondWith(
        // For our own files, revalidate with the server instead of trusting the
        // browser's HTTP cache (firebase.json sets max-age=3600 on .js, which
        // otherwise keeps serving a stale app.js for up to an hour).
        fetch(event.request, sameOrigin ? { cache: "no-cache" } : undefined)
            .then(response => {
                // Only cache good responses (opaque CDN scripts report status 0)
                if (response.ok || response.type === "opaque") {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(async () => {
                const cached = await caches.match(event.request);
                if (cached) return cached;
                // Offline navigation to any path → serve the app shell
                if (event.request.mode === "navigate") {
                    const shell = await caches.match("./index.html");
                    if (shell) return shell;
                }
                return new Response("Offline", { status: 503, statusText: "Offline" });
            })
    );
});
