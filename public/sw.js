// Service worker mínimo: permite instalar la app en el celular.
// No guarda copias de las páginas, así siempre se ve la última versión publicada.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
