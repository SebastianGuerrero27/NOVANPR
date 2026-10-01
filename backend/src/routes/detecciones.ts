import { Router, Request, Response } from 'express';
import sql from 'mssql';
import { getDB } from '../config/db';
import { authMiddleware, requierePermiso, servicioMiddleware } from '../middlewares/auth';
import { tienePermiso } from '../dominio/permisos';
import { decidirAcceso, Decision, EstadoValidacion, MOTIVO_RESTRICCION, RestriccionAcceso } from '../dominio/decisionAcceso';
import { describirHorario, evaluarVigencia, Vigencia } from '../dominio/horario';
import { emitEvent } from '../services/socket';
import { findBlacklistMatch, findPermisoExacto, normalizePlate } from '../services/plateMatching';
import { guardarMetadatosCaptura, registrarLecturaAutomatica } from '../services/evaluacion';
import { compararVehiculo } from '../services/vehiculoAtributos';
import { eliminarEvidencia, urlMedia } from '../services/media';
import { evaluarAutorizacion, EvidenciaLectura, politicaAutorizacion } from '../services/configuracion';
import { auditarOperacion } from '../services/seguridad';
import { ZONA_HORARIA } from '../services/tiempo';
import { notificarDecision } from '../services/avisosAcceso';
import { resolverPorDeteccion } from '../services/notificaciones';

/**
 * Detecciones vehiculares (cada paso por un acceso).
 *
 * Servicio ANPR (X-Servicio-Token)
 *   POST /ingreso            fase 1: captura fotográfica, estado pendiente_ocr
 *   POST /completar-ocr      fase 2: lectura OCR y cruce con listas
 *   POST /descarte           auditoría de falsos positivos descartados
 * Personal autenticado
 *   GET  /                   historial paginado con filtros
 *   GET  /recientes          últimos N pasos (monitoreo)
 *   GET  /exportar           CSV con los mismos filtros del historial
 *   GET  /buscar-placa/:placa situación de una placa en listas e historial
 *   GET  /:id                detalle completo con lectura automática, metadatos y auditoría
 *   POST /validar/:id        corrección / confirmación del operador (excepción con accesos:excepcion)
 *   POST /registro-manual    paso registrado a mano (cámara sin lectura, visita, etc.)
 *   DELETE /:id              permiso detecciones:eliminar, con motivo auditado (borra también la evidencia)
 *   DELETE /                 eliminación masiva (todas o las filtradas), permiso detecciones:eliminar
 *
 * La decisión de acceso la toma la política pura de dominio/decisionAcceso.ts; este módulo solo
 * reúne las evidencias, persiste el resultado y lo difunde (Socket.IO + centro de notificaciones).
 *
 * Eventos Socket.IO: deteccion:nueva, deteccion:actualizada, deteccion:alerta, deteccion:eliminada, deteccion:eliminadas
 */
const router = Router();

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

function evidenciaDe(d: any): EvidenciaLectura | null {
  if (!d.evidencia_lectura) return null;
  try { return JSON.parse(d.evidencia_lectura); } catch { return null; }
}

const fechaCorta = (v: any) => (v ? new Date(v).toISOString().slice(0, 10) : '');

/** Explicación de una restricción temporal del permiso (fuera de horario, no vigente, vencido). */
function motivoRestriccion(d: any): string | null {
  const r = d.restriccion_acceso as RestriccionAcceso | null;
  if (!r || !MOTIVO_RESTRICCION[r]) return null;
  const detalle = r === 'fuera_horario' ? `horario autorizado: ${describirHorario(d.autorizado_horario)}`
    : r === 'no_iniciada' ? `vigente desde ${fechaCorta(d.autorizado_inicio)}`
      : `venció el ${fechaCorta(d.autorizado_vence)}`;
  return `${MOTIVO_RESTRICCION[r]} (${detalle}).`;
}

/** Por qué un paso quedó pendiente de confirmación (lectura no confirmada, confianza o vehículo). */
function motivoRevision(d: any): string | null {
  if (d.estado_validacion === 'no_reconocido' && !d.validado_manualmente) return motivoRestriccion(d);
  if (d.estado_validacion !== 'pendiente_revision' || d.validado_manualmente || d.estado_procesamiento !== 'procesado') return null;
  const enPadron = Boolean(d.vehiculo_autorizado_id);
  const ev = evidenciaDe(d);
  if (d.lectura_valida === false || d.lectura_valida === 0) {
    const motivos = ev?.motivos?.length ? ev.motivos.join('; ') : 'evidencias insuficientes';
    return `${enPadron ? 'La placa está en el padrón, pero la' : 'La'} lectura no está confirmada (${motivos}). Verifique la placa antes de decidir.`;
  }
  if (!enPadron) return null;
  if (d.verificacion_vehiculo === 'no_coincide') return `La placa está en el padrón, pero el vehículo observado no coincide (${d.verificacion_detalle}).`;
  const c = evaluarAutorizacion(d.lectura_valida === null ? null : Boolean(d.lectura_valida), d.confianza_ocr, d.confianza_deteccion);
  if (!c.confianzaOk) {
    return `La placa está en el padrón, pero la confianza (${(c.confianza.evaluada * 100).toFixed(1)} %) es menor al ${(c.confianza.minimo * 100).toFixed(0)} % requerido para autorizar automáticamente. Confirme la placa.`;
  }
  return 'La placa está en el padrón; confirme el ingreso.';
}

