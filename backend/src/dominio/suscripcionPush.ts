import type { Validado } from './validacion';

/**
 * Suscripción Web Push que registra el navegador (W3C Push API, PushSubscription.toJSON()):
 *
 *   { endpoint: 'https://fcm.googleapis.com/fcm/send/…', keys: { p256dh: '…', auth: '…' } }
 *
 * El endpoint es la URL del servicio push del navegador, a la que el servidor enviará los
 * mensajes: debe ser https (RFC 8030) y de longitud acotada. Las claves de cifrado (RFC 8291)
 * son texto base64url. Un valor de otro tipo se rechaza en lugar de convertirse a texto.
 */

/** Largo de la columna SuscripcionesPush.endpoint (NVARCHAR(600)) */
export const MAX_ENDPOINT_PUSH = 600;
const MAX_P256DH = 200;
const MAX_AUTH = 100;
const RE_BASE64URL = /^[A-Za-z0-9_+/-]+={0,2}$/;
// eslint-disable-next-line no-control-regex
const RE_ESPACIO_O_CONTROL = /[\s\u0000-\u001F\u007F]/;

export interface SuscripcionPush {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function esUrlHttps(texto: string): boolean {
  try {
    return new URL(texto).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Endpoint del servicio push: URL https de hasta 600 caracteres, sin espacios. */
export function validarEndpointPush(valor: unknown): Validado<string> {
  if (typeof valor !== 'string' || !valor || valor.length > MAX_ENDPOINT_PUSH || RE_ESPACIO_O_CONTROL.test(valor) || !esUrlHttps(valor)) {
    return { ok: false, error: `Suscripción push inválida: el endpoint debe ser una URL https de hasta ${MAX_ENDPOINT_PUSH} caracteres.` };
  }
  return { ok: true, valor };
}

const claveValida = (valor: unknown, max: number): valor is string =>
  typeof valor === 'string' && valor.length > 0 && valor.length <= max && RE_BASE64URL.test(valor);

/** Cuerpo del registro de una suscripción: endpoint y claves p256dh y auth. */
export function leerSuscripcionPush(cuerpo: unknown): Validado<SuscripcionPush> {
  const c = (cuerpo && typeof cuerpo === 'object' ? cuerpo : {}) as { endpoint?: unknown; keys?: unknown };
  const endpoint = validarEndpointPush(c.endpoint);
  if (!endpoint.ok) return endpoint;
  const claves = (c.keys && typeof c.keys === 'object' ? c.keys : {}) as { p256dh?: unknown; auth?: unknown };
  const { p256dh, auth } = claves;
  if (!claveValida(p256dh, MAX_P256DH) || !claveValida(auth, MAX_AUTH)) {
    return { ok: false, error: 'Suscripción push inválida: las claves p256dh y auth deben ser texto base64url.' };
  }
  return { ok: true, valor: { endpoint: endpoint.valor, p256dh, auth } };
}
