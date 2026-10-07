import sql from 'mssql';
import { getDB } from '../db';
import type { EnlaceGuardado, TipoEnlace } from '../../aplicacion/auth';

/**
 * Enlaces de un solo uso que se envían por correo: verificación del correo (VerificacionEmail) y
 * restablecimiento o definición de la contraseña (RestablecimientoPassword). En la base se guarda
 * solo el hash SHA-256 del token; el token viaja únicamente en el correo.
 */

const TABLA: Record<TipoEnlace, 'VerificacionEmail' | 'RestablecimientoPassword'> = {
  verificacion: 'VerificacionEmail',
  restablecimiento: 'RestablecimientoPassword',
};

/** Anula los enlaces pendientes de la cuenta y guarda uno nuevo que vence en `minutos`. */
export async function emitirEnlace(tipo: TipoEnlace, usuarioId: number, tokenHash: string, minutos: number): Promise<void> {
  await getDB().request()
    .input('uid', sql.Int, usuarioId)
    .input('hash', sql.Char(64), tokenHash)
    .input('min', sql.Int, minutos)
    .query(`
      UPDATE ${TABLA[tipo]} SET usado = 1 WHERE usuario_id = @uid AND usado = 0;
      INSERT INTO ${TABLA[tipo]} (usuario_id, token_hash, fecha_expiracion) VALUES (@uid, @hash, DATEADD(MINUTE, @min, SYSDATETIME()));`);
}

/** ¿Se emitió un enlace de ese tipo para la cuenta en el último minuto? */
export async function enlaceReciente(tipo: TipoEnlace, usuarioId: number): Promise<boolean> {
  const r = await getDB().request().input('uid', sql.Int, usuarioId).query(`
    SELECT COUNT(*) AS n FROM ${TABLA[tipo]} WHERE usuario_id = @uid AND fecha_creacion > DATEADD(MINUTE, -1, SYSDATETIME())`);
  return r.recordset[0].n > 0;
}

/** Enlace por el hash de su token, con el correo y el nombre de la cuenta dueña. */
export async function buscarEnlace(tipo: TipoEnlace, tokenHash: string): Promise<EnlaceGuardado | null> {
  const r = await getDB().request().input('hash', sql.Char(64), tokenHash).query(`
    SELECT TOP 1 t.id, t.usuario_id, t.usado, t.fecha_expiracion, u.email, u.nombre_completo
    FROM ${TABLA[tipo]} t JOIN Usuarios u ON u.id = t.usuario_id
    WHERE t.token_hash = @hash`);
  const t = r.recordset[0];
  if (!t) return null;
  return {
    id: t.id, usuario_id: t.usuario_id, usado: Boolean(t.usado), fecha_expiracion: t.fecha_expiracion,
    email: t.email, nombre_completo: t.nombre_completo,
  };
}