/** Representación única de una detección para la API y los eventos en tiempo real. */
export function mapearDeteccion(d: any, detalle = false) {
  const base = {
    id: d.id,
    placa: d.placa_validada || d.placa_reconocida || null,
    placa_reconocida: d.placa_reconocida ?? null,
    placa_validada: d.placa_validada ?? null,
    estado_validacion: d.estado_validacion as EstadoValidacion,
    estado_procesamiento: d.estado_procesamiento,
    confianza_deteccion: d.confianza_deteccion,
    confianza_ocr: d.confianza_ocr,
    fecha_hora_ingreso: d.fecha_hora_ingreso,
    fecha_hora_procesamiento: d.fecha_hora_procesamiento,
    fuente: d.fuente,
    tracking_id: d.tracking_id,
    imagen_vehiculo: urlMedia(d.ruta_imagen_ingreso),
    imagen_placa: urlMedia(d.ruta_imagen_placa || d.ruta_imagen_ingreso),
    camara: d.camara_id ? { id: d.camara_id, nombre: d.camara_nombre, ubicacion: d.camara_ubicacion } : null,
    tipo_vehiculo: d.tipo_vehiculo || d.autorizado_tipo || d.vehiculo_tipo || null,
    vehiculo: { tipo: d.vehiculo_tipo, marca: d.vehiculo_marca, modelo: d.vehiculo_modelo, color: d.vehiculo_color },
    verificacion_vehiculo: d.verificacion_vehiculo ?? null,
    verificacion_detalle: d.verificacion_detalle ?? null,
    alerta: d.alerta_id ? { id: d.alerta_id, motivo: d.alerta_motivo, nivel: d.nivel_alerta } : null,
    autorizado: d.vehiculo_autorizado_id
      ? { id: d.vehiculo_autorizado_id, propietario: d.propietario, departamento: d.departamento, categoria: d.autorizado_categoria ?? null } : null,
    restriccion_acceso: (d.restriccion_acceso ?? null) as RestriccionAcceso | null,
    validado_manualmente: Boolean(d.validado_manualmente),
    lectura_valida: d.lectura_valida === null || d.lectura_valida === undefined ? null : Boolean(d.lectura_valida),
    motivo_revision: motivoRevision(d),
    validacion: d.validado_manualmente
      ? { usuario: d.validador_nombre ? { id: d.usuario_validador_id, nombre: d.validador_nombre, email: d.validador_email } : null, fecha: d.fecha_validacion }
      : null,
  };
  if (!detalle) return base;
  return {
    ...base,
    lectura_automatica: {
      placa: d.placa_ocr_original, confianza: d.confianza_ocr_original, decision: d.decision_automatica,
      verificador: d.lectura_verificador, latencia_ms: d.latencia_ms,
      modelo_detector: d.modelo_detector, modelo_ocr: d.modelo_ocr,
      valida: d.lectura_valida === null || d.lectura_valida === undefined ? null : Boolean(d.lectura_valida),
      evidencia: evidenciaDe(d),
    },
    captura: {
      luminancia_media: d.luminancia_media, distancia_estimada_m: d.distancia_estimada_m,
      ancho_placa_px: d.ancho_placa_px, nitidez: d.nitidez, velocidad_px_s: d.velocidad_px_s,
      condicion_clima: d.condicion_clima,
    },
  };
}

async function obtenerDeteccion(db: sql.ConnectionPool, id: number) {
  const r = await db.request().input('id', sql.Int, id).query(`${SELECT_DETECCION} WHERE d.id = @id`);
  return r.recordset[0] ?? null;
}

/** Lee la detección completa y la difunde a las sesiones conectadas. */
async function difundir(db: sql.ConnectionPool, id: number, evento: 'deteccion:nueva' | 'deteccion:actualizada') {
  const fila = await obtenerDeteccion(db, id);
  if (!fila) return null;
  const dto = mapearDeteccion(fila);
  emitEvent(evento, dto);
  if (dto.estado_validacion === 'alerta') emitEvent('deteccion:alerta', dto);
  return dto;
}

/** Tipo de vehículo según el formato de placa ANT (motos: 2 letras + 3 dígitos + letra). */
function tipoPorFormato(placa: string): string | null {
  if (/^[A-Z]{2}\d{3}[A-Z]$/.test(placa)) return 'Motocicleta';
  if (/^[A-Z]{3}\d{3,4}$/.test(placa)) return 'Automóvil';
  return null;
}

interface Cruce {
  /** Coincidencia con la lista de alertas (tolerante a homoglifos del OCR) */
  alerta: any | null;
  /** Permiso del padrón (coincidencia exacta). Si hay alerta no se considera. */
  permiso: any | null;
  vigencia: Vigencia | null;
}

/**
 * Evidencias de las listas para una placa en el instante del paso: lista de alertas
 * (aproximada) y permiso del padrón (exacto) con su estado temporal.
 */
async function cruzarListas(db: sql.ConnectionPool, placa: string, instante: Date): Promise<Cruce> {
  const alerta = await findBlacklistMatch(db, placa);
  if (alerta) return { alerta: { ...alerta.row, coincidencia: alerta.coincidencia }, permiso: null, vigencia: null };
  const permiso = await findPermisoExacto(db, placa);
  return { alerta: null, permiso, vigencia: permiso ? evaluarVigencia(permiso, instante, ZONA_HORARIA) : null };
}

