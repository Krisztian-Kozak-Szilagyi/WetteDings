// Service Worker nur, damit die Seite als App installierbar ist. Er speichert nichts zwischen –
// die App lädt alles wie die Webseite aus dem Netz (ohne Internet geht sie nicht).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
