import { Router, Request, Response } from 'express';
import sql from 'mssql';
import { getDB } from '../config/db';
import { authMiddleware } from '../middlewares/auth';
import { emitEvent } from '../services/socket';
import { findAuthorizedExact, findBlacklistMatch } from '../services/plateMatching';

const router = Router();

// =============================================================================
// FASE 1: Registro Inicial del Ingreso Vehicular con Anti-Duplicado Inteligente
// Referencia: Kanhere & Birchfield (2008) — "Taxonomic Analysis of ALPR deduplication"
// Logica: un tracking_id genera exactamente 1 registro por paso fisico (ventana de 30 segundos).
// Si el mismo tracking_id ya tiene un registro activo, se reutiliza su ID (UPSERT pattern).
// Una nueva visita del mismo vehiculo despues de 30 segundos crea un registro independiente.
// =============================================================================
router.post('/ingreso', async (req: Request, res: Response) => {
  const {
    tracking_id,
    ruta_imagen_ingreso,
    confianza_deteccion,
    fuente = 'webcam',
    camara_id = null,
    placa = null
  } = req.body;

  if (!ruta_imagen_ingreso) {
    return res.status(400).json({ error: 'La ruta de la imagen de ingreso es obligatoria.' });
  }

  const tid = tracking_id ?? -1;
  const cleanPlaca = typeof placa === 'string'
    ? placa.toUpperCase().replace(/[^A-Z0-9]/g, '')
    : '';

  try {
    const db = getDB();

    // --- Anti-Duplicado: Verificar si el tracking_id o la placa ya tiene un registro activo ---
    // Ventana de consolidación: 35 segundos (un paso físico continuo del vehículo)
    const dedupReq = db.request();
    dedupReq.input('tracking_id_dedup', sql.Int, tid);
    dedupReq.input('clean_placa', sql.VarChar, cleanPlaca);

    const dedupResult = await dedupReq.query(`
      SELECT TOP 1 id, fecha_hora_ingreso, placa, tracking_id
      FROM DeteccionVehiculo
      WHERE (
        (tracking_id = @tracking_id_dedup AND @tracking_id_dedup > 0)
        OR (
          @clean_placa <> '' AND LEN(@clean_placa) >= 4
          AND REPLACE(REPLACE(COALESCE(placa_reconocida, placa, ''), '-', ''), ' ', '') = @clean_placa
        )
      )
        AND estado_procesamiento IN ('pendiente_ocr', 'procesado')
        AND DATEDIFF(SECOND, fecha_hora_ingreso, GETDATE()) <= 35
      ORDER BY fecha_hora_ingreso DESC;
    `);

    if (dedupResult.recordset.length > 0) {
      const existente = dedupResult.recordset[0];
      console.log(
        `[ANTI-DUPLICADO] Track #${tid} / Placa '${cleanPlaca || 'N/A'}' coincide con Ingreso ID #${existente.id} activo (hace <= 35s). Reutilizando registro.`
      );
      return res.status(200).json({
        message: 'Registro existente reutilizado (paso físico consolidado).',
        ingreso_id: existente.id,
        fecha_hora_ingreso: existente.fecha_hora_ingreso,
        deduplicado: true
      });
    }

    // Sanitizar fuente para no exceder longitud de BD
    const cleanFuente = typeof fuente === 'string' ? fuente.substring(0, 255) : 'webcam';

    // Validar camara_id contra tabla Camaras para prevenir errores de Foreign Key
    let validCamaraId: number | null = null;
    if (camara_id && !isNaN(Number(camara_id))) {
      const parsedCid = Number(camara_id);
      const camCheck = await db.request().input('cid', sql.Int, parsedCid).query('SELECT TOP 1 id FROM Camaras WHERE id = @cid');
      if (camCheck.recordset.length > 0) {
        validCamaraId = parsedCid;
      }
    }

    // --- Sin duplicado: Insertar nuevo registro de ingreso ---
    const initialPlaca = cleanPlaca.length >= 4 ? String(placa).toUpperCase().trim() : 'PROCESANDO';
    const request = db.request();
    request.input('tracking_id', sql.Int, tid);
    request.input('initial_placa', sql.VarChar, initialPlaca);
    request.input('ruta_imagen_ingreso', sql.VarChar, ruta_imagen_ingreso);
    request.input('confianza_deteccion', sql.Float, confianza_deteccion ?? 0.85);
    request.input('fuente', sql.VarChar, cleanFuente);
    request.input('camara_id', sql.Int, validCamaraId);

    const insertQuery = `
      INSERT INTO DeteccionVehiculo (
        placa,
        confianza_deteccion,
        confianza_ocr,
        imagen_vehiculo_path,
        imagen_placa_path,
        fecha_hora,
        tracking_id,
        fuente,
        estado_validacion,
        camara_id,
        estado_procesamiento,
        ruta_imagen_ingreso,
        fecha_hora_ingreso
      )
      OUTPUT INSERTED.id, INSERTED.fecha_hora_ingreso
      VALUES (
        @initial_placa,
        @confianza_deteccion,
        0.0,
        @ruta_imagen_ingreso,
        @ruta_imagen_ingreso,
        GETDATE(),
        @tracking_id,
        @fuente,
        'pendiente_revision',
        @camara_id,
        'pendiente_ocr',
        @ruta_imagen_ingreso,
        GETDATE()
      );
    `;

    const result = await request.query(insertQuery);
    const ingresoCreado = result.recordset[0];

    const eventoPendiente = {
      id: ingresoCreado.id,
      tracking_id: tid,
      ruta_imagen_ingreso,
      imagen_vehiculo_path: ruta_imagen_ingreso,
      imagen_placa_path: ruta_imagen_ingreso,
      fecha_hora_ingreso: ingresoCreado.fecha_hora_ingreso,
      fecha_hora: ingresoCreado.fecha_hora_ingreso,
      estado_procesamiento: 'pendiente_ocr',
      estado_validacion: 'pendiente_revision',
      placa: initialPlaca,
      placa_reconocida: cleanPlaca.length >= 4 ? initialPlaca : null,
      confianza_deteccion: confianza_deteccion ?? 0.85,
      confianza_ocr: null,
      fuente
    };

    emitEvent('nuevo_ingreso_pendiente', eventoPendiente);
    emitEvent('nueva_deteccion', eventoPendiente);
    emitEvent('nuevo_evento', eventoPendiente);

    console.log(`[FASE 1 - CAPTURA] Ingreso ID #${ingresoCreado.id} registrado | Track #${tid} | Placa: ${initialPlaca} | Foto: ${ruta_imagen_ingreso}`);

    return res.status(201).json({
      message: 'Ingreso registrado en estado pendiente_ocr.',
      ingreso_id: ingresoCreado.id,
      fecha_hora_ingreso: ingresoCreado.fecha_hora_ingreso
    });

  } catch (error: any) {
    console.error('[DETECCIONES] Error en Fase 1 (Ingreso):', error.message);
    return res.status(500).json({ error: 'Error interno al registrar el ingreso fotografico.' });
  }
});


