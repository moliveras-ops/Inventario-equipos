const CACHE = "inventario-v1.26";
const CDN = ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "www.gstatic.com"];
const ARCHIVOS = [
  "./", "index.html", "sync.js", "firebase-config.js", "manifest.json", "icon-192.png", "icon-512.png", "logo-iqs.png", "logo-iqs-sello.png", "logo-iqs-hd.png",
  "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js",
  "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
  "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js",
  "https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c =>
    Promise.all(ARCHIVOS.map(u => c.add(new Request(u, { cache: "reload" })).catch(() => {})))
  ));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks =>
    Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

// Archivos propios: siempre se pide la última versión al servidor (sin caché del navegador).
// Si no hay señal, se usa la copia guardada.
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const u = new URL(e.request.url);
  const propio = u.origin === self.location.origin;
  // Solo se cachean archivos de la app y librerías. Las conexiones de Firebase (datos y login) no pasan por aquí.
  if (!propio && !CDN.includes(u.hostname)) return;
  e.respondWith(
    fetch(propio ? new Request(e.request, { cache: "no-store" }) : e.request)
      .then(r => { const copia = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copia)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
