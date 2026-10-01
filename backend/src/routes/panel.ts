import { Router, Request, Response } from 'express';
import sql from 'mssql';
import { getDB } from '../config/db';
import { authMiddleware, requierePermiso } from '../middlewares/auth';
import { ROL_POR_CODIGO, ROLES } from '../dominio/permisos';
import { config } from '../services/configuracion';
import { emailService } from '../services/emailService';
import { estadoServicioAnpr } from '../services/servicioAnpr';
import { desfaseMinutos, hoyLocalSql, inicioDiaLocal } from '../services/tiempo';
import { mapearDeteccion } from './detecciones';

/**
 * Datos del panel de inicio. Todo se calcula en la base con los registros reales: si no
 * hay detecciones, los indicadores valen cero (no hay datos de relleno).
 *
 *   GET /api/panel/resumen          operación (todos los roles)
 *   GET /api/panel/accesos          solicitudes, padrón, denegados y reincidentes (Gestor de accesos)
 *   GET /api/panel/administracion   cuentas, accesos, actividad y estado de servicios (Administrador)
 */
const router = Router();

const CONTEOS = `
  COUNT(*) AS total,
  SUM(CASE WHEN estado_validacion = 'autorizado' THEN 1 ELSE 0 END) AS autorizados,
  SUM(CASE WHEN estado_validacion = 'alerta' THEN 1 ELSE 0 END) AS alertas,
  SUM(CASE WHEN estado_validacion = 'no_reconocido' THEN 1 ELSE 0 END) AS no_registrados,
  SUM(CASE WHEN estado_validacion = 'pendiente_revision' OR estado_procesamiento = 'pendiente_ocr' THEN 1 ELSE 0 END) AS pendientes,
  SUM(CASE WHEN validado_manualmente = 1 THEN 1 ELSE 0 END) AS validados`;

const cero = (o: any) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, Number(v ?? 0)]));