const entradaListas = (c: Cruce) => ({
  alerta: c.alerta ? { id: c.alerta.id as number, coincidencia: c.alerta.coincidencia } : null,
  permiso: c.permiso ? { id: c.permiso.id as number, vigencia: c.vigencia! } : null,
});

/** Persiste la decisión sobre el paso (estado, vínculos con las listas y restricción). */
function parametrosDecision(request: sql.Request, cruce: Cruce, decision: Decision) {
  return request
    .input('estado', sql.VarChar(30), decision.estado)
    .input('alerta', sql.Int, cruce.alerta?.id ?? null)
    .input('autorizado', sql.Int, cruce.permiso?.id ?? null)
    .input('restriccion', sql.VarChar(30), decision.restriccion);
}

// =============================================================================
// FASE 1 · Captura (servicio ANPR). Un paso físico = un registro: se reutiliza el ingreso
// del mismo tracking_id o de la misma placa dentro de una ventana de 35 s.
// =============================================================================
router.post('/ingreso', servicioMiddleware, async (req: Request, res: Response) => {
  const { tracking_id, ruta_imagen_ingreso, confianza_deteccion = null, fuente = 'webcam', camara_id = null, placa = null } = req.body;
  if (!ruta_imagen_ingreso) return res.status(400).json({ error: 'La ruta de la imagen de ingreso es obligatoria.' });

  const tid = Number.isInteger(tracking_id) ? tracking_id : -1;
  const pista = typeof placa === 'string' ? normalizePlate(placa) : '';

  try {
    const db = getDB();
    const dup = await db.request()
      .input('tid', sql.Int, tid)
      .input('placa', sql.VarChar(20), pista)
      .query(`
        SELECT TOP 1 id, fecha_hora_ingreso FROM DeteccionVehiculo
        WHERE ((tracking_id = @tid AND @tid > 0)
               OR (LEN(@placa) >= 4 AND REPLACE(REPLACE(COALESCE(placa_reconocida, ''), '-', ''), ' ', '') = @placa))
          AND estado_procesamiento IN ('pendiente_ocr', 'procesado')
          AND DATEDIFF(SECOND, fecha_hora_ingreso, GETDATE()) <= 35
        ORDER BY fecha_hora_ingreso DESC`);
    if (dup.recordset.length) {
      const e = dup.recordset[0];
      return res.json({ message: 'Registro existente reutilizado (mismo paso físico).', ingreso_id: e.id, fecha_hora_ingreso: e.fecha_hora_ingreso, deduplicado: true });
    }

    let camara: number | null = null;
    if (camara_id !== null && Number.isInteger(Number(camara_id))) {
      const c = await db.request().input('cid', sql.Int, Number(camara_id)).query('SELECT id FROM Camaras WHERE id = @cid');
      if (c.recordset.length) camara = Number(camara_id);
    }

    const ins = await db.request()
      .input('tid', sql.Int, tid)
      .input('pista', sql.VarChar(20), pista.length >= 4 ? pista : null)
      .input('ruta', sql.VarChar(255), String(ruta_imagen_ingreso).substring(0, 255))
      .input('conf', sql.Float, typeof confianza_deteccion === 'number' ? confianza_deteccion : null)
      .input('fuente', sql.VarChar(255), String(fuente).substring(0, 255))
      .input('camara', sql.Int, camara)
      .query(`
        INSERT INTO DeteccionVehiculo (tracking_id, placa_reconocida, ruta_imagen_ingreso, confianza_deteccion, fuente,
                                       camara_id, estado_procesamiento, estado_validacion, fecha_hora_ingreso)
        OUTPUT INSERTED.id, INSERTED.fecha_hora_ingreso
        VALUES (@tid, @pista, @ruta, @conf, @fuente, @camara, 'pendiente_ocr', 'pendiente_revision', GETDATE())`);
    const creado = ins.recordset[0];
    await guardarMetadatosCaptura(db, creado.id, req.body.metadatos);
    await difundir(db, creado.id, 'deteccion:nueva');

    return res.status(201).json({ message: 'Ingreso registrado (pendiente de OCR).', ingreso_id: creado.id, fecha_hora_ingreso: creado.fecha_hora_ingreso });
  } catch (e: any) {
    console.error('[DETECCIONES] fase 1:', e.message);
    return res.status(500).json({ error: 'Error interno al registrar el ingreso.' });
  }
});

