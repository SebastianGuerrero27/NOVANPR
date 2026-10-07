import sql from 'mssql';
import { getDB } from '../db';
import { CODIGO_POR_ROL, rolesCon } from '../../dominio/permisos';
import type { Permiso } from '../../dominio/permisos';
import { CATALOGO, Severidad, TipoNotificacion, urgenciaPush } from '../../dominio/notificaciones';
import { config } from './configuracion';
import { emailService } from './emailService';
import {
  notificacionesEscaladas, notificacionesSuprimidas, notificacionesTotal, notificacionLatencia, notificacionReconocimiento,
} from './metrics';
import { emitirAUsuarios } from './socket';
import { enviarPush, MensajePush, SuscripcionPush } from './webPush';

/**
 * Centro de notificaciones: bandeja persistente + entrega multicanal.
 *
 *   evento de dominio ──▶ notificar() ──▶ [supresión de repeticiones] ──▶ INSERT Notificaciones
 *                                                   │                    + NotificacionUsuario (fan-out por permiso)
 *                                                   ├─▶ Socket.IO  sala usuario:{id}   (en la aplicación, < 1 s)
 *                                                   └─▶ Web Push   service worker      (pestaña cerrada / segundo plano)
 *
 * Garantías: la notificación se guarda ANTES de emitirse, de modo que un cliente que estuvo
 * desconectado la recupera al reconectar (GET /api/notificaciones?desde=<último id>): entrega
 * "al menos una vez" con deduplicación por id en el cliente. El reconocimiento (ACK) es global
 * —la primera persona que atiende la alarma la marca para todos— y se mide el tiempo de
 * reconocimiento; si nadie la atiende a tiempo se escala (tareasProgramadas.ts).
 *
 * Las dependencias de E/S se agrupan en `Puertos` (arquitectura hexagonal) para probar la
 * orquestación sin base de datos ni red (src/tests/services/notificaciones.test.ts).
 */

export interface NuevaNotificacion {
  tipo: TipoNotificacion;
  titulo: string;
  mensaje: string;
  /** Prioridad distinta a la del catálogo (p. ej. el nivel de la alerta) */
  severidad?: Severidad;
  enlace?: string | null;
  datos?: Record<string, unknown>;
  claveDedup?: string;
  deteccionId?: number | null;
  /** Instante del hecho que la origina (para medir la latencia de extremo a extremo) */
  origen?: Date | null;
  destinatarios?: { permiso?: Permiso; usuarios?: number[]; excluir?: number[] };
}

export interface NotificacionDTO {
  id: number;
  tipo: TipoNotificacion;
  severidad: Severidad;
  titulo: string;
  mensaje: string;
  enlace: string | null;
  datos: Record<string, unknown> | null;
  repeticiones: number;
  requiere_ack: boolean;
  fecha_creacion: string | Date;
  fecha_ultima: string | Date;
  leida: boolean;
  atendida: { usuario: { id: number; nombre: string } | null; fecha: string | Date } | null;
  resuelta: boolean;
  escalada: boolean;
}

export interface FilaInsercion {
  tipo: TipoNotificacion;
  severidad: Severidad;
  titulo: string;
  mensaje: string;
  enlace: string | null;
  datos: string | null;
  claveDedup: string | null;
  requiereAck: boolean;
  deteccionId: number | null;
}

/** Operaciones de E/S que necesita el centro (implementación SQL por omisión más abajo). */
export interface Puertos {
  buscarDuplicada(clave: string, ventanaS: number): Promise<number | null>;
  incrementarRepeticion(id: number): Promise<void>;
  insertar(f: FilaInsercion): Promise<number>;
  /** Asigna la notificación a los destinatarios activos y devuelve sus id */
  asignar(id: number, codigosRol: string[], usuarios: number[], excluir: number[]): Promise<number[]>;
  obtener(id: number, usuarioId?: number): Promise<NotificacionDTO | null>;
  destinatariosDe(id: number): Promise<number[]>;
  suscripciones(usuarios: number[]): Promise<SuscripcionPush[]>;
  eliminarSuscripciones(ids: number[]): Promise<void>;
  emitir(usuarios: number[], evento: string, datos: unknown): void;
  push(subs: SuscripcionPush[], msg: MensajePush, opciones: { ttlS: number; urgencia: ReturnType<typeof urgenciaPush> }): Promise<{ vencidas: number[] }>;
  ahora(): Date;
}

