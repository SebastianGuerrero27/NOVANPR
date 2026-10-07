import sql from 'mssql';
import { getDB } from '../db';
import type { RepositorioPanel } from '../../aplicacion/panel';
import { hoyLocalSql } from '../servicios/tiempo';

/**
 * Repositorio SQL Server del panel de inicio. Cada indicador es una consulta de agregación
 * sobre los registros reales; las de un mismo panel se ejecutan en paralelo.
 */

const CONTEOS = `
  COUNT(*) AS total,
  SUM(CASE WHEN estado_validacion = 'autorizado' THEN 1 ELSE 0 END) AS autorizados,
  SUM(CASE WHEN estado_validacion = 'alerta' THEN 1 ELSE 0 END) AS alertas,
  SUM(CASE WHEN estado_validacion = 'no_reconocido' THEN 1 ELSE 0 END) AS no_registrados,
  SUM(CASE WHEN estado_validacion = 'pendiente_revision' OR estado_procesamiento = 'pendiente_ocr' THEN 1 ELSE 0 END) AS pendientes,
  SUM(CASE WHEN validado_manualmente = 1 THEN 1 ELSE 0 END) AS validados`;

/** Pasos que cuentan en los indicadores (procesados, ilegibles o a la espera de OCR). */
const BASE = `estado_procesamiento IN ('procesado', 'no_legible', 'pendiente_ocr')`;

const db = () => getDB();

