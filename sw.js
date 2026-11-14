// ORİMAK Takip — bildirim servis çalışanı
// Yalnızca telefon bildirimi içindir. Sayfayı/dosyaları ÖNBELLEĞE ALMAZ
// (fetch dinleyicisi yok) → site güncellemeleri her zamanki gibi gelir.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (e) {
  var v = {};
  try { v = e.data ? e.data.json() : {}; } catch (err) { v = { govde: e.data ? e.data.text() : '' }; }
  var baslik = v.baslik || 'ORİMAK Takip';
  e.waitUntil(self.registration.showNotification(baslik, {
    body: v.govde || '',
    icon: 'icon-192.png',
    badge: 'favicon-64.png',
    tag: v.id ? 'not-' + v.id : undefined,
    renotify: !!v.id,
    data: { id: v.id || null }
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var id = e.notification.data && e.notification.data.id;
  var hedef = new URL(id ? './?not=' + encodeURIComponent(id) : './?not=1', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (liste) {
    for (var i = 0; i < liste.length; i++) {
      if (liste[i].url.indexOf(self.registration.scope) === 0) {
        liste[i].postMessage({ tip: 'not-ac', id: id || null });
        return liste[i].focus();
      }
    }
    return self.clients.openWindow(hedef);
  }));
});
