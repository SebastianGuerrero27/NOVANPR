import sql from 'mssql';
import { getDB } from './db';
import { emitEvent } from './servicios/socket';
import type { Actor, PuertoAuditoria, PuertoEventos } from '../aplicacion/comun';

/**
 * Adaptadores de infraestructura compartidos por los casos de uso.
 *
 * La auditoría de operaciones es de solo inserción (ISO/IEC 27001 A.8.15, OWASP ASVS V7): no
 * existe operación para editarla ni borrarla. Si el registro falla, se informa en el log y la
 * operación de negocio continúa (la base de datos es la misma, por lo que un fallo aquí indica
 * un problema mayor que ya se reporta por las métricas de salud).
 */
export const auditoriaSql: PuertoAuditoria = {
  async operacion(actor: Actor, accion: string, entidad: string, entidadId: number | null, detalle?: string) {
    try {
      await getDB().request()
        .input('uid', sql.Int, actor.id)
        .input('email', sql.NVarChar(150), actor.email)
        .input('accion', sql.VarChar(50), accion)
        .input('entidad', sql.VarChar(40), entidad)
        .input('eid', sql.Int, entidadId)
        .input('detalle', sql.NVarChar(500), detalle?.substring(0, 500) ?? null)
        .input('ip', sql.VarChar(45), actor.ip)
        .query(`INSERT INTO AuditoriaOperaciones (usuario_id, usuario_email, accion, entidad, entidad_id, detalle, ip)
                VALUES (@uid, @email, @accion, @entidad, @eid, @detalle, @ip)`);
    } catch (e: any) {
      console.error('[AUDITORIA] No se pudo registrar la operación:', e.message);
    }
  },
};

export const eventosSocket: PuertoEventos = {
  emitir: (evento, datos) => emitEvent(evento, datos),
};
