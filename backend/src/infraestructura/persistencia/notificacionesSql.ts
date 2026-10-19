import sql from '../postgres';
import { getDB } from '../db';
import type { RepositorioNotificaciones } from '../../aplicacion/notificaciones';
import { mapearNotificacion, reconocer } from '../servicios/notificaciones';
import { hashEndpoint } from '../servicios/webPush';

/** Repositorio SQL Server de la bandeja (Notificaciones, NotificacionUsuario) y de las suscripciones push. */

const db = () => getDB();
/** Alarma que exige atención y nadie atendió ni se resolvió (no se puede quitar de la bandeja) */
const PENDIENTE = 'n.requiere_ack = 1 AND n.fecha_atencion IS NULL AND n.fecha_resolucion IS NULL';

export const repositorioNotificacionesSql: RepositorioNotificaciones = {
  async bandeja(usuarioId, c) {
    const request = db().request().input('uid', sql.Int, usuarioId).input('n', sql.Int, c.limite);
    const filtros = ['nu.usuario_id = @uid', 'nu.fecha_eliminacion IS NULL'];
    if (c.antesDe !== null) { request.input('antes', sql.BigInt, c.antesDe); filtros.push('n.id < @antes'); }
    if (c.desde !== null) {
      // Recuperación: nuevas o modificadas después del último id conocido por el cliente
      request.input('desde', sql.BigInt, c.desde);
      filtros.push('(n.id > @desde OR n.fecha_ultima >= DATEADD(MINUTE, -10, SYSDATETIME()))');
    }
    if (c.filtro === 'no_leidas') filtros.push('nu.fecha_lectura IS NULL');
    if (c.filtro === 'pendientes') filtros.push('n.requiere_ack = 1 AND n.fecha_atencion IS NULL AND n.fecha_resolucion IS NULL');
    const r = await request.query(`
      SELECT TOP (@n) n.*, nu.fecha_lectura, ua.nombre_completo AS atendida_por_nombre
      FROM NotificacionUsuario nu JOIN Notificaciones n ON n.id = nu.notificacion_id
      LEFT JOIN Usuarios ua ON ua.id = n.atendida_por
      WHERE ${filtros.join(' AND ')}
      ORDER BY n.id DESC`);
    return r.recordset.map(mapearNotificacion);
  },

  async resumen(usuarioId) {
    const r = await db().request().input('uid', sql.Int, usuarioId).query(`
      SELECT
        SUM(CASE WHEN nu.fecha_lectura IS NULL THEN 1 ELSE 0 END) AS no_leidas,
        SUM(CASE WHEN ${PENDIENTE} THEN 1 ELSE 0 END) AS pendientes,
        SUM(CASE WHEN nu.fecha_lectura IS NOT NULL AND NOT (${PENDIENTE}) THEN 1 ELSE 0 END) AS revisadas
      FROM NotificacionUsuario nu JOIN Notificaciones n ON n.id = nu.notificacion_id
      WHERE nu.usuario_id = @uid AND nu.fecha_eliminacion IS NULL`);
    const f = r.recordset[0] ?? {};
    return { no_leidas: Number(f.no_leidas ?? 0), pendientes: Number(f.pendientes ?? 0), revisadas: Number(f.revisadas ?? 0) };
  },

  async leerTodas(usuarioId) {
    await db().request().input('uid', sql.Int, usuarioId)
      .query('UPDATE NotificacionUsuario SET fecha_lectura = SYSDATETIME() WHERE usuario_id = @uid AND fecha_lectura IS NULL AND fecha_eliminacion IS NULL');
  },

  async leer(usuarioId, id) {
    await db().request().input('uid', sql.Int, usuarioId).input('id', sql.BigInt, id).query(`
      UPDATE NotificacionUsuario SET fecha_lectura = COALESCE(fecha_lectura, SYSDATETIME())
      WHERE usuario_id = @uid AND notificacion_id = @id`);
  },

  reconocer,

  async estadoEnBandeja(usuarioId, id) {
    const r = await db().request().input('uid', sql.Int, usuarioId).input('id', sql.BigInt, id).query(`
      SELECT nu.fecha_lectura, n.requiere_ack, n.fecha_atencion, n.fecha_resolucion
      FROM NotificacionUsuario nu JOIN Notificaciones n ON n.id = nu.notificacion_id
      WHERE nu.usuario_id = @uid AND nu.notificacion_id = @id AND nu.fecha_eliminacion IS NULL`);
    const f = r.recordset[0];
    return f ? { leida: Boolean(f.fecha_lectura), requiereAck: Boolean(f.requiere_ack), atendida: Boolean(f.fecha_atencion), resuelta: Boolean(f.fecha_resolucion) } : null;
  },

  // Misma regla que dominio/notificaciones.ts (puedeEliminarse), aplicada en la propia consulta
  async eliminar(usuarioId, id) {
    const r = await db().request().input('uid', sql.Int, usuarioId).input('id', sql.BigInt, id).query(`
      UPDATE NotificacionUsuario nu SET fecha_eliminacion = SYSDATETIME()
      FROM Notificaciones n
      WHERE n.id = nu.notificacion_id
        AND nu.usuario_id = @uid AND nu.notificacion_id = @id AND nu.fecha_eliminacion IS NULL
        AND nu.fecha_lectura IS NOT NULL AND NOT (${PENDIENTE})`);
    return r.rowsAffected[0] > 0;
  },

  async eliminarRevisadas(usuarioId) {
    const r = await db().request().input('uid', sql.Int, usuarioId).query(`
      UPDATE NotificacionUsuario nu SET fecha_eliminacion = SYSDATETIME()
      OUTPUT INSERTED.notificacion_id
      FROM Notificaciones n
      WHERE n.id = nu.notificacion_id AND nu.usuario_id = @uid AND nu.fecha_eliminacion IS NULL
        AND nu.fecha_lectura IS NOT NULL AND NOT (${PENDIENTE})`);
    return r.recordset.map(x => Number(x.notificacion_id));
  },

  async guardarSuscripcion(usuarioId, s, agente) {
    await db().request()
      .input('uid', sql.Int, usuarioId)
      .input('endpoint', sql.NVarChar(600), s.endpoint)
      .input('hash', sql.Char(64), hashEndpoint(s.endpoint))
      .input('p256dh', sql.VarChar(200), s.p256dh)
      .input('auth', sql.VarChar(100), s.auth)
      .input('ua', sql.NVarChar(255), agente)
      .query(`
        INSERT INTO SuscripcionesPush (usuario_id, endpoint, endpoint_hash, p256dh, auth, user_agent)
        VALUES (@uid, @endpoint, @hash, @p256dh, @auth, @ua)
        ON CONFLICT (endpoint_hash) DO UPDATE SET usuario_id = EXCLUDED.usuario_id,
          endpoint = EXCLUDED.endpoint, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
          user_agent = EXCLUDED.user_agent, fallos = 0, fecha_ultimo_uso = CURRENT_TIMESTAMP`);
  },

  async eliminarSuscripcion(usuarioId, endpoint) {
    await db().request().input('uid', sql.Int, usuarioId).input('hash', sql.Char(64), hashEndpoint(endpoint))
      .query('DELETE FROM SuscripcionesPush WHERE endpoint_hash = @hash AND usuario_id = @uid');
  },

  async suscripciones(usuarioId) {
    const r = await db().request().input('uid', sql.Int, usuarioId)
      .query('SELECT id, usuario_id, endpoint, p256dh, auth FROM SuscripcionesPush WHERE usuario_id = @uid');
    return r.recordset;
  },

  async eliminarSuscripciones(ids) {
    if (!ids.length) return;
    const del = db().request();
    ids.forEach((v, i) => del.input(`s${i}`, sql.Int, v));
    await del.query(`DELETE FROM SuscripcionesPush WHERE id IN (${ids.map((_, i) => `@s${i}`).join(',')})`);
  },

  async metricas(dias) {
    const p = () => db().request().input('d', sql.Int, dias);
    const [porSeveridad, tta, avalanchas] = await Promise.all([
      p().query(`
        SELECT severidad, COUNT(*) AS emitidas, SUM(repeticiones - 1) AS repeticiones_agrupadas,
               SUM(CASE WHEN requiere_ack = 1 THEN 1 ELSE 0 END) AS con_ack,
               SUM(CASE WHEN fecha_atencion IS NOT NULL THEN 1 ELSE 0 END) AS reconocidas,
               SUM(CASE WHEN escalada = 1 THEN 1 ELSE 0 END) AS escaladas
        FROM Notificaciones WHERE fecha_creacion >= DATEADD(DAY, -@d, SYSDATETIME()) AND tipo <> 'alarma.escalada'
        GROUP BY severidad`),
      p().query(`
        SELECT severidad,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (fecha_atencion - fecha_creacion))) AS tta_mediana_s,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (fecha_atencion - fecha_creacion))) AS tta_p95_s
        FROM Notificaciones
        WHERE fecha_creacion >= DATEADD(DAY, -@d, SYSDATETIME()) AND fecha_atencion IS NOT NULL
        GROUP BY severidad`),
      p().query(`
        SELECT COUNT(*) AS ventanas_avalancha FROM (
          SELECT date_bin(INTERVAL '10 minutes', fecha_creacion, TIMESTAMP '2000-01-01') AS ventana, COUNT(*) AS n
          FROM Notificaciones
          WHERE fecha_creacion >= DATEADD(DAY, -@d, SYSDATETIME()) AND severidad IN ('critica', 'alta')
          GROUP BY date_bin(INTERVAL '10 minutes', fecha_creacion, TIMESTAMP '2000-01-01')
        ) v WHERE v.n > 10`),
    ]);
    return { porSeveridad: porSeveridad.recordset, tta: tta.recordset, avalanchas: avalanchas.recordset[0] };
  },
};
