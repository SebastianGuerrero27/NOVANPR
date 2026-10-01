import crypto from 'crypto';
import sql from 'mssql';
import webpush from 'web-push';
import { pushEnvios } from './metrics';

/**
 * Canal Web Push (estándar W3C Push API sobre RFC 8030, cifrado RFC 8291 e identificación
 * del servidor con VAPID, RFC 8292). Entrega las alarmas aunque la pestaña esté cerrada o en
 * segundo plano: el navegador las recibe en el service worker (frontend/public/sw.js) y las
 * muestra como notificaciones del sistema operativo.
 *
 * Claves VAPID: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY del entorno. Si no están definidas, el
 * sistema genera un par la primera vez y lo guarda en ClavesServicio, para que las
 * suscripciones sigan siendo válidas tras reiniciar (cambiar la clave invalida todas).
 */

let clavePublica: string | null = null;
let habilitado = false;

export interface SuscripcionPush {
  id: number;
  usuario_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface MensajePush {
  id: number;
  tipo: string;
  severidad: string;
  titulo: string;
  mensaje: string;
  enlace: string | null;
}

async function leerClave(db: sql.ConnectionPool, clave: string): Promise<string | null> {
  const r = await db.request().input('c', sql.VarChar(60), clave).query('SELECT valor FROM ClavesServicio WHERE clave = @c');
  return r.recordset[0]?.valor ?? null;
}

async function guardarClave(db: sql.ConnectionPool, clave: string, valor: string) {
  await db.request().input('c', sql.VarChar(60), clave).input('v', sql.NVarChar(1000), valor).query(`
    IF NOT EXISTS (SELECT 1 FROM ClavesServicio WHERE clave = @c) INSERT INTO ClavesServicio (clave, valor) VALUES (@c, @v)`);
}

export async function iniciarWebPush(db: sql.ConnectionPool): Promise<void> {
  try {
    let publica = process.env.VAPID_PUBLIC_KEY?.trim() || null;
    let privada = process.env.VAPID_PRIVATE_KEY?.trim() || null;
    if (!publica || !privada) {
      publica = await leerClave(db, 'vapid_publica');
      privada = await leerClave(db, 'vapid_privada');
      if (!publica || !privada) {
        const par = webpush.generateVAPIDKeys();
        await guardarClave(db, 'vapid_publica', par.publicKey);
        await guardarClave(db, 'vapid_privada', par.privateKey);
        // Relectura: si otra instancia las creó al mismo tiempo, prevalecen las guardadas primero
        publica = await leerClave(db, 'vapid_publica');
        privada = await leerClave(db, 'vapid_privada');
        console.log('[PUSH] Par de claves VAPID generado y guardado en ClavesServicio.');
      }
    }
    const sujeto = process.env.VAPID_SUBJECT?.trim() || `mailto:${process.env.SMTP_FROM?.match(/[^<\s]+@[^>\s]+/)?.[0] || 'anpr@ecu911.gob.ec'}`;
    webpush.setVapidDetails(sujeto, publica!, privada!);
    clavePublica = publica;
    habilitado = true;
    console.log('[PUSH] Web Push habilitado (VAPID).');
  } catch (e: any) {
    habilitado = false;
    console.warn('[PUSH] Web Push deshabilitado:', e.message);
  }
}

export const clavePublicaVapid = () => clavePublica;
export const webPushHabilitado = () => habilitado;

/** Huella del endpoint (índice único; los endpoints superan el límite de una clave NVARCHAR). */
export const hashEndpoint = (endpoint: string) => crypto.createHash('sha256').update(endpoint).digest('hex');

/**
 * Envía el mensaje a las suscripciones indicadas. Devuelve los id de suscripciones vencidas
 * (404/410 del servicio push) para que el llamador las elimine.
 */
export async function enviarPush(
  subs: SuscripcionPush[], msg: MensajePush, opciones: { ttlS: number; urgencia: 'very-low' | 'low' | 'normal' | 'high' },
): Promise<{ enviados: number; vencidas: number[]; fallidas: number[] }> {
  const vencidas: number[] = [];
  const fallidas: number[] = [];
  let enviados = 0;
  if (!habilitado || !subs.length) return { enviados, vencidas, fallidas };
  const payload = JSON.stringify(msg);
  await Promise.all(subs.map(async s => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
        TTL: opciones.ttlS, urgency: opciones.urgencia, timeout: 5000,
      });
      enviados++;
      pushEnvios.labels('ok').inc();
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        vencidas.push(s.id);
        pushEnvios.labels('vencida').inc();
      } else {
        fallidas.push(s.id);
        pushEnvios.labels('error').inc();
        console.warn(`[PUSH] Envío fallido a la suscripción #${s.id}: ${e?.statusCode ?? ''} ${e?.message ?? e}`);
      }
    }
  }));
  return { enviados, vencidas, fallidas };
}
