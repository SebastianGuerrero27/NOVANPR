import api from './api';

/**
 * Suscripción Web Push del navegador (canal para alarmas con la pestaña cerrada o en segundo
 * plano). Requiere contexto seguro: https o http://localhost. El service worker vive en
 * /sw.js y la clave pública VAPID la entrega el backend.
 */

export type EstadoPush = 'no_soportado' | 'inseguro' | 'deshabilitado' | 'denegado' | 'activo' | 'inactivo';

export const pushSoportado = () =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function claveBinaria(base64: string): Uint8Array<ArrayBuffer> {
  const relleno = '='.repeat((4 - (base64.length % 4)) % 4);
  const b = atob((base64 + relleno).replace(/-/g, '+').replace(/_/g, '/'));
  const salida = new Uint8Array(new ArrayBuffer(b.length));
  for (let i = 0; i < b.length; i++) salida[i] = b.charCodeAt(i);
  return salida;
}

let registro: Promise<ServiceWorkerRegistration> | null = null;

export function registrarServiceWorker(): Promise<ServiceWorkerRegistration> | null {
  if (!pushSoportado() || !window.isSecureContext) return null;
  registro ??= navigator.serviceWorker.register('/sw.js');
  return registro;
}

async function suscripcionActual(): Promise<PushSubscription | null> {
  const r = registrarServiceWorker();
  if (!r) return null;
  return (await r).pushManager.getSubscription();
}

export async function estadoPush(): Promise<EstadoPush> {
  if (!pushSoportado()) return 'no_soportado';
  if (!window.isSecureContext) return 'inseguro';
  const { data } = await api.get('/notificaciones/push/clave');
  if (!data.habilitado || !data.clave_publica) return 'deshabilitado';
  if (Notification.permission === 'denied') return 'denegado';
  return (await suscripcionActual()) && Notification.permission === 'granted' ? 'activo' : 'inactivo';
}

const enviar = (s: PushSubscription) => api.post('/notificaciones/push/suscripcion', s.toJSON());

export async function activarPush(): Promise<EstadoPush> {
  if (!pushSoportado()) return 'no_soportado';
  if (!window.isSecureContext) return 'inseguro';
  const permiso = await Notification.requestPermission();
  if (permiso !== 'granted') return permiso === 'denied' ? 'denegado' : 'inactivo';
  const { data } = await api.get('/notificaciones/push/clave');
  if (!data.habilitado || !data.clave_publica) return 'deshabilitado';
  const r = await registrarServiceWorker()!;
  let s = await r.pushManager.getSubscription();
  // Si la clave del servidor cambió, la suscripción anterior ya no sirve
  const clave = claveBinaria(data.clave_publica);
  if (s && s.options.applicationServerKey) {
    const actual = new Uint8Array(s.options.applicationServerKey);
    if (actual.length !== clave.length || actual.some((b, i) => b !== clave[i])) { await s.unsubscribe(); s = null; }
  }
  s ??= await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: clave });
  await enviar(s);
  return 'activo';
}

export async function desactivarPush(): Promise<EstadoPush> {
  const s = await suscripcionActual();
  if (s) {
    await api.delete('/notificaciones/push/suscripcion', { data: { endpoint: s.endpoint } }).catch(() => undefined);
    await s.unsubscribe();
  }
  return 'inactivo';
}

/** Al iniciar sesión, vincula la suscripción existente de este navegador con la cuenta actual. */
export async function sincronizarPush(): Promise<void> {
  try {
    if (!pushSoportado() || !window.isSecureContext || Notification.permission !== 'granted') return;
    const s = await suscripcionActual();
    if (s) await enviar(s);
  } catch { /* sin push: la aplicación sigue con Socket.IO */ }
}

/**
 * Al cerrar sesión, desvincula este navegador de la cuenta (puesto de guardia compartido):
 * el token se pasa explícitamente porque la sesión local se borra de inmediato.
 */
export async function desvincularPush(token: string | null): Promise<void> {
  try {
    if (!token || !pushSoportado() || !window.isSecureContext) return;
    const s = await suscripcionActual();
    if (s) await api.delete('/notificaciones/push/suscripcion', { data: { endpoint: s.endpoint }, headers: { Authorization: `Bearer ${token}` } });
  } catch { /* la próxima sesión reasigna la suscripción */ }
}
