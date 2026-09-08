import { Router, Request, Response } from 'express';
import sql from 'mssql';
import { getDB } from '../config/db';
import { authMiddleware } from '../middlewares/auth';
import { pingHost, extractHostFromRtsp } from '../services/pingService';
import { emitEvent } from '../services/socket';

const router = Router();

// =============================================================================
// GET /api/camaras - Listar canales / cámaras registradas
// =============================================================================
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const db = getDB();
    const result = await db.request().query(`
      SELECT 
        id, 
        nombre, 
        ip, 
        rtsp_url, 
        ubicacion, 
        activa, 
        COALESCE(estado, CASE WHEN activa = 1 THEN 'ACTIVA' ELSE 'INACTIVA' END) AS estado,
        ultimo_ping,
        tiempo_respuesta_ms,
        mensaje_ping,
        created_at
      FROM Camaras 
      ORDER BY id DESC
    `);
    return res.json(result.recordset);
  } catch (error: any) {
    console.error('[CAMARAS] Error al listar cámaras:', error.message);
    return res.status(500).json({ error: 'Error al listar cámaras.' });
  }
});

// =============================================================================
// POST /api/camaras - Registrar nuevo canal de video / RTSP
// =============================================================================
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  const { nombre, ip, rtsp_url, ubicacion, activa, estado } = req.body;

  if (!nombre || !rtsp_url || !ip) {
    return res.status(400).json({ error: 'Faltan parámetros requeridos: nombre, ip, rtsp_url.' });
  }

  const estadoInicial = estado || (activa !== false ? 'ACTIVA' : 'INACTIVA');
  const activaBit = activa === undefined ? (estadoInicial === 'ACTIVA' ? 1 : 0) : (activa ? 1 : 0);

  try {
    const db = getDB();
    const insert = await db.request()
      .input('nombre', sql.VarChar, nombre.trim())
      .input('ip', sql.VarChar, ip.trim())
      .input('rtsp', sql.VarChar, rtsp_url.trim())
      .input('ubicacion', sql.VarChar, ubicacion ? ubicacion.trim() : 'Acceso Principal')
      .input('activa', sql.Bit, activaBit)
      .input('estado', sql.VarChar, estadoInicial)
      .query(`
        INSERT INTO Camaras (nombre, ip, rtsp_url, ubicacion, activa, estado, created_at)
        OUTPUT inserted.*
        VALUES (@nombre, @ip, @rtsp, @ubicacion, @activa, @estado, GETDATE())
      `);

    const newCam = insert.recordset[0];
    console.log(`[CAMARAS] Canal registrado: ${nombre} (${ip}) - Estado: ${estadoInicial}`);
    emitEvent('camara_creada', newCam);
    return res.status(201).json({ camera: newCam, message: 'Canal registrado exitosamente.' });
  } catch (error: any) {
    console.error('[CAMARAS] Error al crear cámara:', error.message);
    return res.status(500).json({ error: 'Error interno al registrar el canal de video.' });
  }
});

// =============================================================================
// PUT /api/camaras/:id - Actualizar canal existente
// =============================================================================
router.put('/:id', authMiddleware, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { nombre, ip, rtsp_url, ubicacion, activa, estado } = req.body;

  if (!nombre || !rtsp_url || !ip) {
    return res.status(400).json({ error: 'Faltan parámetros requeridos: nombre, ip, rtsp_url.' });
  }

  const estadoValor = estado || (activa ? 'ACTIVA' : 'INACTIVA');
  const activaBit = estado ? (estado === 'ACTIVA' ? 1 : 0) : (activa ? 1 : 0);

  try {
    const db = getDB();
    const update = await db.request()
      .input('id', sql.Int, parseInt(id))
      .input('nombre', sql.VarChar, nombre.trim())
      .input('ip', sql.VarChar, ip.trim())
      .input('rtsp', sql.VarChar, rtsp_url.trim())
      .input('ubicacion', sql.VarChar, ubicacion ? ubicacion.trim() : 'Acceso Principal')
      .input('activa', sql.Bit, activaBit)
      .input('estado', sql.VarChar, estadoValor)
      .query(`
        UPDATE Camaras
        SET 
          nombre = @nombre,
          ip = @ip,
          rtsp_url = @rtsp,
          ubicacion = @ubicacion,
          activa = @activa,
          estado = @estado
        OUTPUT inserted.*
        WHERE id = @id;
      `);

    if (update.recordset.length === 0) {
      return res.status(404).json({ error: 'Canal no encontrado.' });
    }

    const updatedCam = update.recordset[0];
    emitEvent('camara_actualizada', updatedCam);
    return res.json({ camera: updatedCam, message: 'Canal actualizado exitosamente.' });
  } catch (error: any) {
    console.error('[CAMARAS] Error al actualizar cámara:', error.message);
    return res.status(500).json({ error: 'Error al actualizar el canal de video.' });
  }
});