// =============================================================================
// FASE 2: Completar Procesamiento OCR Asíncrono (Worker)
// =============================================================================
router.post('/completar-ocr', async (req: Request, res: Response) => {
  const {
    ingreso_id,
    placa_reconocida,
    confianza_ocr,
    ruta_imagen_placa,
    estado_procesamiento = 'procesado' // 'procesado', 'no_legible', 'error'
  } = req.body;

  if (!ingreso_id) {
    return res.status(400).json({ error: 'El ID de ingreso es obligatorio.' });
  }

  try {
    const db = getDB();
    let cleanPlaca = (placa_reconocida || '').toUpperCase().trim().replace(/[^A-Z0-9-]/g, '');

    let estadoValidacion: 'autorizado' | 'alerta' | 'no_reconocido' | 'pendiente_revision' = 'no_reconocido';
    let alertaId: number | null = null;
    let vehiculoAutorizadoId: number | null = null;
    let alertaInfo: any = null;
    let autorizadoInfo: any = null;

    // Si no es legible o tiene menos de 4 caracteres, NO eliminar de la base de datos.
    // Preservar la integridad referencial y registrar como 'pendiente_revision' para que el operador valide manualmente.
    if (estado_procesamiento !== 'procesado' || cleanPlaca.length < 4 || cleanPlaca === 'NO_LEGIBLE' || cleanPlaca === 'SIN_RECONOCER') {
      const fallbackReq = db.request();
      fallbackReq.input('id', sql.Int, ingreso_id);
      fallbackReq.input('ruta_imagen_placa', sql.VarChar, ruta_imagen_placa || null);

      const fallbackQuery = `
        UPDATE DeteccionVehiculo
        SET
          placa = 'SIN_RECONOCER',
          placa_reconocida = 'SIN_RECONOCER',
          confianza_ocr = 0.0,
          ruta_imagen_placa = COALESCE(@ruta_imagen_placa, ruta_imagen_ingreso),
          imagen_placa_path = COALESCE(@ruta_imagen_placa, ruta_imagen_ingreso),
          fecha_hora_procesamiento = GETDATE(),
          estado_procesamiento = 'no_legible',
          estado_validacion = 'pendiente_revision',
          tipo_vehiculo = 'Vehículo (Por Verificar)'
        WHERE id = @id;

        SELECT d.*,
               c.nombre as camara_nombre, c.ubicacion as camara_ubicacion,
               l.motivo as alerta_motivo, l.nivel_alerta,
               v.propietario, v.departamento, v.tipo_vehiculo
        FROM DeteccionVehiculo d
        LEFT JOIN Camaras c ON d.camara_id = c.id
        LEFT JOIN ListaNegra l ON d.alerta_id = l.id
        LEFT JOIN VehiculosAutorizados v ON d.vehiculo_autorizado_id = v.id
        WHERE d.id = @id;
      `;

      const fallbackRes = await fallbackReq.query(fallbackQuery);
      const fallbackDet = fallbackRes.recordset[0];

      const eventoNoReconocido = {
        ...fallbackDet,
        placa: 'SIN_RECONOCER',
        placa_reconocida: 'SIN_RECONOCER',
        imagen_vehiculo_path: fallbackDet?.ruta_imagen_ingreso,
        imagen_placa_path: fallbackDet?.ruta_imagen_placa || fallbackDet?.ruta_imagen_ingreso,
        fecha_hora: fallbackDet?.fecha_hora_ingreso,
        alerta_detectada: false
      };

      emitEvent('ingreso_actualizado', eventoNoReconocido);
      emitEvent('nueva_deteccion', eventoNoReconocido);

      console.log(`[OCR NO LEGIBLE] Ingreso #${ingreso_id} guardado en BD con estado pendiente_revision para validación del operador.`);
      return res.json({ message: 'Ingreso registrado como pendiente de validación manual.', deteccion: eventoNoReconocido });
    }

    const normalizedPlaca = cleanPlaca.replace('-', '');

    // Anti-duplicado en Fase 2: si este ingreso es duplicado de otro reciente con la misma placa
    const dedupDupReq = db.request();
    dedupDupReq.input('current_id', sql.Int, ingreso_id);
    dedupDupReq.input('norm_placa', sql.VarChar, normalizedPlaca);
    const existingDup = await dedupDupReq.query(`
      SELECT TOP 1 id, fecha_hora_ingreso
      FROM DeteccionVehiculo
      WHERE id <> @current_id
        AND REPLACE(REPLACE(COALESCE(placa_reconocida, placa, ''), '-', ''), ' ', '') = @norm_placa
        AND estado_procesamiento = 'procesado'
        AND DATEDIFF(SECOND, fecha_hora_ingreso, GETDATE()) <= 35
      ORDER BY fecha_hora_ingreso DESC;
    `);

    if (existingDup.recordset.length > 0) {
      const prev = existingDup.recordset[0];
      console.log(`[ANTI-DUPLICADO FASE 2] Ingreso ID #${ingreso_id} con placa ${cleanPlaca} coincide con ID #${prev.id} (hace <= 35s). Eliminando duplicado.`);
      await db.request().input('id', sql.Int, ingreso_id).query(`
        DELETE FROM DeteccionVehiculo WHERE id = @id AND estado_procesamiento = 'pendiente_ocr';
      `);
      return res.json({
        message: 'Detección consolidada con evento previo.',
        deduplicado: true,
        ingreso_id: prev.id
      });
    }

    // Inferencia de tipo de vehículo según normativa ANT Ecuador (ITS Priority: Automóvil por defecto)
    let tipoVehiculoInferido = 'Automóvil';
    if (/^[A-Z]{3}/.test(normalizedPlaca)) {
      tipoVehiculoInferido = 'Automóvil';
    } else if (/^[A-Z]{2}\d{3,4}[A-Z]?$/.test(normalizedPlaca) && normalizedPlaca.length <= 6) {
      tipoVehiculoInferido = 'Motocicleta';
    }

    // 1. Cruce con Lista Negra (Máxima Prioridad). Tolerante a errores de OCR:
    // una coincidencia aproximada también alerta, marcada para confirmación del operador.
    const blacklistMatch = await findBlacklistMatch(db, normalizedPlaca);

    if (blacklistMatch) {
      estadoValidacion = 'alerta';
      alertaId = blacklistMatch.row.id;
      alertaInfo = { ...blacklistMatch.row, coincidencia: blacklistMatch.coincidencia };
    } else {
      // 2. Cruce con Vehículos Autorizados: solo coincidencia exacta (un error de OCR no concede acceso)
      const autorizado = await findAuthorizedExact(db, normalizedPlaca);

      if (autorizado) {
        estadoValidacion = 'autorizado';
        vehiculoAutorizadoId = autorizado.id;
        autorizadoInfo = autorizado;
        if (autorizadoInfo.placa) {
          cleanPlaca = autorizadoInfo.placa;
        }
        if (autorizadoInfo?.tipo_vehiculo) {
          tipoVehiculoInferido = autorizadoInfo.tipo_vehiculo;
        } else {
          tipoVehiculoInferido = 'Automóvil';
        }
      } else {
        estadoValidacion = 'no_reconocido';
      }
    }

    // Actualizar registro en base de datos
    const updateReq = db.request();
    updateReq.input('id', sql.Int, ingreso_id);
    updateReq.input('placa_reconocida', sql.VarChar, cleanPlaca);
    updateReq.input('confianza_ocr', sql.Float, confianza_ocr || 0.85);
    updateReq.input('ruta_imagen_placa', sql.VarChar, ruta_imagen_placa || null);
    updateReq.input('estado_procesamiento', sql.VarChar, 'procesado');
    updateReq.input('estado_validacion', sql.VarChar, estadoValidacion);
    updateReq.input('alerta_id', sql.Int, alertaId);
    updateReq.input('vehiculo_autorizado_id', sql.Int, vehiculoAutorizadoId);
    updateReq.input('tipo_vehiculo', sql.VarChar, tipoVehiculoInferido);

    const updateQuery = `
      UPDATE DeteccionVehiculo
      SET
        placa = @placa_reconocida,
        placa_reconocida = @placa_reconocida,
        confianza_ocr = @confianza_ocr,
        ruta_imagen_placa = @ruta_imagen_placa,
        imagen_placa_path = @ruta_imagen_placa,
        fecha_hora_procesamiento = GETDATE(),
        estado_procesamiento = 'procesado',
        estado_validacion = @estado_validacion,
        alerta_id = @alerta_id,
        vehiculo_autorizado_id = @vehiculo_autorizado_id,
        tipo_vehiculo = @tipo_vehiculo
      WHERE id = @id;

      SELECT d.*,
             c.nombre as camara_nombre, c.ubicacion as camara_ubicacion,
             l.motivo as alerta_motivo, l.nivel_alerta,
             v.propietario, v.departamento, COALESCE(v.tipo_vehiculo, d.tipo_vehiculo, 'Automóvil') as tipo_vehiculo
      FROM DeteccionVehiculo d
      LEFT JOIN Camaras c ON d.camara_id = c.id
      LEFT JOIN ListaNegra l ON d.alerta_id = l.id
      LEFT JOIN VehiculosAutorizados v ON d.vehiculo_autorizado_id = v.id
      WHERE d.id = @id;
    `;

    const updateRes = await updateReq.query(updateQuery);
    const registroActualizado = updateRes.recordset[0];

    const eventoCompleto = {
      ...registroActualizado,
      placa: cleanPlaca,
      imagen_vehiculo_path: registroActualizado?.ruta_imagen_ingreso,
      imagen_placa_path: registroActualizado?.ruta_imagen_placa || registroActualizado?.ruta_imagen_ingreso,
      fecha_hora: registroActualizado?.fecha_hora_ingreso,
      alerta_detectada: estadoValidacion === 'alerta'
    };

    // Emitir WebSocket de ingreso actualizado
    emitEvent('ingreso_actualizado', eventoCompleto);
    emitEvent('nueva_deteccion', eventoCompleto);

    if (estadoValidacion === 'alerta') {
      emitEvent('alerta_vehiculo', eventoCompleto);
      console.warn(`[¡ALERTA CRÍTICA!] Placa: ${cleanPlaca} en Lista Negra! Motivo: ${alertaInfo?.motivo}`);
    }

    console.log(
      `[FASE 2 - OCR WORKER] Ingreso ID #${ingreso_id} completado | Placa: ${cleanPlaca} | ` +
      `Estado: ${estadoValidacion.toUpperCase()} | Confianza OCR: ${((confianza_ocr || 0) * 100).toFixed(1)}%`
    );

    return res.json({
      message: 'OCR completado exitosamente.',
      deteccion: eventoCompleto
    });

  } catch (error: any) {
    console.error('[DETECCIONES] Error en Fase 2 (Completar OCR):', error.message);
    return res.status(500).json({ error: 'Error interno al completar el OCR.' });
  }
});

