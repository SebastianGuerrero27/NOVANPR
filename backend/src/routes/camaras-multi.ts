/**
 * Rutas extendidas para gestión multi-cámara
 * Soporta múltiples cámaras simultáneas con health checks y estadísticas
 */

import { Router, Request, Response } from 'express';
import sql from 'mssql';
import { getDB } from '../config/db';
import { authMiddleware, roleMiddleware } from '../middlewares/auth';
import { cacheHelper, cacheService } from '../services/cache';

const router = Router();

// GET /api/camaras/active - Obtener todas las cámaras activas con streams
router.get('/active', authMiddleware, async (req: Request, res: Response) => {
  try {
    const db = getDB();
    const result = await db.request()
      .query(`
        SELECT 
          c.id,
          c.nombre,
          c.ip,
          c.ubicacion,
          c.priority,
          c.is_active,
          c.region,
          cs.stream_url,
          cs.stream_type,
          cs.health_status,
          cs.last_heartbeat,
          cs.error_message,
          c.current_fps,
          c.detection_count
        FROM Camaras c
        LEFT JOIN CameraStreams cs ON c.id = cs.camera_id AND cs.is_active = 1
        WHERE c.is_active = 1
        ORDER BY c.priority ASC
      `);
    
    return res.json(result.recordset);
  } catch (error: any) {
    console.error('[CAMARAS] Error al obtener cámaras activas:', error.message);
    return res.status(500).json({ error: 'Error al obtener cámaras activas.' });
  }
});

// GET /api/camaras/:id/stats - Obtener estadísticas de una cámara específica
router.get('/:id/stats', authMiddleware, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { hours = 24 } = req.query;

  try {
    const db = getDB();
    const result = await db.request()
      .input('camera_id', sql.Int, parseInt(id))
      .input('hours', sql.Int, parseInt(hours as string))
      .query(`
        SELECT 
          date,
          hour,
          detection_count,
          plate_recognized_count,
          blacklist_match_count,
          avg_confidence,
          avg_fps
        FROM CameraDetectionStats
        WHERE camera_id = @camera_id
          AND date >= DATEADD(HOUR, -@hours, GETDATE())
        ORDER BY date DESC, hour DESC
      `);
    
    return res.json(result.recordset);
  } catch (error: any) {
    console.error('[CAMARAS] Error al obtener estadísticas:', error.message);
    return res.status(500).json({ error: 'Error al obtener estadísticas de la cámara.' });
  }
});

// PUT /api/camaras/:id/health - Actualizar health status de una cámara
router.put('/:id/health', authMiddleware, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { health_status, error_message, current_fps } = req.body;

  try {
    const db = getDB();
    
    // Actualizar tabla Camaras
    await db.request()
      .input('id', sql.Int, parseInt(id))
      .input('health_status', sql.VarChar, health_status)
      .input('current_fps', sql.Float, current_fps || null)
      .query(`
        UPDATE Camaras
        SET current_fps = @current_fps,
            last_frame_timestamp = GETDATE()
        WHERE id = @id
      `);

    // Actualizar tabla CameraStreams
    await db.request()
      .input('camera_id', sql.Int, parseInt(id))
      .input('health_status', sql.VarChar, health_status)
      .input('error_message', sql.VarChar, error_message || null)
      .input('last_heartbeat', sql.DateTime, new Date())
      .query(`
        UPDATE CameraStreams
        SET health_status = @health_status,
            error_message = @error_message,
            last_heartbeat = @last_heartbeat,
            updated_at = GETDATE()
        WHERE camera_id = @camera_id AND is_active = 1
      `);

    return res.json({ message: 'Health status actualizado exitosamente.' });
  } catch (error: any) {
    console.error('[CAMARAS] Error al actualizar health status:', error.message);
    return res.status(500).json({ error: 'Error al actualizar health status.' });
  }
});

