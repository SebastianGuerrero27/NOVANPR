import sql from 'mssql';
import { getDB } from '../db';
import type { RepositorioNotificaciones } from '../../aplicacion/notificaciones';
import { mapearNotificacion, reconocer } from '../servicios/notificaciones';
import { hashEndpoint } from '../servicios/webPush';

/** Repositorio SQL Server de la bandeja (Notificaciones, NotificacionUsuario) y de las suscripciones push. */

const db = () => getDB();

export const repositorioNotificacionesSql: RepositorioNotificaciones = {
  async bandeja(usuarioId, c) {
    const request = db().request().input('uid', sql.Int, usuarioId).input('n', sql.Int, c.limite);
    const filtros = ['nu.usuario_id = @uid'];
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
        SUM(CASE WHEN n.requiere_ack = 1 AND n.fecha_atencion IS NULL AND n.fecha_resolucion IS NULL THEN 1 ELSE 0 END) AS pendientes
      FROM NotificacionUsuario nu JOIN Notificaciones n ON n.id = nu.notificacion_id
      WHERE nu.usuario_id = @uid`);
    return { no_leidas: Number(r.recordset[0]?.no_leidas ?? 0), pendientes: Number(r.recordset[0]?.pendientes ?? 0) };
  },

  async leerTodas(usuarioId) {
    await db().request().input('uid', sql.Int, usuarioId)
      .query('UPDATE NotificacionUsuario SET fecha_lectura = SYSDATETIME() WHERE usuario_id = @uid AND fecha_lectura IS NULL');
  },

  async leer(usuarioId, id) {
    await db().request().input('uid', sql.Int, usuarioId).input('id', sql.BigInt, id).query(`
      UPDATE NotificacionUsuario SET fecha_lectura = COALESCE(fecha_lectura, SYSDATETIME())
      WHERE usuario_id = @uid AND notificacion_id = @id`);
  },

  reconocer,

  async guardarSuscripcion(usuarioId, s, agente) {
    await db().request()
      .input('uid', sql.Int, usuarioId)
      .input('endpoint', sql.NVarChar(600), s.endpoint)
      .input('hash', sql.Char(64), hashEndpoint(s.endpoint))
      .input('p256dh', sql.VarChar(200), s.p256dh)
      .input('auth', sql.VarChar(100), s.auth)
      .input('ua', sql.NVarChar(255), agente)
      .query(`
        MERGE SuscripcionesPush AS t USING (SELECT @hash AS endpoint_hash) AS s ON t.endpoint_hash = s.endpoint_hash
        WHEN MATCHED THEN UPDATE SET usuario_id = @uid, p256dh = @p256dh, auth = @auth, user_agent = @ua, fallos = 0, fecha_ultimo_uso = SYSDATETIME()
        WHEN NOT MATCHED THEN INSERT (usuario_id, endpoint, endpoint_hash, p256dh, auth, user_agent)
             VALUES (@uid, @endpoint, @hash, @p256dh, @auth, @ua);`);
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
        SELECT DISTINCT severidad,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY DATEDIFF_BIG(MILLISECOND, fecha_creacion, fecha_atencion)) OVER (PARTITION BY severidad) / 1000.0 AS tta_mediana_s,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY DATEDIFF_BIG(MILLISECOND, fecha_creacion, fecha_atencion)) OVER (PARTITION BY severidad) / 1000.0 AS tta_p95_s
        FROM Notificaciones
        WHERE fecha_creacion >= DATEADD(DAY, -@d, SYSDATETIME()) AND fecha_atencion IS NOT NULL`),
      p().query(`
        SELECT COUNT(*) AS ventanas_avalancha FROM (
          SELECT DATEADD(MINUTE, (DATEDIFF(MINUTE, 0, fecha_creacion) / 10) * 10, 0) AS ventana, COUNT(*) AS n
          FROM Notificaciones
          WHERE fecha_creacion >= DATEADD(DAY, -@d, SYSDATETIME()) AND severidad IN ('critica', 'alta')
          GROUP BY DATEADD(MINUTE, (DATEDIFF(MINUTE, 0, fecha_creacion) / 10) * 10, 0)
        ) v WHERE v.n > 10`),
    ]);
    return { porSeveridad: porSeveridad.recordset, tta: tta.recordset, avalanchas: avalanchas.recordset[0] };
  },
};