// =============================================================================
// GET /api/detecciones/recientes — Tabla de Ingresos Recientes (Dashboard)
// Retorna los N registros procesados mas recientes con los campos minimos para
// la tabla institucional: lugar, camara, placa, vehiculo, confianza, fecha/hora.
// =============================================================================
router.get('/recientes', async (req: Request, res: Response) => {
  const limite = Math.min(parseInt(String(req.query.limite || '20')), 50);

  try {
    const db = getDB();
    const request = db.request();
    request.input('limite', sql.Int, limite);

    const result = await request.query(`
      SELECT TOP (@limite)
        d.id,
        COALESCE(d.placa_validada, d.placa_reconocida, d.placa, 'SIN_RECONOCER') AS placa,
        d.confianza_ocr,
        d.confianza_deteccion,
        d.estado_validacion,
        d.estado_procesamiento,
        d.fecha_hora_ingreso,
        d.tracking_id,
        d.ruta_imagen_ingreso,
        d.ruta_imagen_placa,
        COALESCE(c.nombre, 'Cámara Principal') AS camara_nombre,
        COALESCE(c.ubicacion, 'Acceso ECU 911') AS camara_ubicacion,
        COALESCE(v.tipo_vehiculo, d.tipo_vehiculo, 'Automóvil') AS tipo_vehiculo,
        COALESCE(v.propietario, '') AS propietario,
        d.alerta_id,
        d.validado_manualmente
      FROM DeteccionVehiculo d
      LEFT JOIN Camaras c ON d.camara_id = c.id
      LEFT JOIN VehiculosAutorizados v ON d.vehiculo_autorizado_id = v.id
      WHERE (d.estado_procesamiento IN ('procesado', 'no_legible', 'pendiente_ocr') OR d.validado_manualmente = 1)
      ORDER BY d.fecha_hora_ingreso DESC;
    `);

    return res.json(result.recordset);
  } catch (error: any) {
    console.error('[DETECCIONES] Error en /recientes:', error.message);
    return res.status(500).json({ error: 'Error al consultar ingresos recientes.' });
  }
});

