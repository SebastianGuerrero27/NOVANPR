import { Router, Request, Response } from 'express';
import sql from 'mssql';
import { getDB } from '../config/db';
import { authMiddleware, requierePermiso } from '../middlewares/auth';
import { CATALOGO } from '../dominio/notificaciones';
import { mapearNotificacion, reconocer } from '../services/notificaciones';
import { clavePublicaVapid, enviarPush, hashEndpoint, webPushHabilitado } from '../services/webPush';
import { config } from '../services/configuracion';

/**
 * Bandeja de notificaciones de la sesión (cada usuario ve solo las suyas).
 *
 *   GET    /                         bandeja: ?limite, ?antes_de=<id> (paginación), ?desde=<id> (recuperación
 *                                    tras reconectar), ?filtro=no_leidas|pendientes
 *   GET    /resumen                  { no_leidas, pendientes } para la campana del encabezado
 *   GET    /catalogo                 tipos de notificación (etiqueta, prioridad, canales)
 *   POST   /:id/leer                 marca como leída
 *   POST   /leer-todas               marca todas como leídas
 *   POST   /:id/reconocer            reconocimiento (ACK) de una alarma
 *   POST   /reconocer-deteccion/:id  ACK de las alarmas de un paso (botón "Enterado" del aviso de garita)
 *   GET    /push/clave               clave pública VAPID y si el canal push está activo
 *   POST   /push/suscripcion         registra la suscripción push del navegador
 *   DELETE /push/suscripcion         la elimina (el usuario desactivó las notificaciones)
 *   POST   /push/prueba              envía un push de prueba a los equipos del usuario
 *   GET    /metricas                 indicadores del canal para la evaluación (evaluacion:ver)
 */
const router = Router();
router.use(authMiddleware);

const idParam = (v: string) => (/^\d+$/.test(v) ? Number(v) : null);

async function resumen(usuarioId: number) {
  const r = await getDB().request().input('uid', sql.Int, usuarioId).query(`
    SELECT
      SUM(CASE WHEN nu.fecha_lectura IS NULL THEN 1 ELSE 0 END) AS no_leidas,
      SUM(CASE WHEN n.requiere_ack = 1 AND n.fecha_atencion IS NULL AND n.fecha_resolucion IS NULL THEN 1 ELSE 0 END) AS pendientes
    FROM NotificacionUsuario nu JOIN Notificaciones n ON n.id = nu.notificacion_id
    WHERE nu.usuario_id = @uid`);
  return { no_leidas: Number(r.recordset[0]?.no_leidas ?? 0), pendientes: Number(r.recordset[0]?.pendientes ?? 0) };
}

router.get('/', async (req: Request, res: Response) => {
  const limite = Math.min(100, Math.max(1, Number(req.query.limite) || 30));
  try {
    const request = getDB().request().input('uid', sql.Int, req.user!.id).input('n', sql.Int, limite);
    const filtros = ['nu.usuario_id = @uid'];
    const antes = idParam(String(req.query.antes_de ?? ''));
    const desde = idParam(String(req.query.desde ?? ''));
    if (antes !== null) { request.input('antes', sql.BigInt, antes); filtros.push('n.id < @antes'); }
    if (desde !== null) {
      // Recuperación: nuevas o modificadas después del último id conocido por el cliente
      request.input('desde', sql.BigInt, desde);
      filtros.push('(n.id > @desde OR n.fecha_ultima >= DATEADD(MINUTE, -10, SYSDATETIME()))');
    }
    if (req.query.filtro === 'no_leidas') filtros.push('nu.fecha_lectura IS NULL');
    if (req.query.filtro === 'pendientes') filtros.push('n.requiere_ack = 1 AND n.fecha_atencion IS NULL AND n.fecha_resolucion IS NULL');
    const r = await request.query(`
      SELECT TOP (@n) n.*, nu.fecha_lectura, ua.nombre_completo AS atendida_por_nombre
      FROM NotificacionUsuario nu JOIN Notificaciones n ON n.id = nu.notificacion_id
      LEFT JOIN Usuarios ua ON ua.id = n.atendida_por
      WHERE ${filtros.join(' AND ')}
      ORDER BY n.id DESC`);
    return res.json({ items: r.recordset.map(mapearNotificacion), ...(await resumen(req.user!.id)) });
  } catch (e: any) {
    console.error('[NOTIFICACIONES] bandeja:', e.message);
    return res.status(500).json({ error: 'No se pudieron obtener las notificaciones.' });
  }
});

