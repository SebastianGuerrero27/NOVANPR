import sql from 'mssql';
import { getDB } from '../db';
import type { RepositorioReportes } from '../../aplicacion/reportes';

/**
 * Repositorio SQL Server del reporte consolidado: cada sección es una consulta de agregación
 * sobre DeteccionVehiculo dentro del período y, opcionalmente, de una cámara. Se ejecutan en
 * paralelo.
 */

const CONTEOS = `
  COUNT(*) AS total,
  SUM(CASE WHEN d.estado_validacion = 'autorizado' THEN 1 ELSE 0 END) AS autorizados,
  SUM(CASE WHEN d.estado_validacion = 'alerta' THEN 1 ELSE 0 END) AS alertas,
  SUM(CASE WHEN d.estado_validacion = 'no_reconocido' THEN 1 ELSE 0 END) AS no_registrados,
  SUM(CASE WHEN d.estado_validacion = 'pendiente_revision' OR d.estado_procesamiento = 'pendiente_ocr' THEN 1 ELSE 0 END) AS pendientes`;

const W = `d.estado_procesamiento IN ('procesado', 'no_legible', 'pendiente_ocr')
           AND d.fecha_hora_ingreso >= @desde AND d.fecha_hora_ingreso <= @hasta
           AND (@camara IS NULL OR d.camara_id = @camara)`;
const DIA = 'CAST(DATEADD(MINUTE, @desfase, d.fecha_hora_ingreso) AS DATE)';
const HORA = 'DATEPART(HOUR, DATEADD(MINUTE, @desfase, d.fecha_hora_ingreso))';

export const repositorioReportesSql: RepositorioReportes = {
  async consolidado(p, desfase) {
    const q = (consulta: string) => getDB().request()
      .input('desde', sql.DateTime, p.desde).input('hasta', sql.DateTime, p.hasta)
      .input('camara', sql.Int, p.camara).input('desfase', sql.Int, desfase)
      .query(consulta);

    const [totales, porDia, porHora, porCamara, porTipo, frecuentes, validacion, alertas] = await Promise.all([
      q(`
        SELECT ${CONTEOS},
               SUM(CASE WHEN d.validado_manualmente = 1 THEN 1 ELSE 0 END) AS validados,
               SUM(CASE WHEN d.fuente = 'manual' THEN 1 ELSE 0 END) AS manuales,
               COUNT(DISTINCT COALESCE(d.placa_validada, d.placa_reconocida)) AS placas_distintas,
               AVG(CAST(d.latencia_ms AS FLOAT)) AS latencia_media_ms,
               AVG(d.confianza_ocr) AS confianza_ocr_media
        FROM DeteccionVehiculo d WHERE ${W}`),
      q(`SELECT ${DIA} AS fecha, ${CONTEOS} FROM DeteccionVehiculo d WHERE ${W} GROUP BY ${DIA} ORDER BY fecha`),
      q(`SELECT ${HORA} AS hora, COUNT(*) AS total FROM DeteccionVehiculo d WHERE ${W} GROUP BY ${HORA}`),
      q(`
        SELECT d.camara_id, COALESCE(c.nombre, CASE WHEN d.fuente = 'manual' THEN 'Registro manual' ELSE 'Sin cámara asociada' END) AS camara, ${CONTEOS}
        FROM DeteccionVehiculo d LEFT JOIN Camaras c ON c.id = d.camara_id WHERE ${W}
        GROUP BY d.camara_id, c.nombre, CASE WHEN d.fuente = 'manual' THEN 'Registro manual' ELSE 'Sin cámara asociada' END
        ORDER BY total DESC`),
      q(`
        SELECT COALESCE(d.tipo_vehiculo, d.vehiculo_tipo, 'Sin clasificar') AS tipo, COUNT(*) AS total
        FROM DeteccionVehiculo d WHERE ${W}
        GROUP BY COALESCE(d.tipo_vehiculo, d.vehiculo_tipo, 'Sin clasificar') ORDER BY total DESC`),
      q(`
        SELECT TOP 10 COALESCE(d.placa_validada, d.placa_reconocida) AS placa, COUNT(*) AS ingresos,
               MAX(d.fecha_hora_ingreso) AS ultimo, MAX(d.estado_validacion) AS estado, MAX(v.propietario) AS propietario
        FROM DeteccionVehiculo d LEFT JOIN VehiculosAutorizados v ON v.id = d.vehiculo_autorizado_id
        WHERE ${W} AND COALESCE(d.placa_validada, d.placa_reconocida) IS NOT NULL
        GROUP BY COALESCE(d.placa_validada, d.placa_reconocida) ORDER BY ingresos DESC, ultimo DESC`),
      q(`
        SELECT u.nombre_completo AS usuario, COUNT(*) AS validaciones,
               SUM(CASE WHEN REPLACE(COALESCE(d.placa_ocr_original, ''), '-', '') <> REPLACE(d.placa_validada, '-', '') THEN 1 ELSE 0 END) AS correcciones
        FROM DeteccionVehiculo d JOIN Usuarios u ON u.id = d.usuario_validador_id
        WHERE ${W} AND d.validado_manualmente = 1
        GROUP BY u.nombre_completo ORDER BY validaciones DESC`),
      q(`
        SELECT TOP 50 d.id, d.fecha_hora_ingreso, COALESCE(d.placa_validada, d.placa_reconocida) AS placa,
               l.motivo, l.nivel_alerta, c.nombre AS camara, d.validado_manualmente
        FROM DeteccionVehiculo d LEFT JOIN ListaNegra l ON l.id = d.alerta_id LEFT JOIN Camaras c ON c.id = d.camara_id
        WHERE ${W} AND d.estado_validacion = 'alerta' ORDER BY d.fecha_hora_ingreso DESC`),
    ]);

    return {
      totales: totales.recordset[0],
      porDia: porDia.recordset,
      porHora: porHora.recordset,
      porCamara: porCamara.recordset,
      porTipo: porTipo.recordset,
      frecuentes: frecuentes.recordset,
      validacion: validacion.recordset,
      alertas: alertas.recordset,
    };
  },
};