router.get('/resumen', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const db = getDB();
    const ahora = new Date();
    const hoy = inicioDiaLocal(ahora);
    const ayer = inicioDiaLocal(ahora, -1);
    const hace7 = inicioDiaLocal(ahora, -6);
    const mismaHoraAyer = new Date(ahora.getTime() - 86400000);
    const desfase = desfaseMinutos(ahora);
    const diasAviso = config.entero('aviso_vencimiento_dias');
    const p = () => db.request()
      .input('hoy', sql.DateTime, hoy).input('ayer', sql.DateTime, ayer).input('hace7', sql.DateTime, hace7)
      .input('mismaHoraAyer', sql.DateTime, mismaHoraAyer).input('desfase', sql.Int, desfase).input('dias', sql.Int, diasAviso);
    const base = `estado_procesamiento IN ('procesado', 'no_legible', 'pendiente_ocr')`;

    const [dia, ayerR, porHora, tendencia, camaras, cola, alertas, listas, precision] = await Promise.all([
      p().query(`SELECT ${CONTEOS} FROM DeteccionVehiculo WHERE ${base} AND fecha_hora_ingreso >= @hoy`),
      p().query(`SELECT COUNT(*) AS total FROM DeteccionVehiculo WHERE ${base} AND fecha_hora_ingreso >= @ayer AND fecha_hora_ingreso < @mismaHoraAyer`),
      p().query(`
        SELECT DATEPART(HOUR, DATEADD(MINUTE, @desfase, fecha_hora_ingreso)) AS hora, ${CONTEOS}
        FROM DeteccionVehiculo WHERE ${base} AND fecha_hora_ingreso >= @hoy
        GROUP BY DATEPART(HOUR, DATEADD(MINUTE, @desfase, fecha_hora_ingreso))`),
      p().query(`
        SELECT CAST(DATEADD(MINUTE, @desfase, fecha_hora_ingreso) AS DATE) AS fecha, ${CONTEOS}
        FROM DeteccionVehiculo WHERE ${base} AND fecha_hora_ingreso >= @hace7
        GROUP BY CAST(DATEADD(MINUTE, @desfase, fecha_hora_ingreso) AS DATE)`),
      p().query(`
        SELECT c.id, c.nombre, c.ubicacion, c.activa, c.estado, c.ultimo_ping, c.tiempo_respuesta_ms,
               (SELECT COUNT(*) FROM DeteccionVehiculo d WHERE d.camara_id = c.id AND d.fecha_hora_ingreso >= @hoy) AS detecciones_hoy
        FROM Camaras c ORDER BY c.nombre`),
      p().query(`SELECT COUNT(*) AS n FROM DeteccionVehiculo WHERE estado_validacion = 'pendiente_revision' AND validado_manualmente = 0`),
      p().query(`
        SELECT TOP 5 d.*, c.nombre AS camara_nombre, c.ubicacion AS camara_ubicacion, l.motivo AS alerta_motivo, l.nivel_alerta
        FROM DeteccionVehiculo d LEFT JOIN Camaras c ON c.id = d.camara_id LEFT JOIN ListaNegra l ON l.id = d.alerta_id
        WHERE d.estado_validacion = 'alerta' ORDER BY d.fecha_hora_ingreso DESC`),
      p().query(`
        SELECT
          (SELECT COUNT(*) FROM VehiculosAutorizados WHERE activo = 1 AND (fecha_vencimiento IS NULL OR fecha_vencimiento >= ${hoyLocalSql()})) AS autorizados_vigentes,
          (SELECT COUNT(*) FROM VehiculosAutorizados WHERE activo = 1 AND fecha_vencimiento >= ${hoyLocalSql()}
             AND fecha_vencimiento <= DATEADD(DAY, @dias, ${hoyLocalSql()})) AS autorizados_por_vencer,
          (SELECT COUNT(*) FROM VehiculosAutorizados WHERE activo = 1 AND fecha_vencimiento < ${hoyLocalSql()}) AS autorizados_vencidos,
          (SELECT COUNT(*) FROM ListaNegra WHERE activo = 1 AND (fecha_vencimiento IS NULL OR fecha_vencimiento >= ${hoyLocalSql()})) AS alertas_vigentes`),
      // Exactitud de la lectura automática frente a lo confirmado por el personal (últimos 7 días)
      p().query(`
        SELECT COUNT(*) AS validadas,
               SUM(CASE WHEN REPLACE(COALESCE(placa_ocr_original, ''), '-', '') = REPLACE(placa_validada, '-', '') THEN 1 ELSE 0 END) AS correctas
        FROM DeteccionVehiculo
        WHERE validado_manualmente = 1 AND placa_validada IS NOT NULL AND COALESCE(decision_automatica, '') <> 'manual'
          AND fecha_hora_ingreso >= @hace7`),
    ]);

    const horas = Array.from({ length: 24 }, (_, h) => {
      const f = porHora.recordset.find(x => x.hora === h);
      return { hora: h, ...cero(f ? { total: f.total, autorizados: f.autorizados, alertas: f.alertas, no_registrados: f.no_registrados, pendientes: f.pendientes } : { total: 0, autorizados: 0, alertas: 0, no_registrados: 0, pendientes: 0 }) };
    });
    const dias = Array.from({ length: 7 }, (_, i) => {
      const inicio = inicioDiaLocal(ahora, i - 6);
      const clave = new Date(inicio.getTime() + desfase * 60000).toISOString().slice(0, 10);
      const f = tendencia.recordset.find(x => new Date(x.fecha).toISOString().slice(0, 10) === clave);
      return { fecha: clave, ...cero(f ? { total: f.total, autorizados: f.autorizados, alertas: f.alertas, no_registrados: f.no_registrados, pendientes: f.pendientes } : { total: 0, autorizados: 0, alertas: 0, no_registrados: 0, pendientes: 0 }) };
    });

    const prec = precision.recordset[0];
    return res.json({
      generado: ahora,
      hoy: cero(dia.recordset[0]),
      ayer_misma_hora: Number(ayerR.recordset[0].total),
      por_hora: horas,
      tendencia: dias,
      camaras: camaras.recordset.map(c => ({ ...c, activa: Boolean(c.activa) })),
      cola_revision: Number(cola.recordset[0].n),
      ultimas_alertas: alertas.recordset.map(d => mapearDeteccion(d)),
      listas: { ...cero(listas.recordset[0]), dias_aviso: diasAviso },
      exactitud_ocr: { validadas: Number(prec.validadas), correctas: Number(prec.correctas ?? 0) },
    });
  } catch (e: any) {
    console.error('[PANEL] resumen:', e.message);
    return res.status(500).json({ error: 'No se pudo obtener el resumen del panel.' });
  }
});