// POST /api/camaras/:id/detection - Registrar detección para estadísticas
router.post('/:id/detection', authMiddleware, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { plate_recognized, blacklist_match, confidence } = req.body;

  try {
    const db = getDB();
    const cameraId = parseInt(id);
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const hour = now.getHours();

    // Incrementar contador de detecciones en tabla Camaras
    await db.request()
      .input('id', sql.Int, cameraId)
      .query('UPDATE Camaras SET detection_count = detection_count + 1 WHERE id = @id');

    // Upsert en tabla de estadísticas
    await db.request()
      .input('camera_id', sql.Int, cameraId)
      .input('date', sql.Date, date)
      .input('hour', sql.Int, hour)
      .input('detection_count', sql.Int, 1)
      .input('plate_recognized_count', sql.Int, plate_recognized ? 1 : 0)
      .input('blacklist_match_count', sql.Int, blacklist_match ? 1 : 0)
      .input('confidence', sql.Float, confidence || null)
      .query(`
        MERGE CameraDetectionStats AS target
        USING (VALUES (@camera_id, @date, @hour)) AS source (camera_id, date, hour)
        ON (target.camera_id = source.camera_id AND target.date = source.date AND target.hour = source.hour)
        WHEN MATCHED THEN
          UPDATE SET 
            detection_count = detection_count + @detection_count,
            plate_recognized_count = plate_recognized_count + @plate_recognized_count,
            blacklist_match_count = blacklist_match_count + @blacklist_match_count,
            avg_confidence = CASE 
              WHEN @confidence IS NOT NULL THEN (avg_confidence * detection_count + @confidence) / (detection_count + 1)
              ELSE avg_confidence
            END
        WHEN NOT MATCHED THEN
          INSERT (camera_id, date, hour, detection_count, plate_recognized_count, blacklist_match_count, avg_confidence)
          VALUES (@camera_id, @date, @hour, @detection_count, @plate_recognized_count, @blacklist_match_count, @confidence);
      `);

    return res.json({ message: 'Detección registrada exitosamente.' });
  } catch (error: any) {
    console.error('[CAMARAS] Error al registrar detección:', error.message);
    return res.status(500).json({ error: 'Error al registrar detección.' });
  }
});

// PUT /api/camaras/:id/toggle - Activar/desactivar cámara
router.put('/:id/toggle', authMiddleware, roleMiddleware(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { is_active } = req.body;

  try {
    const db = getDB();
    
    await db.request()
      .input('id', sql.Int, parseInt(id))
      .input('is_active', sql.Bit, is_active)
      .query('UPDATE Camaras SET is_active = @is_active WHERE id = @id');

    // Invalidar caché de cámaras
    await cacheService.deletePattern('cameras:*');

    return res.json({ message: `Cámara ${is_active ? 'activada' : 'desactivada'} exitosamente.` });
  } catch (error: any) {
    console.error('[CAMARAS] Error al cambiar estado de cámara:', error.message);
    return res.status(500).json({ error: 'Error al cambiar estado de la cámara.' });
  }
});

// GET /api/camaras/health-summary - Resumen de health de todas las cámaras
router.get('/health-summary', authMiddleware, async (req: Request, res: Response) => {
  try {
    const db = getDB();
    const result = await db.request()
      .query(`
        SELECT 
          COUNT(*) as total_cameras,
          SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_cameras,
          SUM(CASE WHEN health_status = 'healthy' THEN 1 ELSE 0 END) as healthy_cameras,
          SUM(CASE WHEN health_status = 'degraded' THEN 1 ELSE 0 END) as degraded_cameras,
          SUM(CASE WHEN health_status = 'offline' THEN 1 ELSE 0 END) as offline_cameras,
          AVG(CASE WHEN current_fps IS NOT NULL THEN current_fps ELSE NULL END) as avg_fps,
          SUM(detection_count) as total_detections
        FROM Camaras c
        LEFT JOIN CameraStreams cs ON c.id = cs.camera_id AND cs.is_active = 1
      `);
    
    return res.json(result.recordset[0]);
  } catch (error: any) {
    console.error('[CAMARAS] Error al obtener resumen de health:', error.message);
    return res.status(500).json({ error: 'Error al obtener resumen de health.' });
  }
});

export default router;