// =============================================================================
// POST /api/camaras/:id/ping - Diagnóstico Ping ICMP y Actualización Automática
// =============================================================================
router.post('/:id/ping', authMiddleware, async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const db = getDB();
    const camQuery = await db.request()
      .input('id', sql.Int, parseInt(id))
      .query('SELECT * FROM Camaras WHERE id = @id');

    if (camQuery.recordset.length === 0) {
      return res.status(404).json({ error: 'Cámara no encontrada.' });
    }

    const cam = camQuery.recordset[0];
    // Resolver host objetivo (IP declarada o extraída de la URL RTSP)
    const targetHost = (cam.ip && cam.ip.trim().length > 3) 
      ? cam.ip.trim() 
      : extractHostFromRtsp(cam.rtsp_url) || '127.0.0.1';

    console.log(`[CAMARAS] Ejecutando Ping ICMP a cámara #${id} (${cam.nombre}) -> ${targetHost}`);
    const pingResult = await pingHost(targetHost, 1500);

    const nuevoEstado = pingResult.success ? 'ACTIVA' : 'INACTIVA';
    const nuevaActiva = pingResult.success ? 1 : 0;
    const tiempoMs = pingResult.timeMs || null;
    const mensaje = pingResult.message || (pingResult.success ? 'Conexión exitosa' : 'Sin respuesta de host');

    // Actualizar en base de datos
    const updateResult = await db.request()
      .input('id', sql.Int, parseInt(id))
      .input('activa', sql.Bit, nuevaActiva)
      .input('estado', sql.VarChar, nuevoEstado)
      .input('tiempo', sql.Int, tiempoMs)
      .input('mensaje', sql.VarChar, mensaje)
      .query(`
        UPDATE Camaras
        SET 
          activa = @activa,
          estado = @estado,
          ultimo_ping = GETDATE(),
          tiempo_respuesta_ms = @tiempo,
          mensaje_ping = @mensaje
        OUTPUT inserted.*
        WHERE id = @id;
      `);

    const updatedCamera = updateResult.recordset[0];

    // Emitir eventos en tiempo real hacia todos los clientes conectados (SignalR / Socket.IO)
    emitEvent('camara_estado_cambiado', {
      id: updatedCamera.id,
      nombre: updatedCamera.nombre,
      ip: updatedCamera.ip,
      activa: updatedCamera.activa,
      estado: updatedCamera.estado,
      tiempo_respuesta_ms: updatedCamera.tiempo_respuesta_ms,
      ultimo_ping: updatedCamera.ultimo_ping,
      mensaje_ping: updatedCamera.mensaje_ping
    });

    emitEvent('notificacion_camara', {
      tipo: pingResult.success ? 'success' : 'error',
      titulo: `Cámara ${updatedCamera.nombre}`,
      mensaje: pingResult.success 
        ? `En línea: respondío en ${tiempoMs}ms. Estado: ACTIVA.`
        : `Sin conexión: ${mensaje}. Estado: INACTIVA.`,
      camera: updatedCamera
    });

    return res.json({
      success: pingResult.success,
      estado: nuevoEstado,
      activa: Boolean(nuevaActiva),
      timeMs: tiempoMs,
      message: mensaje,
      camera: updatedCamera
    });
  } catch (error: any) {
    console.error(`[CAMARAS] Error en ping a cámara #${id}:`, error.message);
    return res.status(500).json({ error: error.message || 'Error al ejecutar ping a la cámara.' });
  }
});

