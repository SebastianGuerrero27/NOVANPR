import { Router, Request, Response } from 'express';
import sql from 'mssql';
import { getDB } from '../config/db';
import { authMiddleware } from '../middlewares/auth';
import { bucketDistancia, bucketLuz, calcularEvaluacion, FilaEvaluacion, tipoPlaca } from '../services/evaluacion';

/**
 * Métricas de evaluación del sistema con datos de operación (tesis / artículo).
 *
 *   GET /api/evaluacion/resumen?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&camara_id=1
 *   GET /api/evaluacion/export.csv?desde=...&hasta=...   (una fila por paso vehicular)
 *
 * El CSV alimenta services/anpr/scripts/estadistica.py (bootstrap, McNemar).
 */
const router = Router();

async function cargarFilas(req: Request): Promise<{ filas: any[]; total: number }> {
  const { desde, hasta, camara_id } = req.query;
  const db = getDB();
  const r = db.request();
  const filtros: string[] = ["estado_procesamiento <> 'pendiente_ocr'"];
  if (typeof desde === 'string' && desde) { r.input('desde', sql.DateTime, new Date(desde)); filtros.push('fecha_hora_ingreso >= @desde'); }
  if (typeof hasta === 'string' && hasta) { r.input('hasta', sql.DateTime, new Date(`${hasta}T23:59:59`)); filtros.push('fecha_hora_ingreso <= @hasta'); }
  if (camara_id && !isNaN(Number(camara_id))) { r.input('cam', sql.Int, Number(camara_id)); filtros.push('camara_id = @cam'); }

  const res = await r.query(`
    SELECT id, fecha_hora_ingreso, camara_id, fuente, validado_manualmente,
           placa_ocr_original, confianza_ocr_original, placa_validada, lectura_verificador,
           decision_automatica, estado_validacion AS decision_final, latencia_ms,
           luminancia_media, distancia_estimada_m, ancho_placa_px, nitidez, velocidad_px_s,
           condicion_clima, modelo_detector, modelo_ocr, confianza_deteccion
    FROM DeteccionVehiculo
    WHERE ${filtros.join(' AND ')}
    ORDER BY fecha_hora_ingreso
  `);
  return { filas: res.recordset, total: res.recordset.length };
}

router.get('/resumen', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { filas, total } = await cargarFilas(req);
    const validadas: FilaEvaluacion[] = filas.filter(f => f.validado_manualmente);
    const resumen = calcularEvaluacion(validadas, total);
    const modelos = [...new Set(filas.map(f => `${f.modelo_detector ?? '?'} + ${f.modelo_ocr ?? '?'}`))];
    return res.json({ periodo: { desde: req.query.desde ?? null, hasta: req.query.hasta ?? null }, modelos, ...resumen });
  } catch (error: any) {
    console.error('[EVALUACION] Error al calcular resumen:', error.message);
    return res.status(500).json({ error: 'Error al calcular las métricas de evaluación.' });
  }
});

const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

router.get('/export.csv', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { filas } = await cargarFilas(req);
    const columnas = [
      'id', 'fecha_hora_ingreso', 'camara_id', 'fuente', 'validado_manualmente',
      'placa_ocr_original', 'confianza_ocr_original', 'placa_validada', 'lectura_verificador',
      'decision_automatica', 'decision_final', 'latencia_ms', 'luminancia_media', 'distancia_estimada_m',
      'ancho_placa_px', 'nitidez', 'velocidad_px_s', 'condicion_clima', 'modelo_detector', 'modelo_ocr',
      'confianza_deteccion', 'luz', 'rango_distancia', 'tipo_servicio', 'formato_placa',
    ];
    const lineas = [columnas.join(',')];
    for (const f of filas) {
      const tipo = f.placa_validada ? tipoPlaca(f.placa_validada) : { servicio: '', formato: '' };
      const fila = {
        ...f,
        luz: bucketLuz(f.luminancia_media, f.fecha_hora_ingreso),
        rango_distancia: bucketDistancia(f.distancia_estimada_m),
        tipo_servicio: tipo.servicio,
        formato_placa: tipo.formato,
      };
      lineas.push(columnas.map(c => csvCell((fila as any)[c])).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="evaluacion_anpr.csv"');
    return res.send(lineas.join('\n'));
  } catch (error: any) {
    console.error('[EVALUACION] Error al exportar CSV:', error.message);
    return res.status(500).json({ error: 'Error al exportar los datos de evaluación.' });
  }
});

export default router;