// =============================================================================
// FASE 2 · Resultado OCR (servicio ANPR) y cruce con las listas
// =============================================================================
router.post('/completar-ocr', servicioMiddleware, async (req: Request, res: Response) => {
  const { ingreso_id, placa_reconocida, confianza_ocr, ruta_imagen_placa, estado_procesamiento = 'procesado',
    lectura_verificador = null, latencia_ms = null, lectura_valida = null, evidencia_lectura = null } = req.body;
  // Veredicto del motor sobre la lectura (null si el motor no lo informa)
  const validez: boolean | null = typeof lectura_valida === 'boolean' ? lectura_valida : null;
  const evidencia = evidencia_lectura && typeof evidencia_lectura === 'object'
    ? JSON.stringify(evidencia_lectura).substring(0, 1500) : null;
  if (!Number.isInteger(ingreso_id)) return res.status(400).json({ error: 'El ID de ingreso es obligatorio.' });

  try {
    const db = getDB();
    let placa = normalizePlate(placa_reconocida);
    const confianza = typeof confianza_ocr === 'number' ? confianza_ocr : null;
    const lecturaAutomatica = (decision: string) => registrarLecturaAutomatica(db, ingreso_id, {
      placaOriginal: placa, confianza, decision, lecturaVerificador: lectura_verificador, latenciaMs: latencia_ms,
    });

    // Sin lectura utilizable: queda para validación del operador (no se elimina la evidencia)
    if (estado_procesamiento !== 'procesado' || placa.length < 4 || placa === 'NOLEGIBLE' || placa === 'SINRECONOCER') {
      await db.request()
        .input('id', sql.Int, ingreso_id)
        .input('ruta', sql.VarChar(255), ruta_imagen_placa || null)
        .query(`
          UPDATE DeteccionVehiculo SET
            placa_reconocida = NULL, confianza_ocr = NULL,
            ruta_imagen_placa = COALESCE(@ruta, ruta_imagen_ingreso),
            fecha_hora_procesamiento = GETDATE(),
            estado_procesamiento = 'no_legible', estado_validacion = 'pendiente_revision'
          WHERE id = @id`);
      await lecturaAutomatica('pendiente_revision');
      const dto = await difundir(db, ingreso_id, 'deteccion:actualizada');
      return res.json({ message: 'Ingreso pendiente de validación manual.', deteccion: dto });
    }

    // Mismo paso físico ya procesado con la misma placa: se consolida
    const dup = await db.request()
      .input('id', sql.Int, ingreso_id)
      .input('placa', sql.VarChar(20), placa)
      .query(`
        SELECT TOP 1 id FROM DeteccionVehiculo
        WHERE id <> @id AND estado_procesamiento = 'procesado'
          AND REPLACE(REPLACE(COALESCE(placa_reconocida, ''), '-', ''), ' ', '') = @placa
          AND DATEDIFF(SECOND, fecha_hora_ingreso, GETDATE()) <= 35
        ORDER BY fecha_hora_ingreso DESC`);
    if (dup.recordset.length) {
      await db.request().input('id', sql.Int, ingreso_id)
        .query(`DELETE FROM DeteccionVehiculo WHERE id = @id AND estado_procesamiento = 'pendiente_ocr'`);
      emitEvent('deteccion:eliminada', { id: ingreso_id, consolidado_en: dup.recordset[0].id });
      return res.json({ message: 'Detección consolidada con el paso previo.', deduplicado: true, ingreso_id: dup.recordset[0].id });
    }

    await db.request()
      .input('id', sql.Int, ingreso_id)
      .input('valida', sql.Bit, validez)
      .input('evidencia', sql.NVarChar(1500), evidencia)
      .query('UPDATE DeteccionVehiculo SET lectura_valida = @valida, evidencia_lectura = @evidencia WHERE id = @id');

    const obs = (await db.request().input('id', sql.Int, ingreso_id).query(`
      SELECT confianza_deteccion, fecha_hora_ingreso, vehiculo_marca AS marca, vehiculo_color AS color, vehiculo_tipo AS tipo
      FROM DeteccionVehiculo WHERE id = @id`)).recordset[0];
    if (!obs) return res.status(404).json({ error: 'Ingreso no encontrado.' });

    // El acceso se juzga en el instante del paso (horario y vigencia del permiso)
    const cruce = await cruzarListas(db, placa, new Date(obs.fecha_hora_ingreso));
    let tipo: string | null = tipoPorFormato(placa);
    if (cruce.permiso) {
      placa = normalizePlate(cruce.permiso.placa) || placa;
      tipo = cruce.permiso.tipo_vehiculo || tipo;
    }

    // Segundo factor: marca / color / tipo observados vs. registrados (posible placa clonada)
    const registrado = cruce.alerta ?? cruce.permiso;
    let verificacion: ReturnType<typeof compararVehiculo> | null = null;
    if (registrado) {
      verificacion = compararVehiculo(registrado, obs);
      if (verificacion.resultado === 'no_coincide') console.warn(`[SEGUNDO FACTOR] Ingreso #${ingreso_id} ${placa}: ${verificacion.detalle}`);
      await db.request()
        .input('id', sql.Int, ingreso_id)
        .input('res', sql.VarChar(20), verificacion.resultado)
        .input('det', sql.VarChar(255), verificacion.detalle.substring(0, 255))
        .query('UPDATE DeteccionVehiculo SET verificacion_vehiculo = @res, verificacion_detalle = @det WHERE id = @id');
    }

    const decision = decidirAcceso({
      origen: 'automatico',
      ...entradaListas(cruce),
      lectura: { lecturaValida: validez, confianzaOcr: confianza, confianzaDeteccion: obs.confianza_deteccion ?? null },
      verificacionVehiculo: verificacion?.resultado ?? null,
      politica: politicaAutorizacion(),
    });
    console.log(`[DECISION] Ingreso #${ingreso_id} ${placa}: ${decision.estado} (${decision.regla}: ${decision.motivos.join('; ')})`);

    await parametrosDecision(db.request(), cruce, decision)
      .input('id', sql.Int, ingreso_id)
      .input('placa', sql.VarChar(20), placa)
      .input('conf', sql.Float, confianza)
      .input('ruta', sql.VarChar(255), ruta_imagen_placa || null)
      .input('tipo', sql.VarChar(50), tipo)
      .query(`
        UPDATE DeteccionVehiculo SET
          placa_reconocida = @placa, confianza_ocr = @conf,
          ruta_imagen_placa = COALESCE(@ruta, ruta_imagen_placa),
          fecha_hora_procesamiento = GETDATE(), estado_procesamiento = 'procesado',
          estado_validacion = @estado, alerta_id = @alerta, vehiculo_autorizado_id = @autorizado,
          restriccion_acceso = @restriccion, tipo_vehiculo = COALESCE(@tipo, tipo_vehiculo)
        WHERE id = @id`);
    await lecturaAutomatica(decision.estado);
    const dto = await difundir(db, ingreso_id, 'deteccion:actualizada');
    if (dto) void notificarDecision(dto, decision, cruce.permiso);
    return res.json({ message: 'OCR completado.', deteccion: dto });
  } catch (e: any) {
    console.error('[DETECCIONES] fase 2:', e.message);
    return res.status(500).json({ error: 'Error interno al completar el OCR.' });
  }
});

