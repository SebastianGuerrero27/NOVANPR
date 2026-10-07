import jwt from 'jsonwebtoken';
import { config } from './servicios/configuracion';
import { type Rol, ROL_POR_CODIGO } from '../dominio/permisos';

/**
 * Sesiones (JWT) y estado vigente de las cuentas. Lo usan el middleware HTTP
 * (interfaz/http/middlewares/auth.ts, a través de contenedor/sesiones.ts) y Socket.IO
 * (servicios/socket.ts).
 */

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

export function firmarToken(u: Omit<UserPayload, 'username'>): string {
  const payload: UserPayload = { ...u, username: u.email };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: `${config.entero('sesion_horas')}h` as jwt.SignOptions['expiresIn'] });
}

/** Contenido de un JWT firmado y vigente; null si es inválido o venció. */
export function decodificarToken(token: string): UserPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as UserPayload;
  } catch {
    return null;
  }
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

export async function cuentaVigente(id: number): Promise<{ vigente: boolean; rol?: Rol }> {
  const c = cacheCuentas.get(id);
  if (c && Date.now() - c.t < SEGUNDOS_CACHE_CUENTA * 1000) return c;
  // Import diferido: evita cargar la conexión en pruebas que solo usan firmarToken
  const { getDB } = await import('./db');
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

/** Verifica un JWT fuera de Express (Socket.IO): el usuario con su rol vigente, o null. */
export async function verificarSesion(token: unknown): Promise<UserPayload | null> {
  if (typeof token !== 'string' || !token) return null;
  const payload = decodificarToken(token);
  if (!payload) return null;
  try {
    const cuenta = await cuentaVigente(payload.id);
    return cuenta.vigente ? { ...payload, rol: cuenta.rol ?? payload.rol } : null;
  } catch {
    return null;
  }
}