// =============================================================================
// GET /api/detecciones — Listar detecciones historicas y en vivo
// =============================================================================
router.get('/', async (req: Request, res: Response) => {
  const { placa, fechaInicio, fechaFin, estado, estado_procesamiento, camaraId } = req.query;

  try {
    const db = getDB();
    let queryStr = `
      SELECT d.*,
             c.nombre as camara_nombre, c.ubicacion as camara_ubicacion,
             l.motivo as alerta_motivo, l.nivel_alerta,
             v.propietario, v.departamento, COALESCE(v.tipo_vehiculo, d.tipo_vehiculo, 'Automóvil') as tipo_vehiculo
      FROM DeteccionVehiculo d
      LEFT JOIN Camaras c ON d.camara_id = c.id
      LEFT JOIN ListaNegra l ON d.alerta_id = l.id
      LEFT JOIN VehiculosAutorizados v ON d.vehiculo_autorizado_id = v.id
      WHERE (d.estado_procesamiento IN ('procesado', 'no_legible', 'pendiente_ocr') OR d.validado_manualmente = 1)
    `;

    const request = db.request();

    if (placa && String(placa).trim()) {
      const cleanPlaca = String(placa).trim().replace(/[^a-zA-Z0-9]/g, '');
      request.input('placa', sql.VarChar, `%${cleanPlaca}%`);
      request.input('placaRaw', sql.VarChar, `%${String(placa).trim()}%`);
      queryStr += ` AND (REPLACE(COALESCE(d.placa_validada, d.placa_reconocida, d.placa), '-', '') LIKE @placa OR d.placa_reconocida LIKE @placaRaw OR d.placa LIKE @placaRaw)`;
    }

    if (estado && estado !== 'todos') {
      request.input('estado', sql.VarChar, estado);
      queryStr += ` AND d.estado_validacion = @estado`;
    }

    if (estado_procesamiento) {
      request.input('estado_proc', sql.VarChar, estado_procesamiento);
      queryStr += ` AND d.estado_procesamiento = @estado_proc`;
    }

    if (camaraId && String(camaraId).trim()) {
      request.input('camaraId', sql.Int, parseInt(String(camaraId)));
      queryStr += ` AND d.camara_id = @camaraId`;
    }

    if (fechaInicio && String(fechaInicio).trim()) {
      request.input('fechaInicio', sql.DateTime2, new Date(String(fechaInicio)));
      queryStr += ` AND d.fecha_hora_ingreso >= @fechaInicio`;
    }

    if (fechaFin && String(fechaFin).trim()) {
      request.input('fechaFin', sql.DateTime2, new Date(String(fechaFin)));
      queryStr += ` AND d.fecha_hora_ingreso <= @fechaFin`;
    }

    queryStr += ` ORDER BY d.fecha_hora_ingreso DESC`;

    const result = await request.query(queryStr);

    const normalizados = result.recordset.map((item: any) => ({
      ...item,
      placa: item.validado_manualmente ? item.placa_validada : (item.placa_reconocida || item.placa || 'SIN_RECONOCER'),
      tipo_vehiculo: item.tipo_vehiculo || 'Automóvil',
      imagen_vehiculo_path: item.ruta_imagen_ingreso,
      imagen_placa_path: item.ruta_imagen_placa || item.ruta_imagen_ingreso,
      fecha_hora: item.fecha_hora_ingreso
    }));

    return res.json(normalizados);
  } catch (error: any) {
    console.error('[DETECCIONES] Error al listar detecciones:', error.message);
    return res.status(500).json({ error: 'Error al consultar detecciones.' });
  }
});