// ─── Mapeo de filas ──────────────────────────────────────────────────────────

const SELECT_NOTIFICACION = `
  SELECT n.*, ua.nombre_completo AS atendida_por_nombre
  FROM Notificaciones n LEFT JOIN Usuarios ua ON ua.id = n.atendida_por`;

export function mapearNotificacion(n: any): NotificacionDTO {
  let datos: Record<string, unknown> | null = null;
  if (n.datos) { try { datos = JSON.parse(n.datos); } catch { datos = null; } }
  return {
    id: Number(n.id),
    tipo: n.tipo,
    severidad: n.severidad,
    titulo: n.titulo,
    mensaje: n.mensaje,
    enlace: n.enlace ?? null,
    datos,
    repeticiones: n.repeticiones ?? 1,
    requiere_ack: Boolean(n.requiere_ack),
    fecha_creacion: n.fecha_creacion,
    fecha_ultima: n.fecha_ultima ?? n.fecha_creacion,
    leida: Boolean(n.fecha_lectura),
    atendida: n.fecha_atencion
      ? { usuario: n.atendida_por ? { id: n.atendida_por, nombre: n.atendida_por_nombre } : null, fecha: n.fecha_atencion }
      : null,
    resuelta: Boolean(n.fecha_resolucion),
    escalada: Boolean(n.escalada),
  };
}

// ─── Implementación SQL ──────────────────────────────────────────────────────

const db = () => getDB();

