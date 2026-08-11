// ============================================================
//  SERVICE WORKER — Los Cumpas
//  Dedicado exclusivamente a recibir notificaciones push (avisos
//  de productos por vencer, etc.) aunque la app esté cerrada, y a
//  abrir la PWA cuando el usuario toca la notificación.
//  No maneja caché de archivos ni funciona offline — la app ya
//  guarda su propio estado en localStorage (ver index.html).
// ============================================================

self.addEventListener('install', () => {
  self.skipWaiting(); // activa esta versión de inmediato, sin esperar a cerrar pestañas viejas
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim()); // toma control de la página ya abierta sin recargar
});

// Llega un push cifrado desde el Worker (backend) — se descifra solo (el navegador
// lo hace automáticamente antes de disparar este evento) y se muestra como
// notificación del sistema.
self.addEventListener('push', (event) => {
  let data = { title: 'Los Cumpas', body: 'Tienes un aviso nuevo', url: './' };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (e) {
    // si el payload no es JSON válido, se usa el texto plano como cuerpo
    try { data.body = event.data.text(); } catch (e2) {}
  }

  const options = {
    body: data.body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: data.url || './' },
    vibrate: [100, 50, 100],
    tag: 'los-cumpas-aviso', // agrupa notificaciones sucesivas en vez de apilarlas
    renotify: true
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

// El usuario tocó la notificación — enfoca una pestaña ya abierta de la app si
// existe, o abre una nueva. La URL se resuelve contra el scope real del Service
// Worker (no un dominio fijo), para que funcione igual en GitHub Pages o donde
// esté publicada la PWA.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destino = new URL(event.notification.data && event.notification.data.url || './', self.registration.scope).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(destino);
    })
  );
});