router.get('/resumen', async (req: Request, res: Response) => {
  try {
    return res.json(await resumen(req.user!.id));
  } catch (e: any) {
    console.error('[NOTIFICACIONES] resumen:', e.message);
    return res.status(500).json({ error: 'No se pudo obtener el resumen de notificaciones.' });
  }
});

router.get('/catalogo', (_req: Request, res: Response) => {
  return res.json(Object.entries(CATALOGO).map(([tipo, d]) => ({
    tipo, etiqueta: d.etiqueta, severidad: d.severidad, requiere_ack: d.requiereAck, push: d.push, permiso: d.permiso ?? null,
  })));
});

router.post('/leer-todas', async (req: Request, res: Response) => {
  try {
    await getDB().request().input('uid', sql.Int, req.user!.id)
      .query('UPDATE NotificacionUsuario SET fecha_lectura = SYSDATETIME() WHERE usuario_id = @uid AND fecha_lectura IS NULL');
    return res.json({ message: 'Notificaciones marcadas como leídas.', ...(await resumen(req.user!.id)) });
  } catch (e: any) {
    console.error('[NOTIFICACIONES] leer todas:', e.message);
    return res.status(500).json({ error: 'No se pudieron marcar las notificaciones.' });
  }
});

router.post('/:id(\\d+)/leer', async (req: Request, res: Response) => {
  try {
    await getDB().request().input('uid', sql.Int, req.user!.id).input('id', sql.BigInt, Number(req.params.id)).query(`
      UPDATE NotificacionUsuario SET fecha_lectura = COALESCE(fecha_lectura, SYSDATETIME())
      WHERE usuario_id = @uid AND notificacion_id = @id`);
    return res.json(await resumen(req.user!.id));
  } catch (e: any) {
    console.error('[NOTIFICACIONES] leer:', e.message);
    return res.status(500).json({ error: 'No se pudo marcar la notificación.' });
  }
});

router.post('/:id(\\d+)/reconocer', async (req: Request, res: Response) => {
  try {
    const n = await reconocer(req.user!.id, { id: Number(req.params.id) });
    return res.json({ reconocidas: n, ...(await resumen(req.user!.id)) });
  } catch (e: any) {
    console.error('[NOTIFICACIONES] reconocer:', e.message);
    return res.status(500).json({ error: 'No se pudo registrar el reconocimiento.' });
  }
});

router.post('/reconocer-deteccion/:id(\\d+)', async (req: Request, res: Response) => {
  try {
    const n = await reconocer(req.user!.id, { deteccionId: Number(req.params.id) });
    return res.json({ reconocidas: n, ...(await resumen(req.user!.id)) });
  } catch (e: any) {
    console.error('[NOTIFICACIONES] reconocer detección:', e.message);
    return res.status(500).json({ error: 'No se pudo registrar el reconocimiento.' });
  }
});

// ─── Web Push ────────────────────────────────────────────────────────────────

router.get('/push/clave', (_req: Request, res: Response) => {
  return res.json({ habilitado: webPushHabilitado() && config.booleano('notif_push_habilitado'), clave_publica: clavePublicaVapid() });
});

router.post('/push/suscripcion', async (req: Request, res: Response) => {
  const endpoint = String(req.body?.endpoint ?? '');
  const p256dh = String(req.body?.keys?.p256dh ?? '');
  const auth = String(req.body?.keys?.auth ?? '');
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 600 || !p256dh || p256dh.length > 200 || !auth || auth.length > 100) {
    return res.status(400).json({ error: 'Suscripción push inválida.' });
  }
  try {
    // Un mismo navegador puede pasar a otra cuenta: la suscripción se reasigna al usuario actual
    await getDB().request()
      .input('uid', sql.Int, req.user!.id)
      .input('endpoint', sql.NVarChar(600), endpoint)
      .input('hash', sql.Char(64), hashEndpoint(endpoint))
      .input('p256dh', sql.VarChar(200), p256dh)
      .input('auth', sql.VarChar(100), auth)
      .input('ua', sql.NVarChar(255), String(req.headers['user-agent'] ?? '').substring(0, 255))
      .query(`
        MERGE SuscripcionesPush AS t USING (SELECT @hash AS endpoint_hash) AS s ON t.endpoint_hash = s.endpoint_hash
        WHEN MATCHED THEN UPDATE SET usuario_id = @uid, p256dh = @p256dh, auth = @auth, user_agent = @ua, fallos = 0, fecha_ultimo_uso = SYSDATETIME()
        WHEN NOT MATCHED THEN INSERT (usuario_id, endpoint, endpoint_hash, p256dh, auth, user_agent)
             VALUES (@uid, @endpoint, @hash, @p256dh, @auth, @ua);`);
    return res.status(201).json({ message: 'Notificaciones del navegador activadas en este equipo.' });
  } catch (e: any) {
    console.error('[NOTIFICACIONES] suscripción:', e.message);
    return res.status(500).json({ error: 'No se pudo registrar la suscripción.' });
  }
});