/**
 * Panel del Gestor de accesos: solicitudes, estado del padrón, accesos denegados y
 * restringidos de hoy y placas reincidentes (base para registrar o investigar).
 */
router.get('/accesos', authMiddleware, requierePermiso('padron:gestionar'), async (req: Request, res: Response) => {
  try {
    const db = getDB();
    const ahora = new Date();
    const hoy = inicioDiaLocal(ahora);
    const hace7 = inicioDiaLocal(ahora, -6);
    const diasAviso = config.entero('aviso_vencimiento_dias');
    const p = () => db.request().input('hoy', sql.DateTime, hoy).input('hace7', sql.DateTime, hace7).input('dias', sql.Int, diasAviso)
      .input('uid', sql.Int, req.user!.id);
    const h = hoyLocalSql();
    const [solicitudes, padron, categorias, denegados, reincidentes, recientes] = await Promise.all([
      p().query(`
        SELECT TOP 5 s.id, s.placa, s.propietario, s.categoria, s.motivo, s.fecha_solicitud, u.nombre_completo AS solicitante,
               (SELECT COUNT(*) FROM SolicitudesAcceso WHERE estado = 'pendiente' AND solicitado_por <> @uid) AS total
        FROM SolicitudesAcceso s JOIN Usuarios u ON u.id = s.solicitado_por
        -- Separación de funciones: las solicitudes propias no son trabajo pendiente de quien las registró
        WHERE s.estado = 'pendiente' AND s.solicitado_por <> @uid ORDER BY s.fecha_solicitud`),
      p().query(`
        SELECT
          SUM(CASE WHEN (fecha_vencimiento IS NULL OR fecha_vencimiento >= ${h}) AND (fecha_inicio IS NULL OR fecha_inicio <= ${h}) THEN 1 ELSE 0 END) AS vigentes,
          SUM(CASE WHEN fecha_vencimiento >= ${h} AND fecha_vencimiento <= DATEADD(DAY, @dias, ${h}) THEN 1 ELSE 0 END) AS por_vencer,
          SUM(CASE WHEN fecha_vencimiento < ${h} THEN 1 ELSE 0 END) AS vencidos,
          SUM(CASE WHEN fecha_inicio > ${h} THEN 1 ELSE 0 END) AS por_iniciar,
          SUM(CASE WHEN horario IS NOT NULL THEN 1 ELSE 0 END) AS con_horario
        FROM VehiculosAutorizados WHERE activo = 1`),
      p().query(`SELECT categoria, COUNT(*) AS n FROM VehiculosAutorizados WHERE activo = 1 GROUP BY categoria`),
      p().query(`
        SELECT SUM(CASE WHEN restriccion_acceso IS NULL THEN 1 ELSE 0 END) AS sin_permiso,
               SUM(CASE WHEN restriccion_acceso IS NOT NULL THEN 1 ELSE 0 END) AS restringidos
        FROM DeteccionVehiculo WHERE estado_validacion = 'no_reconocido' AND fecha_hora_ingreso >= @hoy`),
      p().query(`
        SELECT TOP 5 REPLACE(COALESCE(placa_validada, placa_reconocida), '-', '') AS placa, COUNT(*) AS intentos,
               MAX(fecha_hora_ingreso) AS ultimo
        FROM DeteccionVehiculo
        WHERE estado_validacion = 'no_reconocido' AND restriccion_acceso IS NULL AND fecha_hora_ingreso >= @hace7
          AND COALESCE(placa_validada, placa_reconocida) IS NOT NULL
        GROUP BY REPLACE(COALESCE(placa_validada, placa_reconocida), '-', '')
        HAVING COUNT(*) >= 2 ORDER BY COUNT(*) DESC, MAX(fecha_hora_ingreso) DESC`),
      p().query(`
        SELECT TOP 8 d.*, c.nombre AS camara_nombre, c.ubicacion AS camara_ubicacion,
               v.propietario, v.departamento, v.categoria AS autorizado_categoria, v.horario AS autorizado_horario,
               v.fecha_inicio AS autorizado_inicio, v.fecha_vencimiento AS autorizado_vence
        FROM DeteccionVehiculo d LEFT JOIN Camaras c ON c.id = d.camara_id
        LEFT JOIN VehiculosAutorizados v ON v.id = d.vehiculo_autorizado_id
        WHERE d.estado_validacion = 'no_reconocido' AND d.fecha_hora_ingreso >= @hace7
        ORDER BY d.fecha_hora_ingreso DESC`),
    ]);
    const sol = solicitudes.recordset;
    return res.json({
      generado: ahora,
      solicitudes: { pendientes: Number(sol[0]?.total ?? 0), ultimas: sol.map(({ total: _t, ...x }) => x) },
      padron: { ...cero(padron.recordset[0]), dias_aviso: diasAviso },
      categorias: Object.fromEntries(categorias.recordset.map(c => [c.categoria, Number(c.n)])),
      hoy: cero(denegados.recordset[0]),
      reincidentes: reincidentes.recordset.map(r => ({ placa: r.placa, intentos: Number(r.intentos), ultimo: r.ultimo })),
      denegados_recientes: recientes.recordset.map(d => mapearDeteccion(d)),
    });
  } catch (e: any) {
    console.error('[PANEL] accesos:', e.message);
    return res.status(500).json({ error: 'No se pudo obtener el panel de accesos.' });
  }
});