// =============================================================================
// GET /api/detecciones/exportar — Exportar historial a CSV
// =============================================================================
router.get('/exportar', async (req: Request, res: Response) => {
  const { placa, fechaInicio, fechaFin, estado, camaraId } = req.query;

  try {
    const db = getDB();
    let queryStr = `
      SELECT d.*,
             c.nombre as camara_nombre, c.ubicacion as camara_ubicacion,
             l.motivo as alerta_motivo, l.nivel_alerta,
             v.propietario, v.departamento, v.tipo_vehiculo
      FROM DeteccionVehiculo d
      LEFT JOIN Camaras c ON d.camara_id = c.id
      LEFT JOIN ListaNegra l ON d.alerta_id = l.id
      LEFT JOIN VehiculosAutorizados v ON d.vehiculo_autorizado_id = v.id
      WHERE d.placa IS NOT NULL 
        AND d.placa != 'NO_LEGIBLE' 
        AND d.placa != 'PROCESANDO...' 
        AND d.placa != 'PROCESANDO'
        AND LEN(REPLACE(d.placa, '-', '')) >= 5
    `;

    const request = db.request();

    if (placa && String(placa).trim()) {
      const cleanPlaca = String(placa).trim().replace(/[^a-zA-Z0-9]/g, '');
      request.input('placa', sql.VarChar, `%${cleanPlaca}%`);
      queryStr += ` AND (REPLACE(d.placa_reconocida, '-', '') LIKE @placa OR d.placa_reconocida LIKE @placa)`;
    }

    if (estado && estado !== 'todos') {
      request.input('estado', sql.VarChar, estado);
      queryStr += ` AND d.estado_validacion = @estado`;
    }

    if (camaraId && String(camaraId).trim()) {
      request.input('camaraId', sql.Int, parseInt(String(camaraId)));
      queryStr += ` AND d.camara_id = @camaraId`;
    }

    if (fechaInicio && String(fechaInicio).trim()) {
      request.input('fechaInicio', sql.DateTime2, new Date(String(fechaInicio)));
      queryStr += ` AND d.fecha_hora_ingreso >= @fechaInicio`;
    }

    if (fechaFin && String(fechaFin).trim()) {
      request.input('fechaFin', sql.DateTime2, new Date(String(fechaFin)));
      queryStr += ` AND d.fecha_hora_ingreso <= @fechaFin`;
    }

    queryStr += ` ORDER BY d.fecha_hora_ingreso DESC`;

    const result = await request.query(queryStr);
    const rows = result.recordset;

    // Generar CSV
    const headers = [
      'ID',
      'Placa Reconocida',
      'Fecha y Hora',
      'Estado Validacion',
      'Propietario',
      'Departamento',
      'Tipo Vehiculo',
      'Alerta Lista Negra',
      'Motivo Alerta',
      'Nivel Alerta',
      'Camara',
      'Ubicacion',
      'Confianza YOLO (%)',
      'Confianza OCR (%)',
      'Validado Manualmente'
    ];

    const escapeCsv = (val: any) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    let csvContent = '\uFEFF' + headers.join(',') + '\n';

    for (const r of rows) {
      const row = [
        r.id,
        escapeCsv(r.validado_manualmente ? r.placa_validada : (r.placa_reconocida || r.placa)),
        escapeCsv(r.fecha_hora_ingreso ? new Date(r.fecha_hora_ingreso).toLocaleString('es-EC') : ''),
        escapeCsv(r.estado_validacion),
        escapeCsv(r.propietario || 'N/A'),
        escapeCsv(r.departamento || 'N/A'),
        escapeCsv(r.tipo_vehiculo || 'N/A'),
        escapeCsv(r.alerta_id ? 'SI' : 'NO'),
        escapeCsv(r.alerta_motivo || 'N/A'),
        escapeCsv(r.nivel_alerta || 'N/A'),
        escapeCsv(r.camara_nombre || 'Acceso Principal'),
        escapeCsv(r.camara_ubicacion || 'Garita'),
        escapeCsv(r.confianza_deteccion ? `${(r.confianza_deteccion * 100).toFixed(1)}%` : '0%'),
        escapeCsv(r.confianza_ocr ? `${(r.confianza_ocr * 100).toFixed(1)}%` : '0%'),
        escapeCsv(r.validado_manualmente ? 'SI' : 'NO')
      ];
      csvContent += row.join(',') + '\n';
    }

    const filename = `reporte_ingresos_anpr_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csvContent);

  } catch (error: any) {
    console.error('[DETECCIONES] Error al exportar CSV:', error.message);
    return res.status(500).json({ error: 'Error al exportar datos.' });
  }
});

// =============================================================================
// GET /api/detecciones/stats — Estadísticas del día
// =============================================================================
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const db = getDB();
    const result = await db.request().query(`
      SELECT
        COUNT(*) as total_hoy,
        ISNULL(SUM(CASE WHEN estado_validacion = 'autorizado' THEN 1 ELSE 0 END), 0) as autorizados_hoy,
        ISNULL(SUM(CASE WHEN estado_validacion = 'alerta' THEN 1 ELSE 0 END), 0) as alertas_hoy,
        ISNULL(SUM(CASE WHEN estado_validacion = 'no_reconocido' THEN 1 ELSE 0 END), 0) as no_reconocidos_hoy,
        ISNULL(SUM(CASE WHEN estado_procesamiento = 'pendiente_ocr' OR estado_validacion = 'pendiente_revision' THEN 1 ELSE 0 END), 0) as pendientes_hoy
      FROM DeteccionVehiculo
      WHERE CAST(fecha_hora_ingreso AS DATE) = CAST(GETDATE() AS DATE)
    `);

    return res.json(result.recordset[0]);
  } catch (error: any) {
    console.error('[DETECCIONES] Error al obtener estadísticas:', error.message);
    return res.status(500).json({ error: 'Error al obtener estadísticas.' });
  }
});

// =============================================================================
// DELETE /api/detecciones/limpiar — Purgar detecciones
// =============================================================================
router.delete('/limpiar', async (req: Request, res: Response) => {
  try {
    const db = getDB();
    await db.request().query(`
      DELETE FROM DeteccionVehiculo;
      DELETE FROM EventosIngreso;
    `);
    console.log('[DETECCIONES] Historial de detecciones purgado.');
    return res.json({ message: 'Historial de detecciones limpiado exitosamente.' });
  } catch (error: any) {
    console.error('[DETECCIONES] Error al limpiar detecciones:', error.message);
    return res.status(500).json({ error: 'Error al limpiar detecciones.' });
  }
});

// =============================================================================
// DELETE /api/detecciones/:id — Eliminar detección individual
// =============================================================================
router.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const db = getDB();
    await db.request()
      .input('id', sql.Int, parseInt(id))
      .query(`
        DELETE FROM DeteccionVehiculo WHERE id = @id;
        DELETE FROM EventosIngreso WHERE id = @id;
      `);
    console.log(`[DETECCIONES] Detección #${id} eliminada individualmente.`);
    return res.json({ message: 'Detección eliminada exitosamente.', id: parseInt(id) });
  } catch (error: any) {
    console.error('[DETECCIONES] Error al eliminar detección individual:', error.message);
    return res.status(500).json({ error: 'Error al eliminar la detección.' });
  }
});

