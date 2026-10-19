import sql, { PostgresRequest } from '../postgres';
import { getDB } from '../db';
import type { Cruce, RepositorioDetecciones } from '../../aplicacion/detecciones';
import type { Decision } from '../../dominio/decisionAcceso';
import { type FiltrosDetecciones, VENTANA_MISMO_PASO_S } from '../../dominio/detecciones';
import { guardarAtributosVehiculo, guardarMetadatosCaptura, type LecturaAutomatica, registrarLecturaAutomatica } from '../servicios/evaluacion';

/**
 * Repositorio SQL Server de los pasos vehiculares (DeteccionVehiculo), con la cámara, la alerta,
 * el permiso y la persona que validó, más los descartes del motor (AuditoriaDescartes).
 */

const SELECT_DETECCION = `
  SELECT d.*,
         c.nombre AS camara_nombre, c.ubicacion AS camara_ubicacion,
         l.motivo AS alerta_motivo, l.nivel_alerta,
         v.propietario, v.departamento, v.tipo_vehiculo AS autorizado_tipo, v.categoria AS autorizado_categoria,
         v.horario AS autorizado_horario, v.fecha_inicio AS autorizado_inicio, v.fecha_vencimiento AS autorizado_vence,
         uv.nombre_completo AS validador_nombre, uv.email AS validador_email
  FROM DeteccionVehiculo d
  LEFT JOIN Camaras c ON c.id = d.camara_id
  LEFT JOIN ListaNegra l ON l.id = d.alerta_id
  LEFT JOIN VehiculosAutorizados v ON v.id = d.vehiculo_autorizado_id
  LEFT JOIN Usuarios uv ON uv.id = d.usuario_validador_id`;

/** Placa sin separadores, para comparar lecturas y correcciones. */
const PLACA_D = "REPLACE(COALESCE(d.placa_validada, d.placa_reconocida, ''), '-', '')";

const db = () => getDB();

/** Filtros del historial, la exportación y la eliminación masiva (ya validados en el dominio). */
function aplicarFiltros(f: FiltrosDetecciones, request: PostgresRequest): string[] {
  const w: string[] = [`d.estado_procesamiento IN ('procesado', 'no_legible', 'pendiente_ocr')`];
  if (f.placa) {
    request.input('placa', sql.VarChar(22), `%${f.placa}%`);
    w.push(`${PLACA_D} LIKE @placa`);
  }
  if (f.estados.length) {
    f.estados.forEach((e, i) => request.input(`est${i}`, sql.VarChar(30), e));
    w.push(`d.estado_validacion IN (${f.estados.map((_, i) => `@est${i}`).join(',')})`);
  }
  if (f.camara !== null) {
    request.input('camara', sql.Int, f.camara);
    w.push('d.camara_id = @camara');
  }
  if (f.validado !== null) w.push(`d.validado_manualmente = ${f.validado ? 1 : 0}`);
  if (f.desde) {
    request.input('desde', sql.DateTime, f.desde);
    w.push('d.fecha_hora_ingreso >= @desde');
  }
  if (f.hasta) {
    request.input('hasta', sql.DateTime, f.hasta);
    w.push('d.fecha_hora_ingreso <= @hasta');
  }
  return w;
}

/** Decisión sobre el paso: estado, vínculos con las listas y restricción temporal. */
function parametrosDecision(request: PostgresRequest, cruce: Cruce, decision: Decision): PostgresRequest {
  return request
    .input('estado', sql.VarChar(30), decision.estado)
    .input('alerta', sql.Int, cruce.alerta?.id ?? null)
    .input('autorizado', sql.Int, cruce.permiso?.id ?? null)
    .input('restriccion', sql.VarChar(30), decision.restriccion);
}

