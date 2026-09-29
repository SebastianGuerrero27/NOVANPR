import { Router, Request, Response } from 'express';
import sql from 'mssql';
import { getDB } from '../config/db';
import { adminOSupervisor, authMiddleware } from '../middlewares/auth';
import { desfaseMinutos, inicioDiaLocal } from '../services/tiempo';

/**
 * Reporte consolidado de un período (Administrador / Supervisor).
 *
 *   GET /api/reportes?desde=ISO&hasta=ISO&camara=id
 *
 * Por omisión, los últimos 7 días locales. Máximo 366 días por consulta.
 */
const router = Router();
router.use(authMiddleware, adminOSupervisor);

const CONTEOS = `
  COUNT(*) AS total,
  SUM(CASE WHEN d.estado_validacion = 'autorizado' THEN 1 ELSE 0 END) AS autorizados,
  SUM(CASE WHEN d.estado_validacion = 'alerta' THEN 1 ELSE 0 END) AS alertas,
  SUM(CASE WHEN d.estado_validacion = 'no_reconocido' THEN 1 ELSE 0 END) AS no_registrados,
  SUM(CASE WHEN d.estado_validacion = 'pendiente_revision' OR d.estado_procesamiento = 'pendiente_ocr' THEN 1 ELSE 0 END) AS pendientes`;

const num = (o: any) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, typeof v === 'number' || v === null ? Number(v ?? 0) : v]));