// =============================================================================
// POST /api/detecciones/validar/:id — Validación manual de placa por operador
// =============================================================================
router.post('/validar/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { placa_validada, tipo_vehiculo } = req.body;

  if (!placa_validada) {
    return res.status(400).json({ error: 'Debe ingresar la placa validada manualmente.' });
  }

  try {
    const db = getDB();
    let cleanPlaca = String(placa_validada).toUpperCase().trim().replace(/[^A-Z0-9-]/g, '');
    const normalizedPlaca = cleanPlaca.replace('-', '');

    let estadoValidacion: 'autorizado' | 'alerta' | 'no_reconocido' | 'pendiente_revision' = 'no_reconocido';
    let alertaId: number | null = null;
    let vehiculoAutorizadoId: number | null = null;
    let alertaInfo: any = null;
    let finalTipoVehiculo = tipo_vehiculo || '';

    // 1. Cruce con Lista Negra
    const blacklistReq = db.request();
    blacklistReq.input('placaRaw', sql.VarChar, cleanPlaca);
    blacklistReq.input('placaClean', sql.VarChar, normalizedPlaca);
    const blacklistRes = await blacklistReq.query(`
      SELECT TOP 1 id, motivo, nivel_alerta FROM ListaNegra WHERE activo = 1 AND (REPLACE(placa, '-', '') = @placaClean OR placa = @placaRaw)
    `);

    if (blacklistRes.recordset.length > 0) {
      estadoValidacion = 'alerta';
      alertaId = blacklistRes.recordset[0].id;
      alertaInfo = blacklistRes.recordset[0];
    } else {
      // 2. Cruce con Vehículos Autorizados (coincidencia exacta)
      const whitelistReq = db.request();
      whitelistReq.input('placaRaw', sql.VarChar, cleanPlaca);
      whitelistReq.input('placaClean', sql.VarChar, normalizedPlaca);
      const whitelistRes = await whitelistReq.query(`
        SELECT TOP 1 id, placa, propietario, departamento, tipo_vehiculo
        FROM VehiculosAutorizados
        WHERE activo = 1 AND (REPLACE(placa, '-', '') = @placaClean OR placa = @placaRaw)
      `);

      if (whitelistRes.recordset.length > 0) {
        estadoValidacion = 'autorizado';
        vehiculoAutorizadoId = whitelistRes.recordset[0].id;
        if (whitelistRes.recordset[0].placa) {
          cleanPlaca = whitelistRes.recordset[0].placa;
        }
        if (!finalTipoVehiculo && whitelistRes.recordset[0].tipo_vehiculo) {
          finalTipoVehiculo = whitelistRes.recordset[0].tipo_vehiculo;
        }
      }
    }

    // Inferencia de tipo de vehículo si el operador no lo especificó manualmente
    if (!finalTipoVehiculo) {
      if (/^[A-Z]{3}/.test(normalizedPlaca)) {
        finalTipoVehiculo = 'Automóvil';
      } else if (/^[A-Z]{2}\d{3,4}[A-Z]?$/.test(normalizedPlaca) && normalizedPlaca.length <= 6) {
        finalTipoVehiculo = 'Motocicleta';
      } else {
        finalTipoVehiculo = 'Automóvil';
      }
    }

    // 3. Actualizar registro en DeteccionVehiculo
    const updateReq = db.request();
    updateReq.input('id', sql.Int, parseInt(id));
    updateReq.input('placaValidada', sql.VarChar, cleanPlaca);
    updateReq.input('estadoValidacion', sql.VarChar, estadoValidacion);
    updateReq.input('alertaId', sql.Int, alertaId);
    updateReq.input('vehiculoAutorizadoId', sql.Int, vehiculoAutorizadoId);
    updateReq.input('tipoVehiculo', sql.VarChar, finalTipoVehiculo);

    const updateQuery = `
      UPDATE DeteccionVehiculo
      SET
        validado_manualmente = 1,
        placa_validada = @placaValidada,
        placa_reconocida = @placaValidada,
        placa = @placaValidada,
        tipo_vehiculo = @tipoVehiculo,
        estado_procesamiento = 'procesado',
        estado_validacion = @estadoValidacion,
        alerta_id = @alertaId,
        vehiculo_autorizado_id = @vehiculoAutorizadoId
      WHERE id = @id;

      UPDATE EventosIngreso
      SET
        validado_manualmente = 1,
        placa_validada = @placaValidada,
        placa = @placaValidada
      WHERE id = @id;

      SELECT d.*,
             c.nombre as camara_nombre, c.ubicacion as camara_ubicacion,
             l.motivo as alerta_motivo, l.nivel_alerta,
             v.propietario, v.departamento, COALESCE(v.tipo_vehiculo, d.tipo_vehiculo, 'Automóvil') as tipo_vehiculo
      FROM DeteccionVehiculo d
      LEFT JOIN Camaras c ON d.camara_id = c.id
      LEFT JOIN ListaNegra l ON d.alerta_id = l.id
      LEFT JOIN VehiculosAutorizados v ON d.vehiculo_autorizado_id = v.id
      WHERE d.id = @id;
    `;

    const updateResult = await updateReq.query(updateQuery);

    if (updateResult.recordset.length === 0) {
      return res.status(404).json({ error: 'Detección no encontrada.' });
    }

    const actualizado = {
      ...updateResult.recordset[0],
      placa: cleanPlaca,
      imagen_vehiculo_path: updateResult.recordset[0].ruta_imagen_ingreso,
      imagen_placa_path: updateResult.recordset[0].ruta_imagen_placa || updateResult.recordset[0].ruta_imagen_ingreso,
      alerta_detectada: estadoValidacion === 'alerta'
    };

    // Emitir WebSocket en tiempo real
    emitEvent('ingreso_actualizado', actualizado);
    emitEvent('nueva_deteccion', actualizado);

    if (estadoValidacion === 'alerta') {
      emitEvent('alerta_vehiculo', actualizado);
    }

    console.log(`[VALIDACION MANUAL] Detección #${id} validada como: ${cleanPlaca} | Estado: ${estadoValidacion.toUpperCase()}`);

    return res.json({
      message: 'Detección validada manualmente con éxito.',
      deteccion: actualizado
    });
  } catch (error: any) {
    console.error('[DETECCIONES] Error en validación manual:', error.message);
    return res.status(500).json({ error: 'Error al registrar la validación manual.' });
  }
});