export const repositorioDeteccionesSql: RepositorioDetecciones = {
  async obtener(id) {
    const r = await db().request().input('id', sql.Int, id).query(`${SELECT_DETECCION} WHERE d.id = @id`);
    return r.recordset[0] ?? null;
  },

  /**
   * Ingreso del mismo paso físico: misma placa (o, sin placa, el mismo tracking) en la misma cámara
   * dentro de la ventana, medida en milisegundos igual que en el motor. El tracking solo cuenta sin
   * placa: sus números vuelven a empezar cuando el motor se reinicia y podrían ser de otro vehículo.
   */
  async mismoPaso(trackingId, pista, camaraId, tipoMovimiento) {
    const r = await db().request()
      .input('tid', sql.Int, trackingId)
      .input('placa', sql.VarChar(20), pista)
      .input('camara', sql.Int, camaraId)
      .input('movimiento', sql.VarChar(10), tipoMovimiento)
      .input('ventana', sql.Int, VENTANA_MISMO_PASO_S * 1000)
      .query(`
        SELECT TOP 1 id, fecha_hora_ingreso FROM DeteccionVehiculo
        WHERE ((LEN(@placa) < 4 AND tracking_id = @tid AND @tid > 0)
               OR (LEN(@placa) >= 4 AND REPLACE(REPLACE(COALESCE(placa_reconocida, ''), '-', ''), ' ', '') = @placa))
          AND ((camara_id = @camara) OR (camara_id IS NULL AND @camara IS NULL))
          AND tipo_movimiento = @movimiento
          AND estado_procesamiento IN ('pendiente_ocr', 'procesado')
          AND fecha_hora_ingreso > DATEADD(MILLISECOND, -@ventana, GETDATE())
        ORDER BY fecha_hora_ingreso DESC`);
    return r.recordset[0] ?? null;
  },

  async existeCamara(id) {
    const r = await db().request().input('cid', sql.Int, id).query('SELECT id FROM Camaras WHERE id = @cid');
    return r.recordset.length > 0;
  },

  async direccionCamara(id) {
    const r = await db().request().input('id', sql.Int, id).query('SELECT direccion FROM Camaras WHERE id = @id');
    const direccion = r.recordset[0]?.direccion;
    return direccion === 'salida' ? 'salida' : direccion === 'ingreso' ? 'ingreso' : null;
  },

  async crearIngreso(n) {
    const r = await db().request()
      .input('tid', sql.Int, n.trackingId)
      .input('pista', sql.VarChar(20), n.pista)
      .input('ruta', sql.VarChar(255), n.ruta)
      .input('conf', sql.Float, n.confianza)
      .input('fuente', sql.VarChar(255), n.fuente)
      .input('camara', sql.Int, n.camaraId)
      .input('movimiento', sql.VarChar(10), n.tipoMovimiento)
      .query(`
        INSERT INTO DeteccionVehiculo (tracking_id, placa_reconocida, ruta_imagen_ingreso, confianza_deteccion, fuente,
                                       camara_id, tipo_movimiento, estado_procesamiento, estado_validacion, fecha_hora_ingreso)
        OUTPUT INSERTED.id, INSERTED.fecha_hora_ingreso
        VALUES (@tid, @pista, @ruta, @conf, @fuente, @camara, @movimiento, 'pendiente_ocr', 'pendiente_revision', GETDATE())`);
    return r.recordset[0];
  },

  async guardarSalida(id, lectura) {
    await db().request()
      .input('id', sql.Int, id)
      .input('placa', sql.VarChar(20), lectura.placa)
      .input('confianza', sql.Float, lectura.confianza)
      .input('ruta', sql.VarChar(255), lectura.rutaPlaca)
      .query(`UPDATE DeteccionVehiculo SET
          placa_reconocida = @placa, confianza_ocr = @confianza,
          ruta_imagen_placa = COALESCE(@ruta, ruta_imagen_placa),
          fecha_hora_procesamiento = GETDATE(), estado_procesamiento = 'procesado',
          estado_validacion = 'salida_registrada', decision_automatica = 'salida_registrada',
          alerta_id = NULL, vehiculo_autorizado_id = NULL, restriccion_acceso = NULL
        WHERE id = @id AND tipo_movimiento = 'salida'`);
  },

  async validarSalida(id, lectura) {
    await db().request()
      .input('id', sql.Int, id)
      .input('placa', sql.VarChar(20), lectura.placa)
      .input('usuario', sql.Int, lectura.usuarioId)
      .query(`UPDATE DeteccionVehiculo SET
          placa_validada = @placa, validado_manualmente = 1, usuario_validador_id = @usuario,
          fecha_validacion = GETDATE(), estado_procesamiento = 'procesado',
          estado_validacion = 'salida_registrada', decision_automatica = COALESCE(decision_automatica, 'salida_registrada'),
          alerta_id = NULL, vehiculo_autorizado_id = NULL, restriccion_acceso = NULL
        WHERE id = @id AND tipo_movimiento = 'salida'`);
  },

  async crearSalidaManual({ placa, camaraId, usuarioId }) {
    const r = await db().request()
      .input('placa', sql.VarChar(20), placa)
      .input('camara', sql.Int, camaraId)
      .input('usuario', sql.Int, usuarioId)
      .query(`INSERT INTO DeteccionVehiculo (
          placa_reconocida, placa_validada, camara_id, tipo_movimiento, fuente, fecha_hora_ingreso,
          fecha_hora_procesamiento, estado_procesamiento, estado_validacion, decision_automatica,
          validado_manualmente, usuario_validador_id, fecha_validacion
        )
        OUTPUT INSERTED.id
        VALUES (@placa, @placa, @camara, 'salida', 'manual', GETDATE(), GETDATE(),
                'procesado', 'salida_registrada', 'salida_registrada', TRUE, @usuario, GETDATE())`);
    return r.recordset[0].id;
  },

  guardarMetadatos: (id, metadatos) => guardarMetadatosCaptura(db(), id, metadatos as never),

  guardarVehiculo: (id, vehiculo) => guardarAtributosVehiculo(db(), id, vehiculo as never),

  registrarLecturaAutomatica: (id, l) => registrarLecturaAutomatica(db(), id, l as LecturaAutomatica),

  async marcarNoLegible(id, rutaPlaca) {
    await db().request()
      .input('id', sql.Int, id)
      .input('ruta', sql.VarChar(255), rutaPlaca)
      .query(`
        UPDATE DeteccionVehiculo SET
          placa_reconocida = NULL, confianza_ocr = NULL,
          ruta_imagen_placa = COALESCE(@ruta, ruta_imagen_ingreso),
          fecha_hora_procesamiento = GETDATE(),
          estado_procesamiento = 'no_legible', estado_validacion = 'pendiente_revision'
        WHERE id = @id`);
  },

  /** Otro paso ya procesado con la misma placa, en la misma cámara y dentro de la ventana. */
  async pasoProcesadoConPlaca(idExcluido, placa, camaraId, tipoMovimiento) {
    const r = await db().request()
      .input('id', sql.Int, idExcluido)
      .input('placa', sql.VarChar(20), placa)
      .input('camara', sql.Int, camaraId)
      .input('movimiento', sql.VarChar(10), tipoMovimiento)
      .input('ventana', sql.Int, VENTANA_MISMO_PASO_S * 1000)
      .query(`
        SELECT TOP 1 id FROM DeteccionVehiculo
        WHERE id <> @id AND estado_procesamiento = 'procesado'
          AND REPLACE(REPLACE(COALESCE(placa_reconocida, ''), '-', ''), ' ', '') = @placa
          AND ((camara_id = @camara) OR (camara_id IS NULL AND @camara IS NULL))
          AND tipo_movimiento = @movimiento
          AND fecha_hora_ingreso > DATEADD(MILLISECOND, -@ventana, GETDATE())
        ORDER BY fecha_hora_ingreso DESC`);
    return r.recordset[0]?.id ?? null;
  },

  async eliminarPendiente(id) {
    await db().request().input('id', sql.Int, id)
      .query(`DELETE FROM DeteccionVehiculo WHERE id = @id AND estado_procesamiento = 'pendiente_ocr'`);
  },

  async guardarVeredicto(id, valida, evidencia) {
    await db().request()
      .input('id', sql.Int, id)
      .input('valida', sql.Bit, valida)
      .input('evidencia', sql.NVarChar(1500), evidencia)
      .query('UPDATE DeteccionVehiculo SET lectura_valida = @valida, evidencia_lectura = @evidencia WHERE id = @id');
  },

  async observacion(id) {
    const r = await db().request().input('id', sql.Int, id).query(`
      SELECT confianza_deteccion, fecha_hora_ingreso, vehiculo_marca AS marca, vehiculo_color AS color, vehiculo_tipo AS tipo
      FROM DeteccionVehiculo WHERE id = @id`);
    return r.recordset[0] ?? null;
  },

  async guardarVerificacion(id, resultado, detalle) {
    await db().request()
      .input('id', sql.Int, id)
      .input('res', sql.VarChar(20), resultado)
      .input('det', sql.VarChar(255), detalle)
      .query('UPDATE DeteccionVehiculo SET verificacion_vehiculo = @res, verificacion_detalle = @det WHERE id = @id');
  },

  async guardarDecisionAutomatica(id, x, cruce, decision) {
    await parametrosDecision(db().request(), cruce, decision)
      .input('id', sql.Int, id)
      .input('placa', sql.VarChar(20), x.placa)
      .input('conf', sql.Float, x.confianza)
      .input('ruta', sql.VarChar(255), x.rutaPlaca)
      .input('tipo', sql.VarChar(50), x.tipo)
      .query(`
        UPDATE DeteccionVehiculo SET
          placa_reconocida = @placa, confianza_ocr = @conf,
          ruta_imagen_placa = COALESCE(@ruta, ruta_imagen_placa),
          fecha_hora_procesamiento = GETDATE(), estado_procesamiento = 'procesado',
          estado_validacion = @estado, alerta_id = @alerta, vehiculo_autorizado_id = @autorizado,
          restriccion_acceso = @restriccion, tipo_vehiculo = COALESCE(@tipo, tipo_vehiculo)
        WHERE id = @id`);
  },

  async registrarDescarte(x) {
    await db().request()
      .input('tid', sql.Int, x.trackingId)
      .input('motivo', sql.VarChar(100), x.motivo)
      .input('texto', sql.VarChar(50), x.texto)
      .input('conf', sql.Float, x.confianza)
      .input('fuente', sql.VarChar(255), x.fuente)
      .input('camara', sql.Int, x.camaraId)
      .query(`INSERT INTO AuditoriaDescartes (tracking_id, motivo, texto_candidato, confianza, fuente, camara_id)
              VALUES (@tid, @motivo, @texto, @conf, @fuente, @camara)`);
  },

  async contar(f) {
    const request = db().request();
    const w = aplicarFiltros(f, request);
    return (await request.query(`SELECT COUNT(*) AS n FROM DeteccionVehiculo d WHERE ${w.join(' AND ')}`)).recordset[0].n;
  },

  async pagina(f, offset, tamano) {
    const request = db().request();
    const w = aplicarFiltros(f, request);
    request.input('offset', sql.Int, offset).input('tamano', sql.Int, tamano);
    const r = await request.query(`${SELECT_DETECCION} WHERE ${w.join(' AND ')}
      ORDER BY d.fecha_hora_ingreso DESC LIMIT @tamano OFFSET @offset`);
    return r.recordset;
  },

  async recientes(limite) {
    const r = await db().request().input('n', sql.Int, limite).query(`
      ${SELECT_DETECCION}
      WHERE d.estado_procesamiento IN ('procesado', 'no_legible', 'pendiente_ocr')
      ORDER BY d.fecha_hora_ingreso DESC LIMIT @n`);
    return r.recordset;
  },

  async exportar(f) {
    const request = db().request();
    const w = aplicarFiltros(f, request);
    return (await request.query(`${SELECT_DETECCION} WHERE ${w.join(' AND ')} ORDER BY d.fecha_hora_ingreso DESC`)).recordset;
  },

  async historialPlaca(placa, excluirId) {
    const request = db().request().input('placa', sql.VarChar(20), placa);
    if (excluirId !== undefined) request.input('id', sql.Int, excluirId);
    const r = await request.query(`
      ${SELECT_DETECCION}
      WHERE ${excluirId !== undefined ? 'd.id <> @id AND ' : ''}${PLACA_D} = @placa
      ORDER BY d.fecha_hora_ingreso DESC LIMIT 10`);
    return r.recordset;
  },

  async auditoriaDe(id) {
    const r = await db().request().input('id', sql.Int, id).query(`
      SELECT fecha, accion, usuario_email, detalle FROM AuditoriaOperaciones
      WHERE entidad = 'deteccion' AND entidad_id = @id ORDER BY fecha DESC`);
    return r.recordset;
  },

  async guardarValidacion(id, x, cruce, decision) {
    await parametrosDecision(db().request(), cruce, decision)
      .input('id', sql.Int, id)
      .input('placa', sql.VarChar(20), x.placa)
      .input('tipo', sql.VarChar(50), x.tipo)
      .input('usuario', sql.Int, x.usuarioId)
      .query(`
        UPDATE DeteccionVehiculo SET
          -- Conserva la lectura y decisión automáticas (métricas de evaluación)
          placa_ocr_original = COALESCE(placa_ocr_original, placa_reconocida),
          decision_automatica = COALESCE(decision_automatica, estado_validacion),
          validado_manualmente = 1, placa_validada = @placa, usuario_validador_id = @usuario, fecha_validacion = GETDATE(),
          estado_procesamiento = 'procesado', estado_validacion = @estado,
          alerta_id = @alerta, vehiculo_autorizado_id = @autorizado, restriccion_acceso = @restriccion,
          tipo_vehiculo = COALESCE(@tipo, tipo_vehiculo)
        WHERE id = @id`);
  },

  async crearManual(x, cruce, decision) {
    const r = await parametrosDecision(db().request(), cruce, decision)
      .input('placa', sql.VarChar(20), x.placa)
      .input('camara', sql.Int, x.camaraId)
      .input('tipo', sql.VarChar(50), x.tipo)
      .input('usuario', sql.Int, x.usuarioId)
      .query(`
        INSERT INTO DeteccionVehiculo (placa_reconocida, placa_validada, fuente, camara_id, estado_procesamiento, estado_validacion,
                                       alerta_id, vehiculo_autorizado_id, restriccion_acceso, tipo_vehiculo, validado_manualmente,
                                       usuario_validador_id, fecha_validacion, fecha_hora_ingreso, fecha_hora_procesamiento, decision_automatica)
        OUTPUT INSERTED.id
        VALUES (NULL, @placa, 'manual', @camara, 'procesado', @estado, @alerta, @autorizado, @restriccion, @tipo, 1, @usuario,
                GETDATE(), GETDATE(), GETDATE(), 'manual')`);
    return r.recordset[0].id;
  },

  async eliminar(id) {
    await db().request().input('id', sql.Int, id).query('DELETE FROM DeteccionVehiculo WHERE id = @id');
  },

  async eliminarFiltradas(f) {
    const request = db().request();
    const w = f ? aplicarFiltros(f, request) : ['1 = 1'];
    const r = await request.query(`
      WITH eliminadas AS (
        DELETE FROM DeteccionVehiculo d
        WHERE ${w.join(' AND ')}
        RETURNING d.id, d.ruta_imagen_ingreso, d.ruta_imagen_placa
      )
      SELECT id, ruta_imagen_ingreso, ruta_imagen_placa FROM eliminadas`);
    return r.recordset;
  },
};