export const puertosSql: Puertos = {
  async buscarDuplicada(clave, ventanaS) {
    const r = await db().request().input('k', sql.VarChar(120), clave).input('v', sql.Int, ventanaS).query(`
      SELECT TOP 1 id FROM Notificaciones
      WHERE clave_dedup = @k AND fecha_resolucion IS NULL AND fecha_creacion >= DATEADD(SECOND, -@v, SYSDATETIME())
      ORDER BY id DESC`);
    return r.recordset[0] ? Number(r.recordset[0].id) : null;
  },
  async incrementarRepeticion(id) {
    // Una repetición vuelve a marcar la notificación como no leída para todos
    await db().request().input('id', sql.BigInt, id).query(`
      UPDATE Notificaciones SET repeticiones = repeticiones + 1, fecha_ultima = SYSDATETIME() WHERE id = @id;
      UPDATE NotificacionUsuario SET fecha_lectura = NULL WHERE notificacion_id = @id;`);
  },
  async insertar(f) {
    const r = await db().request()
      .input('tipo', sql.VarChar(40), f.tipo)
      .input('sev', sql.VarChar(10), f.severidad)
      .input('titulo', sql.NVarChar(150), f.titulo.substring(0, 150))
      .input('mensaje', sql.NVarChar(500), f.mensaje.substring(0, 500))
      .input('enlace', sql.VarChar(200), f.enlace?.substring(0, 200) ?? null)
      .input('datos', sql.NVarChar(1000), f.datos?.substring(0, 1000) ?? null)
      .input('clave', sql.VarChar(120), f.claveDedup?.substring(0, 120) ?? null)
      .input('ack', sql.Bit, f.requiereAck)
      .input('det', sql.Int, f.deteccionId)
      .query(`
        INSERT INTO Notificaciones (tipo, severidad, titulo, mensaje, enlace, datos, clave_dedup, requiere_ack, deteccion_id)
        OUTPUT INSERTED.id
        VALUES (@tipo, @sev, @titulo, @mensaje, @enlace, @datos, @clave, @ack, @det)`);
    return Number(r.recordset[0].id);
  },
  async asignar(id, codigosRol, usuarios, excluir) {
    const req = db().request().input('id', sql.BigInt, id);
    codigosRol.forEach((c, i) => req.input(`r${i}`, sql.VarChar(20), c));
    usuarios.forEach((u, i) => req.input(`u${i}`, sql.Int, u));
    excluir.forEach((u, i) => req.input(`x${i}`, sql.Int, u));
    const condiciones = [
      codigosRol.length ? `r.codigo IN (${codigosRol.map((_, i) => `@r${i}`).join(',')})` : null,
      usuarios.length ? `u.id IN (${usuarios.map((_, i) => `@u${i}`).join(',')})` : null,
    ].filter(Boolean);
    if (!condiciones.length) return [];
    const r = await req.query(`
      INSERT INTO NotificacionUsuario (notificacion_id, usuario_id)
      OUTPUT INSERTED.usuario_id
      SELECT @id, u.id FROM Usuarios u JOIN Roles r ON r.id = u.rol_id
      WHERE u.estado = 'activo' AND u.bloqueado = 0 AND (${condiciones.join(' OR ')})
        ${excluir.length ? `AND u.id NOT IN (${excluir.map((_, i) => `@x${i}`).join(',')})` : ''}`);
    return r.recordset.map(x => Number(x.usuario_id));
  },
  async obtener(id, usuarioId) {
    const req = db().request().input('id', sql.BigInt, id);
    let consulta = `${SELECT_NOTIFICACION} WHERE n.id = @id`;
    if (usuarioId !== undefined) {
      req.input('uid', sql.Int, usuarioId);
      consulta = `
        SELECT n.*, ua.nombre_completo AS atendida_por_nombre, nu.fecha_lectura
        FROM Notificaciones n JOIN NotificacionUsuario nu ON nu.notificacion_id = n.id AND nu.usuario_id = @uid
        LEFT JOIN Usuarios ua ON ua.id = n.atendida_por WHERE n.id = @id`;
    }
    const r = await req.query(consulta);
    return r.recordset[0] ? mapearNotificacion(r.recordset[0]) : null;
  },
  async destinatariosDe(id) {
    const r = await db().request().input('id', sql.BigInt, id).query('SELECT usuario_id FROM NotificacionUsuario WHERE notificacion_id = @id');
    return r.recordset.map(x => Number(x.usuario_id));
  },
  async suscripciones(usuarios) {
    if (!usuarios.length) return [];
    const req = db().request();
    usuarios.forEach((u, i) => req.input(`u${i}`, sql.Int, u));
    const r = await req.query(`SELECT id, usuario_id, endpoint, p256dh, auth FROM SuscripcionesPush
                               WHERE usuario_id IN (${usuarios.map((_, i) => `@u${i}`).join(',')})`);
    return r.recordset;
  },
  async eliminarSuscripciones(ids) {
    if (!ids.length) return;
    const req = db().request();
    ids.forEach((u, i) => req.input(`s${i}`, sql.Int, u));
    await req.query(`DELETE FROM SuscripcionesPush WHERE id IN (${ids.map((_, i) => `@s${i}`).join(',')})`);
  },
  emitir: emitirAUsuarios,
  async push(subs, msg, opciones) {
    return enviarPush(subs, msg, opciones);
  },
  ahora: () => new Date(),
};

let puertos: Puertos = puertosSql;

/** Sustituye la E/S (pruebas). Sin argumento restaura la implementación SQL. */
export function configurarPuertos(p?: Partial<Puertos>) {
  puertos = p ? { ...puertosSql, ...p } : puertosSql;
}

// ─── Casos de uso ────────────────────────────────────────────────────────────

/**
 * Crea (o agrupa) una notificación y la entrega a sus destinatarios. Nunca lanza: un fallo
 * de notificación no debe interrumpir el registro del paso vehicular que la origina.
 */