// =============================================================================
// GET /api/detecciones/buscar-placa/:placa — Consulta unificada de placa
// =============================================================================
router.get('/buscar-placa/:placa', async (req: Request, res: Response) => {
  const { placa } = req.params;
  if (!placa || !placa.trim()) {
    return res.status(400).json({ error: 'Debe especificar una placa para buscar.' });
  }

  try {
    const db = getDB();
    const cleanPlaca = String(placa).toUpperCase().trim().replace(/[^A-Z0-9-]/g, '');
    const normalizedPlaca = cleanPlaca.replace(/-/g, '');

    // 1. Consultar en Lista Negra
    const blReq = db.request();
    blReq.input('placaRaw', sql.VarChar, cleanPlaca);
    blReq.input('placaClean', sql.VarChar, normalizedPlaca);
    const blRes = await blReq.query(`
      SELECT TOP 1 * FROM ListaNegra 
      WHERE activo = 1 AND (REPLACE(placa, '-', '') = @placaClean OR placa = @placaRaw)
    `);

    // 2. Consultar en Vehículos Autorizados
    const wlReq = db.request();
    wlReq.input('placaRaw', sql.VarChar, cleanPlaca);
    wlReq.input('placaClean', sql.VarChar, normalizedPlaca);
    const wlRes = await wlReq.query(`
      SELECT TOP 1 * FROM VehiculosAutorizados 
      WHERE activo = 1 AND (REPLACE(placa, '-', '') = @placaClean OR placa = @placaRaw)
    `);

    // 3. Consultar últimos ingresos en DeteccionVehiculo
    const histReq = db.request();
    histReq.input('placaRaw', sql.VarChar, `%${cleanPlaca}%`);
    histReq.input('placaClean', sql.VarChar, `%${normalizedPlaca}%`);
    const histRes = await histReq.query(`
      SELECT TOP 5 d.*, c.nombre as camara_nombre, c.ubicacion as camara_ubicacion
      FROM DeteccionVehiculo d
      LEFT JOIN Camaras c ON d.camara_id = c.id
      WHERE (REPLACE(d.placa_reconocida, '-', '') LIKE @placaClean OR d.placa_reconocida LIKE @placaRaw OR d.placa LIKE @placaRaw)
      ORDER BY d.fecha_hora_ingreso DESC
    `);

    let estado: 'alerta' | 'autorizado' | 'no_registrado' = 'no_registrado';
    let alertaInfo = null;
    let autorizadoInfo = null;

    if (blRes.recordset.length > 0) {
      estado = 'alerta';
      alertaInfo = blRes.recordset[0];
    } else if (wlRes.recordset.length > 0) {
      estado = 'autorizado';
      autorizadoInfo = wlRes.recordset[0];
    }

    return res.json({
      placa: cleanPlaca,
      estado,
      alerta: alertaInfo,
      autorizado: autorizadoInfo,
      ultimos_ingresos: histRes.recordset.map((item: any) => ({
        ...item,
        placa: item.placa_reconocida || item.placa,
        imagen_vehiculo_path: item.ruta_imagen_ingreso,
        imagen_placa_path: item.ruta_imagen_placa || item.ruta_imagen_ingreso,
        fecha_hora: item.fecha_hora_ingreso
      }))
    });
  } catch (error: any) {
    console.error('[DETECCIONES] Error al buscar placa:', error.message);
    return res.status(500).json({ error: 'Error al buscar la placa en el sistema.' });
  }
});