// =============================================================================
// POST /api/camaras/ping-all - Diagnóstico Ping Masivo a todos los canales
// =============================================================================
router.post('/ping-all', authMiddleware, async (req: Request, res: Response) => {
  try {
    const db = getDB();
    const result = await db.request().query('SELECT * FROM Camaras');
    const camaras = result.recordset;

    const pingPromises = camaras.map(async (cam) => {
      const targetHost = (cam.ip && cam.ip.trim().length > 3) 
        ? cam.ip.trim() 
        : extractHostFromRtsp(cam.rtsp_url) || '127.0.0.1';

      const pingRes = await pingHost(targetHost, 1500);
      const nuevoEstado = pingRes.success ? 'ACTIVA' : 'INACTIVA';
      const nuevaActiva = pingRes.success ? 1 : 0;
      const tiempoMs = pingRes.timeMs || null;
      const mensaje = pingRes.message;

      await db.request()
        .input('id', sql.Int, cam.id)
        .input('activa', sql.Bit, nuevaActiva)
        .input('estado', sql.VarChar, nuevoEstado)
        .input('tiempo', sql.Int, tiempoMs)
        .input('mensaje', sql.VarChar, mensaje)
        .query(`
          UPDATE Camaras
          SET activa = @activa, estado = @estado, ultimo_ping = GETDATE(),
              tiempo_respuesta_ms = @tiempo, mensaje_ping = @mensaje
          WHERE id = @id;
        `);

      emitEvent('camara_estado_cambiado', {
        id: cam.id,
        nombre: cam.nombre,
        activa: nuevaActiva === 1,
        estado: nuevoEstado,
        tiempo_respuesta_ms: tiempoMs,
        mensaje_ping: mensaje
      });

      return {
        id: cam.id,
        nombre: cam.nombre,
        ip: targetHost,
        success: pingRes.success,
        estado: nuevoEstado,
        timeMs: tiempoMs,
        message: mensaje
      };
    });

    const resultados = await Promise.all(pingPromises);
    const activas = resultados.filter(r => r.success).length;
    const inactivas = resultados.filter(r => !r.success).length;

    emitEvent('notificacion_camara', {
      tipo: 'info',
      titulo: 'Ping Global de Canales Completado',
      mensaje: `Diagnóstico general: ${activas} activas, ${inactivas} inactivas.`
    });

    return res.json({
      success: true,
      total: resultados.length,
      activas,
      inactivas,
      detalles: resultados
    });
  } catch (error: any) {
    console.error('[CAMARAS] Error en ping masivo:', error.message);
    return res.status(500).json({ error: 'Error al ejecutar ping masivo a los canales.' });
  }
});

// =============================================================================
// PATCH /api/camaras/:id/toggle - Alternar estado activo / inactivo
// =============================================================================
router.patch('/:id/toggle', authMiddleware, async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const db = getDB();
    const toggle = await db.request()
      .input('id', sql.Int, parseInt(id))
      .query(`
        UPDATE Camaras
        SET 
          activa = CASE WHEN activa = 1 THEN 0 ELSE 1 END,
          estado = CASE WHEN activa = 1 THEN 'INACTIVA' ELSE 'ACTIVA' END
        OUTPUT inserted.*
        WHERE id = @id;
      `);

    if (toggle.recordset.length === 0) {
      return res.status(404).json({ error: 'Canal no encontrado.' });
    }

    const cam = toggle.recordset[0];
    emitEvent('camara_estado_cambiado', cam);
    return res.json({ camera: cam, message: `Estado del canal actualizado a ${cam.estado}.` });
  } catch (error: any) {
    console.error('[CAMARAS] Error al alternar estado de cámara:', error.message);
    return res.status(500).json({ error: 'Error al alternar estado del canal.' });
  }
});

// =============================================================================
// DELETE /api/camaras/:id - Eliminar canal
// =============================================================================
router.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const db = getDB();
    const del = await db.request()
      .input('id', sql.Int, parseInt(id))
      .query(`DELETE FROM Camaras WHERE id = @id; SELECT @@ROWCOUNT as affected;`);

    const affected = del.recordset[0]?.affected || 0;
    if (affected === 0) return res.status(404).json({ error: 'Cámara no encontrada.' });
    emitEvent('camara_eliminada', { id: parseInt(id) });
    return res.json({ message: 'Canal de video eliminado exitosamente.' });
  } catch (error: any) {
    console.error('[CAMARAS] Error al eliminar cámara:', error.message);
    return res.status(500).json({ error: 'Error al eliminar el canal de video.' });
  }
});

export default router;