export async function notificar(n: NuevaNotificacion): Promise<NotificacionDTO | null> {
  const def = CATALOGO[n.tipo];
  try {
    if (n.claveDedup && def.ventanaS > 0) {
      const previa = await puertos.buscarDuplicada(n.claveDedup, def.ventanaS);
      if (previa !== null) {
        notificacionesSuprimidas.labels(n.tipo).inc();
        if (def.alDuplicar === 'omitir') return null;
        await puertos.incrementarRepeticion(previa);
        const dto = await puertos.obtener(previa);
        if (dto) puertos.emitir(await puertos.destinatariosDe(previa), 'notificacion:actualizada', { ...dto, leida: false });
        return dto;
      }
    }

    const severidad = n.severidad ?? def.severidad;
    const id = await puertos.insertar({
      tipo: n.tipo, severidad, titulo: n.titulo, mensaje: n.mensaje, enlace: n.enlace ?? null,
      datos: n.datos ? JSON.stringify(n.datos) : null, claveDedup: n.claveDedup ?? null,
      requiereAck: def.requiereAck, deteccionId: n.deteccionId ?? null,
    });

    const permiso = n.destinatarios?.permiso ?? def.permiso;
    const roles = permiso ? rolesCon(permiso).map(r => CODIGO_POR_ROL[r]) : [];
    const usuarios = await puertos.asignar(id, roles, n.destinatarios?.usuarios ?? [], n.destinatarios?.excluir ?? []);
    const dto = await puertos.obtener(id);
    if (!dto) return null;

    puertos.emitir(usuarios, 'notificacion:nueva', dto);
    notificacionesTotal.labels(n.tipo, severidad).inc();
    if (n.origen) notificacionLatencia.labels(n.tipo).observe(Math.max(0, (puertos.ahora().getTime() - n.origen.getTime()) / 1000));

    if (def.push && config.booleano('notif_push_habilitado') && usuarios.length) {
      // Sin esperar: el push no debe retrasar la respuesta al motor ANPR
      void entregarPush(usuarios, dto, def.ttlPushS);
    }
    return dto;
  } catch (e: any) {
    console.error(`[NOTIFICACIONES] No se pudo emitir ${n.tipo}:`, e.message);
    return null;
  }
}

async function entregarPush(usuarios: number[], dto: NotificacionDTO, ttlS: number) {
  try {
    const subs = await puertos.suscripciones(usuarios);
    if (!subs.length) return;
    const r = await puertos.push(subs, {
      id: dto.id, tipo: dto.tipo, severidad: dto.severidad, titulo: dto.titulo, mensaje: dto.mensaje, enlace: dto.enlace,
    }, { ttlS, urgencia: urgenciaPush(dto.severidad) });
    await puertos.eliminarSuscripciones(r.vencidas);
  } catch (e: any) {
    console.warn('[NOTIFICACIONES] Push:', e.message);
  }
}

/** Difunde el estado actualizado de una notificación a todos sus destinatarios. */
async function difundirEstado(id: number) {
  const dto = await puertos.obtener(id);
  if (!dto) return;
  const { leida: _omitida, ...estado } = dto;
  puertos.emitir(await puertos.destinatariosDe(id), 'notificacion:actualizada', estado);
}

/**
 * Reconocimiento (ACK) de alarmas por una persona. La primera que reconoce queda registrada
 * como quien la atendió; se mide el tiempo de reconocimiento. Devuelve cuántas reconoció.
 */
export async function reconocer(usuarioId: number, filtro: { id?: number; deteccionId?: number }): Promise<number> {
  const req = getDB().request().input('uid', sql.Int, usuarioId);
  let donde: string;
  if (filtro.id !== undefined) { req.input('id', sql.BigInt, filtro.id); donde = 'n.id = @id'; }
  else if (filtro.deteccionId !== undefined) { req.input('det', sql.Int, filtro.deteccionId); donde = 'n.deteccion_id = @det'; }
  else return 0;
  const r = await req.query(`
    UPDATE n SET atendida_por = @uid, fecha_atencion = SYSDATETIME()
    OUTPUT INSERTED.id, INSERTED.severidad, DATEDIFF_BIG(MILLISECOND, INSERTED.fecha_creacion, INSERTED.fecha_atencion) AS ms
    FROM Notificaciones n JOIN NotificacionUsuario nu ON nu.notificacion_id = n.id AND nu.usuario_id = @uid
    WHERE ${donde} AND n.requiere_ack = 1 AND n.fecha_atencion IS NULL;
    UPDATE nu SET fecha_lectura = COALESCE(nu.fecha_lectura, SYSDATETIME())
    FROM NotificacionUsuario nu JOIN Notificaciones n ON n.id = nu.notificacion_id
    WHERE nu.usuario_id = @uid AND ${donde};`);
  const filas = (r.recordsets as any[])[0] ?? [];
  for (const f of filas) {
    notificacionReconocimiento.labels(f.severidad).observe(Number(f.ms) / 1000);
    await difundirEstado(Number(f.id));
  }
  return filas.length;
}

