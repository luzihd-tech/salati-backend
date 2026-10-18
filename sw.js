// Prayer Spot — service worker minimal (nécessaire pour que Chrome propose « Installer »).
// Il ne met RIEN en cache : l'app est toujours chargée en ligne, dans sa dernière version.
// Seule exception : sans connexion, on affiche une petite page « Pas de connexion ».
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return; // tout le reste passe normalement par le réseau
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Prayer Spot</title><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:#f8f9fa;color:#0d1f18;text-align:center;padding:24px">' +
    '<div><div style="font-size:20px;font-weight:800;margin-bottom:8px">Pas de connexion</div>' +
    '<div style="color:#7a8f86;margin-bottom:20px">Vérifie ta connexion internet puis réessaie.</div>' +
    '<button onclick="location.reload()" style="background:#0d6e47;color:#fff;border:none;border-radius:12px;padding:12px 22px;font-size:15px;font-weight:700">Réessayer</button></div></body></html>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  )));
});