// =============================================================================
// POST /api/detecciones/registro-manual — Registro manual desde la tarjeta Home
// =============================================================================
router.post('/registro-manual', async (req: Request, res: Response) => {
  const { nombres, cedula, placa, departamento, tipo_vehiculo = 'Particular' } = req.body;

  if (!nombres || !placa) {
    return res.status(400).json({ error: 'Nombres y Placa son campos obligatorios.' });
  }

  try {
    const db = getDB();
    const cleanPlaca = String(placa).toUpperCase().trim().replace(/[^A-Z0-9-]/g, '');
    const normalizedPlaca = cleanPlaca.replace(/-/g, '');
    const propietario = `${nombres.trim()}${cedula ? ` (CI: ${cedula.trim()})` : ''}`;

    // 1. Revisar si está en Lista Negra
    const blReq = db.request();
    blReq.input('placaRaw', sql.VarChar, cleanPlaca);
    blReq.input('placaClean', sql.VarChar, normalizedPlaca);
    const blRes = await blReq.query(`
      SELECT TOP 1 * FROM ListaNegra 
      WHERE activo = 1 AND (REPLACE(placa, '-', '') = @placaClean OR placa = @placaRaw)
    `);

    let estadoValidacion: 'autorizado' | 'alerta' | 'no_reconocido' = 'autorizado';
    let alertaId: number | null = null;
    let vehiculoAutorizadoId: number | null = null;
    let alertaMotivo: string | null = null;
    let nivelAlerta: string | null = null;

    if (blRes.recordset.length > 0) {
      estadoValidacion = 'alerta';
      alertaId = blRes.recordset[0].id;
      alertaMotivo = blRes.recordset[0].motivo;
      nivelAlerta = blRes.recordset[0].nivel_alerta;
    } else {
      // 2. Insertar o actualizar en VehiculosAutorizados
      const wlReq = db.request();
      wlReq.input('placa', sql.VarChar, normalizedPlaca);
      wlReq.input('propietario', sql.VarChar, propietario);
      wlReq.input('departamento', sql.VarChar, departamento || 'Registro Manual');
      wlReq.input('tipo', sql.VarChar, tipo_vehiculo);

      const wlRes = await wlReq.query(`
        IF EXISTS (SELECT 1 FROM VehiculosAutorizados WHERE placa = @placa)
        BEGIN
          UPDATE VehiculosAutorizados 
          SET propietario = @propietario, departamento = @departamento, activo = 1, fecha_registro = GETDATE()
          OUTPUT inserted.id
          WHERE placa = @placa;
        END
        ELSE
        BEGIN
          INSERT INTO VehiculosAutorizados (placa, propietario, departamento, tipo_vehiculo, activo, fecha_registro)
          OUTPUT inserted.id
          VALUES (@placa, @propietario, @departamento, @tipo, 1, GETDATE());
        END
      `);
      if (wlRes.recordset.length > 0) {
        vehiculoAutorizadoId = wlRes.recordset[0].id;
      }
    }

    // 3. Crear registro de ingreso en DeteccionVehiculo
    const insertReq = db.request();
    insertReq.input('placa', sql.VarChar, cleanPlaca);
    insertReq.input('estadoValidacion', sql.VarChar, estadoValidacion);
    insertReq.input('alertaId', sql.Int, alertaId);
    insertReq.input('vehiculoAutorizadoId', sql.Int, vehiculoAutorizadoId);

    const insertRes = await insertReq.query(`
      INSERT INTO DeteccionVehiculo (
        placa,
        placa_reconocida,
        confianza_deteccion,
        confianza_ocr,
        imagen_vehiculo_path,
        imagen_placa_path,
        fecha_hora,
        fuente,
        estado_validacion,
        estado_procesamiento,
        ruta_imagen_ingreso,
        ruta_imagen_placa,
        fecha_hora_ingreso,
        validado_manualmente,
        placa_validada,
        alerta_id,
        vehiculo_autorizado_id
      )
      OUTPUT inserted.*
      VALUES (
        @placa,
        @placa,
        1.0,
        1.0,
        '',
        '',
        GETDATE(),
        'manual',
        @estadoValidacion,
        'procesado',
        '',
        '',
        GETDATE(),
        1,
        @placa,
        @alertaId,
        @vehiculoAutorizadoId
      )
    `);

    const nuevoIngreso = {
      ...insertRes.recordset[0],
      propietario,
      departamento: departamento || 'Registro Manual',
      tipo_vehiculo,
      camara_nombre: 'Ingreso Manual Garita',
      camara_ubicacion: 'Centro de Control ECU 911',
      alerta_motivo: alertaMotivo,
      nivel_alerta: nivelAlerta,
      alerta_detectada: estadoValidacion === 'alerta'
    };

    // Emitir WebSocket
    emitEvent('nuevo_ingreso_pendiente', nuevoIngreso);
    emitEvent('ingreso_actualizado', nuevoIngreso);
    emitEvent('nueva_deteccion', nuevoIngreso);
    emitEvent('nuevo_evento', nuevoIngreso);

    if (estadoValidacion === 'alerta') {
      emitEvent('alerta_vehiculo', nuevoIngreso);
    }

    console.log(`[REGISTRO MANUAL] Placa: ${cleanPlaca} | Propietario: ${propietario} | Estado: ${estadoValidacion}`);

    return res.status(201).json({
      message: 'Vehículo registrado manualmente exitosamente.',
      ingreso: nuevoIngreso
    });

  } catch (error: any) {
    console.error('[REGISTRO MANUAL] Error:', error.message);
    return res.status(500).json({ error: 'Error interno al realizar el registro manual.' });
  }
});

// =============================================================================
// POST /api/detecciones/descarte — Auditoría de Falsos Positivos / Descartes
// =============================================================================
router.post('/descarte', async (req: Request, res: Response) => {
  const { tracking_id, motivo, texto_candidato, confianza, fuente, camara_id } = req.body;
  try {
    const db = getDB();
    const request = db.request();
    request.input('tracking_id', sql.Int, tracking_id || -1);
    request.input('motivo', sql.VarChar, motivo || 'falso_positivo_ocr');
    request.input('texto_candidato', sql.VarChar, texto_candidato || null);
    request.input('confianza', sql.Float, confianza || 0.0);
    request.input('fuente', sql.VarChar, fuente || 'webcam');
    request.input('camara_id', sql.Int, camara_id || null);

    await request.query(`
      INSERT INTO AuditoriaDescartes (tracking_id, motivo, texto_candidato, confianza, fuente, camara_id)
      VALUES (@tracking_id, @motivo, @texto_candidato, @confianza, @fuente, @camara_id);
    `);

    return res.status(201).json({ success: true, message: 'Descarte auditado exitosamente.' });
  } catch (err: any) {
    console.error('[DESCARTE AUDIT] Error al registrar descarte:', err.message);
    return res.status(500).json({ error: 'Error al registrar descarte.' });
  }
});

export default router;
