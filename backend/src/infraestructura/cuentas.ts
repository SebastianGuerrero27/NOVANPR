import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import sql from 'mssql';
import { getDB } from './db';
import type { PuertoAuditoriaCuentas, PuertoClaves, PuertoTokens } from '../aplicacion/usuarios';
import { generarToken, hashToken } from './servicios/seguridad';

/**
 * Adaptadores de seguridad de las cuentas:
 *   - Auditoría de cuentas (AuditoriaUsuarios) y de accesos (AuditoriaAccesos), de solo inserción
 *     (ISO/IEC 27001 A.8.15). Si el registro falla se informa en el log y la operación continúa.
 *   - Contraseñas con bcrypt (hash lento con sal; nunca se guarda la contraseña).
 *   - Tokens de los enlaces de un solo uso: 32 bytes aleatorios; en la base, solo su SHA-256.
 */

/** Rondas de bcrypt de las contraseñas que eligen las personas (BCRYPT_ROUNDS, 12 por omisión). */
const RONDAS_BCRYPT = Number(process.env.BCRYPT_ROUNDS ?? 12);
/** Hash de una clave aleatoria: iguala el tiempo de respuesta cuando el correo no existe. */
const HASH_FICTICIO = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), RONDAS_BCRYPT);

export const clavesBcrypt: PuertoClaves = {
  cifrar: password => bcrypt.hash(password, RONDAS_BCRYPT),
  comparar: (password, hash) => bcrypt.compare(password, hash),
  async compararFicticio(password) {
    await bcrypt.compare(password, HASH_FICTICIO);
  },
  // Clave aleatoria que nadie conoce (ni el administrador): la persona define la suya con el enlace
  inutilizable: () => bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
};

export const tokensEnlace: PuertoTokens = { generar: generarToken, hash: hashToken };

export const auditoriaCuentasSql: PuertoAuditoriaCuentas = {
  async cuenta(origen, accion, objetivo, detalle) {
    // Flujos públicos (registro, recuperación): sin actor; queda la IP del visitante
    const actor = 'id' in origen ? origen : null;
    try {
      await getDB().request()
        .input('accion', sql.VarChar(50), accion)
        .input('actor', sql.Int, actor?.id ?? null)
        .input('actorEmail', sql.NVarChar(150), actor?.email ?? null)
        .input('objId', sql.Int, objetivo.id ?? null)
        .input('objEmail', sql.NVarChar(150), objetivo.email ?? null)
        .input('detalle', sql.NVarChar(500), detalle?.substring(0, 500) ?? null)
        .input('ip', sql.VarChar(45), origen.ip)
        .query(`INSERT INTO AuditoriaUsuarios (accion, actor_id, actor_email, objetivo_id, objetivo_email, detalle, ip)
                VALUES (@accion, @actor, @actorEmail, @objId, @objEmail, @detalle, @ip)`);
    } catch (e: any) {
      console.error('[AUDITORIA] No se pudo registrar la acción:', e.message);
    }
  },

  async acceso(visitante, email, usuarioId, exito, motivo) {
    try {
      await getDB().request()
        .input('email', sql.NVarChar(150), email.substring(0, 150))
        .input('uid', sql.Int, usuarioId)
        .input('exito', sql.Bit, exito)
        .input('motivo', sql.VarChar(50), motivo)
        .input('ip', sql.VarChar(45), visitante.ip)
        .input('ua', sql.NVarChar(255), (visitante.agente ?? '').substring(0, 255))
        .query(`INSERT INTO AuditoriaAccesos (email, usuario_id, exito, motivo, ip, user_agent)
                VALUES (@email, @uid, @exito, @motivo, @ip, @ua)`);
    } catch (e: any) {
      console.error('[AUDITORIA] No se pudo registrar el acceso:', e.message);
    }
  },
};
