import crypto from 'crypto';
import { Request } from 'express';
import sql from 'mssql';
import { config } from './configuracion';

/**
 * Utilidades de seguridad de cuentas: política de contraseñas, dominios de correo
 * permitidos, tokens de un solo uso y auditoría.
 */

export const maxIntentos = () => config.entero('login_max_intentos');
export const minutosBloqueo = () => config.entero('login_minutos_bloqueo');
export const HORAS_VERIFICACION = 24;
export const MINUTOS_RESTABLECIMIENTO = 30;
export const HORAS_CUENTA_NUEVA = 48;

/** Dominios de correo aceptados (configuración del sistema o ALLOWED_EMAIL_DOMAINS). */
export function dominiosPermitidos(): string[] {
  return config.lista('dominios_correo');
}

export function normalizarEmail(email: unknown): string {
  return String(email ?? '').trim().toLowerCase();
}

export function validarEmail(email: string): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150) return 'Correo electrónico inválido.';
  const dominios = dominiosPermitidos();
  const dominio = email.split('@')[1];
  if (dominios.length && !dominios.includes(dominio)) {
    return `Solo se aceptan correos de: ${dominios.map(d => '@' + d).join(', ')}.`;
  }
  return null;
}

/** Política: 10+ caracteres con mayúscula, minúscula, número y símbolo. */
export function validarPassword(password: unknown): string | null {
  const p = String(password ?? '');
  if (p.length < 10) return 'La contraseña debe tener al menos 10 caracteres.';
  if (p.length > 128) return 'La contraseña es demasiado larga.';
  if (!/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/\d/.test(p) || !/[^A-Za-z0-9]/.test(p)) {
    return 'La contraseña debe incluir mayúscula, minúscula, número y un símbolo.';
  }
  return null;
}

export function validarNombre(nombre: unknown): string | null {
  const n = String(nombre ?? '').trim();
  if (n.length < 5 || n.length > 150) return 'Ingrese su nombre completo (5 a 150 caracteres).';
  return null;
}

/** Token aleatorio para el enlace y su hash SHA-256 (solo el hash se guarda en la base). */
export function generarToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function ipDe(req: Request): string {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (fwd || req.socket.remoteAddress || '').substring(0, 45);
}

export function urlFrontend(): string {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
}

export async function auditarUsuario(
  db: sql.ConnectionPool,
  req: Request,
  accion: string,
  objetivo: { id?: number | null; email?: string | null },
  detalle?: string,
): Promise<void> {
  try {
    await db.request()
      .input('accion', sql.VarChar(50), accion)
      .input('actor', sql.Int, req.user?.id ?? null)
      .input('actorEmail', sql.NVarChar(150), req.user?.email ?? null)
      .input('objId', sql.Int, objetivo.id ?? null)
      .input('objEmail', sql.NVarChar(150), objetivo.email ?? null)
      .input('detalle', sql.NVarChar(500), detalle?.substring(0, 500) ?? null)
      .input('ip', sql.VarChar(45), ipDe(req))
      .query(`INSERT INTO AuditoriaUsuarios (accion, actor_id, actor_email, objetivo_id, objetivo_email, detalle, ip)
              VALUES (@accion, @actor, @actorEmail, @objId, @objEmail, @detalle, @ip)`);
  } catch (e: any) {
    console.error('[AUDITORIA] No se pudo registrar la acción:', e.message);
  }
}

export async function auditarAcceso(
  db: sql.ConnectionPool,
  req: Request,
  email: string,
  usuarioId: number | null,
  exito: boolean,
  motivo: string,
): Promise<void> {
  try {
    await db.request()
      .input('email', sql.NVarChar(150), email.substring(0, 150))
      .input('uid', sql.Int, usuarioId)
      .input('exito', sql.Bit, exito)
      .input('motivo', sql.VarChar(50), motivo)
      .input('ip', sql.VarChar(45), ipDe(req))
      .input('ua', sql.NVarChar(255), String(req.headers['user-agent'] || '').substring(0, 255))
      .query(`INSERT INTO AuditoriaAccesos (email, usuario_id, exito, motivo, ip, user_agent)
              VALUES (@email, @uid, @exito, @motivo, @ip, @ua)`);
  } catch (e: any) {
    console.error('[AUDITORIA] No se pudo registrar el acceso:', e.message);
  }
}

/** Acción operativa (detecciones, listas, cámaras, configuración) en AuditoriaOperaciones. */
export async function auditarOperacion(
  db: sql.ConnectionPool,
  req: Request,
  accion: string,
  entidad: string,
  entidadId: number | null,
  detalle?: string,
): Promise<void> {
  try {
    await db.request()
      .input('uid', sql.Int, req.user?.id ?? null)
      .input('email', sql.NVarChar(150), req.user?.email ?? null)
      .input('accion', sql.VarChar(50), accion)
      .input('entidad', sql.VarChar(40), entidad)
      .input('eid', sql.Int, entidadId)
      .input('detalle', sql.NVarChar(500), detalle?.substring(0, 500) ?? null)
      .input('ip', sql.VarChar(45), ipDe(req))
      .query(`INSERT INTO AuditoriaOperaciones (usuario_id, usuario_email, accion, entidad, entidad_id, detalle, ip)
              VALUES (@uid, @email, @accion, @entidad, @eid, @detalle, @ip)`);
  } catch (e: any) {
    console.error('[AUDITORIA] No se pudo registrar la operación:', e.message);
  }
}
