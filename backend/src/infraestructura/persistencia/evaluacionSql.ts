import sql from 'mssql';
import { getDB } from '../db';
import type { RepositorioEvaluacion } from '../../aplicacion/evaluacion';

/** Repositorio SQL Server de la evaluación: los pasos de DeteccionVehiculo con sus metadatos de captura. */
export const repositorioEvaluacionSql: RepositorioEvaluacion = {
  async pasos(f) {
    const r = getDB().request();
    const filtros: string[] = ["estado_procesamiento <> 'pendiente_ocr'"];
    if (f.inicio) { r.input('desde', sql.DateTime, f.inicio); filtros.push('fecha_hora_ingreso >= @desde'); }
    if (f.fin) { r.input('hasta', sql.DateTime, f.fin); filtros.push('fecha_hora_ingreso <= @hasta'); }
    if (f.camaraId !== null) { r.input('cam', sql.Int, f.camaraId); filtros.push('camara_id = @cam'); }

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
    return res.recordset;
  },
};