export const repositorioPanelSql: RepositorioPanel = {
  async operacion(p) {
    const q = (consulta: string) => db().request()
      .input('hoy', sql.DateTime, p.hoy).input('ayer', sql.DateTime, p.ayer).input('hace7', sql.DateTime, p.hace7)
      .input('mismaHoraAyer', sql.DateTime, p.mismaHoraAyer).input('desfase', sql.Int, p.desfase).input('dias', sql.Int, p.diasAviso)
      .query(consulta);
    const h = hoyLocalSql();

    const [dia, ayer, porHora, tendencia, camaras, cola, alertas, listas, precision] = await Promise.all([
      q(`SELECT ${CONTEOS} FROM DeteccionVehiculo WHERE ${BASE} AND fecha_hora_ingreso >= @hoy`),
      q(`SELECT COUNT(*) AS total FROM DeteccionVehiculo WHERE ${BASE} AND fecha_hora_ingreso >= @ayer AND fecha_hora_ingreso < @mismaHoraAyer`),
      q(`
        SELECT DATEPART(HOUR, DATEADD(MINUTE, @desfase, fecha_hora_ingreso)) AS hora, ${CONTEOS}
        FROM DeteccionVehiculo WHERE ${BASE} AND fecha_hora_ingreso >= @hoy
        GROUP BY DATEPART(HOUR, DATEADD(MINUTE, @desfase, fecha_hora_ingreso))`),
      q(`
        SELECT CAST(DATEADD(MINUTE, @desfase, fecha_hora_ingreso) AS DATE) AS fecha, ${CONTEOS}
        FROM DeteccionVehiculo WHERE ${BASE} AND fecha_hora_ingreso >= @hace7
        GROUP BY CAST(DATEADD(MINUTE, @desfase, fecha_hora_ingreso) AS DATE)`),
      q(`
        SELECT c.id, c.nombre, c.ubicacion, c.activa, c.estado, c.ultimo_ping, c.tiempo_respuesta_ms,
               (SELECT COUNT(*) FROM DeteccionVehiculo d WHERE d.camara_id = c.id AND d.fecha_hora_ingreso >= @hoy) AS detecciones_hoy
        FROM Camaras c ORDER BY c.nombre`),
      q(`SELECT COUNT(*) AS n FROM DeteccionVehiculo WHERE estado_validacion = 'pendiente_revision' AND validado_manualmente = 0`),
      q(`
        SELECT TOP 5 d.*, c.nombre AS camara_nombre, c.ubicacion AS camara_ubicacion, l.motivo AS alerta_motivo, l.nivel_alerta
        FROM DeteccionVehiculo d LEFT JOIN Camaras c ON c.id = d.camara_id LEFT JOIN ListaNegra l ON l.id = d.alerta_id
        WHERE d.estado_validacion = 'alerta' ORDER BY d.fecha_hora_ingreso DESC`),
      q(`
        SELECT
          (SELECT COUNT(*) FROM VehiculosAutorizados WHERE activo = 1 AND (fecha_vencimiento IS NULL OR fecha_vencimiento >= ${h})) AS autorizados_vigentes,
          (SELECT COUNT(*) FROM VehiculosAutorizados WHERE activo = 1 AND fecha_vencimiento >= ${h}
             AND fecha_vencimiento <= DATEADD(DAY, @dias, ${h})) AS autorizados_por_vencer,
          (SELECT COUNT(*) FROM VehiculosAutorizados WHERE activo = 1 AND fecha_vencimiento < ${h}) AS autorizados_vencidos,
          (SELECT COUNT(*) FROM ListaNegra WHERE activo = 1 AND (fecha_vencimiento IS NULL OR fecha_vencimiento >= ${h})) AS alertas_vigentes`),
      // Exactitud de la lectura automática frente a lo confirmado por el personal (últimos 7 días)
      q(`
        SELECT COUNT(*) AS validadas,
               SUM(CASE WHEN REPLACE(COALESCE(placa_ocr_original, ''), '-', '') = REPLACE(placa_validada, '-', '') THEN 1 ELSE 0 END) AS correctas
        FROM DeteccionVehiculo
        WHERE validado_manualmente = 1 AND placa_validada IS NOT NULL AND COALESCE(decision_automatica, '') <> 'manual'
          AND fecha_hora_ingreso >= @hace7`),
    ]);

    return {
      hoy: dia.recordset[0],
      ayer: ayer.recordset[0],
      porHora: porHora.recordset,
      tendencia: tendencia.recordset,
      camaras: camaras.recordset,
      cola: cola.recordset[0],
      alertas: alertas.recordset,
      listas: listas.recordset[0],
      precision: precision.recordset[0],
    };
  },

  async accesos(p) {
    const q = (consulta: string) => db().request()
      .input('hoy', sql.DateTime, p.hoy).input('hace7', sql.DateTime, p.hace7).input('dias', sql.Int, p.diasAviso)
      .input('uid', sql.Int, p.usuarioId)
      .query(consulta);
    const h = hoyLocalSql();

    const [solicitudes, padron, categorias, denegados, reincidentes, recientes] = await Promise.all([
      q(`
        SELECT TOP 5 s.id, s.placa, s.propietario, s.categoria, s.motivo, s.fecha_solicitud, u.nombre_completo AS solicitante,
               (SELECT COUNT(*) FROM SolicitudesAcceso WHERE estado = 'pendiente' AND solicitado_por <> @uid) AS total
        FROM SolicitudesAcceso s JOIN Usuarios u ON u.id = s.solicitado_por
        -- Separación de funciones: las solicitudes propias no son trabajo pendiente de quien las registró
        WHERE s.estado = 'pendiente' AND s.solicitado_por <> @uid ORDER BY s.fecha_solicitud`),
      q(`
        SELECT
          SUM(CASE WHEN (fecha_vencimiento IS NULL OR fecha_vencimiento >= ${h}) AND (fecha_inicio IS NULL OR fecha_inicio <= ${h}) THEN 1 ELSE 0 END) AS vigentes,
          SUM(CASE WHEN fecha_vencimiento >= ${h} AND fecha_vencimiento <= DATEADD(DAY, @dias, ${h}) THEN 1 ELSE 0 END) AS por_vencer,
          SUM(CASE WHEN fecha_vencimiento < ${h} THEN 1 ELSE 0 END) AS vencidos,
          SUM(CASE WHEN fecha_inicio > ${h} THEN 1 ELSE 0 END) AS por_iniciar,
          SUM(CASE WHEN horario IS NOT NULL THEN 1 ELSE 0 END) AS con_horario
        FROM VehiculosAutorizados WHERE activo = 1`),
      q(`SELECT categoria, COUNT(*) AS n FROM VehiculosAutorizados WHERE activo = 1 GROUP BY categoria`),
      q(`
        SELECT SUM(CASE WHEN restriccion_acceso IS NULL THEN 1 ELSE 0 END) AS sin_permiso,
               SUM(CASE WHEN restriccion_acceso IS NOT NULL THEN 1 ELSE 0 END) AS restringidos
        FROM DeteccionVehiculo WHERE estado_validacion = 'no_reconocido' AND fecha_hora_ingreso >= @hoy`),
      q(`
        SELECT TOP 5 REPLACE(COALESCE(placa_validada, placa_reconocida), '-', '') AS placa, COUNT(*) AS intentos,
               MAX(fecha_hora_ingreso) AS ultimo
        FROM DeteccionVehiculo
        WHERE estado_validacion = 'no_reconocido' AND restriccion_acceso IS NULL AND fecha_hora_ingreso >= @hace7
          AND COALESCE(placa_validada, placa_reconocida) IS NOT NULL
        GROUP BY REPLACE(COALESCE(placa_validada, placa_reconocida), '-', '')
        HAVING COUNT(*) >= 2 ORDER BY COUNT(*) DESC, MAX(fecha_hora_ingreso) DESC`),
      q(`
        SELECT TOP 8 d.*, c.nombre AS camara_nombre, c.ubicacion AS camara_ubicacion,
               v.propietario, v.departamento, v.categoria AS autorizado_categoria, v.horario AS autorizado_horario,
               v.fecha_inicio AS autorizado_inicio, v.fecha_vencimiento AS autorizado_vence
        FROM DeteccionVehiculo d LEFT JOIN Camaras c ON c.id = d.camara_id
        LEFT JOIN VehiculosAutorizados v ON v.id = d.vehiculo_autorizado_id
        WHERE d.estado_validacion = 'no_reconocido' AND d.fecha_hora_ingreso >= @hace7
        ORDER BY d.fecha_hora_ingreso DESC`),
    ]);

    return {
      solicitudes: solicitudes.recordset,
      padron: padron.recordset[0],
      categorias: categorias.recordset,
      denegados: denegados.recordset[0],
      reincidentes: reincidentes.recordset,
      recientes: recientes.recordset,
    };
  },

  async administracion() {
    const q = (consulta: string) => db().request().query(consulta);
    const [usuarios, accesos, fallidos, actividad] = await Promise.all([
      q(`
        SELECT r.codigo, u.estado, u.bloqueado,
               CASE WHEN u.bloqueado_hasta > SYSDATETIME() THEN 1 ELSE 0 END AS bloqueo_temporal, COUNT(*) AS n
        FROM Usuarios u JOIN Roles r ON r.id = u.rol_id
        GROUP BY r.codigo, u.estado, u.bloqueado, CASE WHEN u.bloqueado_hasta > SYSDATETIME() THEN 1 ELSE 0 END`),
      q(`
        SELECT SUM(CASE WHEN exito = 1 THEN 1 ELSE 0 END) AS exitosos, SUM(CASE WHEN exito = 0 THEN 1 ELSE 0 END) AS fallidos
        FROM AuditoriaAccesos WHERE fecha >= DATEADD(HOUR, -24, SYSDATETIME())`),
      q(`SELECT TOP 5 fecha, email, motivo, ip FROM AuditoriaAccesos WHERE exito = 0 ORDER BY fecha DESC`),
      q(`
        SELECT TOP 10 * FROM (
          SELECT fecha, usuario_email AS actor, accion, entidad, detalle FROM AuditoriaOperaciones
          UNION ALL
          SELECT fecha, actor_email AS actor, accion, 'usuario' AS entidad,
                 CONCAT(objetivo_email, CASE WHEN detalle IS NULL THEN '' ELSE CONCAT(' · ', detalle) END) AS detalle
          FROM AuditoriaUsuarios
        ) a ORDER BY fecha DESC`),
    ]);

    return {
      usuarios: usuarios.recordset,
      accesos: accesos.recordset[0],
      fallidos: fallidos.recordset,
      actividad: actividad.recordset,
    };
  },
};
