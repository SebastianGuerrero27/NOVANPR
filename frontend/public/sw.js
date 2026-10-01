/* Service worker del Sistema ANPR · notificaciones Web Push (W3C Push API, RFC 8030/8291/8292).
 *
 * Recibe las alarmas del backend aunque la pestaña esté cerrada o en segundo plano y las muestra
 * como notificaciones del sistema operativo. Si hay una ventana del sistema visible y enfocada,
 * no duplica el aviso: la aplicación ya lo muestra por Socket.IO.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (evento) => {
  let d = {};
  try { d = evento.data ? evento.data.json() : {}; } catch (_) { d = { titulo: 'Sistema ANPR', mensaje: evento.data ? evento.data.text() : '' }; }
  evento.waitUntil((async () => {
    const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const enPantalla = ventanas.some((c) => c.visibilityState === 'visible' && c.focused);
    if (enPantalla && d.id) {
      ventanas.forEach((c) => c.postMessage({ tipo: 'anpr:push', datos: d }));
      return;
    }
    const urgente = d.severidad === 'critica' || d.severidad === 'alta';
    await self.registration.showNotification(d.titulo || 'Sistema ANPR', {
      body: d.mensaje || '',
      tag: d.id ? `anpr-${d.id}` : 'anpr',
      renotify: true,
      requireInteraction: urgente,
      icon: '/icono-anpr.png',
      badge: '/icono-anpr.png',
      vibrate: urgente ? [300, 120, 300, 120, 300] : [150],
      timestamp: Date.now(),
      data: { enlace: d.enlace || '/notificaciones', id: d.id },
    });
  })());
});

self.addEventListener('notificationclick', (evento) => {
  evento.notification.close();
  const destino = new URL(evento.notification.data?.enlace || '/', self.location.origin).href;
  evento.waitUntil((async () => {
    const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of ventanas) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        c.postMessage({ tipo: 'anpr:navegar', enlace: evento.notification.data?.enlace || '/notificaciones' });
        return;
      }
    }
    await self.clients.openWindow(destino);
  })());
});