router.post('/descarte', servicioMiddleware, async (req: Request, res: Response) => {
  const { tracking_id, motivo, texto_candidato, confianza, fuente, camara_id } = req.body;
  try {
    await getDB().request()
      .input('tid', sql.Int, Number.isInteger(tracking_id) ? tracking_id : -1)
      .input('motivo', sql.VarChar(100), String(motivo || 'falso_positivo_ocr').substring(0, 100))
      .input('texto', sql.VarChar(50), texto_candidato ? String(texto_candidato).substring(0, 50) : null)
      .input('conf', sql.Float, typeof confianza === 'number' ? confianza : null)
      .input('fuente', sql.VarChar(255), fuente ? String(fuente).substring(0, 255) : null)
      .input('camara', sql.Int, Number.isInteger(camara_id) ? camara_id : null)
      .query(`INSERT INTO AuditoriaDescartes (tracking_id, motivo, texto_candidato, confianza, fuente, camara_id)
              VALUES (@tid, @motivo, @texto, @conf, @fuente, @camara)`);
    return res.status(201).json({ success: true });
  } catch (e: any) {
    console.error('[DETECCIONES] descarte:', e.message);
    return res.status(500).json({ error: 'Error al registrar el descarte.' });
  }
});

// =============================================================================
// Consultas del personal
// =============================================================================

/** Filtros comunes del historial y la exportación. */
function aplicarFiltros(req: Request, request: sql.Request): string[] {
  const q = req.query;
  const f: string[] = [`d.estado_procesamiento IN ('procesado', 'no_legible', 'pendiente_ocr')`];
  const placa = normalizePlate(String(q.placa ?? ''));
  if (placa) {
    request.input('placa', sql.VarChar(22), `%${placa}%`);
    f.push(`REPLACE(COALESCE(d.placa_validada, d.placa_reconocida, ''), '-', '') LIKE @placa`);
  }
  const estados = String(q.estado ?? '').split(',').filter(e => ['autorizado', 'alerta', 'no_reconocido', 'pendiente_revision'].includes(e));
  if (estados.length) {
    estados.forEach((e, i) => request.input(`est${i}`, sql.VarChar(30), e));
    f.push(`d.estado_validacion IN (${estados.map((_, i) => `@est${i}`).join(',')})`);
  }
  if (q.camara && Number.isInteger(Number(q.camara))) {
    request.input('camara', sql.Int, Number(q.camara));
    f.push('d.camara_id = @camara');
  }
  if (q.validado === 'si' || q.validado === 'no') f.push(`d.validado_manualmente = ${q.validado === 'si' ? 1 : 0}`);
  if (q.desde && !Number.isNaN(Date.parse(String(q.desde)))) {
    request.input('desde', sql.DateTime, new Date(String(q.desde)));
    f.push('d.fecha_hora_ingreso >= @desde');
  }
  if (q.hasta && !Number.isNaN(Date.parse(String(q.hasta)))) {
    request.input('hasta', sql.DateTime, new Date(String(q.hasta)));
    f.push('d.fecha_hora_ingreso <= @hasta');
  }
  return f;
}

router.get('/', authMiddleware, async (req: Request, res: Response) => {
  const tamano = Math.min(100, Math.max(5, Number(req.query.tamano) || 25));
  const pagina = Math.max(1, Number(req.query.pagina) || 1);
  try {
    const db = getDB();
    const conteo = db.request();
    const filtrosConteo = aplicarFiltros(req, conteo);
    const total = (await conteo.query(`SELECT COUNT(*) AS n FROM DeteccionVehiculo d WHERE ${filtrosConteo.join(' AND ')}`)).recordset[0].n;

    const consulta = db.request();
    const filtros = aplicarFiltros(req, consulta);
    consulta.input('offset', sql.Int, (pagina - 1) * tamano).input('tamano', sql.Int, tamano);
    const r = await consulta.query(`${SELECT_DETECCION} WHERE ${filtros.join(' AND ')}
      ORDER BY d.fecha_hora_ingreso DESC OFFSET @offset ROWS FETCH NEXT @tamano ROWS ONLY`);
    return res.json({ items: r.recordset.map(d => mapearDeteccion(d)), total, pagina, tamano });
  } catch (e: any) {
    console.error('[DETECCIONES] listar:', e.message);
    return res.status(500).json({ error: 'Error al consultar las detecciones.' });
  }
});

