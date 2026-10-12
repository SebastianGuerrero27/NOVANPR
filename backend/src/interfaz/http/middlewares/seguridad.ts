import crypto from 'crypto';
import type { Request, RequestHandler } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

/**
 * Protección HTTP de la API:
 *   - Cabeceras de seguridad (helmet): nosniff, sin incrustar en marcos de otros sitios, CSP,
 *     política de referencia, HSTS cuando la conexión es HTTPS.
 *   - Límite de solicitudes por IP: uno general para toda la API y otro estricto para el acceso
 *     (inicio de sesión, registro, recuperación de contraseña), que frena el relleno de
 *     credenciales entre cuentas; el bloqueo por cuenta tras intentos fallidos sigue aparte.
 *
 * El contador vive en la memoria de cada instancia: con varias réplicas el límite efectivo se
 * multiplica por el número de instancias. Detrás de un proxy (ingress, nginx) configure
 * TRUST_PROXY con el número de saltos para que la IP sea la del cliente y no la del proxy.
 */

export const cabecerasSeguridad: RequestHandler = helmet({
  // Las fotos de evidencia (/media, con enlace firmado) las muestra el frontend, que en desarrollo y
  // en la red local está en otro puerto del mismo equipo: mismo sitio, distinto origen
  crossOriginResourcePolicy: { policy: 'same-site' },
  // En la red local la API también se sirve por HTTP: no forzar HTTPS en los recursos de /api/docs
  contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
});

/** Valor de `trust proxy` de Express desde TRUST_PROXY (número de saltos o lista de redes). */
export function confianzaProxy(valor = process.env.TRUST_PROXY): boolean | number | string {
  if (!valor || valor === 'false') return false;
  if (/^\d+$/.test(valor)) return Number(valor);
  return valor; // p. ej. "loopback, 10.0.0.0/8"; "true" se desaconseja: cualquiera falsearía su IP
}

/** En las pruebas automáticas los límites se desactivan, salvo que se pida explícitamente. */
const limitesActivos = () => process.env.NODE_ENV !== 'test' || process.env.LIMITE_SOLICITUDES === 'true';

/** Llamada máquina a máquina del motor ANPR (token de servicio válido): no la limita la IP. */
function esServicio(req: Request): boolean {
  const esperado = process.env.ANPR_SERVICE_TOKEN || '';
  const recibido = req.get('X-Servicio-Token') || '';
  if (!esperado || !recibido) return false;
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const numero = (valor: string | undefined, omision: number) => {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : omision;
};

/** Límite general de la API (por omisión 600 solicitudes por minuto e IP). */
export function limitadorApi(): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: () => numero(process.env.LIMITE_API_POR_MINUTO, 600),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // MediaMTX consulta /api/medios/autorizar por cada lector de video; el motor usa su token
    skip: req => !limitesActivos() || esServicio(req) || req.originalUrl.startsWith('/api/medios/autorizar'),
    message: { error: 'Demasiadas solicitudes. Intente de nuevo en un momento.' },
  });
}

/**
 * ¿La solicitud de acceso queda fuera del conteo? Solo un inicio de sesión aceptado: detrás de un
 * NAT (o de Docker Desktop, que presenta a todos los clientes con la IP de su puerta de enlace)
 * muchos operadores comparten IP, y sus ingresos correctos no deben bloquear a los demás. Registro,
 * recuperación y reenvío de verificación cuentan siempre (generan correos y responden 200 aunque
 * la cuenta no exista).
 */
export const accesoAceptado = (ruta: string, estado: number): boolean =>
  ruta.split('?')[0] === '/api/auth/login' && estado < 400;

/** Límite del acceso (por omisión 20 intentos cada 15 minutos por IP, sumando todas las rutas). */
export function limitadorAcceso(): RequestHandler {
  return rateLimit({
    windowMs: 15 * 60_000,
    limit: () => numero(process.env.LIMITE_ACCESO_POR_15_MIN, 20),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => !limitesActivos(),
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req, res) => accesoAceptado(req.originalUrl, res.statusCode),
    message: { error: 'Demasiados intentos de acceso desde este equipo. Espere unos minutos e intente de nuevo.' },
  });
}

/** Rutas de acceso público que reciben credenciales o generan correos. */
export const RUTAS_ACCESO = [
  '/api/auth/login', '/api/auth/registro', '/api/auth/olvide-password', '/api/auth/restablecer-password',
  '/api/auth/reenviar-verificacion', '/api/auth/configuracion-inicial',
];
