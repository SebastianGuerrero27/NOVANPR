import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../services/configuracion';
import { CODIGO_POR_ROL, Permiso, Rol, ROL_POR_CODIGO, tienePermiso } from '../dominio/permisos';

export { CODIGO_POR_ROL, ROL_POR_CODIGO };
export type { Permiso, Rol };

// Sin valor por defecto: un secreto conocido permitiría falsificar tokens de administrador.
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET no está definido. Configúrelo en backend/.env o en el .env de docker compose.');
}
export const JWT_SECRET: string = process.env.JWT_SECRET;

export interface UserPayload {
  id: number;
  email: string;
  /** Igual a email; se conserva por compatibilidad con código que leía `username`. */
  username: string;
  nombre: string;
  rol: Rol;
}

declare global {
  namespace Express {
    interface Request {
      user?: UserPayload;
    }
  }
}

export function firmarToken(u: Omit<UserPayload, 'username'>): string {
  const payload: UserPayload = { ...u, username: u.email };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: `${config.entero('sesion_horas')}h` as jwt.SignOptions['expiresIn'] });
}

/**
 * Estado vigente de la cuenta (activa, no bloqueada, rol actual). Se consulta en cada
 * solicitud con una caché corta para que un bloqueo, una desactivación o un cambio de rol
 * surtan efecto en segundos y no recién cuando vence el token.
 */
const SEGUNDOS_CACHE_CUENTA = 20;
const cacheCuentas = new Map<number, { t: number; vigente: boolean; rol?: Rol }>();
const alInvalidar: ((id?: number) => void)[] = [];

/** Suscribe una acción al cambio de una cuenta (p. ej. cerrar sus conexiones de tiempo real). */
export function alInvalidarCuenta(fn: (id?: number) => void) {
  alInvalidar.push(fn);
}

export function invalidarCuenta(id?: number) {
  if (id === undefined) cacheCuentas.clear();
  else cacheCuentas.delete(id);
  for (const fn of alInvalidar) {
    try { fn(id); } catch { /* el oyente no debe romper la solicitud */ }
  }
}

async function cuentaVigente(id: number): Promise<{ vigente: boolean; rol?: Rol }> {
  const c = cacheCuentas.get(id);
  if (c && Date.now() - c.t < SEGUNDOS_CACHE_CUENTA * 1000) return c;
  // Import diferido: evita cargar la conexión en pruebas que solo usan firmarToken
  const { getDB } = await import('../config/db');
  const r = await getDB().request().input('id', id).query(`
    SELECT u.estado, u.bloqueado, u.bloqueado_hasta, r.codigo
    FROM Usuarios u JOIN Roles r ON r.id = u.rol_id WHERE u.id = @id`);
  const u = r.recordset[0];
  const vigente = !!u && u.estado === 'activo' && !u.bloqueado
    && !(u.bloqueado_hasta && new Date(u.bloqueado_hasta) > new Date());
  const entrada = { t: Date.now(), vigente, rol: u ? ROL_POR_CODIGO[u.codigo] : undefined };
  cacheCuentas.set(id, entrada);
  return entrada;
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Sesión requerida.' });
  }
  let payload: UserPayload;
  try {
    payload = jwt.verify(authHeader.split(' ')[1], JWT_SECRET) as UserPayload;
  } catch {
    // 401 (no 403): el frontend lo interpreta como sesión vencida y lleva al login
    return res.status(401).json({ error: 'La sesión expiró o no es válida. Inicie sesión nuevamente.' });
  }
  try {
    const cuenta = await cuentaVigente(payload.id);
    if (!cuenta.vigente) {
      return res.status(401).json({ error: 'Su cuenta fue bloqueada o desactivada. Contacte al administrador.' });
    }
    req.user = { ...payload, rol: cuenta.rol ?? payload.rol };
    next();
  } catch (e: any) {
    console.error('[AUTH] No se pudo verificar la cuenta:', e.message);
    return res.status(503).json({ error: 'No se pudo verificar la sesión. Intente nuevamente.' });
  }
}

/** Verifica un JWT fuera de Express (Socket.IO). Devuelve el usuario o null. */
export async function verificarTokenSocket(token: unknown): Promise<UserPayload | null> {
  if (typeof token !== 'string' || !token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as UserPayload;
    const cuenta = await cuentaVigente(payload.id);
    return cuenta.vigente ? { ...payload, rol: cuenta.rol ?? payload.rol } : null;
  } catch {
    return null;
  }
}

export function roleMiddleware(roles: Rol[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Sesión requerida.' });
    if (!roles.includes(req.user.rol)) {
      return res.status(403).json({ error: 'No tiene permisos para esta acción.' });
    }
    next();
  };
}

/**
 * Exige que el rol de la sesión tenga TODOS los permisos indicados (matriz de
 * dominio/permisos.ts). Es el control que usan los endpoints; `roleMiddleware` queda solo
 * por compatibilidad.
 */
export function requierePermiso(...permisos: Permiso[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Sesión requerida.' });
    if (!permisos.every(p => tienePermiso(req.user!.rol, p))) {
      return res.status(403).json({ error: 'No tiene permisos para esta acción.' });
    }
    next();
  };
}

/** Atajo histórico: administración exclusiva (equivale a los permisos de administración). */
export const soloAdmin = roleMiddleware(['Admin']);

/**
 * Autenticación máquina a máquina para el microservicio ANPR (registro de capturas y
 * resultados OCR). Compara el encabezado X-Servicio-Token con ANPR_SERVICE_TOKEN en tiempo
 * constante. Si la variable no está definida se rechaza en producción y se permite en
 * desarrollo con una advertencia.
 */
let avisoSinToken = false;
export function servicioMiddleware(req: Request, res: Response, next: NextFunction) {
  const esperado = process.env.ANPR_SERVICE_TOKEN || '';
  if (!esperado) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'ANPR_SERVICE_TOKEN no configurado en el servidor.' });
    }
    if (!avisoSinToken) {
      console.warn('[SEGURIDAD] ANPR_SERVICE_TOKEN no está definido: las rutas del servicio ANPR aceptan cualquier origen (solo desarrollo).');
      avisoSinToken = true;
    }
    return next();
  }
  const recibido = String(req.headers['x-servicio-token'] || '');
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Token de servicio inválido.' });
  }
  next();
}