/**
 * La condición que originó las alarmas de un paso quedó atendida (el personal validó o
 * corrigió la lectura, o se eliminó el registro): se resuelven y dejan de escalar.
 */
export async function resolverPorDeteccion(deteccionId: number): Promise<void> {
  try {
    const r = await getDB().request().input('det', sql.Int, deteccionId).query(`
      UPDATE Notificaciones SET fecha_resolucion = SYSDATETIME()
      OUTPUT INSERTED.id
      WHERE deteccion_id = @det AND fecha_resolucion IS NULL`);
    for (const f of r.recordset) await difundirEstado(Number(f.id));
  } catch (e: any) {
    console.warn('[NOTIFICACIONES] resolver:', e.message);
  }
}

/**
 * Escala las alarmas críticas/altas sin reconocer después del umbral configurado. La marca
 * `escalada` se toma con UPDATE … OUTPUT (atómico): con varias instancias del backend cada
 * alarma se escala una sola vez.
 */
export async function escalarPendientes(): Promise<number> {
  const umbral = config.entero('notif_escalamiento_segundos');
  if (umbral <= 0) return 0;
  const r = await getDB().request().input('u', sql.Int, umbral).query(`
    UPDATE Notificaciones SET escalada = 1, fecha_escalamiento = SYSDATETIME()
    OUTPUT INSERTED.id, INSERTED.tipo, INSERTED.severidad, INSERTED.titulo, INSERTED.mensaje, INSERTED.enlace,
           INSERTED.deteccion_id, INSERTED.fecha_creacion
    WHERE requiere_ack = 1 AND fecha_atencion IS NULL AND fecha_resolucion IS NULL AND escalada = 0
      AND severidad IN ('critica', 'alta') AND tipo <> 'alarma.escalada'
      AND fecha_creacion <= DATEADD(SECOND, -@u, SYSDATETIME())
      AND fecha_creacion >= DATEADD(HOUR, -12, SYSDATETIME())`);
  for (const a of r.recordset) {
    notificacionesEscaladas.inc();
    await difundirEstado(Number(a.id));
    const segundos = Math.round((Date.now() - new Date(a.fecha_creacion).getTime()) / 1000);
    const escalada = await notificar({
      tipo: 'alarma.escalada',
      titulo: `Sin atender: ${a.titulo}`,
      mensaje: `${a.mensaje} · Nadie la reconoció en ${segundos} s.`,
      enlace: a.enlace, deteccionId: a.deteccion_id,
      datos: { notificacion_original: Number(a.id), tipo_original: a.tipo },
    });
    if (escalada && config.booleano('notif_escalamiento_correo')) {
      await enviarCorreoEscalamiento(Number(escalada.id), escalada.titulo, escalada.mensaje, a.enlace);
    }
  }
  return r.recordset.length;
}

async function enviarCorreoEscalamiento(id: number, titulo: string, mensaje: string, enlace: string | null) {
  try {
    const r = await getDB().request().input('id', sql.BigInt, id).query(`
      SELECT u.email, u.nombre_completo FROM NotificacionUsuario nu JOIN Usuarios u ON u.id = nu.usuario_id
      WHERE nu.notificacion_id = @id`);
    const url = `${(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '')}${enlace ?? '/notificaciones'}`;
    await Promise.all(r.recordset.map(u => emailService.alarmaEscalada(u.email, u.nombre_completo, titulo, mensaje, url)));
  } catch (e: any) {
    console.warn('[NOTIFICACIONES] Correo de escalamiento:', e.message);
  }
}

/** Elimina las notificaciones más antiguas que la retención configurada. */
export async function purgarAntiguas(): Promise<number> {
  const r = await getDB().request().input('d', sql.Int, config.entero('notif_retencion_dias')).query(`
    DELETE FROM Notificaciones WHERE fecha_creacion < DATEADD(DAY, -@d, SYSDATETIME())`);
  return r.rowsAffected[0] ?? 0;
}