router.get('/', async (req: Request, res: Response) => {
  const ahora = new Date();
  const desde = req.query.desde && !Number.isNaN(Date.parse(String(req.query.desde))) ? new Date(String(req.query.desde)) : inicioDiaLocal(ahora, -6);
  const hasta = req.query.hasta && !Number.isNaN(Date.parse(String(req.query.hasta))) ? new Date(String(req.query.hasta)) : ahora;
  if (hasta <= desde) return res.status(400).json({ error: 'La fecha final debe ser posterior a la inicial.' });
  if (hasta.getTime() - desde.getTime() > 366 * 86400000) return res.status(400).json({ error: 'El período máximo es de un año.' });
  const camara = req.query.camara && Number.isInteger(Number(req.query.camara)) ? Number(req.query.camara) : null;
  const desfase = desfaseMinutos(ahora);

  const p = () => getDB().request()
    .input('desde', sql.DateTime, desde).input('hasta', sql.DateTime, hasta)
    .input('camara', sql.Int, camara).input('desfase', sql.Int, desfase);
  const W = `d.estado_procesamiento IN ('procesado', 'no_legible', 'pendiente_ocr')
             AND d.fecha_hora_ingreso >= @desde AND d.fecha_hora_ingreso <= @hasta
             AND (@camara IS NULL OR d.camara_id = @camara)`;
  const DIA = 'CAST(DATEADD(MINUTE, @desfase, d.fecha_hora_ingreso) AS DATE)';
  const HORA = 'DATEPART(HOUR, DATEADD(MINUTE, @desfase, d.fecha_hora_ingreso))';

  try {
    const [totales, porDia, porHora, porCamara, porTipo, frecuentes, validacion, alertas] = await Promise.all([
      p().query(`
        SELECT ${CONTEOS},
               SUM(CASE WHEN d.validado_manualmente = 1 THEN 1 ELSE 0 END) AS validados,
               SUM(CASE WHEN d.fuente = 'manual' THEN 1 ELSE 0 END) AS manuales,
               COUNT(DISTINCT COALESCE(d.placa_validada, d.placa_reconocida)) AS placas_distintas,
               AVG(CAST(d.latencia_ms AS FLOAT)) AS latencia_media_ms,
               AVG(d.confianza_ocr) AS confianza_ocr_media
        FROM DeteccionVehiculo d WHERE ${W}`),
      p().query(`SELECT ${DIA} AS fecha, ${CONTEOS} FROM DeteccionVehiculo d WHERE ${W} GROUP BY ${DIA} ORDER BY fecha`),
      p().query(`SELECT ${HORA} AS hora, COUNT(*) AS total FROM DeteccionVehiculo d WHERE ${W} GROUP BY ${HORA}`),
      p().query(`
        SELECT d.camara_id, COALESCE(c.nombre, CASE WHEN d.fuente = 'manual' THEN 'Registro manual' ELSE 'Sin cámara asociada' END) AS camara, ${CONTEOS}
        FROM DeteccionVehiculo d LEFT JOIN Camaras c ON c.id = d.camara_id WHERE ${W}
        GROUP BY d.camara_id, c.nombre, CASE WHEN d.fuente = 'manual' THEN 'Registro manual' ELSE 'Sin cámara asociada' END
        ORDER BY total DESC`),
      p().query(`
        SELECT COALESCE(d.tipo_vehiculo, d.vehiculo_tipo, 'Sin clasificar') AS tipo, COUNT(*) AS total
        FROM DeteccionVehiculo d WHERE ${W}
        GROUP BY COALESCE(d.tipo_vehiculo, d.vehiculo_tipo, 'Sin clasificar') ORDER BY total DESC`),
      p().query(`
        SELECT TOP 10 COALESCE(d.placa_validada, d.placa_reconocida) AS placa, COUNT(*) AS ingresos,
               MAX(d.fecha_hora_ingreso) AS ultimo, MAX(d.estado_validacion) AS estado, MAX(v.propietario) AS propietario
        FROM DeteccionVehiculo d LEFT JOIN VehiculosAutorizados v ON v.id = d.vehiculo_autorizado_id
        WHERE ${W} AND COALESCE(d.placa_validada, d.placa_reconocida) IS NOT NULL
        GROUP BY COALESCE(d.placa_validada, d.placa_reconocida) ORDER BY ingresos DESC, ultimo DESC`),
      p().query(`
        SELECT u.nombre_completo AS usuario, COUNT(*) AS validaciones,
               SUM(CASE WHEN REPLACE(COALESCE(d.placa_ocr_original, ''), '-', '') <> REPLACE(d.placa_validada, '-', '') THEN 1 ELSE 0 END) AS correcciones
        FROM DeteccionVehiculo d JOIN Usuarios u ON u.id = d.usuario_validador_id
        WHERE ${W} AND d.validado_manualmente = 1
        GROUP BY u.nombre_completo ORDER BY validaciones DESC`),
      p().query(`
        SELECT TOP 50 d.id, d.fecha_hora_ingreso, COALESCE(d.placa_validada, d.placa_reconocida) AS placa,
               l.motivo, l.nivel_alerta, c.nombre AS camara, d.validado_manualmente
        FROM DeteccionVehiculo d LEFT JOIN ListaNegra l ON l.id = d.alerta_id LEFT JOIN Camaras c ON c.id = d.camara_id
        WHERE ${W} AND d.estado_validacion = 'alerta' ORDER BY d.fecha_hora_ingreso DESC`),
    ]);

    // Serie diaria continua (días sin registros = 0)
    const dias: any[] = [];
    for (let t = inicioDiaLocal(desde); t <= hasta; t = new Date(t.getTime() + 86400000)) {
      const clave = new Date(t.getTime() + desfase * 60000).toISOString().slice(0, 10);
      const f = porDia.recordset.find(x => new Date(x.fecha).toISOString().slice(0, 10) === clave);
      dias.push({ fecha: clave, ...num(f ? { total: f.total, autorizados: f.autorizados, alertas: f.alertas, no_registrados: f.no_registrados, pendientes: f.pendientes } : { total: 0, autorizados: 0, alertas: 0, no_registrados: 0, pendientes: 0 }) });
    }

    return res.json({
      periodo: { desde, hasta, camara },
      totales: { ...num(totales.recordset[0]), latencia_media_ms: totales.recordset[0].latencia_media_ms, confianza_ocr_media: totales.recordset[0].confianza_ocr_media },
      por_dia: dias,
      por_hora: Array.from({ length: 24 }, (_, h) => ({ hora: h, total: Number(porHora.recordset.find(x => x.hora === h)?.total ?? 0) })),
      por_camara: porCamara.recordset.map(num),
      por_tipo: porTipo.recordset.map(num),
      placas_frecuentes: frecuentes.recordset,
      validacion_por_usuario: validacion.recordset.map(num),
      alertas: alertas.recordset,
    });
  } catch (e: any) {
    console.error('[REPORTES] consulta:', e.message);
    return res.status(500).json({ error: 'No se pudo generar el reporte.' });
  }
});

export default router;