router.get('/recientes', authMiddleware, async (req: Request, res: Response) => {
  const limite = Math.min(50, Math.max(1, Number(req.query.limite) || 20));
  try {
    const r = await getDB().request().input('n', sql.Int, limite).query(`
      ${SELECT_DETECCION}
      WHERE d.estado_procesamiento IN ('procesado', 'no_legible', 'pendiente_ocr')
      ORDER BY d.fecha_hora_ingreso DESC OFFSET 0 ROWS FETCH NEXT @n ROWS ONLY`);
    return res.json(r.recordset.map(d => mapearDeteccion(d)));
  } catch (e: any) {
    console.error('[DETECCIONES] recientes:', e.message);
    return res.status(500).json({ error: 'Error al consultar los ingresos recientes.' });
  }
});

const ETIQUETA_ESTADO: Record<string, string> = {
  autorizado: 'Autorizado', alerta: 'Alerta', no_reconocido: 'No registrado', pendiente_revision: 'Pendiente de revisión',
};

router.get('/exportar', authMiddleware, async (req: Request, res: Response) => {
  try {
    const request = getDB().request();
    const filtros = aplicarFiltros(req, request);
    const r = await request.query(`${SELECT_DETECCION} WHERE ${filtros.join(' AND ')} ORDER BY d.fecha_hora_ingreso DESC`);
    const csv = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const pct = (v: number | null) => (typeof v === 'number' ? (v * 100).toFixed(1) : '');
    const cab = ['ID', 'Fecha y hora', 'Placa', 'Lectura OCR', 'Estado', 'Validado por operador', 'Validador', 'Cámara', 'Ubicación',
      'Tipo de vehículo', 'Marca observada', 'Color observado', 'Verificación del vehículo', 'Propietario (padrón)', 'Departamento',
      'Motivo de alerta', 'Nivel de alerta', 'Confianza detección (%)', 'Confianza OCR (%)'];
    const filas = r.recordset.map(d => [
      d.id, new Date(d.fecha_hora_ingreso).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' }),
      d.placa_validada || d.placa_reconocida || '', d.placa_ocr_original || d.placa_reconocida || '',
      ETIQUETA_ESTADO[d.estado_validacion] ?? d.estado_validacion, d.validado_manualmente ? 'Sí' : 'No', d.validador_email || '',
      d.camara_nombre || '', d.camara_ubicacion || '', d.tipo_vehiculo || d.vehiculo_tipo || '', d.vehiculo_marca || '',
      d.vehiculo_color || '', d.verificacion_vehiculo || '', d.propietario || '', d.departamento || '',
      d.alerta_motivo || '', d.nivel_alerta || '', pct(d.confianza_deteccion), pct(d.confianza_ocr),
    ].map(csv).join(','));
    const nombre = `ingresos_anpr_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    await auditarOperacion(getDB(), req, 'EXPORTACION', 'deteccion', null, `${r.recordset.length} registros · ${JSON.stringify(req.query).substring(0, 300)}`);
    return res.send('﻿' + [cab.map(csv).join(','), ...filas].join('\n'));
  } catch (e: any) {
    console.error('[DETECCIONES] exportar:', e.message);
    return res.status(500).json({ error: 'Error al exportar.' });
  }
});

router.get('/buscar-placa/:placa', authMiddleware, async (req: Request, res: Response) => {
  const placa = normalizePlate(req.params.placa);
  if (placa.length < 3) return res.status(400).json({ error: 'Ingrese al menos 3 caracteres de la placa.' });
  try {
    const db = getDB();
    const cruce = await cruzarListas(db, placa, new Date());
    const decision = decidirAcceso({ origen: 'manual', ...entradaListas(cruce), politica: politicaAutorizacion() });
    const hist = await db.request().input('placa', sql.VarChar(20), placa).query(`
      ${SELECT_DETECCION}
      WHERE REPLACE(COALESCE(d.placa_validada, d.placa_reconocida, ''), '-', '') = @placa
      ORDER BY d.fecha_hora_ingreso DESC OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY`);
    return res.json({
      placa,
      estado: decision.estado === 'no_reconocido' ? (cruce.permiso ? 'restringido' : 'no_registrado') : decision.estado,
      restriccion: decision.restriccion,
      motivo: decision.restriccion ? MOTIVO_RESTRICCION[decision.restriccion] : null,
      alerta: cruce.alerta,
      autorizado: cruce.permiso ? { ...cruce.permiso, horario_texto: describirHorario(cruce.permiso.horario) } : null,
      ultimos_ingresos: hist.recordset.map(d => mapearDeteccion(d)),
    });
  } catch (e: any) {
    console.error('[DETECCIONES] buscar placa:', e.message);
    return res.status(500).json({ error: 'Error al buscar la placa.' });
  }
});

router.get('/:id(\\d+)', authMiddleware, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  try {
    const db = getDB();
    const d = await obtenerDeteccion(db, id);
    if (!d) return res.status(404).json({ error: 'Detección no encontrada.' });
    const dto = mapearDeteccion(d, true);
    const [auditoria, anteriores] = await Promise.all([
      db.request().input('id', sql.Int, id).query(`
        SELECT fecha, accion, usuario_email, detalle FROM AuditoriaOperaciones
        WHERE entidad = 'deteccion' AND entidad_id = @id ORDER BY fecha DESC`),
      dto.placa
        ? db.request().input('id', sql.Int, id).input('placa', sql.VarChar(20), normalizePlate(dto.placa)).query(`
            ${SELECT_DETECCION}
            WHERE d.id <> @id AND REPLACE(COALESCE(d.placa_validada, d.placa_reconocida, ''), '-', '') = @placa
            ORDER BY d.fecha_hora_ingreso DESC OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY`)
        : Promise.resolve({ recordset: [] as any[] }),
    ]);
    return res.json({ ...dto, auditoria: auditoria.recordset, pasos_anteriores: anteriores.recordset.map(x => mapearDeteccion(x)) });
  } catch (e: any) {
    console.error('[DETECCIONES] detalle:', e.message);
    return res.status(500).json({ error: 'Error al consultar la detección.' });
  }
});

// =============================================================================
// Acciones del personal
// =============================================================================

router.post('/validar/:id(\\d+)', authMiddleware, requierePermiso('detecciones:validar'), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const placa = normalizePlate(req.body?.placa_validada);
  const tipoVehiculo = req.body?.tipo_vehiculo ? String(req.body.tipo_vehiculo).substring(0, 50) : null;
  const observacion = req.body?.observacion ? String(req.body.observacion).trim().substring(0, 300) : null;
  // Excepción: conceder el paso pese a la restricción temporal del permiso (con motivo auditado)
  const excepcion = req.body?.excepcion === true;
  if (placa.length < 4 || placa.length > 10) return res.status(400).json({ error: 'Ingrese una placa válida (4 a 10 caracteres).' });
  if (excepcion && !tienePermiso(req.user!.rol, 'accesos:excepcion')) {
    return res.status(403).json({ error: 'No tiene permiso para autorizar ingresos por excepción.' });
  }
  if (excepcion && (observacion?.length ?? 0) < 5) {
    return res.status(400).json({ error: 'Indique el motivo de la excepción (mínimo 5 caracteres).' });
  }

  try {
    const db = getDB();
    const actual = await obtenerDeteccion(db, id);
    if (!actual) return res.status(404).json({ error: 'Detección no encontrada.' });

    const cruce = await cruzarListas(db, placa, new Date(actual.fecha_hora_ingreso));
    const decision = decidirAcceso({ origen: 'manual', ...entradaListas(cruce), excepcion, politica: politicaAutorizacion() });
    const final = cruce.permiso ? normalizePlate(cruce.permiso.placa) || placa : placa;
    await parametrosDecision(db.request(), cruce, decision)
      .input('id', sql.Int, id)
      .input('placa', sql.VarChar(20), final)
      .input('tipo', sql.VarChar(50), tipoVehiculo || cruce.permiso?.tipo_vehiculo || tipoPorFormato(final))
      .input('usuario', sql.Int, req.user!.id)
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

    const antes = actual.placa_validada || actual.placa_reconocida || 'sin lectura';
    await auditarOperacion(db, req, decision.regla === 'R2-excepcion' ? 'EXCEPCION_ACCESO' : 'VALIDACION', 'deteccion', id,
      `${antes} → ${final} (${ETIQUETA_ESTADO[decision.estado]}${decision.restriccion ? ` · ${MOTIVO_RESTRICCION[decision.restriccion]}` : ''})${observacion ? ` · ${observacion}` : ''}`);
    // La persona atendió el paso: sus alarmas se resuelven; si la corrección revela una alerta, se avisa
    await resolverPorDeteccion(id);
    const dto = await difundir(db, id, 'deteccion:actualizada');
    if (dto && decision.estado === 'alerta' && actual.estado_validacion !== 'alerta') void notificarDecision(dto, decision);
    return res.json({ message: 'Validación registrada.', deteccion: dto });
  } catch (e: any) {
    console.error('[DETECCIONES] validar:', e.message);
    return res.status(500).json({ error: 'Error al registrar la validación.' });
  }
});

/**
 * Paso registrado a mano por el personal (cámara fuera de servicio, vehículo sin placa
 * legible, etc.). Se cruza con las listas igual que una lectura automática y NO modifica
 * el padrón de autorizados: para autorizar un vehículo se usa la pantalla de listas.
 */
router.post('/registro-manual', authMiddleware, requierePermiso('detecciones:validar'), async (req: Request, res: Response) => {
  const placa = normalizePlate(req.body?.placa);
  const motivo = String(req.body?.motivo ?? '').trim();
  const camaraId = Number.isInteger(Number(req.body?.camara_id)) ? Number(req.body.camara_id) : null;
  const tipo = req.body?.tipo_vehiculo ? String(req.body.tipo_vehiculo).substring(0, 50) : null;
  if (placa.length < 4 || placa.length > 10) return res.status(400).json({ error: 'Ingrese una placa válida (4 a 10 caracteres).' });
  if (motivo.length < 5) return res.status(400).json({ error: 'Indique el motivo del registro manual (mínimo 5 caracteres).' });

  try {
    const db = getDB();
    const cruce = await cruzarListas(db, placa, new Date());
    const decision = decidirAcceso({ origen: 'manual', ...entradaListas(cruce), politica: politicaAutorizacion() });
    const ins = await parametrosDecision(db.request(), cruce, decision)
      .input('placa', sql.VarChar(20), placa)
      .input('camara', sql.Int, camaraId)
      .input('tipo', sql.VarChar(50), tipo || cruce.permiso?.tipo_vehiculo || tipoPorFormato(placa))
      .input('usuario', sql.Int, req.user!.id)
      .query(`
        INSERT INTO DeteccionVehiculo (placa_reconocida, placa_validada, fuente, camara_id, estado_procesamiento, estado_validacion,
                                       alerta_id, vehiculo_autorizado_id, restriccion_acceso, tipo_vehiculo, validado_manualmente,
                                       usuario_validador_id, fecha_validacion, fecha_hora_ingreso, fecha_hora_procesamiento, decision_automatica)
        OUTPUT INSERTED.id
        VALUES (NULL, @placa, 'manual', @camara, 'procesado', @estado, @alerta, @autorizado, @restriccion, @tipo, 1, @usuario,
                GETDATE(), GETDATE(), GETDATE(), 'manual')`);
    const id = ins.recordset[0].id;
    await auditarOperacion(db, req, 'REGISTRO_MANUAL', 'deteccion', id, `${placa} (${ETIQUETA_ESTADO[decision.estado]}) · ${motivo}`);
    const dto = await difundir(db, id, 'deteccion:nueva');
    if (dto && decision.estado === 'alerta') void notificarDecision(dto, decision);
    return res.status(201).json({ message: 'Ingreso registrado manualmente.', deteccion: dto });
  } catch (e: any) {
    console.error('[DETECCIONES] registro manual:', e.message);
    return res.status(500).json({ error: 'Error al registrar el ingreso manual.' });
  }
});

const fechaLocal = (f: Date) => new Date(f).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' });

/** Elimina una detección y su evidencia fotográfica (solo Administrador, con motivo auditado). */
router.delete('/:id(\\d+)', authMiddleware, requierePermiso('detecciones:eliminar'), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const motivo = String(req.body?.motivo ?? '').trim();
  if (motivo.length < 3) return res.status(400).json({ error: 'Indique el motivo de la eliminación.' });
  try {
    const db = getDB();
    const d = await obtenerDeteccion(db, id);
    if (!d) return res.status(404).json({ error: 'Detección no encontrada.' });
    await db.request().input('id', sql.Int, id).query('DELETE FROM DeteccionVehiculo WHERE id = @id');
    const archivos = await eliminarEvidencia([d.ruta_imagen_ingreso, d.ruta_imagen_placa]);
    await auditarOperacion(db, req, 'DETECCION_ELIMINADA', 'deteccion', id,
      `${d.placa_validada || d.placa_reconocida || 'sin lectura'} del ${fechaLocal(d.fecha_hora_ingreso)} · ${archivos} imágenes · ${motivo}`);
    emitEvent('deteccion:eliminada', { id });
    await resolverPorDeteccion(id);
    return res.json({ message: 'Detección eliminada.', id });
  } catch (e: any) {
    console.error('[DETECCIONES] eliminar:', e.message);
    return res.status(500).json({ error: 'Error al eliminar la detección.' });
  }
});

/**
 * Eliminación masiva (solo Administrador): todas las detecciones o las que cumplen los mismos
 * filtros del historial (?placa, estado, camara, validado, desde, hasta). Exige escribir
 * ELIMINAR como confirmación y un motivo; borra también la evidencia fotográfica y queda en
 * la auditoría con la cantidad y los filtros usados.
 */
router.delete('/', authMiddleware, requierePermiso('detecciones:eliminar'), async (req: Request, res: Response) => {
  const motivo = String(req.body?.motivo ?? '').trim();
  if (req.body?.confirmacion !== 'ELIMINAR') return res.status(400).json({ error: 'Escriba ELIMINAR para confirmar.' });
  if (motivo.length < 5) return res.status(400).json({ error: 'Indique el motivo de la eliminación (mínimo 5 caracteres).' });
  try {
    const db = getDB();
    const consulta = db.request();
    const filtros = aplicarFiltros(req, consulta);
    // Sin filtros se eliminan todas, en cualquier estado de procesamiento
    const conFiltros = ['placa', 'estado', 'camara', 'validado', 'desde', 'hasta'].some(k => req.query[k]);
    const r = await consulta.query(`
      DELETE d OUTPUT DELETED.id, DELETED.ruta_imagen_ingreso, DELETED.ruta_imagen_placa
      FROM DeteccionVehiculo d WHERE ${conFiltros ? filtros.join(' AND ') : '1 = 1'}`);
    const filas = r.recordset;
    const archivos = await eliminarEvidencia(filas.flatMap(f => [f.ruta_imagen_ingreso, f.ruta_imagen_placa]));
    const alcance = conFiltros ? `filtros ${JSON.stringify(req.query).substring(0, 200)}` : 'todas las detecciones';
    await auditarOperacion(db, req, 'DETECCIONES_ELIMINADAS', 'deteccion', null,
      `${filas.length} registros y ${archivos} imágenes · ${alcance} · ${motivo}`);
    emitEvent('deteccion:eliminadas', { total: filas.length });
    return res.json({ message: `${filas.length} ${filas.length === 1 ? 'registro eliminado' : 'registros eliminados'}.`, total: filas.length });
  } catch (e: any) {
    console.error('[DETECCIONES] eliminación masiva:', e.message);
    return res.status(500).json({ error: 'Error al eliminar las detecciones.' });
  }
});

export default router;