router.get('/administracion', authMiddleware, requierePermiso('usuarios:gestionar'), async (_req: Request, res: Response) => {
  try {
    const db = getDB();
    const [usuarios, accesos, fallidos, actividad, anpr] = await Promise.all([
      db.request().query(`
        SELECT r.codigo, u.estado, u.bloqueado,
               CASE WHEN u.bloqueado_hasta > SYSDATETIME() THEN 1 ELSE 0 END AS bloqueo_temporal, COUNT(*) AS n
        FROM Usuarios u JOIN Roles r ON r.id = u.rol_id
        GROUP BY r.codigo, u.estado, u.bloqueado, CASE WHEN u.bloqueado_hasta > SYSDATETIME() THEN 1 ELSE 0 END`),
      db.request().query(`
        SELECT SUM(CASE WHEN exito = 1 THEN 1 ELSE 0 END) AS exitosos, SUM(CASE WHEN exito = 0 THEN 1 ELSE 0 END) AS fallidos
        FROM AuditoriaAccesos WHERE fecha >= DATEADD(HOUR, -24, SYSDATETIME())`),
      db.request().query(`SELECT TOP 5 fecha, email, motivo, ip FROM AuditoriaAccesos WHERE exito = 0 ORDER BY fecha DESC`),
      db.request().query(`
        SELECT TOP 10 * FROM (
          SELECT fecha, usuario_email AS actor, accion, entidad, detalle FROM AuditoriaOperaciones
          UNION ALL
          SELECT fecha, actor_email AS actor, accion, 'usuario' AS entidad,
                 CONCAT(objetivo_email, CASE WHEN detalle IS NULL THEN '' ELSE CONCAT(' · ', detalle) END) AS detalle
          FROM AuditoriaUsuarios
        ) a ORDER BY fecha DESC`),
      estadoServicioAnpr(),
    ]);

    const porRol = Object.fromEntries(ROLES.map(r => [r, 0])) as Record<string, number>;
    const u = { total: 0, activos: 0, pendientes: 0, inactivos: 0, bloqueados: 0, por_rol: porRol };
    for (const f of usuarios.recordset) {
      u.total += f.n;
      if (f.bloqueado || f.bloqueo_temporal) u.bloqueados += f.n;
      else if (f.estado === 'activo') u.activos += f.n;
      else if (f.estado === 'pendiente') u.pendientes += f.n;
      else u.inactivos += f.n;
      if (ROL_POR_CODIGO[f.codigo]) u.por_rol[ROL_POR_CODIGO[f.codigo]] += f.n;
    }
    return res.json({
      usuarios: u,
      accesos_24h: cero(accesos.recordset[0]),
      ultimos_fallidos: fallidos.recordset,
      actividad: actividad.recordset,
      servicios: {
        base_datos: { en_linea: true },
        anpr,
        correo: { configurado: emailService.smtpConfigurado() },
      },
    });
  } catch (e: any) {
    console.error('[PANEL] administración:', e.message);
    return res.status(500).json({ error: 'No se pudo obtener el panel de administración.' });
  }
});

export default router;
