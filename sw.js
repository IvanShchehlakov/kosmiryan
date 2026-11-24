// Service worker: офлайн-кэш. Версия и список файлов подставляются при сборке.
const VERSION = "f1e9145c5088";
const CACHE = "bd0712-" + VERSION;
const ASSETS = ["./","./css/style.css","./data.json","./fonts/jbm-cyrillic-400.woff2","./fonts/jbm-cyrillic-700.woff2","./fonts/jbm-latin-400.woff2","./fonts/jbm-latin-700.woff2","./icon.svg","./index.html","./js/app.js","./js/cosmos.js","./js/fx.js","./js/normalize.js","./js/sky.js","./js/sky3d.js","./js/vendor/three.module.min.js","./manifest.webmanifest","./sky-catalog.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("bd0712-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// HTML и data.json — сначала сеть (чтобы обновления доходили), остальное — сначала кэш.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const networkFirst = e.request.mode === "navigate" || url.pathname.endsWith("/data.json");
  if (networkFirst) {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return r;
        })
        .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("./"))),
    );
  } else {
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)));
  }
});