router.delete('/push/suscripcion', async (req: Request, res: Response) => {
  const endpoint = String(req.body?.endpoint ?? '');
  if (!endpoint) return res.status(400).json({ error: 'Indique la suscripción.' });
  try {
    await getDB().request().input('uid', sql.Int, req.user!.id).input('hash', sql.Char(64), hashEndpoint(endpoint))
      .query('DELETE FROM SuscripcionesPush WHERE endpoint_hash = @hash AND usuario_id = @uid');
    return res.json({ message: 'Notificaciones del navegador desactivadas en este equipo.' });
  } catch (e: any) {
    console.error('[NOTIFICACIONES] baja de suscripción:', e.message);
    return res.status(500).json({ error: 'No se pudo eliminar la suscripción.' });
  }
});

router.post('/push/prueba', async (req: Request, res: Response) => {
  if (!webPushHabilitado()) return res.status(503).json({ error: 'El canal push no está disponible en el servidor.' });
  try {
    const db = getDB();
    const subs = (await db.request().input('uid', sql.Int, req.user!.id)
      .query('SELECT id, usuario_id, endpoint, p256dh, auth FROM SuscripcionesPush WHERE usuario_id = @uid')).recordset;
    if (!subs.length) return res.status(404).json({ error: 'Este usuario no tiene equipos suscritos.' });
    const r = await enviarPush(subs, {
      id: 0, tipo: 'prueba', severidad: 'baja', titulo: 'Prueba de notificaciones',
      mensaje: 'Las notificaciones del Sistema ANPR llegan a este equipo.', enlace: '/notificaciones',
    }, { ttlS: 60, urgencia: 'normal' });
    if (r.vencidas.length) {
      const del = db.request();
      r.vencidas.forEach((v, i) => del.input(`s${i}`, sql.Int, v));
      await del.query(`DELETE FROM SuscripcionesPush WHERE id IN (${r.vencidas.map((_, i) => `@s${i}`).join(',')})`);
    }
    return res.json({ message: `Prueba enviada a ${r.enviados} ${r.enviados === 1 ? 'equipo' : 'equipos'}.`, ...r });
  } catch (e: any) {
    console.error('[NOTIFICACIONES] prueba push:', e.message);
    return res.status(500).json({ error: 'No se pudo enviar la prueba.' });
  }
});

// ─── Indicadores para la evaluación científica del canal ─────────────────────

/**
 * Tiempo de reconocimiento (TTA) por prioridad (mediana y p95), tasa de escalamiento y
 * tasa de alarmas por hora en el período (ISA-18.2 recomienda ≤ 6 alarmas/h por operador
 * en régimen estable y define "avalancha" como > 10 alarmas en 10 min).
 */
router.get('/metricas', requierePermiso('evaluacion:ver'), async (req: Request, res: Response) => {
  const dias = Math.min(90, Math.max(1, Number(req.query.dias) || 7));
  try {
    const db = getDB();
    const p = () => db.request().input('d', sql.Int, dias);
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
    const filas = porSeveridad.recordset.map(f => {
      const t = tta.recordset.find(x => x.severidad === f.severidad);
      return {
        severidad: f.severidad,
        emitidas: Number(f.emitidas), repeticiones_agrupadas: Number(f.repeticiones_agrupadas ?? 0),
        con_ack: Number(f.con_ack), reconocidas: Number(f.reconocidas), escaladas: Number(f.escaladas),
        tta_mediana_s: t ? Number(t.tta_mediana_s) : null, tta_p95_s: t ? Number(t.tta_p95_s) : null,
      };
    });
    const total = filas.reduce((a, f) => a + f.emitidas, 0);
    return res.json({
      dias, por_severidad: filas,
      alarmas_por_hora: total / (dias * 24),
      ventanas_avalancha_10min: Number(avalanchas.recordset[0]?.ventanas_avalancha ?? 0),
    });
  } catch (e: any) {
    console.error('[NOTIFICACIONES] métricas:', e.message);
    return res.status(500).json({ error: 'No se pudieron calcular las métricas de notificación.' });
  }
});

export default router;
